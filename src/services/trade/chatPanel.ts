/**
 * chatPanel — the pure half of Chart AI PANEL sessions: up to
 * PANEL_MAX_MODELS models answering one user request TOGETHER. Each seat
 * speaks in turn seeing the room so far (its prior turns + the others'),
 * can @mention a peer to bring it in (mailbox send_message doubles as the
 * visible cross-talk line), may stay silent with the (pass) token, and the
 * last seat in the round synthesizes the final answer. Skill/memory/tool
 * edits ride the same desk-tool loop every seat already has, so proposals
 * made by ANY seat show up in the shared transcript.
 *
 * Pure module: the engine never imports providers or React — the dock feeds
 * it a run callback so tests drive it with a fake transport.
 */

import { PANEL_MAX_MODELS, type ChatSession } from './chatSessions';
import { isPassReply } from '../agents/groupRounds';
import { escapeRegExp } from '../../utils/escapeRegExp';

export interface PanelSeat {
    /** Stable key: `bot:<botId>` for an agent seat, else `${providerId}:${modelId}`. */
    id: string;
    /** Seat label in the transcript — the agent's name, or the model's. */
    name: string;
    providerId: string;
    modelId: string;
    /** Set when this seat IS a roster agent. The dock then runs it with that
     *  bot's persona, provider/model AND its own notebook, so a panel can be
     *  N agents rather than N models. Absent = a plain model seat. */
    botId?: string;
}

export interface PanelTurn {
    seatId: string;
    text: string;
    /** True for the synthesizer's closing turn. */
    synthesis?: boolean;
}

/** The ONE seat-key rule: an agent seat keys on its bot, a model seat on its
 *  provider+model. Shared by the seat list and the picker's chips so a chip
 *  cannot address a different seat than the one the panel is running. */
export const panelSeatKey = (m: { providerId: string; modelId: string; botId?: string }): string =>
    m.botId ? `bot:${m.botId}` : `${m.providerId}:${m.modelId}`;

/** The panel seats from a stored session (deduped, cap-enforced). Accepts
 *  the live (streaming) session shape too — only panelModels is read.
 *  `botNameFor` resolves a seat's `botId` to the roster agent's name; a botId
 *  that no longer resolves degrades to a plain model seat on that bot's model
 *  rather than naming a phantom "b1" in the transcript. */
export const panelSeats = (
    session: Pick<ChatSession, 'panelModels'>,
    labelFor: (modelId: string) => string,
    botNameFor?: (botId: string) => string | undefined,
): PanelSeat[] => {
    const out: PanelSeat[] = [];
    const seen = new Set<string>();
    for (const raw of (session.panelModels ?? []).slice(0, PANEL_MAX_MODELS)) {
        const botName = raw.botId ? botNameFor?.(raw.botId) : undefined;
        // An unresolvable botId is a deleted agent: drop the claim and keep the
        // model, so the seat still answers under a real name.
        const m = botName ? raw : { providerId: raw.providerId, modelId: raw.modelId };
        const key = panelSeatKey(m);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            id: key,
            name: botName ?? labelFor(m.modelId),
            providerId: m.providerId,
            modelId: m.modelId,
            ...(botName ? { botId: m.botId } : {}),
        });
    }
    return out;
};

/** Next-seat plan for a panel turn. `spoken` records every seat that has
 *  already taken a turn THIS prompt (passes included — the caller always
 *  appends the seat id, so the round provably terminates). `pull` lists
 *  seat ids mentioned with @ by prior speakers: an unspoken mentioned seat
 *  jumps the round-robin queue (the "they can talk to each other" routing). */
export const planPanelTurn = (seats: PanelSeat[], spoken: string[], pull: string[] = []): { seat: PanelSeat | null; isSynthesis: boolean } => {
    const open = seats.filter(s => !spoken.includes(s.id));
    if (open.length > 0) {
        const pulled = pull.map(id => open.find(s => s.id === id)).find(Boolean);
        return { seat: pulled ?? open[0], isSynthesis: false };
    }
    const last = seats[seats.length - 1];
    // Everyone spoke exactly once AND there is more than one seat: the last
    // seat closes with the synthesis. A single-seat panel is just its answer.
    if (last && seats.length >= 2 && spoken.length === seats.length) return { seat: last, isSynthesis: true };
    // The synthesis already happened (or nothing to synthesize) — settled.
    return { seat: null, isSynthesis: false };
};

/** Room transcript for the NEXT speaker: every prior seat turn rendered
 *  with speaker names so a seat can quote/rebut a peer. */
export const formatRoomTranscript = (turns: PanelTurn[], nameFor: (seatId: string) => string): string => {
    if (turns.length === 0) return '';
    const lines = turns.map(t => `${nameFor(t.seatId)}: ${t.text}`);
    return ['The panel has spoken so far (other models, same chart, same request):', ...lines].join('\n\n');
};

/** Deterministic mention routing: a seat's reply may @mention peers to pull
 *  them in before the round-robin order continues. Matches each known seat
 *  NAME after an @ (multi-word names included), so nothing over-captures.
 *  Returns mentioned seat ids in first-mention order (self excluded). */
export const parsePanelMentions = (text: string, seats: PanelSeat[], selfId: string): string[] => {
    if (!text.includes('@')) return [];
    const hits: Array<{ at: number; id: string }> = [];
    for (const s of seats) {
        if (s.id === selfId || !s.name) continue;
        const escaped = escapeRegExp(s.name);
        const re = new RegExp(`@${escaped}(?![\\p{L}\\p{N}])`, 'giu');
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) hits.push({ at: m.index, id: s.id });
    }
    const out: string[] = [];
    for (const h of hits.sort((a, b) => a.at - b.at)) {
        if (!out.includes(h.id)) out.push(h.id);
    }
    return out;
};

/** True while an accumulated stream could still collapse to a pure pass.
 *  The panel keeps a seat's bubble EMPTY while this holds (runSeatTurn), so
 *  an '(pas…' stream never renders and a proven pass is dropped without ever
 *  having taken a visible turn. */
export const panelCouldStillBePass = (accumulated: string): boolean =>
    isPassReply(accumulated) || '(pass)'.startsWith(accumulated.trim().toLowerCase());
