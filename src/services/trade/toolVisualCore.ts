/**
 * toolVisualCore — pure, DOM-free parsers & formatters for:
 *   1. Deterministic Inline Interactive Tool Visualizers (`scout_market`,
 *      `spot_vs_perp`, `setup_replay`) rendered from `toolPayloadStore` payloads.
 *   2. Descriptive collapsed work summary lines in `ChatWorkTimeline`.
 *   3. Live mark drift & SL-breach guard math for `TradeProposalCard`.
 *   4. Back/Forward session navigation history stack.
 *
 * Zero React, DOM, `window`, `localStorage`, or network imports (`check:boundaries`).
 */

export interface ScoutVisualRow {
    symbol: string;
    score: number;
    regimeLabel: string;
    flowRegime: string;
    basisBps: number | null;
    divergence: string | null;
    timedOut?: boolean;
    summaryLine: string;
}

export interface ScoutVisualModel {
    kind: 'scout_market';
    toolCallId: string;
    title: string;
    intervals: string[];
    items: ScoutVisualRow[];
    summary: string;
    rawText: string;
}

export interface SpotVsPerpVisualModel {
    kind: 'spot_vs_perp';
    toolCallId: string;
    symbol: string;
    interval: string;
    spotAvailable: boolean;
    spotDeltaSharePct: number;
    perpDeltaSharePct: number;
    spotCvd: number | null;
    perpCvd: number | null;
    basisBps: number | null;
    fundingRatePct: number | null;
    regime: string;
    summary: string;
    rawText: string;
}

export interface SetupReplayOutcomeBar {
    label: string;
    r: number;
    outcome: 'win' | 'loss' | 'timeout';
}

export interface SetupReplayVisualModel {
    kind: 'setup_replay';
    toolCallId: string;
    symbol: string;
    interval: string;
    setup: string;
    totalTrades: number;
    wins: number;
    losses: number;
    timeouts: number;
    winRatePct: number;
    expectancyR: number;
    netR: number;
    outcomes: SetupReplayOutcomeBar[];
    summary: string;
    rawText: string;
}

export type ToolVisualModel =
    | ScoutVisualModel
    | SpotVsPerpVisualModel
    | SetupReplayVisualModel;

const numOrNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

const parseJsonSafe = (text: string): Record<string, unknown> | null => {
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
};

/** Parse numbered brief lines from `scout_market` compact payload. */
const parseScoutBriefLines = (brief: string): ScoutVisualRow[] => {
    const out: ScoutVisualRow[] = [];
    const lines = brief.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
        const m = /^\d+\.\s+([A-Z0-9]+)\s+\((-?\d+(?:\.\d+)?)\)\s*·\s*(.+)$/.exec(line);
        if (!m) continue;
        const symbol = m[1];
        const score = Number(m[2]);
        const rest = m[3];
        const parts = rest.split('·').map(p => p.trim()).filter(Boolean);
        let regimeLabel = parts[0] || 'n/a';
        let flowRegime = 'neutral';
        let basisBps: number | null = null;
        let divergence: string | null = null;
        let timedOut = false;

        for (const p of parts) {
            if (p.startsWith('flow=')) {
                flowRegime = p.slice(5).trim();
            } else if (p.startsWith('basis=')) {
                const bm = /(-?\d+(?:\.\d+)?)\s*bps/i.exec(p);
                if (bm) basisBps = Number(bm[1]);
            } else if (p === 'TIMEOUT') {
                timedOut = true;
            } else if (p !== parts[0]) {
                divergence = p;
            }
        }
        if (regimeLabel.startsWith('flow=')) regimeLabel = 'n/a';

        out.push({
            symbol,
            score: Number.isFinite(score) ? score : 0,
            regimeLabel,
            flowRegime,
            basisBps,
            divergence,
            timedOut,
            summaryLine: line,
        });
    }
    return out;
};

export const parseScoutVisual = (toolCallId: string, rawText: string): ScoutVisualModel | null => {
    const obj = parseJsonSafe(rawText);
    if (!obj) return null;
    const intervals = Array.isArray(obj.intervalsUsed)
        ? obj.intervalsUsed.filter((x): x is string => typeof x === 'string')
        : [];
    const brief = typeof obj.brief === 'string' ? obj.brief : '';
    let items: ScoutVisualRow[] = [];

    if (Array.isArray(obj.ranked) && obj.ranked.length > 0) {
        items = obj.ranked
            .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
            .map(r => {
                const sym = String(r.symbol ?? '');
                const regimesObj = r.regimes && typeof r.regimes === 'object'
                    ? (r.regimes as Record<string, unknown>)
                    : {};
                const regStr = Object.entries(regimesObj).map(([k, v]) => `${k}=${String(v)}`).join(', ') || 'n/a';
                const flow = typeof r.spotPerpRegime === 'string' ? r.spotPerpRegime : 'neutral';
                const basis = numOrNull(r.basisBps);
                const score = numOrNull(r.score) ?? 0;
                const div = typeof r.topDivergence === 'string' ? r.topDivergence : null;
                return {
                    symbol: sym,
                    score,
                    regimeLabel: regStr,
                    flowRegime: flow,
                    basisBps: basis,
                    divergence: div,
                    timedOut: r.timedOut === true,
                    summaryLine: `${sym} (${score}) · ${regStr} · flow=${flow}${basis !== null ? ` · basis=${basis.toFixed(1)}bps` : ''}`,
                };
            })
            .filter(r => r.symbol.length > 0);
    } else if (brief) {
        items = parseScoutBriefLines(brief);
    }

    if (items.length === 0) return null;
    return {
        kind: 'scout_market',
        toolCallId,
        title: `Market Scout${intervals.length > 0 ? ` · ${intervals.join(' / ')}` : ''}`,
        intervals,
        items,
        summary: brief || items.map(i => i.summaryLine).join('\n'),
        rawText,
    };
};

export const parseSpotVsPerpVisual = (toolCallId: string, rawText: string): SpotVsPerpVisualModel | null => {
    const obj = parseJsonSafe(rawText);
    if (!obj) return null;
    const symbol = typeof obj.symbol === 'string' ? obj.symbol.toUpperCase() : '';
    if (!symbol) return null;
    const interval = typeof obj.interval === 'string' ? obj.interval : '15m';
    const spotAvailable = obj.spotAvailable !== false;
    const spotShare = numOrNull(obj.spotDeltaShare);
    const perpShare = numOrNull(obj.perpDeltaShare);
    const spotCvd = numOrNull(obj.spotCvd);
    const perpCvd = numOrNull(obj.perpCvd);
    const basisBps = numOrNull(obj.basisBps);
    const fundingRate = numOrNull(obj.fundingRate);
    const regime = typeof obj.regime === 'string' ? obj.regime : 'neutral';
    const summary = typeof obj.summary === 'string'
        ? obj.summary
        : `${symbol} ${interval} · ${regime} · basis ${basisBps !== null ? `${basisBps.toFixed(1)}bps` : 'n/a'}`;

    return {
        kind: 'spot_vs_perp',
        toolCallId,
        symbol,
        interval,
        spotAvailable,
        spotDeltaSharePct: spotShare !== null ? Math.round(spotShare * 1000) / 10 : 0,
        perpDeltaSharePct: perpShare !== null ? Math.round(perpShare * 1000) / 10 : 0,
        spotCvd,
        perpCvd,
        basisBps,
        fundingRatePct: fundingRate !== null ? Math.round(fundingRate * 10000) / 100 : null,
        regime,
        summary,
        rawText,
    };
};

export const parseSetupReplayVisual = (toolCallId: string, rawText: string): SetupReplayVisualModel | null => {
    const obj = parseJsonSafe(rawText);
    if (!obj) return null;
    const symbol = typeof obj.symbol === 'string' ? obj.symbol.toUpperCase() : '';
    const stats = (obj.stats && typeof obj.stats === 'object' ? obj.stats : obj) as Record<string, unknown>;
    const total = numOrNull(stats.totalTrades ?? stats.trades ?? stats.count ?? stats.signals ?? stats.n);
    if (!symbol || total === null || total <= 0) return null;

    const wins = numOrNull(stats.wins) ?? 0;
    const losses = numOrNull(stats.losses) ?? 0;
    const timeouts = numOrNull(stats.timeouts ?? stats.expired ?? stats.flat) ?? Math.max(0, total - wins - losses);
    const winRateRaw = numOrNull(stats.winRatePct ?? stats.winRate);
    const winRatePct = winRateRaw !== null
        ? (winRateRaw <= 1 ? Math.round(winRateRaw * 1000) / 10 : Math.round(winRateRaw * 10) / 10)
        : Math.round((wins / total) * 1000) / 10;
    const expectancyR = numOrNull(stats.expectancyR ?? stats.avgR) ?? 0;
    const netR = numOrNull(stats.netR ?? stats.totalR) ?? Math.round(expectancyR * total * 100) / 100;
    const interval = typeof obj.interval === 'string' ? obj.interval : '1h';
    const setup = typeof obj.setup === 'string' ? obj.setup : (typeof obj.setupName === 'string' ? obj.setupName : 'Setup replay');

    const rawList = Array.isArray(obj.samples)
        ? obj.samples
        : Array.isArray(obj.outcomes)
            ? obj.outcomes
            : Array.isArray(obj.trades)
                ? obj.trades
                : [];
    const outcomes: SetupReplayOutcomeBar[] = rawList
        .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
        .slice(0, 12)
        .map((x, idx) => {
            const rVal = numOrNull(x.r ?? x.rMultiple ?? x.pnlR) ?? 0;
            const outRaw = String(x.outcome ?? x.result ?? '').toLowerCase();
            const outcome: 'win' | 'loss' | 'timeout' =
                outRaw.includes('win') || rVal > 0 ? 'win'
                    : outRaw.includes('loss') || rVal < 0 ? 'loss'
                        : 'timeout';
            return {
                label: typeof x.label === 'string' ? x.label : `#${idx + 1}`,
                r: Math.round(rVal * 100) / 100,
                outcome,
            };
        });

    if (outcomes.length === 0) {
        if (wins > 0) outcomes.push({ label: `${wins} Wins`, r: Math.max(0.1, netR > 0 ? netR : wins), outcome: 'win' });
        if (losses > 0) outcomes.push({ label: `${losses} Losses`, r: -losses, outcome: 'loss' });
        if (timeouts > 0) outcomes.push({ label: `${timeouts} Timeouts`, r: 0, outcome: 'timeout' });
    }

    const summary = typeof obj.summary === 'string'
        ? obj.summary
        : `${symbol} ${interval} ${setup} · ${wins}W/${losses}L (${winRatePct}% WR) · Exp ${expectancyR >= 0 ? '+' : ''}${expectancyR.toFixed(2)}R · Net ${netR >= 0 ? '+' : ''}${netR.toFixed(2)}R`;

    return {
        kind: 'setup_replay',
        toolCallId,
        symbol,
        interval,
        setup,
        totalTrades: total,
        wins,
        losses,
        timeouts,
        winRatePct,
        expectancyR: Math.round(expectancyR * 100) / 100,
        netR: Math.round(netR * 100) / 100,
        outcomes,
        summary,
        rawText,
    };
};

export const parseToolVisualsFromPayloads = (
    payloads: ReadonlyArray<{ toolCallId: string; name: string; text: string }>,
): ToolVisualModel[] => {
    const out: ToolVisualModel[] = [];
    for (const p of payloads) {
        if (!p.text) continue;
        if (p.name === 'scout_market') {
            const v = parseScoutVisual(p.toolCallId, p.text);
            if (v) out.push(v);
        } else if (p.name === 'spot_vs_perp') {
            const v = parseSpotVsPerpVisual(p.toolCallId, p.text);
            if (v) out.push(v);
        } else if (p.name === 'setup_replay') {
            const v = parseSetupReplayVisual(p.toolCallId, p.text);
            if (v) out.push(v);
        }
    }
    return out;
};

// ─── Descriptive Collapsed Work Summary ──────────────────────────────────────

const friendlyToolPhrase = (rawLabel: string): string => {
    const lower = rawLabel.toLowerCase();
    if (lower.includes('spot_vs_perp') || lower.includes('spot vs')) return 'spot vs. perp CVD';
    if (lower.includes('scout_market') || lower.includes('market scout') || lower.includes('scout')) return 'multi-symbol scout';
    if (lower.includes('setup_replay') || lower.includes('replay')) return 'setup replay';
    if (lower.includes('present_trade') || lower.includes('math gate')) return 'math gate';
    if (lower.includes('market_packet') || lower.includes('market data') || lower.includes('get_chart_view') || lower.includes('structure')) return 'structure';
    if (lower.includes('order_book') || lower.includes('order book') || lower.includes('depth')) return 'order book';
    if (lower.includes('funding') || lower.includes('open_interest') || lower.includes('derivatives')) return 'funding & OI';
    if (lower.includes('divergence')) return 'divergences';
    if (lower.includes('regime')) return 'regime';
    if (lower.includes('volume_profile') || lower.includes('vpvr')) return 'volume profile';
    if (lower.includes('paper')) return 'paper broker';
    if (lower.includes('skill')) return 'playbooks';
    if (lower.includes('memory') || lower.includes('recall')) return 'memory';
    if (lower.includes('draw') || lower.includes('mark_trade')) return 'chart drawings';
    if (lower.includes('web_search') || lower.includes('news')) return 'catalysts';
    return rawLabel.replace(/_/g, ' ').trim();
};

/**
 * Turn completed tool call labels into a concise, human-readable 1-line
 * collapsed summary (e.g., `Checked BTC 15m structure, spot vs. perp CVD & math gate · 2s`).
 * Returns `null` when no tools ran so 0-tool turns keep `Thought for Ns`.
 */
export const buildDescriptiveWorkSummary = (
    pairedCalls: ReadonlyArray<{ label: string }>,
    opts?: { symbol?: string; interval?: string; seconds?: number | null },
): string | null => {
    if (pairedCalls.length === 0) return null;
    const unique: string[] = [];
    for (const c of pairedCalls) {
        const phrase = friendlyToolPhrase(c.label);
        if (phrase && !unique.includes(phrase)) unique.push(phrase);
    }
    if (unique.length === 0) return null;

    const shown = unique.slice(0, 3);
    const extra = unique.length - shown.length;
    let body: string;
    if (shown.length === 1) {
        body = shown[0];
    } else if (shown.length === 2 && extra === 0) {
        body = `${shown[0]} & ${shown[1]}`;
    } else if (extra === 0) {
        body = `${shown[0]}, ${shown[1]} & ${shown[2]}`;
    } else {
        body = `${shown.join(', ')} +${extra} more`;
    }

    const rawSym = (opts?.symbol ?? '').replace(/USDT$/i, '').trim().toUpperCase();
    const tf = (opts?.interval ?? '').trim();
    const prefix = rawSym && tf ? `Checked ${rawSym} ${tf} ` : rawSym ? `Checked ${rawSym} ` : 'Checked ';
    const sec = typeof opts?.seconds === 'number' && Number.isFinite(opts.seconds) && opts.seconds > 0
        ? ` · ${Math.round(opts.seconds)}s`
        : '';
    return `${prefix}${body}${sec}`;
};

// ─── Live Mark Drift & SL Breach Guard ───────────────────────────────────────

export interface ProposalLiveDrift {
    markPrice: number;
    driftPct: number;
    driftLabel: string;
    favorable: boolean;
    slBreached: boolean;
    tp1Reached: boolean;
}

export const computeProposalLiveDrift = (
    proposal: { direction: 'Long' | 'Short'; entry: number; stopLoss: number; takeProfits: number[] },
    markPrice: number | null | undefined,
): ProposalLiveDrift | null => {
    if (typeof markPrice !== 'number' || !Number.isFinite(markPrice) || markPrice <= 0) return null;
    if (!Number.isFinite(proposal.entry) || proposal.entry <= 0) return null;

    const driftPct = ((markPrice - proposal.entry) / proposal.entry) * 100;
    const isLong = proposal.direction === 'Long';
    const favorable = isLong ? driftPct >= 0 : driftPct <= 0;
    const slBreached = Number.isFinite(proposal.stopLoss) && proposal.stopLoss > 0
        ? (isLong ? markPrice <= proposal.stopLoss : markPrice >= proposal.stopLoss)
        : false;
    const tp1 = proposal.takeProfits[0];
    const tp1Reached = typeof tp1 === 'number' && Number.isFinite(tp1) && tp1 > 0
        ? (isLong ? markPrice >= tp1 : markPrice <= tp1)
        : false;
    const sign = driftPct > 0 ? '+' : '';
    const driftLabel = `${sign}${driftPct.toFixed(2)}% from entry`;

    return {
        markPrice,
        driftPct: Math.round(driftPct * 100) / 100,
        driftLabel,
        favorable,
        slBreached,
        tp1Reached,
    };
};

// ─── Back / Forward Session Navigation History Stack ─────────────────────────

export interface NavHistoryState {
    stack: string[];
    index: number;
}

export const createNavHistory = (initialId?: string | null): NavHistoryState =>
    initialId ? { stack: [initialId], index: 0 } : { stack: [], index: -1 };

export const pushNavHistory = (state: NavHistoryState, id: string, maxLen = 40): NavHistoryState => {
    const clean = id.trim();
    if (!clean) return state;
    if (state.index >= 0 && state.stack[state.index] === clean) return state;
    const base = state.index >= 0 ? state.stack.slice(0, state.index + 1) : [];
    const next = [...base, clean];
    const trimmed = next.length > maxLen ? next.slice(next.length - maxLen) : next;
    return { stack: trimmed, index: trimmed.length - 1 };
};

export const stepNavBack = (state: NavHistoryState): { next: NavHistoryState; targetId: string | null } => {
    if (state.index <= 0) return { next: state, targetId: null };
    const nextIdx = state.index - 1;
    return {
        next: { stack: state.stack, index: nextIdx },
        targetId: state.stack[nextIdx] ?? null,
    };
};

export const stepNavForward = (state: NavHistoryState): { next: NavHistoryState; targetId: string | null } => {
    if (state.index < 0 || state.index >= state.stack.length - 1) {
        return { next: state, targetId: null };
    }
    const nextIdx = state.index + 1;
    return {
        next: { stack: state.stack, index: nextIdx },
        targetId: state.stack[nextIdx] ?? null,
    };
};
