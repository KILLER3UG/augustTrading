/**
 * chatDisplay — the ONE place that cleans INTERNAL text out of what the
 * transcript SHOWS the trader.
 *
 * The model-facing conversation legitimately carries machine vocabulary:
 * the context-injection headers (`[LIVE CHART CONTEXT …]`, `[PRICE STAMP …]`,
 * `[LIVE CANDLE …]`, `[PRICES …]`, `[ON SCREEN …]`) and the harness's own
 * receipts (`[APPROVAL RECEIPT — the app, not the trader] …`, prefixed
 * `HARNESS NOTE (this app, not the trader):`). That vocabulary belongs in the
 * PAYLOAD — the seat needs it — but a mock/probe reply (or any transport that
 * echoes its input) must never paint it into the trader's transcript: a
 * bubble reading `[LIVE CHART CONTEXT — BTCUSDT · …]` is the app talking to
 * itself in the trader's face.
 *
 * So the RENDER path strips the markers here, once, instead of every
 * transcript surface re-deriving its own regex (the second implementation is
 * how the numbers — and the leaks — drift).
 */

/** Bracket groups that open with one of these markers are app-internal, at
 *  any position in the text. Bracket-matched, so the nested `[ON SCREEN]`
 *  inside a `[PRICES …]` block does not cut the removal short. */
const INTERNAL_MARK_STARTERS: readonly string[] = [
    '[LIVE CHART CONTEXT',
    '[PRICE STAMP',
    '[LIVE CANDLE',
    '[PRICES',
    '[ON SCREEN',
    '[APPROVAL RECEIPT',
    '[HARNESS',
];

/** The harness-notice voice (utils/harnessMarks.ts HARNESS_TURN_MARK), in the
 *  casings it reaches the transcript in (the amber row uppercased it). */
const HARNESS_MARK_RE = /^harness note \(this app, not the trader\):\s*/i;

/** Remove the app's internal bracket groups from displayed text. */
export const stripInternalContextMarks = (text: string): string => {
    if (!text || text.indexOf('[') === -1) return text;
    let out = '';
    let i = 0;
    while (i < text.length) {
        if (text[i] === '[') {
            const rest = text.slice(i);
            const marker = INTERNAL_MARK_STARTERS.find(m => rest.startsWith(m));
            if (marker) {
                // Skip to THIS group's matching close bracket.
                let depth = 0;
                let j = i;
                for (; j < text.length; j += 1) {
                    if (text[j] === '[') depth += 1;
                    else if (text[j] === ']') {
                        depth -= 1;
                        if (depth === 0) break;
                    }
                }
                i = j + 1;
                if (text[i] === ' ') i += 1; // one seam space, not two
                continue;
            }
        }
        out += text[i];
        i += 1;
    }
    return out.replace(/ {2,}/g, ' ').trim();
};

/** Clean a harness notice line for the transcript: the machine voice and the
 *  leading tags come out, the human sentence stays. A persisted notice (or a
 *  signal text that reached the row whole) still reads as one quiet line.
 *  The two APPROVAL receipts collapse to the trader's own receipt line — the
 *  card already carries the resolved state; the row only confirms it. */
export const harnessNoticeDisplay = (raw: string): string => {
    let out = (raw ?? '').trim();
    out = out.replace(HARNESS_MARK_RE, '');
    // A leading machine tag (`[APPROVAL RECEIPT — the app, not the trader]`)
    // duplicates the mark the line already carried; the sentence after it is
    // the trader-facing content.
    out = out.replace(/^\[[^\]]*\]\s*/, '');
    out = out.replace(/^⚡\s*/, '');
    const cleaned = stripInternalContextMarks(out);
    if (/the trader approved your plan/i.test(cleaned)) return 'Plan approved — logged & monitoring';
    if (/undid the approval|approval undone/i.test(cleaned)) return 'Plan approval undone';
    return cleaned;
};
