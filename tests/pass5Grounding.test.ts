/**
 * Pass 5 — market grounding on ordinary Chat turns.
 *
 * RED harness: an ordinary Chat turn answered a "Scan top USDT futures setups"
 * request from model memory (0 tool calls) and fabricated a 30-coin scan with
 * AEROUSDT entry/SL/TP/RSI and a "Scan complete" claim. These tests pin the
 * BEHAVIOUR of the fix: intent detection, requireTools resolution, mandate
 * injection, and the post-turn ungrounded notice. No source-string regexes —
 * every assertion calls a function and checks what it returns.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    promptNeedsMarketGrounding,
    shouldRequireTools,
    applyGroundingMandate,
    looksLikeUngroundedMarketClaim,
    groundingNotice,
    surfacePromptWith,
    FULL_ANALYSIS_MANDATE,
    FULL_ANALYSIS_NOTHING_LOOKED_UP_NOTICE,
    UNGROUNDED_CLAIM_NOTICE,
} from '../src/services/trade/chatSurfaceTurn';
import { isHarnessNoticeLine } from '../src/utils/turnStatus';
import { getRecentMemoryInjections } from '../src/services/learning/MemoryInjectionService';

describe('pass 5 — market grounding classification', () => {
    it('flags a live-scan request and forces requireTools without the Full analysis button', () => {
        const prompt = 'Scan top USDT futures setups';
        assert.equal(promptNeedsMarketGrounding(prompt), true);
        assert.equal(shouldRequireTools(prompt, false), true);
        assert.equal(shouldRequireTools(prompt, true), true);
    });

    it('flags screener / current price / RSI requests but not greetings or opinions', () => {
        for (const p of [
            'run a screener for momentum',
            'what is the current price of SOL?',
            'give me the RSI on BTC',
            'check the order book for ETH',
        ]) {
            assert.equal(promptNeedsMarketGrounding(p), true, p);
        }
        for (const p of [
            'hello',
            'how was your day?',
            'what do you think about the market?',
            'share your thoughts on risk management',
        ]) {
            assert.equal(promptNeedsMarketGrounding(p), false, p);
        }
    });

    it('does not set requireTools for a greeting; an explicit press still wins', () => {
        assert.equal(shouldRequireTools('hello', false), false);
        assert.equal(shouldRequireTools('hello', true), true);
    });

    it('injects the FULL ANALYSIS mandate only when requireTools is set', () => {
        const based = 'You are the trading desk seat.';
        const withMandate = applyGroundingMandate(based, true);
        assert.ok(withMandate.includes(FULL_ANALYSIS_MANDATE));
        assert.ok(withMandate.includes('FULL ANALYSIS REQUESTED'));
        assert.ok(withMandate.includes('Call the market tools'));
        assert.equal(applyGroundingMandate(based, false), based);
    });
});

describe('pass 5 — ungrounded claim detection and post-turn notice', () => {
    const scanAnswer =
        'Scan complete — 27 June 2026. AEROUSDT entry 0.8421, SL 0.8100, TP 0.9100, RSI 68. 30 coins scanned.';

    it('recognises a fabricated scan answer as a live-market claim but not conversation', () => {
        assert.equal(looksLikeUngroundedMarketClaim(scanAnswer), true);
        assert.equal(looksLikeUngroundedMarketClaim('hello there'), false);
        assert.equal(looksLikeUngroundedMarketClaim('I think the market is choppy today'), false);
    });

    it('flags a fabricated 0-tool scan as ungrounded', () => {
        const notice = groundingNotice({
            fullAnalysis: false,
            requireTools: true,
            sawMarketTool: false,
            interrupted: false,
            answer: scanAnswer,
        });
        assert.ok(notice, 'expected a notice for a fabricated 0-tool scan');
        assert.match(notice as string, /UNGROUNDED/i);
        assert.match(notice as string, /no market tool/i);
    });

    it('does NOT flag a legitimate tool-backed scan', () => {
        const notice = groundingNotice({
            fullAnalysis: false,
            requireTools: true,
            sawMarketTool: true,
            interrupted: false,
            answer: scanAnswer,
        });
        assert.equal(notice, null);
    });

    it('never flags a greeting or a non-fabricated opinion; keeps honest wording for Full analysis', () => {
        assert.equal(groundingNotice({
            fullAnalysis: false, requireTools: false, sawMarketTool: false,
            interrupted: false, answer: 'hello',
        }), null);

        assert.equal(groundingNotice({
            fullAnalysis: false, requireTools: true, sawMarketTool: false,
            interrupted: false, answer: 'In my opinion the market is choppy.',
        }), null);

        const full = groundingNotice({
            fullAnalysis: true, requireTools: true, sawMarketTool: false,
            interrupted: false, answer: 'I did not look anything up.',
        });
        assert.ok(full && full.includes(FULL_ANALYSIS_NOTHING_LOOKED_UP_NOTICE));
    });

    it('classifies UNGROUNDED_CLAIM_NOTICE as a harness notice and catches fabricated 0-tool claims regardless of trigger', () => {
        assert.equal(isHarnessNoticeLine(UNGROUNDED_CLAIM_NOTICE), true);
        const caught = groundingNotice({
            fullAnalysis: false,
            requireTools: false,
            sawMarketTool: false,
            interrupted: false,
            answer: scanAnswer,
        });
        assert.equal(caught, UNGROUNDED_CLAIM_NOTICE);
    });

    it('exposes only a compact index without pre-recording Turn 1 skills into MemoryInjectionService', async () => {
        const prompt = surfacePromptWith('You are a trading desk seat.', 'the trader asks', {
            matchText: 'hello',
            record: { coin: 'BTCUSDT' },
        });
        assert.equal(prompt.text.includes('## Procedure'), false, 'never pre-load full skill bodies into Turn 1 system prompt');
        const records = await getRecentMemoryInjections('default');
        assert.equal(records.length, 0, 'Turn 1 "hello" must record zero pre-loaded MEMORY skill entries');
    });
});
