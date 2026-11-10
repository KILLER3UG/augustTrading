/**
 * chartIndicatorSettings — per-user chart indicator visibility and parameters.
 *
 * The reference defaults are the six studies OKX shows out of the box: Volume,
 * EMA(20), EMA(200), BOLL, RSI(14), MACD. Everything else August can draw
 * (TSI, VWAP, volume profile, session levels, swings, CVD, funding/OI) starts
 * OFF until the trader toggles it — a chart that opens with fifteen studies is
 * not a chart, it is a spreadsheet.
 *
 * The series themselves come from `chartIndicators.ts`, the ONE module the
 * chart and the prompt both read. This file only stores which of them are
 * visible, so the settings can never change a number.
 */

export type ChartIndicatorId =
    | 'volume'
    | 'ema20'
    | 'ema200'
    | 'boll'
    | 'rsi'
    | 'macd'
    | 'tsi'
    | 'vwap'
    | 'avwap'
    | 'volumeProfile'
    | 'sessionLevels'
    | 'swings'
    | 'cvd'
    | 'funding';

export interface ChartIndicatorSettings {
    /** Visibility only. Parameters are pinned in `chartIndicators.ts` so the
     *  chart and the prompt cannot disagree about what "EMA20" means. */
    visible: Record<ChartIndicatorId, boolean>;
}

export const CHART_INDICATOR_IDS = [
    'volume', 'ema20', 'ema200', 'boll', 'rsi', 'macd',
    'tsi', 'vwap', 'avwap', 'volumeProfile', 'sessionLevels', 'swings', 'cvd', 'funding',
] as const satisfies readonly ChartIndicatorId[];

/** OKX's out-of-the-box set. */
export const DEFAULT_CHART_INDICATOR_SETTINGS: ChartIndicatorSettings = {
    visible: {
        volume: true,
        ema20: true,
        ema200: true,
        boll: true,
        rsi: true,
        macd: true,
        tsi: false,
        vwap: false,
        avwap: false,
        volumeProfile: false,
        sessionLevels: false,
        swings: false,
        cvd: false,
        funding: false,
    },
};

const keyFor = (username: string): string => `chart_indicators_v1_${username}`;

/** What each study is called in the legend and the toggle menu. The names are
 *  OKX's, so the trader's vocabulary and the chart's agree. */
export const CHART_INDICATOR_LABELS: Record<ChartIndicatorId, string> = {
    volume: 'Volume',
    ema20: 'EMA(20)',
    ema200: 'EMA(200)',
    boll: 'BOLL(20, 2)',
    rsi: 'RSI(14)',
    macd: 'MACD(12, 26, 9)',
    tsi: 'TSI(25, 13, 13)',
    vwap: 'VWAP (session)',
    avwap: 'Anchored VWAP (Alt+click to anchor)',
    volumeProfile: 'Volume profile',
    sessionLevels: 'Session levels',
    swings: 'Swings / BOS',
    cvd: 'CVD',
    funding: 'Funding & OI',
};

/** Studies that need their own pane. They are listed and can be toggled now,
 *  but the pane itself lands with the sub-pane step — the toggle persists the
 *  choice so nothing is lost when the pane arrives. */
export const CHART_INDICATOR_PANE: Partial<Record<ChartIndicatorId, 'main' | 'sub'>> = {
    ema20: 'main',
    ema200: 'main',
    boll: 'main',
    rsi: 'sub',
    macd: 'sub',
    tsi: 'sub',
    vwap: 'main',
    avwap: 'main',
    volumeProfile: 'sub',
    cvd: 'sub',
    funding: 'sub',
};

/** Read the trader's chart settings, falling back to the OKX default set.
 *  A malformed or partial blob never yields a half-initialised chart: unknown
 *  ids are dropped and missing ids take the default. */
export const readChartIndicatorSettings = (username: string): ChartIndicatorSettings => {
    try {
        const raw = localStorage.getItem(keyFor(username));
        if (!raw) return DEFAULT_CHART_INDICATOR_SETTINGS;
        const parsed: unknown = JSON.parse(raw);
        const incoming = (parsed as { visible?: Record<string, unknown> } | null)?.visible;
        if (!incoming || typeof incoming !== 'object') return DEFAULT_CHART_INDICATOR_SETTINGS;
        const visible = { ...DEFAULT_CHART_INDICATOR_SETTINGS.visible };
        for (const id of CHART_INDICATOR_IDS) {
            const v = incoming[id];
            if (typeof v === 'boolean') visible[id] = v;
        }
        return { visible };
    } catch {
        return DEFAULT_CHART_INDICATOR_SETTINGS;
    }
};

export const writeChartIndicatorSettings = (username: string, settings: ChartIndicatorSettings): void => {
    try { localStorage.setItem(keyFor(username), JSON.stringify(settings)); } catch { /* private mode */ }
};
