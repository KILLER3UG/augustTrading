/**
 * toolTurn — ONE model turn against the desk-tool transport.
 *
 * This is the half of `runSeatTurn` that was never about the dock: stream a
 * reply, let the model call tools while it does, keep its reasoning out of the
 * answer channel, and settle the row honestly. It lived inside the Chart AI
 * panel's session machinery, so the Agents surface could not get tool calls
 * without copying that machinery — and a second copy is how two homes start
 * disagreeing about one turn.
 *
 * The executor owns the TRANSITION; the caller owns the ROW. How a turn is
 * stored (a dock `LiveEntry` with `tools`/`toolIds`, a canonical `Message` with
 * `thoughtProcesses`) stays behind `ToolTurnEvents`, because the two row types
 * do not share those fields — `Message` has no `tools`/`toolIds` at all, which
 * is why this is an event sink and not one shared state object.
 *
 * Four behaviours here each cost a bug to learn; do not "simplify" them:
 *  - the abort check runs BEFORE the echo repair, or a deliberate Stop is
 *    reported as a failure ("it cancelled" became "could not answer");
 *  - the settle reads STRIPPED text, or a text-protocol tool call reaches the
 *    transcript as literal protocol soup;
 *  - the splitter only acts when it really peeled something, or a clean answer
 *    that happens to open with "Verdict:" gets eaten;
 *  - `resetText` fires on a bounced malformed call, because what streamed so
 *    far was the attempt, not the answer.
 */

import type { ProviderConfig, WireAuditEntry } from '../../types/provider';
import type { ChatMessage } from '../providers/GenericProviderService';
// LAZY: the desk whale loads on the first tool turn, not at boot (O-146).
import type { ToolAction } from '../../types/message';
const deskService = (): Promise<typeof import('../analysis/DeskToolsService')> => import('../analysis/DeskToolsService');
const captureTurn = (input: Parameters<typeof import('../learning/trainingCapture').captureTurn>[0]) => import('../learning/trainingCapture').then(m => m.captureTurn(input));
const noteCaptureFailure = (reason: string) => import('../learning/trainingCapture').then(m => m.noteCaptureFailure(reason));
import type { StreamWithDeskToolsOptions } from '../analysis/DeskToolsService';
import { emptyTokenUsage, mergeTokenUsage } from '../../utils/tokenUsage';
import type { TokenUsage } from '../../utils/tokenUsage';
import { splitThinkingFromOutput } from '../../utils/thinkingSplit';
import { getHarnessSettings } from '../../utils/harnessSettings';
import type { ReasoningEffort } from '../providers/reasoningControls';

/** What the row should look like right now. Every method is a display intent,
 *  never a storage shape — the caller decides whether that means a chatStore
 *  patch, a Message patch, or (after unmount) nothing at all. */
export interface ToolTurnEvents {
    /** Absolute visible text, not an append. A hidden-pass seat sees '' until
     *  it proves it spoke, then the whole answer lands at once. */
    setText(text: string): void;
    addReasoning(chunk: string): void;
    addToolLine(line: string): void;
    /** A transient "still working" line. Never part of the settled trail:
     *  calls are paired one-call-one-row, and a progress line in that grammar
     *  reads as a completed result. */
    addLiveToolLine?(line: string): void;
    /** The model's tool NAME, once per executed call. Separate from the display
     *  line because a caller that checks what a turn looked up must not parse
     *  prose: `calling present_trade…` reads like any other lookup. */
    addToolCall?(name: string): void;
    attachPayload(payload: Parameters<NonNullable<StreamWithDeskToolsOptions['onToolPayload']>>[0]): void;
    addAction(action: Parameters<NonNullable<StreamWithDeskToolsOptions['onToolAction']>>[0]): void;
}

export interface ToolTurnOutcome {
    /** The answer, after stripping and the echo/peel repair — what to PAINT. */
    text: string;
    /** What to hand back to the caller. Equal to `text` except on the pure-echo
     *  path, where the bubble must show only what came after the echoed
     *  reasoning while a panel room still has to carry the whole analysis. */
    carry: string;
    /** The reasoning that should be STORED with the turn (peeled-aware). */
    reasoning: string;
    /** The splitter moved reasoning out of the answer channel. */
    leaked: boolean;
    /** The user pulled the plug — not a failure, and checked before anything else. */
    interrupted: boolean;
    workedMs: number;
    /** A line the caller should append to its own notice list: this turn had no
     *  separate answer, only its reasoning. */
    notice?: string;
    /** Token counts the PROVIDER reported for this turn, merged across every
     *  round it made. Measured, never inferred: it stays zero when the provider
     *  sent no usage frame, and a zero is a gap rather than a small number. */
    usage: TokenUsage;
    /** How many usage frames arrived — so a caller can tell one round from four
     *  without re-deriving it from tool lines. */
    usageCalls: number;
    /** The thinking tier this turn was actually sent under — the RESOLVED one,
     *  because the caller resolved it before the request left. It rides out
     *  with the outcome so the answer can RECORD it: the row the trader reads
     *  says how hard the model was asked to think, and a fact that is not
     *  carried out of the executor has to be re-derived by every writer —
     *  which is how two rows end up claiming different tiers for one turn. */
    effort: ReasoningEffort;
    wireAudit?: WireAuditEntry[];
    /** The turn hit the token ceiling AND recovered — a thinking-cut re-ask
     *  or a partial-text continuation came back clean. The caller suppresses
     *  the "PROVIDER STOPPED EARLY" notice: the tally counted the truncated
     *  call, but the answer on the row is whole, and warning about a treated
     *  wound is noise. */
    recoveredFromTruncation?: boolean;
}

export interface ToolTurnRequest {
    config: ProviderConfig;
    messages: ChatMessage[];
    signal: AbortSignal;
    /** The turn's own start, so a Stop, a failure and a clean finish all report
     *  the same "worked for Ns". */
    startedAt: number;
    effort: ReasoningEffort;
    events: ToolTurnEvents;
    /** Forwarded verbatim to the transport, minus the five callbacks this owns. */
    transport: Omit<
        StreamWithDeskToolsOptions,
        'onReasoning' | 'onToolEvent' | 'onToolCall' | 'onToolPayload' | 'onToolAction' | 'onStreamReset' | 'signal'
    >;
    /** Panel seats: keep the bubble empty while a pure (pass) is still possible.
     *  Passed the RAW accumulator, never the stripped one. */
    keepTextHidden?: (accumulated: string) => boolean;
    /** The Settings memory switch for this turn (prompt index, pre-read hints
     *  and the memory tools all obey it). */
    memoryEnabled?: boolean;
    /** The trader's latest message, for the forget guard. */
    lastUserMessage?: string;
    /** Training-corpus tee, read at turn end: the STRUCTURED plan a
     *  `present_trade` minted this turn — id, symbol, verified playbook stamp
     *  — and the O-46 snapshot when its fetch landed. The dispatcher owns the
     *  state (its `PresentTradeSink` receives it from the structured path)
     *  and hands it over here; the recorder reads what the STRUCTURED path
     *  reported instead of mining plan ids out of tool prose (a receipt
     *  reworded, a card cancelled, and the regex join silently missed). */
    capturePlan?: () => { planId: string; symbol: string; playbookId: string | null; snapshot?: CaptureSnapshot | null } | null;
}

/** The O-46 snapshot shape the recorder stores — structurally what
 *  `buildDecisionSnapshot` returns (see `trainingCapture.DecisionSnapshot`). */
export type CaptureSnapshot = {
    regimeId: string | null; regimeText: string | null;
    atr: number | null; atrTf: string | null;
    prevDayHigh: number | null; prevDayLow: number | null;
    sessionVwap: number | null; capturedAt: string;
};

/** What the turn produced before usage is folded in. */
type InnerOutcome = Omit<ToolTurnOutcome, 'usage' | 'usageCalls' | 'effort' | 'wireAudit'>;

/**
 * The one turn executor, with token accounting measured rather than inferred.
 *
 * `streamChatWithDeskTools` forwards `onUsage` to the wire, and the wire calls it
 * with whatever the provider reported for THAT request — so this collects per
 * request, with no shared bus. A global subscriber would have attributed an
 * a detached run's tokens to whichever interactive turn happened to be streaming
 * beside it. A turn whose provider sent no usage frame reports zeroes, and the
 * panel shows a gap instead of a number nobody measured.
 */
export const runToolTurn = async (req: ToolTurnRequest): Promise<ToolTurnOutcome> => {
    // The training-corpus tee: every tool line and structured action the turn
    // produces is ALSO collected here, so the 'Improve future August models'
    // recorder (OFF by default, Settings → Data) can store the turn whole —
    // trader words, reasoning, tool trail, actions — without any sink
    // reshaping. A capture failure must never touch the turn: fire-and-forget
    // below, and the recorder itself never throws.
    const capturedToolLines: string[] = [];
    const capturedActions: ToolAction[] = [];
    const teedEvents: ToolTurnEvents = {
        ...req.events,
        addToolLine: line => { capturedToolLines.push(line); req.events.addToolLine(line); },
        addAction: action => { capturedActions.push(action); req.events.addAction(action); },
    };

    let usage = emptyTokenUsage();
    let usageCalls = 0;
    const callerOnUsage = req.transport.onUsage;
    // The wire audit, collected per CALL — the same discipline as the usage
    // above: one turn makes several requests, and a turn's record has to say
    // what EACH of them asked for.
    const wireAudit: WireAuditEntry[] = [];
    const callerOnWireAudit = req.transport.onWireAudit;
    const outcome = await runToolTurnInner({
        ...req,
        events: teedEvents,
        transport: {
            ...req.transport,
            onUsage: (frame: TokenUsage) => {
                usage = mergeTokenUsage(usage, frame);
                usageCalls += 1;
                callerOnUsage?.(frame);
            },
            onWireAudit: (entry: WireAuditEntry) => {
                wireAudit.push(entry);
                callerOnWireAudit?.(entry);
            },
        },
    });
    // The effort rides out HERE, on the one return every path shares: the
    // inner executor never sees a tier, so there is exactly one place that
    // stamps it and every caller records the same value. The wire audit
    // rides out beside it, for the same reason.
    // Fire-and-forget: OFF means a no-op inside the recorder, and a failure
    // is data the Settings card shows — never a turn that breaks.
    const capturedPlan = req.capturePlan?.() ?? null;
    void captureTurn({
        surface: 'chat',
        symbol: capturedPlan?.symbol ?? null,
        model: { provider: req.config.name || 'unknown', model: req.config.selectedModel },
        effort: req.effort ?? null,
        userText: req.lastUserMessage ?? '',
        finalText: outcome.text ?? '',
        reasoning: outcome.reasoning ?? '',
        toolEvents: capturedToolLines,
        actions: capturedActions.flat(),
        // The STRUCTURED plan, not a regex over the receipt prose — and the
        // snapshot rides with it when the fetch beat the turn's end.
        planId: capturedPlan?.planId ?? null,
        snapshot: capturedPlan?.snapshot ?? null,
    }).then(result => {
        if (!result.ok && result.reason !== 'disabled' && result.reason !== 'desktop-only') {
            noteCaptureFailure(result.reason);
        }
    }).catch(e => {
        noteCaptureFailure(e instanceof Error ? e.message : String(e));
    });

    return {
        ...outcome,
        usage,
        usageCalls,
        effort: req.effort,
        wireAudit: wireAudit.length > 0 ? wireAudit : undefined,
    };
};

const runToolTurnInner = async (req: ToolTurnRequest): Promise<InnerOutcome> => {
    const { events, signal, startedAt } = req;
    let raw = '';
    let reasoning = '';
    // The loop reports turn-level facts a text stream cannot carry (the
    // generator yields deltas); the recovered flag rides this callback.
    let recoveredFromTruncation = false;
    const visible = (text: string): string => (req.keepTextHidden && req.keepTextHidden(raw) ? '' : text);

    const { streamChatWithDeskTools } = await deskService();
    const stream = streamChatWithDeskTools(req.config, req.messages, {
        ...req.transport,
        memoryEnabled: req.memoryEnabled !== false,
        lastUserMessage: req.lastUserMessage,
        signal,
        // The transport's reactive path (a provider that rejected the request
        // and stated its limit). The proactive one reports through
        // `onToolEvent`, which the caller already paints as a tool line — this
        // is the only compaction channel that would otherwise be silent.
        onContextCompact: line => events.addToolLine(line),
        onStreamReset: () => {
            // The attempt, not the answer: clear the accumulator and repaint,
            // so the corrected turn paints alone instead of concatenating.
            raw = '';
            events.setText(visible(''));
        },
        onReasoning: chunk => { reasoning += chunk; events.addReasoning(chunk); },
        onToolEvent: line => events.addToolLine(line),
        onToolProgress: line => events.addLiveToolLine?.(line),
        onToolCall: name => events.addToolCall?.(name),
        onToolPayload: payload => events.attachPayload(payload),
        onToolAction: action => events.addAction(action),
        onLoopMeta: meta => { recoveredFromTruncation = meta.recoveredFromTruncation; },
    });

    for await (const delta of stream) {
        if (signal.aborted) break;
        raw += delta;
        events.setText(visible(raw));
    }

    const workedMs = Math.max(0, Date.now() - startedAt);
    const full = (await deskService()).stripTextToolCalls(raw);
    // The transport self-gates: with `deskToolsEnabled` off (or the caller's own
    // `enabled: false`) it streams plain text and parses NO tool call at all. A
    // seat that still emits the protocol then claims to have read the tape while
    // nothing ran — the one failure a fallback must not hide. The markup comes
    // off either way; what this adds is the truth in the transcript.
    const toolsOff = req.transport.enabled === false || !getHarnessSettings().deskToolsEnabled;
    const attemptedProtocol = full.trim() !== raw.trim();
    const offNotice = 'Desk tools are OFF for this turn, so nothing was looked up - '
        + 'the seat tried to call a tool and no data came back. Anything it reports is from memory.';

    // An explicit Stop is the user pulling the plug, and it settles FIRST: after
    // it, every other path reads like a failure, and a stopped turn is a
    // half-written answer the trader chose to cut.
    if (signal.aborted) {
        return { text: full, carry: full, reasoning, leaked: false, interrupted: true, workedMs };
    }

    const settled = splitThinkingFromOutput(reasoning, full);
    const r = reasoning.trim();
    const f = full.trim();
    // PURE ECHO: the model repeated its native chain of thought verbatim into
    // the content channel, so the reply is only what came AFTER it — and if
    // nothing did, the row has to say so instead of showing the scratchpad twice.
    if (r && settled.output === '' && (f === '' || f.startsWith(r))) {
        const rest = f.slice(r.length).trim();
        const echoNotice = rest ? undefined
            : 'The model streamed only its reasoning this turn — no separate answer came through. Try a lower thinking effort, or ask again.';
        return {
            text: rest,
            carry: rest || f,
            reasoning,
            leaked: false,
            interrupted: false,
            workedMs,
            ...(recoveredFromTruncation ? { recoveredFromTruncation: true } : {}),
            ...(toolsOff && attemptedProtocol
                ? { notice: offNotice }
                : echoNotice ? { notice: echoNotice } : {}),
        };
    }

    const leaked = full.trim() !== settled.output && !!(settled.thinking.trim() || r);
    const text = leaked ? (settled.output || full) : full;
    return {
        text,
        carry: text,
        reasoning: leaked ? (settled.thinking || reasoning) : reasoning,
        leaked,
        interrupted: false,
        workedMs,
        ...(recoveredFromTruncation ? { recoveredFromTruncation: true } : {}),
        ...(toolsOff && attemptedProtocol ? { notice: offNotice } : {}),
    };
};
