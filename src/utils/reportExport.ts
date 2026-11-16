/**
 * Report export utilities — turn the trade log into a CSV download or a
 * print-ready HTML report (open → Ctrl/Cmd+P → save as PDF), and turn a
 * profile's conversations into a CSV or Markdown transcript.
 */

import { LoggedTrade } from '../types';
import { TradeOutcome } from '../types';
import { Conversation, Message } from '../types';
import { phtDayKey, phtDayYear, phtFullStamp } from './timezone';

const dateStamp = (): string => phtDayKey();

function downloadBlob(content: string, filename: string, type: string): void {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Escape a value for CSV (quoted, embedded quotes doubled). */
const csvCell = (value: unknown): string =>
    `"${String(value ?? '').replace(/"/g, '""')}"`;

/**
 * Export the trade log as a CSV file (Excel/Sheets friendly).
 */
export const exportTradesCSV = (trades: LoggedTrade[]): void => {
    const header = [
        'Date', 'Coin', 'Direction', 'Outcome', 'Entry', 'Stop Loss', 'Take Profits',
        'Leverage', 'PnL (USD)', 'PnL (%)', 'Family', 'Strategy', 'Confidence', 'Post-Mortem',
    ];
    /** A journal row written before import validation rejected `analysis: null`
     *  still belongs in the trader's export. Empty plan cells, not a throw and not a
     *  silently missing row — a CSV that drops a trade is the same class of lie as a
     *  tally that invents one. */
    const MISSING_PLAN = {} as LoggedTrade['analysis'];
    const rows = trades.map(t => {
        const a = t.analysis ?? MISSING_PLAN;
        return [
            t.timestamp,
            a.coinName || '',
            a.direction || '',
            t.outcome,
            a.entryPoints?.[0]?.price || '',
            a.stopLoss || '',
            (a.takeProfit || []).map(tp => tp.price).join(' / '),
            t.leverage ?? '',
            t.pnlAmount ?? '',
            t.pnlPercent ?? '',
            a.detectedPatternFamily || '',
            a.strategy || '',
            a.confidence || '',
            (t.postMortem || '').slice(0, 300),
        ];
    });
    const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
    downloadBlob(csv, `august-trades-${dateStamp()}.csv`, 'text/csv;charset=utf-8;');
};

/**
 * Escape a value for safe interpolation into the report HTML — coin names,
 * strategies and directions come from AI output and can contain markup.
 */
const escapeHtml = (value: unknown): string => {
    const str = value === null || value === undefined ? '' : String(value);
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

/**
 * Export the trade log as a printable HTML report (monochrome, print
 * stylesheet included — open it and use the browser's print-to-PDF).
 *
 * On the web the report opens in a new tab. In the Electron shell the
 * window-open handler denies every target that is not https:, so a blob:
 * URL could never become a window there — the button clicked and nothing
 * happened. Desktop downloads the same file instead (the path the CSV and
 * JSONL exports already use); open it and print-to-PDF as before.
 */
export const exportTradesHTML = (trades: LoggedTrade[]): void => {
    const completed = trades.filter(t => t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS);
    const wins = completed.filter(t => t.outcome === TradeOutcome.WIN).length;
    const losses = completed.length - wins;
    const winRate = completed.length > 0 ? Math.round((wins / completed.length) * 100) : 0;
    const priced = trades.filter(t => typeof t.pnlAmount === 'number');
    const totalPnl = priced.reduce((sum, t) => sum + (t.pnlAmount as number), 0);
    const grossWin = trades.filter(t => t.outcome === TradeOutcome.WIN).reduce((s, t) => s + (t.pnlAmount || 0), 0);
    const grossLoss = Math.abs(trades.filter(t => t.outcome === TradeOutcome.LOSS).reduce((s, t) => s + (t.pnlAmount || 0), 0));
    const profitFactor = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? '∞' : '—');
    const factorLabel = priced.length > 0 && priced.length < trades.length
        ? `Profit factor (${priced.length}/${trades.length})`
        : 'Profit factor';

    const rows = trades.map(t => {
        const a = t.analysis ?? ({} as LoggedTrade['analysis']);
        return `
        <tr>
            <td>${phtDayYear(t.timestamp)}</td>
            <td>${escapeHtml(a.coinName) || '—'}</td>
            <td>${escapeHtml(a.direction) || '—'}</td>
            <td>${escapeHtml(t.outcome)}</td>
            <td>${escapeHtml(a.entryPoints?.[0]?.price) || '—'}</td>
            <td>${escapeHtml(a.stopLoss) || '—'}</td>
            <td>${escapeHtml((a.takeProfit || []).map(tp => tp.price).join(' / ')) || '—'}</td>
            <td>${escapeHtml(t.leverage) || '—'}x</td>
            <td>${t.pnlAmount !== undefined ? t.pnlAmount.toFixed(2) : (t.pnlPercent !== undefined ? `${t.pnlPercent >= 0 ? '+' : ''}${t.pnlPercent.toFixed(1)}%` : '—')}</td>
            <td>${escapeHtml(a.detectedPatternFamily) || '—'}</td>
            <td>${escapeHtml(a.strategy) || '—'}</td>
        </tr>`;
    }).join('');

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>August Trading — Trade Report</title>
<style>
  :root { color-scheme: light; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; color: #141416; margin: 2rem auto; max-width: 1100px; padding: 0 1.5rem; }
  h1 { font-size: 1.4rem; margin-bottom: .25rem; }
  .sub { color: #717171; font-size: .85rem; margin-bottom: 1.5rem; }
  .stats { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
  .stat { border: 1px solid #d9d9d9; border-radius: 8px; padding: .6rem 1rem; min-width: 110px; }
  .stat b { display: block; font-size: 1.2rem; }
  .stat span { font-size: .7rem; color: #717171; text-transform: uppercase; letter-spacing: .05em; }
  table { width: 100%; border-collapse: collapse; font-size: .8rem; }
  th, td { border-bottom: 1px solid #ececec; padding: .45rem .5rem; text-align: left; }
  th { background: #eaeaec; font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; color: #717171; }
  tr:nth-child(even) td { background: #f7f7f7; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
  <h1>Trading Journal — Report</h1>
  <div class="sub">Generated ${phtFullStamp(Date.now())} · ${trades.length} trades (${wins} W / ${losses} L)</div>
  <div class="stats">
    <div class="stat"><b>${winRate}%</b><span>Win rate</span></div>
    <div class="stat"><b>${priced.length > 0 ? `${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}${priced.length < trades.length ? ` (${priced.length}/${trades.length})` : ''}` : 'not captured'}</b><span>Net PnL (USD)</span></div>
    <div class="stat"><b>${profitFactor}</b><span>${factorLabel}</span></div>
    <div class="stat"><b>${trades.length}</b><span>Trades</span></div>
  </div>
  <table>
    <thead><tr><th>Date</th><th>Coin</th><th>Dir</th><th>Outcome</th><th>Entry</th><th>SL</th><th>TPs</th><th>Lev</th><th>PnL</th><th>Family</th><th>Strategy</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;

    const onDesktop = typeof window !== 'undefined'
        && !!(window as { electronAPI?: { isElectron?: boolean } }).electronAPI?.isElectron;
    if (onDesktop) {
        downloadBlob(html, `august-trades-${dateStamp()}.html`, 'text/html;charset=utf-8');
        return;
    }
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

export const TRAINING_SCHEMA_VERSION = 1;

/**
 * One model-ready training record for a logged trade.
 *
 * Shape rules, in the order they matter:
 *  - STABLE: every key exists on every line, `null` where the app never learned
 *    the fact, and `schemaVersion` on the record itself — absence must never be
 *    ambiguous between "not recorded" and "older schema".
 *  - THREE NESTS THAT MUST NOT BE FLATTENED TOGETHER: `decision` is what the
 *    model knew AT ENTRY TIME, `outcome` is what the market said later, `lesson`
 *    is the post-hoc reading. Training a verdict on its own outcome is leaking
 *    the answer into the input, and the fields that make that possible
 *    (`outcomeResolvedAt`, `postMortem`, `rootCauseClass`) sit away from inputs.
 *  - UNRESOLVED and METRIC-LESS rows are INCLUDED and FLAGGED (`incomplete`,
 *    `missing[]`). Dropping them biases the corpus toward trades that happened to
 *    settle; writing 0 for a missing R teaches that the exit landed on the entry.
 *  - UNITS ARE NEVER MERGED: `pnlAmount` is captured dollars, `pnlPercent` is a
 *    leveraged position percent (an autopilot read). Nothing here converts one
 *    into the other, because a derived figure would be indistinguishable from a
 *    captured one.
 *
 * Entry-time candles are RECONSTRUCTABLE rather than stored: `decision` carries
 * the symbol, the analysis-time timestamp (`analysisCreatedAt`) and the entry
 * price — exactly what `fetchFuturesOHLCVFromTime(symbol, tf, analysisCreatedAt)`
 * takes, the same tape path the post-mortem's candle validation walks. The bars
 * themselves are megabytes per trade and are reachable by
 * `provenance.sourceRunId`, not by line.
 */
export const trainingRecordFor = (t: LoggedTrade): Record<string, unknown> => {
    const decision = {
        symbol: t.analysis?.coinName ?? null,
        direction: t.analysis?.direction ?? null,
        strategy: t.analysis?.strategy ?? null,
        strategyFamily: t.analysis?.strategyFamily ?? null,
        verdictProbability: typeof t.analysis?.probability === 'number' ? t.analysis.probability : null,
        entry: t.analysis?.entryPoints?.[0]?.price ?? null,
        stopLoss: t.analysis?.stopLoss ?? null,
        takeProfits: (t.analysis?.takeProfit ?? []).map(tp => tp.price),
        leverage: t.leverage ?? null,
        tradeType: t.tradeType ?? null,
        marketRegime: t.marketRegime ?? null,
        /** The tape's anchor: analysis time, not log time. */
        analysisCreatedAt: t.analysis?.createdAt ?? null,
        planId: t.planId ?? null,
        checklist: t.checklistCompleted ?? null,
        followedPlan: typeof t.followedPlan === 'boolean' ? t.followedPlan : null,
    };
    const resolved = t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS;
    const outcome = {
        outcome: t.outcome,
        resolved,
        outcomeResolvedAt: t.outcomeResolvedAt ?? null,
        pnlAmount: typeof t.pnlAmount === 'number' ? t.pnlAmount : null,
        pnlPercent: typeof t.pnlPercent === 'number' ? t.pnlPercent : null,
        /** The canonical outcome label (price levels only). `rMultiple` is the
         *  older leveraged-percent derivation: kept for history, not preferred. */
        realizedR: typeof t.realizedR === 'number' ? t.realizedR : null,
        rMultiple: typeof t.rMultiple === 'number' ? t.rMultiple : null,
        rSource: t.rSource ?? null,
        maxAdverseExcursion: typeof t.maxAdverseExcursion === 'number' ? t.maxAdverseExcursion : null,
        maxFavorableExcursion: typeof t.maxFavorableExcursion === 'number' ? t.maxFavorableExcursion : null,
        excursionSource: t.excursionSource ?? null,
        extendedSLZoneBreach: t.extendedSLZoneBreach ?? false,
    };
    const lesson = {
        mistakeTags: t.mistakeTags ?? [],
        emotionalState: t.emotionalState ?? null,
        planDeviationNote: t.planDeviationNote ?? null,
        rootCauseClass: t.rootCauseClass ?? null,
        postMortem: t.postMortem ?? null,
    };
    return {
        schemaVersion: TRAINING_SCHEMA_VERSION,
        id: t.id,
        loggedAt: t.timestamp,
        incomplete: !resolved || outcome.realizedR === null
            || (outcome.pnlAmount === null && outcome.pnlPercent === null)
            || outcome.maxAdverseExcursion === null || lesson.postMortem === null
            || decision.checklist === null,
        missing: [
            ...(!resolved ? ['outcome'] : []),
            ...(outcome.realizedR === null ? ['realizedR'] : []),
            ...(outcome.pnlAmount === null && outcome.pnlPercent === null ? ['pnl'] : []),
            ...(outcome.maxAdverseExcursion === null ? ['excursions'] : []),
            ...(lesson.postMortem === null ? ['postMortem'] : []),
            ...(decision.checklist === null ? ['checklist'] : []),
        ],
        decision,
        outcome,
        lesson,
        provenance: {
            modelsUsed: t.modelsUsed ?? null,
            moderator: t.moderatorModel ? { provider: t.moderatorProvider ?? null, model: t.moderatorModel } : null,
            sourceRunId: t.sourceRunId ?? null,
            // Size discipline: the transcript belongs in the reasoning export.
            // Count it; the bodies stay behind the run id.
            debateTurnCount: t.debateTurns?.length ?? 0,
        },
    };
};

/**
 * Export the journal as JSONL — one training record per line — for offline
 * fine-tuning. Deliberately includes UNRESOLVED rows with `outcome` telling you
 * so: dropping them would silently bias the corpus toward trades that settled,
 * which is a different question than the one a finetune answers.
 */
export const exportTrainingDataJSONL = (trades: LoggedTrade[]): void => {
    const body = trades.map(t => JSON.stringify(trainingRecordFor(t))).join('\n');
    downloadBlob(`${body}${body ? '\n' : ''}`, `august-training-data-${dateStamp()}.jsonl`, 'application/x-ndjson');
};

/* ════════════════════════════ MESSAGE TRANSCRIPTS ═══════════════════════════
   The conversation is the other record this app keeps, and until now it only
   ever left the machine as a whole-profile JSON backup — a format nothing else
   reads. These two exporters cover the same data in the two shapes a trader
   actually asks for: Markdown to read, CSV to sort.

   ONE flattener, two writers. That is the whole design: a CSV and a Markdown
   file of the same chat that disagree about whether the reasoning was included
   would be two records of one conversation, which is the drift this repo keeps
   hitting everywhere else. `messageRecord` decides what a message IS; both
   formats render from it and neither gets to add or drop a field on its own. */

/** One message, flattened to the fields BOTH transcript formats carry. */
interface MessageRecord {
    chat: string;
    chatId: string;
    at: string;
    role: string;
    speaker: string;
    model: string;
    effort: string;
    text: string;
    reasoning: string;
    tools: string;
    toolPayloads: string;
    actions: string;
    entry: string;
    stop: string;
    targets: string;
    probability: string;
    promptTokens: string;
    completionTokens: string;
    costUsd: string;
    skills: string;
    images: number;
    planId: string;
    error: string;
    wireAudit: string;
}

const stampOf = (iso: string | undefined, fallback: number): string => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : new Date(fallback).toISOString();
};

/** A number that exports as text, and an absent one exports as nothing — a `0`
 *  cost and a not-recorded cost are different facts and must not print alike. */
const num = (v: number | undefined): string => (typeof v === 'number' ? String(v) : '');

/** The single definition of "what a message contains".
 *
 *  There is deliberately no "interrupted" column: `interrupted` is a DOCK ENTRY
 *  field, not a `Message` one, and the two homes of one conversation do not
 *  carry the same set of flags. Inventing one here would export a column that is
 *  empty for every row and reads as "no turn was ever stopped". */
const messageRecord = (m: Message, chatTitle: string, chatId: string, at: number): MessageRecord => {
    const a = m.analysis;
    return {
        chat: chatTitle,
        chatId,
        at: stampOf(m.createdAt, at),
        role: String(m.role ?? ''),
        // A bot's row names the bot; a desk row is the desk. Nothing is invented
        // here — an unattributed row exports empty rather than guessing a seat.
        speaker: m.botId ?? m.dmEnvelope?.fromName ?? '',
        model: Object.values(m.modelsUsed ?? {}).filter(Boolean).join(' / '),
        effort: m.runStats?.effort ?? '',
        text: m.text ?? '',
        // providerId → trace. Joined with a blank line and prefixed per provider,
        // because a multi-model run holds one trace each and losing which seat
        // thought what would make the export unreadable rather than incomplete.
        reasoning: Object.entries(m.thoughtProcesses ?? {})
            .filter(([, t]) => !!t && t.trim())
            .map(([p, t]) => (Object.keys(m.thoughtProcesses ?? {}).length > 1 ? `[${p}]\n${t}` : t))
            .join('\n\n'),
        tools: (m.toolEvents ?? []).join('\n'),
        toolPayloads: (m.toolIds ?? []).filter(Boolean).join(' / '),
        actions: (m.toolActions ?? []).map(x => `${x.tool}${x.ok ? '' : ' (FAILED)'}`).join('\n'),
        entry: a?.entryPoints?.[0]?.price ?? '',
        stop: a?.stopLoss ?? '',
        targets: (a?.takeProfit ?? []).map(tp => tp.price).filter(Boolean).join(' / '),
        probability: typeof a?.probability === 'number' ? `${a.probability}%` : '',
        promptTokens: num(m.runStats?.promptTokens),
        completionTokens: num(m.runStats?.completionTokens),
        costUsd: num(m.runStats?.costUsd),
        skills: (m.injectedSkills ?? []).join(', '),
        images: m.images?.length ?? 0,
        planId: m.planId ?? '',
        error: m.error ?? '',
        // Verbatim rather than parsed: the transport decides its own shape, and a
        // reader that guesses at the fields silently drops them.
        wireAudit: m.wireAudit?.length ? JSON.stringify(m.wireAudit) : '',
    };
}

/** Every message of every conversation, oldest chat first — then the dock
 *  sessions that have no canonical thread and would otherwise never be exported.
 *  The caller passes ONLY those (a dock session that does have a `conversationId`
 *  is the same conversation, and listing it twice would double-count the file). */
const flattenChats = (conversations: Conversation[], dock: DockChatInput[] = []): MessageRecord[] => {
    const ordered = [...(conversations ?? [])].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const out: MessageRecord[] = [];
    for (const c of ordered) {
        const title = c.title?.trim() || 'Untitled chat';
        for (const m of c.messages ?? []) out.push(messageRecord(m, title, c.id, c.timestamp ?? Date.now()));
    }
    for (const c of [...(dock ?? [])].sort((a, b) => a.at - b.at)) {
        for (const e of c.entries ?? []) out.push(dockRecord(e, c));
    }
    return out;
};

export interface TranscriptExportSummary { chats: number; messages: number }

/** A chat that lives ONLY in the Chart AI dock.
 *
 *  One conversation has two homes, and `entriesForSession` merges them — but a
 *  dock session with no `conversationId` has NO counterpart: it is a chart-side
 *  session of its own, with its own tool rounds and key levels. Exporting only
 *  the profile's conversations would therefore drop real messages while the
 *  button said "every stored message", so the caller passes these too.
 *
 *  A structural input rather than an import of `chatSessions`, on purpose: this
 *  module is a util and must not start depending on a service to render a file. */
export interface DockEntryInput {
    at?: number;
    role: string;
    speaker?: string;
    text: string;
    reasoning?: string;
    tools?: string[];
    toolIds?: string[];
    error?: string;
    image?: string;
    notice?: boolean;
    effort?: string;
    workedMs?: number;
    actions?: Array<{ tool: string; ok: boolean }>;
}

export interface DockChatInput {
    id: string;
    title: string;
    at: number;
    model?: string;
    entries: DockEntryInput[];
}

const dockRecord = (e: DockEntryInput, c: DockChatInput): MessageRecord => ({
    chat: c.title?.trim() || 'Untitled chat',
    chatId: c.id,
    at: c.at ? new Date(c.at).toISOString().replace('T', ' ').slice(0, 16) : '',
    role: e.notice ? 'notice' : e.role,
    speaker: e.speaker ?? '',
    // The session's model, not a per-message one: a dock entry does not record
    // which model answered it, and inventing a column that is really the chat's
    // setting would read as per-turn provenance.
    model: c.model ?? '',
    effort: e.effort ?? '',
    text: e.text ?? '',
    reasoning: e.reasoning ?? '',
    tools: (e.tools ?? []).join('\n'),
    toolPayloads: (e.toolIds ?? []).filter(Boolean).join(' / '),
    actions: (e.actions ?? []).map(x => `${x.tool}${x.ok ? '' : ' (FAILED)'}`).join('\n'),
    entry: '', stop: '', targets: '', probability: '',
    promptTokens: '', completionTokens: '',
    costUsd: '',
    skills: '',
    images: e.image ? 1 : 0,
    planId: '',
    error: e.error ?? '',
    wireAudit: '',
});

const TRANSCRIPT_COLUMNS: Array<keyof MessageRecord> = [
    'chat', 'chatId', 'at', 'role', 'speaker', 'model', 'effort', 'text', 'reasoning',
    'tools', 'toolPayloads', 'actions', 'entry', 'stop', 'targets', 'probability',
    'promptTokens', 'completionTokens', 'costUsd', 'skills', 'images', 'planId',
    'error', 'wireAudit',
];

/**
 * Export every stored message as CSV — one row per message, one column per
 * stored field, so a spreadsheet can filter by model, tier or chat the way the
 * journal export lets you filter by outcome.
 */
export const exportMessagesCSV = (conversations: Conversation[], dock: DockChatInput[] = []): TranscriptExportSummary => {
    const rows = flattenChats(conversations, dock);
    const header = TRANSCRIPT_COLUMNS.map(c => c.replace(/^([a-z])/, (_s, ch) => ch.toUpperCase()));
    const csv = [header, ...rows.map(r => TRANSCRIPT_COLUMNS.map(c => r[c]))]
        .map(line => line.map(csvCell).join(','))
        .join('\r\n');
    downloadBlob(csv, `august-messages-${dateStamp()}.csv`, 'text/csv;charset=utf-8;');
    return { chats: new Set(rows.map(r => r.chatId)).size, messages: rows.length };
};

/** A Markdown block quote, so a trace containing `#`, `-` or ``` cannot rewrite
 *  the document it is exported into. */
const quoted = (text: string): string =>
    text.split('\n').map(l => `> ${l}`).join('\n');

/**
 * Export every stored message as a Markdown transcript — readable in any editor,
 * diffable, and the format the reasoning actually survives in (a CSV cell of
 * 4,000 characters of thinking is technically present and practically dead).
 */
export const exportMessagesMarkdown = (conversations: Conversation[], dock: DockChatInput[] = []): TranscriptExportSummary => {
    const rows = flattenChats(conversations, dock);
    const byChat = new Map<string, MessageRecord[]>();
    for (const r of rows) {
        const list = byChat.get(r.chatId) ?? [];
        list.push(r);
        byChat.set(r.chatId, list);
    }
    const parts: string[] = [`# August — conversation export`, ``, `_${rows.length} messages across ${byChat.size} chats · exported ${new Date().toISOString()}_`, ``];
    for (const [chatId, list] of byChat) {
        parts.push(`## ${list[0].chat}`, ``, `_${list[0].at} · \`${chatId}\`_`, ``);
        for (const r of list) {
            const who = r.role === 'user' ? 'You' : (r.speaker || 'desk');
            const meta = [r.model, r.effort && `tier ${r.effort}`, r.error && 'FAILED']
                .filter(Boolean).join(' · ');
            parts.push(`### ${who}${meta ? ` — ${meta}` : ''}`, ``);
            if (r.text) parts.push(r.text, ``);
            if (r.images) parts.push(`_${r.images} image(s) attached — not included in this export; they live in the profile backup._`, ``);
            if (r.entry || r.stop || r.targets || r.probability) {
                parts.push(`**Plan** — entry ${r.entry || '—'} · stop ${r.stop || '—'} · targets ${r.targets || '—'} · probability ${r.probability || '—'}`, ``);
            }
            if (r.actions) parts.push(`**Side effects**`, ...r.actions.split('\n').map(l => `- ${l}`), ``);
            if (r.tools) {
                parts.push(`**Tool trail** (${r.tools.split('\n').length} lines)`, ...r.tools.split('\n').map(l => `- ${l}`), ``);
            }
            if (r.reasoning) parts.push(`<details><summary>Reasoning (${r.reasoning.length} chars)</summary>`, ``, quoted(r.reasoning), ``, `</details>`, ``);
            if (r.wireAudit) parts.push(`<details><summary>Wire audit</summary>`, ``, quoted(r.wireAudit), ``, `</details>`, ``);
            if (r.skills) parts.push(`_Skills shown to the model: ${r.skills}_`, ``);
            if (r.promptTokens || r.costUsd) {
                parts.push(`_${[r.promptTokens && `prompt ${r.promptTokens}`, r.completionTokens && `completion ${r.completionTokens}`, r.costUsd && `cost $${r.costUsd}`].filter(Boolean).join(' · ')}_`, ``);
            }
        }
    }
    downloadBlob(parts.join('\n'), `august-messages-${dateStamp()}.md`, 'text/markdown;charset=utf-8;');
    return { chats: byChat.size, messages: rows.length };
};
