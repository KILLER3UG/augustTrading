import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../src/services/providers/GenericProviderService';
import {
    compactMessages,
    DEFAULT_MAX_HISTORY_IMAGES,
    IMAGE_PRUNE_STUB,
    pruneHistoryImages,
} from '../src/services/providers/contextCompact';
import {
    computeSnapshotDimensions,
    DEFAULT_SNAPSHOT_MIME,
    DEFAULT_SNAPSHOT_QUALITY,
    MAX_SNAPSHOT_HEIGHT,
    MAX_SNAPSHOT_WIDTH,
} from '../src/services/trade/chartSnapshotAnnotator';
import { drawingsFromLevelTool } from '../src/services/trade/chartDrawings';
import { __resetShortIdCountersForTests } from '../src/services/trade/chartGeometry';
import {
    executeDeskTool,
    normalizePriceSnapshotInterval,
    PRICE_SNAPSHOT_INTERVALS,
} from '../src/services/analysis/DeskToolsService';
import type { ChartSnapshot } from '../src/components/trade/TradingChart';

const makeImageTurn = (label: string, idx: number): ChatMessage => ({
    role: 'user',
    content: [
        { type: 'text', text: label },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,IMG_${idx}` } },
    ],
});

describe('contextCompact — bounded history image pruning', () => {
    it('retains only the newest 2 image_url parts and stubs older images while keeping text intact', () => {
        const history: ChatMessage[] = [
            { role: 'system', content: 'Static system prompt' },
            makeImageTurn('Turn 1 question', 1),
            { role: 'assistant', content: 'Reply 1' },
            makeImageTurn('Turn 2 question', 2),
            { role: 'assistant', content: 'Reply 2' },
            makeImageTurn('Turn 3 question', 3),
            { role: 'assistant', content: 'Reply 3' },
            makeImageTurn('Turn 4 question', 4),
            { role: 'assistant', content: 'Reply 4' },
            makeImageTurn('Turn 5 question', 5),
        ];

        assert.equal(DEFAULT_MAX_HISTORY_IMAGES, 2);
        const { messages, prunedCount, prunedMessageIndices } = pruneHistoryImages(history);
        assert.equal(prunedCount, 3);
        assert.deepEqual(prunedMessageIndices, [1, 3, 5]);

        const countImages = (m: ChatMessage): number =>
            Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').length : 0;

        // Oldest 3 turns had images replaced with the compact stub; text preserved.
        for (const idx of [1, 3, 5]) {
            assert.equal(countImages(messages[idx]), 0);
            const parts = messages[idx].content as Array<{ type: string; text?: string }>;
            assert.equal(parts[0].text, (history[idx].content as Array<{ text?: string }>)[0].text);
            assert.equal(parts[1].type, 'text');
            assert.equal(parts[1].text, IMAGE_PRUNE_STUB);
        }

        // Newest 2 turns retain their images verbatim.
        assert.equal(countImages(messages[7]), 1);
        assert.equal(countImages(messages[9]), 1);
    });

    it('runs Pass 0 image pruning inside compactMessages even under a generous token ceiling', () => {
        const history: ChatMessage[] = [
            { role: 'system', content: 'System' },
            makeImageTurn('t1', 1),
            { role: 'assistant', content: 'a1' },
            makeImageTurn('t2', 2),
            { role: 'assistant', content: 'a2' },
            makeImageTurn('t3', 3),
        ];

        const compacted = compactMessages({ messages: history, ceilingTokens: 100_000 });
        assert.equal(compacted.changed, true);
        assert.equal(compacted.actions.some(a => a.kind === 'image-prune'), true);
        const totalImagesAfter = compacted.messages.reduce(
            (sum, m) => sum + (Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').length : 0),
            0,
        );
        assert.equal(totalImagesAfter, 2);

        // <= 2 images: untouched when well below ceiling.
        const twoImageHistory = history.slice(0, 4);
        const untouched = compactMessages({ messages: twoImageHistory, ceilingTokens: 100_000 });
        assert.equal(untouched.changed, false);
    });
});

describe('chartSnapshotAnnotator — bounded JPEG defaults & scaling', () => {
    it('defaults to image/jpeg at 0.85 quality and scales to <= 1280x720 without upscaling', () => {
        assert.equal(DEFAULT_SNAPSHOT_MIME, 'image/jpeg');
        assert.equal(DEFAULT_SNAPSHOT_QUALITY, 0.85);
        assert.equal(MAX_SNAPSHOT_WIDTH, 1280);
        assert.equal(MAX_SNAPSHOT_HEIGHT, 720);

        const uhd = computeSnapshotDimensions(2560, 1440);
        assert.equal(uhd.width, 1280);
        assert.equal(uhd.height, 720);

        const fourThree = computeSnapshotDimensions(1600, 1200);
        assert.equal(fourThree.width, 960);
        assert.equal(fourThree.height, 720);

        const small = computeSnapshotDimensions(800, 450);
        assert.equal(small.width, 800);
        assert.equal(small.height, 450);
        assert.equal(small.scale, 1);
    });
});

describe('chartDrawings — deterministic mark_trade_levels bracket validation', () => {
    beforeEach(() => {
        __resetShortIdCountersForTests();
    });

    it('rejects inverted Long/Short brackets, equal levels, and same-side SL/TP', () => {
        // Inverted Long: SL above entry
        const invLongSl = drawingsFromLevelTool({ direction: 'Long', entry: 100, stopLoss: 105, takeProfits: [110] });
        assert.equal(invLongSl.drawings.length, 0);
        assert.match(invLongSl.error ?? '', /inverted Long/i);

        // Inverted Long: TP below entry
        const invLongTp = drawingsFromLevelTool({ direction: 'Long', entry: 100, stopLoss: 95, takeProfits: [90] });
        assert.equal(invLongTp.drawings.length, 0);
        assert.match(invLongTp.error ?? '', /inverted Long/i);

        // Inverted Short: SL below entry
        const invShortSl = drawingsFromLevelTool({ direction: 'Short', entry: 100, stopLoss: 95, takeProfits: [90] });
        assert.equal(invShortSl.drawings.length, 0);
        assert.match(invShortSl.error ?? '', /inverted Short/i);

        // Inverted Short: TP above entry
        const invShortTp = drawingsFromLevelTool({ direction: 'Short', entry: 100, stopLoss: 105, takeProfits: [110] });
        assert.equal(invShortTp.drawings.length, 0);
        assert.match(invShortTp.error ?? '', /inverted Short/i);

        // Inferred direction (no direction field): SL < entry implies Long, so TP < entry must be rejected
        const sameSide = drawingsFromLevelTool({ entry: 100, stopLoss: 95, takeProfits: [92] });
        assert.equal(sameSide.drawings.length, 0);
        assert.ok(sameSide.error);

        // SL === entry or TP === entry
        assert.match(drawingsFromLevelTool({ entry: 100, stopLoss: 100, takeProfits: [110] }).error ?? '', /cannot equal entry/i);
        assert.match(drawingsFromLevelTool({ entry: 100, stopLoss: 95, takeProfits: [100] }).error ?? '', /cannot equal entry/i);
    });

    it('accepts valid Long & Short brackets and stamps agent origin + monotonic shortIds', () => {
        const longRes = drawingsFromLevelTool(
            { direction: 'Long', entry: 100, stopLoss: 95, takeProfits: [110, 120] },
            { symbol: 'BTCUSDT', interval: '15m' },
        );
        assert.equal(longRes.error, undefined);
        assert.equal(longRes.drawings.length, 4);
        assert.deepEqual(
            longRes.drawings.map(d => d.shortId),
            ['#D1', '#D2', '#D3', '#D4'],
        );
        assert.ok(longRes.drawings.every(d => d.origin === 'agent' && d.createdOnTf === '15m' && d.version === 1));

        const shortRes = drawingsFromLevelTool(
            { direction: 'Short', entry: 100, stopLoss: 105, takeProfits: [90] },
            { symbol: 'BTCUSDT', interval: '15m', existing: longRes.drawings },
        );
        assert.equal(shortRes.error, undefined);
        assert.deepEqual(
            shortRes.drawings.map(d => d.shortId),
            ['#D5', '#D6', '#D7'],
        );
    });
});

describe('DeskToolsService — get_chart_view short-circuit & get_price_snapshot interval guard', () => {
    it('short-circuits get_chart_view on matching if_revision with fresh mark and zero network fetch', async () => {
        const originalFetch = globalThis.fetch;
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            throw new Error('network should not be called on revision short-circuit');
        }) as typeof fetch;

        try {
            const snap: ChartSnapshot = {
                symbol: 'BTCUSDT',
                interval: '15m',
                candles: [
                    { time: 1_700_000_000, open: 68_000, high: 68_150, low: 67_950, close: 68_100 },
                    { time: 1_700_000_900, open: 68_100, high: 68_220, low: 68_080, close: 68_200 },
                ],
                markPrice: 68_215,
                levels: [],
                drawings: [],
                modelDrawings: [],
                priceScaleMode: 'normal',
                activeStudies: { 'EMA 20': 68_010 },
                revision: 'rev-1234abcd',
                atr14: 180,
                capturedAt: Date.now(),
            };

            const res = await executeDeskTool(
                { id: 'tc-1', name: 'get_chart_view', arguments: { if_revision: 'rev-1234abcd' } },
                {
                    defaultSymbol: 'BTCUSDT',
                    allowedTools: 'all',
                    getChartSnapshot: () => snap,
                    getLiveMarkPrice: () => 68_240.5,
                    getFormingCandle: () => ({
                        time: 1_700_000_900,
                        open: 68_100,
                        high: 68_250,
                        low: 68_080,
                        close: 68_240.5,
                    }),
                },
            );

            assert.equal(fetchCalls, 0);
            assert.equal(res.ok, true);
            const payload = JSON.parse(res.content) as Record<string, unknown>;
            assert.equal(payload.unchanged, true);
            assert.equal(payload.revision, 'rev-1234abcd');
            assert.equal(payload.symbol, 'BTCUSDT');
            assert.equal(payload.interval, '15m');
            assert.equal(payload.liveMark, 68_240.5);
            assert.ok(payload.formingCandle && typeof payload.formingCandle === 'object');
            assert.equal(typeof payload.checkedAt, 'string');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('rejects unsupported get_price_snapshot intervals explicitly without coercing or calling network', async () => {
        assert.equal(normalizePriceSnapshotInterval('1D'), '1d');
        assert.equal(normalizePriceSnapshotInterval('15m'), '15m');
        assert.equal(normalizePriceSnapshotInterval('7m'), null);
        assert.ok(PRICE_SNAPSHOT_INTERVALS.includes('4h'));

        const originalFetch = globalThis.fetch;
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            throw new Error('network should not be called for invalid interval');
        }) as typeof fetch;

        try {
            const res = await executeDeskTool(
                { id: 'tc-2', name: 'get_price_snapshot', arguments: { symbol: 'BTCUSDT', interval: '7m' } },
                { defaultSymbol: 'BTCUSDT', allowedTools: 'all' },
            );
            assert.equal(fetchCalls, 0);
            assert.equal(res.ok, false);
            assert.match(res.content, /unsupported interval "7m"/i);
            assert.match(res.content, /15m/);
            assert.match(res.content, /1d/);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
