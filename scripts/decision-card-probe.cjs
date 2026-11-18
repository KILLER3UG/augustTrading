/**
 * decision-card-probe — drive the proposal DECISION CARD (Approve / Reject /
 * Ask-why / Undo) end to end in a real browser.
 *
 * WHY THIS EXISTS. Phase 3 turns the old "Track this trade" card into the
 * trader's decision surface: Approve logs through the gated human path and
 * queues an approval-receipt harness turn, Reject records a decline, Ask-why
 * pre-fills a pushback prompt, a stale plan needs a re-confirm, and a short
 * undo window reverses the whole approval. The pure logic is pinned by
 * check-contracts (staleness math, receipt dedupe, decline ledger, undo
 * window); this probe proves the RENDERED flows:
 *
 *   1. a presented plan renders the card; nothing logs until Approve;
 *   2. Ask-why pre-fills the composer with the pushback prompt;
 *   3. Approve writes ONE PENDING journal row, queues the APPROVAL RECEIPT
 *      harness turn, and opens the undo window — and a second Approve tap
 *      cannot log a second row;
 *   4. Undo inside the window deletes the row, removes the receipt (the
 *      APPROVAL UNDONE note reaches the thread) and puts the card back;
 *   5. a plan past its undo window settles into the logged row and cannot be
 *      approved twice;
 *   6. a STALE plan (mark far from the proposed entry) refuses a silent
 *      approval: the drift is printed and a re-confirm tap is required;
 *   7. Reject records the decline (HOLD ledger, source 'desk') with the
 *      card's optional reason.
 *
 *   node scripts/decision-card-probe.cjs   # self-hosts vite on 4187 + mock on 8791
 *
 * Exits non-zero on any failure. Companion to dock-card-probe (P-6); this is
 * the Phase 3 decision-card evidence.
 */

const { spawn } = require('child_process');
const { mkdirSync } = require('fs');
const net = require('net');
const path = require('path');
const { chromium } = require('@playwright/test');

const PORT = process.env.PROBE_PORT ? Number(process.env.PROBE_PORT) : 4187;
const MOCK_PORT = process.env.MOCK_PORT ? Number(process.env.MOCK_PORT) : 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The scripted present_trade calls, in the order the probe's turns fire.
// Entries sit FAR from any live mark with a huge stop distance, so the
// staleness rule (drift past half the stop distance) keeps them FRESH
// whatever the synthetic tape prints; PLAN_C is the deliberate STALE case
// (entry 100 with a 1-point stop: any real mark is miles past half the stop).
const PLAN_A = {
    symbol: 'BTCUSDT', direction: 'Long', entry: 84000, stopLoss: 1000,
    takeProfits: [200000], confidence: 'Low',
    rationale: 'Probe plan A — the approve / receipt / undo walk.',
    invalidation: 'A close below the probe stop.',
};
const PLAN_B = {
    symbol: 'BTCUSDT', direction: 'Long', entry: 84000, stopLoss: 1000,
    takeProfits: [200000], confidence: 'Low',
    rationale: 'Probe plan B — the double-approve and undo-lapse walk.',
    invalidation: 'A close below the probe stop.',
};
const PLAN_C = {
    symbol: 'BTCUSDT', direction: 'Long', entry: 100, stopLoss: 99.9,
    takeProfits: [130], confidence: 'Low',
    rationale: 'Probe plan C — deliberately stale against any live mark.',
    invalidation: 'A close above 130.',
};
const PLAN_D = {
    symbol: 'BTCUSDT', direction: 'Short', entry: 84000, stopLoss: 85000,
    takeProfits: [80000], confidence: 'Low',
    rationale: 'Probe plan D — the reject walk.',
    invalidation: 'A push above the probe stop.',
};
const PLAN_E = {
    symbol: 'BTCUSDT', direction: 'Long', entry: 84000, stopLoss: 1000,
    takeProfits: [200000], confidence: 'Low',
    rationale: 'Probe plan E — the session-guard walk.',
    invalidation: 'A close below the probe stop.',
};
// The risk-card walks: a TIGHTEN (one tap) and a LOOSEN (the explicit second
// tap), then a revert inside the window.
const RISK_TIGHTEN = {
    __tool: 'propose_risk_change', target: 'riskPercent', value: 0.5,
    reason: 'The range is tight; risk per trade comes down until it resolves.',
};
const RISK_LOOSEN = {
    __tool: 'propose_risk_change', target: 'riskPercent', value: 2,
    reason: 'The range resolved; risk per trade goes back up.',
};
// The session-guard walk: the agent PROPOSES the cap down to 1 (one tap, a
// tighten), the plan-E approve must then be REFUSED by the deterministic
// guard, and the only way back is the gated one — the agent proposes the cap
// up to 8 (two taps, a loosen) and the same approve now lands.
const GUARD_TIGHTEN = {
    __tool: 'propose_risk_change', target: 'guardMaxTradesPerDay', value: 1,
    reason: 'The tape is choppy; one attempt today, then a review.',
};
const GUARD_LOOSEN = {
    __tool: 'propose_risk_change', target: 'guardMaxTradesPerDay', value: 8,
    reason: 'The trader wants the session open; the cap goes back up explicitly.',
};
// The strategy walk: the model PROPOSES a draft plan (propose_strategy writes
// the notebook), then PROPOSES its activation — the card is the only writer.
const STRAT_PROPOSE = {
    __tool: 'propose_strategy', name: 'Probe Range Reclaim',
    entry: 'Reclaim of the daily range mid with a 15m close above it.',
    invalidation: 'A 15m close back below the range mid.',
    coin: 'BTCUSDT', direction: 'Long',
};
const STRAT_ACTIVATE = {
    __tool: 'propose_strategy_activation', slug: 'probe-range-reclaim', action: 'activate',
    reason: 'Its base rate cleared the bar; the seats should trade with it in context.',
};
// The evidence walk (UI audit bug 12): the card shape the probe had no
// capture for. The settlement correction targets a SEEDED row id (`pt-2`,
// above) — the executor refuses a hallucinated id, so the fixture must be
// real. (The stats card's evidence lives in parity-proof-probe, P-5.)
const SETTLEMENT_FIX = {
    __tool: 'correct_trade_outcome', tradeId: 'pt-2', outcome: 'WIN', pnlPercent: 2.4,
    reason: 'The tape shows the shelf held — this row recorded backwards.',
};

async function waitForServer(url, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok || res.status === 404) return true;
        } catch { /* not up yet */ }
        await sleep(250);
    }
    return false;
}

/** Seed the profile the way dock-card-probe does (the mount-armed save flush
 *  would overwrite an external write, so this runs from favicon.ico). */
async function seed(page) {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem('august_surface_v1', 'trade');
        sessionStorage.setItem('activeUsername', 'Probe User');
    });
    // Guard headroom for the early walks: the deterministic session guard
    // (daily loss, trade cap, streak pause, cooldown) would otherwise refuse
    // every approve — the seeded pt-2/pt-3 rows are trades today and the
    // DEFAULT preset caps the day at 2. The guard's own walk later in this
    // probe tightens the cap through the app's card path.
    await page.evaluate(() => {
        localStorage.setItem('harness_settings_v1', JSON.stringify({
            equityUsd: 10000, riskPercent: 1,
            guardMaxTradesPerDay: 20, guardDailyLossPct: 20, guardPostLossCooldownMin: 0,
        }));
    });
    await page.evaluate(async (mockPort) => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('FuturesAI-DB', 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains('userProfiles')) {
                    request.result.createObjectStore('userProfiles', { keyPath: 'username' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const analysis = (over) => ({
            direction: 'Long', confidence: 'High', coinName: 'BTCUSDT',
            entryPoints: [{ price: '84210.5', description: 'reclaim' }],
            stopLoss: '83100', takeProfit: [{ price: '87900' }],
            probability: 62, reasoning: 'Holding above the 200-EMA into thin sell-side.',
            marketConditions: {}, activeStrategies: [], validationWarnings: [],
            ...over,
        });
        const tradeRow = (id, minsAgo, outcome, tradeType, direction, coin) => ({
            id,
            outcome,
            tradeType,
            timestamp: new Date(Date.now() - minsAgo * 60000).toISOString(),
            leverage: 10,
            analysis: analysis({ direction, coinName: coin }),
        });
        const tx = db.transaction('userProfiles', 'readwrite');
        tx.objectStore('userProfiles').put({
            username: 'Probe User',
            conversations: [],
            tradeLog: [
                tradeRow('pt-2', 280, 'LOSS', 'scalp', 'Short', 'BTCUSDT'),
                tradeRow('pt-3', 260, 'WIN', 'swing', 'Long', 'ETHUSDT'),
            ],
            tradeSummaries: [],
            finalTradeSummary: null,
            settings: { activeFrameworks: [] },
        });
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
        localStorage.setItem('provider_configs_v1', JSON.stringify([{
            id: 'mock', name: 'Mock', apiKey: 'mock-key',
            baseUrl: `http://127.0.0.1:${mockPort}/v1`,
            apiFormat: 'chat_completions',
            isEnabled: true, isBuiltIn: false,
            models: ['mock-mini'], selectedModel: 'mock-mini',
        }]));
    }, MOCK_PORT);
}

/** Read the WHOLE journal back — the approve writes a PENDING row the
 *  assertions count and the undo deletes. */
async function readTrades(page) {
    return page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('FuturesAI-DB', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const row = await new Promise((resolve) => {
            const get = db.transaction('userProfiles', 'readonly')
                .objectStore('userProfiles').get('Probe User');
            get.onsuccess = () => resolve(get.result || null);
            get.onerror = () => resolve(null);
        });
        db.close();
        return ((row && row.tradeLog) || []).map((t) => ({
            id: t.id, outcome: t.outcome, planId: t.planId || null,
        }));
    });
}

const pendingRows = (rows) => rows.filter((r) => r.outcome === 'PENDING');

/** Read the live riskPercent out of the settings store — the WRITE the risk
 *  card's confirm must make through the app's own settings path. */
async function readRiskPercent(page) {
    return page.evaluate(() => {
        try {
            const v = JSON.parse(localStorage.getItem('harness_settings_v1') || '{}').riskPercent;
            return typeof v === 'number' ? v : null;
        } catch { return null; }
    });
}

/** The strategy plan's serialized status, read out of the notebook store the
 *  app itself wrote — the activation confirm and its revert must both move it
 *  through the same writer Settings uses. */
async function readStrategyStatus(page) {
    return page.evaluate(() => {
        try {
            const raw = localStorage.getItem('memory_files_v1_Probe User') || '';
            // The slug appears in the graph-index note too — take the FIRST
            // occurrence that is followed by a strategy frontmatter status.
            const re = /status:\s*(draft|active|retired)/g;
            let m;
            while ((m = re.exec(raw)) !== null) {
                const head = raw.slice(Math.max(0, m.index - 400), m.index);
                if (head.includes('probe-range-reclaim')) return m[1];
            }
            return 'unparsed';
        } catch { return 'read-failed'; }
    });
}

/** Read the live max-trades-per-day cap — the guard walk's tightened and
 *  loosened values must both land in the settings store. */
async function readGuardCap(page) {
    return page.evaluate(() => {
        try {
            const v = JSON.parse(localStorage.getItem('harness_settings_v1') || '{}').guardMaxTradesPerDay;
            return typeof v === 'number' ? v : null;
        } catch { return null; }
    });
}

/** Poll the journal until at least `min` PENDING rows exist — the debounced
 *  DATA save (~1.5s) flushes behind the write, so a single read races it. */
async function waitForPendingRows(page, min, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let rows = [];
    while (Date.now() < deadline) {
        rows = pendingRows(await readTrades(page));
        if (rows.length >= min) return rows;
        await sleep(400);
    }
    return rows;
}

/** Read every decline ledger row (any user bucket) — the Reject check. */
async function readDeclines(page) {
    return page.evaluate(() => {
        const out = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('trade_declines_v1_')) {
                try { out.push(...JSON.parse(localStorage.getItem(k) || '[]')); } catch { /* skip */ }
            }
        }
        return out.map((d) => ({ symbol: d.symbol, reason: d.reason, source: d.source }));
    });
}

/** Send one dock message the way a person does (native value setter + Send). */
async function sendInDock(page, text) {
    await scrollTranscriptToBottom(page);
    await page.waitForFunction(() => {
        const ta = document.querySelector('textarea');
        if (!ta || ta.disabled) return false;
        return [...document.querySelectorAll('button')].some((b) => !b.disabled && /send/i.test(
            `${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`,
        ));
    }, null, { timeout: 30000 });
    const sent = await page.evaluate((needle) => {
        const ta = document.querySelector('textarea');
        if (!ta || ta.disabled) return 'no composer';
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
            .set.call(ta, needle);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find((b) => /send/i.test(
            `${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`,
        ));
        if (!btn) return 'no send button';
        if (btn.disabled) return 'send disabled';
        btn.click();
        return 'clicked';
    }, text);
    if (sent !== 'clicked') throw new Error(`send failed: ${sent}`);
}


/** Re-locate and read a card's text, tolerating a virtualized unmount mid-read
 *  (the autopilot's scanning notices re-flow the transcript). */
async function cardText(page, cardSelector, text, tries = 4) {
    let last = '';
    for (let i = 0; i < tries; i++) {
        const card = await waitForCard(page, cardSelector, text, 20000);
        if (card) {
            try {
                last = await card.innerText();
                if (last) return last;
            } catch { /* detached mid-read — re-locate */ }
        }
        await sleep(800);
    }
    return last;
}

const failures = [];
const check = (name, ok, detail) => {
    if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` (${detail})` : ''}`);
};

/** Scroll the dock transcript UP — the transcript is VIRTUALIZED, so a card
 *  a couple of rows above the newest one can be unmounted, and the approval
 *  receipt turns that follow an approve push it exactly there. A trader
 *  scrolls back to the card; the probe does the same. */
async function scrollTranscriptUp(page, amount = 1600) {
    await page.evaluate((amt) => {
        // The transcript scroller is the panel's .custom-scrollbar log box —
        // not the tallest scrollable descendant (menus/drawers compete).
        const boxes = [...document.querySelectorAll('[data-testid="trade-chat-panel"] .custom-scrollbar')]
            .filter((el) => el.scrollHeight > el.clientHeight + 100)
            .sort((a, b) => b.clientHeight - a.clientHeight);
        const box = boxes[0];
        if (box) box.scrollTop = Math.max(0, box.scrollTop - amt);
    }, amount);
}

/** Scroll the dock transcript back to the newest row — Virtuoso follows the
 *  newest row only when the list is AT the bottom, so a probe that scrolled
 *  up must re-anchor before the next turn or the new row never mounts. */
async function scrollTranscriptToBottom(page) {
    await page.evaluate(() => {
        const boxes = [...document.querySelectorAll('[data-testid="trade-chat-panel"] .custom-scrollbar')]
            .filter((el) => el.scrollHeight > el.clientHeight + 100)
            .sort((a, b) => b.clientHeight - a.clientHeight);
        const box = boxes[0];
        if (box) box.scrollTop = box.scrollHeight;
    });
}

/** Click Approve and ride out the fail-closed confirms (an unmeasured gate
 *  and an unverified plan each ask for an explicit confirm before the row
 *  lands), then wait for the undo window. */
async function approveToUndoWindow(page, consoleLog) {
    // The card may sit ABOVE the virtualized window: a receipt turn or a risk
    // note that fired after its own turn ended pushes the newest rows down,
    // and Virtuoso unmounts what scrolled away. Sweep up until the button
    // mounts before the first click — the in-loop retries below only cover
    // misses after a click landed.
    for (let i = 0; i < 10; i++) {
        if (await page.locator('[data-testid="proposal-approve"]').count()) break;
        await scrollTranscriptUp(page, 900);
        await sleep(300);
    }
    await page.locator('[data-testid="proposal-approve"]').last().click();
    for (let i = 0; i < 14; i++) {
        if (await page.locator('[data-testid="proposal-undo-window"]').count()) return;
        const dlg = page.locator('[data-testid="confirm-dialog-confirm"]');
        if (await dlg.count()) {
            consoleLog.push(`dialog[${i}]: clicked confirm`);
            await dlg.first().click();
            await sleep(400);
        } else {
            // The receipt turns that follow the approve push the card out of
            // the virtualized window — scroll back to it each miss.
            await scrollTranscriptUp(page, 1200);
            await sleep(400);
        }
    }
    if (await page.locator('[data-testid="proposal-undo-window"]').count()) return;
    // Diagnose the miss: what does the card say, is the button disabled, is a
    // dialog open, and what did the journal hold?
    const diag = await page.evaluate(async () => {
        const card = [...document.querySelectorAll('[data-testid="trade-proposal-card"]')].pop();
        const btn = [...document.querySelectorAll('[data-testid="proposal-approve"]')].pop();
        const dlg = document.querySelector('[role="dialog"]');
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('FuturesAI-DB', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const row = await new Promise((resolve) => {
            const get = db.transaction('userProfiles', 'readonly')
                .objectStore('userProfiles').get('Probe User');
            get.onsuccess = () => resolve(get.result || null);
            get.onerror = () => resolve(null);
        });
        db.close();
        return {
            card: card ? card.textContent.replace(/\s+/g, ' ').slice(0, 300) : 'NO CARD',
            btnDisabled: btn ? btn.disabled : 'no button',
            dialog: dlg ? dlg.textContent.replace(/\s+/g, ' ').slice(0, 200) : 'none',
            rows: (((row && row.tradeLog) || [])).map((t) => [t.id, t.outcome, t.planId]),
        };
    });
    console.error('  [diag] card:', diag.card);
    console.error('  [diag] btnDisabled:', diag.btnDisabled, '| dialog:', diag.dialog);
    console.error('  [diag] rows:', JSON.stringify(diag.rows));
    await page.waitForSelector('[data-testid="proposal-undo-window"]', { timeout: 20000 });
}


/** Dump the transcript's mounted state — the virtualized window is the whole
 *  difference between "the app rendered it" and "body.innerText saw it". */
async function dumpTranscriptState(page, label) {
    const d = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="trade-chat-panel"]');
        const boxes = [...document.querySelectorAll('[data-testid="trade-chat-panel"] .custom-scrollbar')]
            .map((el) => ({ ch: el.clientHeight, sh: el.scrollHeight, st: Math.round(el.scrollTop) }));
        const items = [...document.querySelectorAll('[data-testid="trade-chat-panel"] [data-index]')];
        const cards = [
            ...[...document.querySelectorAll('[data-testid="trade-proposal-card"]')].map((c) => 'TRADE ' + c.textContent.replace(/\s+/g, ' ').slice(0, 80)),
            ...[...document.querySelectorAll('[data-testid="risk-change-card"]')].map((c) => 'RISK-PENDING ' + c.textContent.replace(/\s+/g, ' ').slice(0, 80)),
            ...[...document.querySelectorAll('[data-testid="risk-change-applied"]')].map((c) => 'RISK-APPLIED ' + c.textContent.replace(/\s+/g, ' ').slice(0, 80)),
        ];
        const lastTexts = items.slice(-3).map((el) => el.textContent.replace(/\s+/g, ' ').slice(0, 100));
        return {
            panelMounted: !!panel,
            boxes,
            mountedItems: items.length,
            cards,
            lastTexts,
            bodyHas: {
                planC: document.body.innerText.includes('Probe plan C'),
                planD: document.body.innerText.includes('Probe plan D'),
                logged: document.body.innerText.includes('Approved — tracking this trade'),
            },
        };
    });
    console.error(`  [state:${label}]`, JSON.stringify(d));
}


/** Scroll-scan until a card matching `text` is MOUNTED in the virtualized
 *  transcript, and return its locator (scoped: every interaction targets THIS
 *  card, never "the newest one"). Null when the deadline passes. */
async function waitForCard(page, cardSelector, text, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    const locate = () => page.locator(`[data-testid="trade-chat-panel"] [data-testid="${cardSelector}"]`, { hasText: text });
    while (Date.now() < deadline) {
        await scrollTranscriptToBottom(page);
        await sleep(250);
        if (await locate().count()) return locate().last();
        for (let i = 0; i < 6; i++) {
            await scrollTranscriptUp(page, 900);
            await sleep(250);
            if (await locate().count()) return locate().last();
        }
        await sleep(400);
    }
    return null;
}

/**
 * Evidence-shot guard (UI audit bug 12): a card outside the viewport makes a
 * screenshot that does not show the thing it names (the stale
 * decision-card-*.png set). Scroll the target into the MIDDLE of the
 * viewport, assert it actually intersects the viewport box, then capture.
 * Bug 2's half: NEVER capture with a modal covering the screen — a Settings
 * window or any aria-modal dialog over the shot is a blocked screenshot,
 * exactly what the render-probe refuses for its layout evidence.
 */
async function shootCard(page, filePath, locator, label) {
    if (!locator) throw new Error(`${label}: no card locator to capture`);
    const blocked = await page.evaluate(() => {
        const win = document.querySelector('[data-testid="settings-window"]');
        if (win) return 'settings-window open';
        const dlg = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
            .find((d) => d.getClientRects().length > 0);
        return dlg ? 'a modal dialog is open' : null;
    });
    if (blocked) throw new Error(`${label}: refusing to capture — ${blocked}`);
    const el = locator.first();
    // The transcript is VIRTUALIZED: a scrollIntoView can be followed by a
    // follow-output re-scroll that unmounts the row mid-assert. Retry the
    // scroll-assert pair; the assertion itself stays strict.
    let onScreen = false;
    for (let attempt = 0; attempt < 4 && !onScreen; attempt++) {
        await el.evaluate((node) => node.scrollIntoView({ block: 'center' })).catch(() => {});
        await sleep(300 + attempt * 200);
        onScreen = await el.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
        }).catch(() => false);
    }
    if (!onScreen) throw new Error(`${label}: target is not inside the viewport after scrollIntoView`);
    await page.screenshot({ path: filePath });
}

/** The same scan for a bare testid (the settled logged row, which is a
 *  sibling of the card, not a child). */
async function waitForTestidScrolled(page, testid, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    const locate = () => page.locator(`[data-testid="trade-chat-panel"] [data-testid="${testid}"]`);
    while (Date.now() < deadline) {
        await scrollTranscriptToBottom(page);
        await sleep(250);
        if (await locate().count()) return true;
        for (let i = 0; i < 6; i++) {
            await scrollTranscriptUp(page, 900);
            await sleep(250);
            if (await locate().count()) return true;
        }
        await sleep(400);
    }
    return false;
}


/** Wait for `needle` to appear anywhere in the mounted transcript text,
 *  SCANNING while it polls: the list is virtualized and the follow-scroll
 *  moves, so the row carrying the text is not always mounted. */
async function waitForTextScrolling(page, needle, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await scrollTranscriptToBottom(page);
        await sleep(250);
        if (await page.evaluate((n) => document.body.innerText.includes(n), needle)) return true;
        for (let i = 0; i < 6; i++) {
            await scrollTranscriptUp(page, 900);
            await sleep(250);
            if (await page.evaluate((n) => document.body.innerText.includes(n), needle)) return true;
        }
        await sleep(400);
    }
    // A failed scan must be explainable: dump what the transcript actually
    // shows at its tail, so a needle that can never match is visible in the
    // failure output instead of guessed at.
    const tail = await page.evaluate(() => (document.body.innerText || '').slice(-700)).catch(() => '');
    console.log(`  [scan-miss] needle="${needle}" transcript tail: ${tail.replace(/\s+/g, ' ').slice(0, 400)}`);
    return false;
}

async function main() {
    const free = (port) => new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.once('listening', () => probe.close(() => resolve(true)));
        probe.listen(port, '127.0.0.1');
    });
    for (const [label, port] of [['dev server', PORT], ['mock provider', MOCK_PORT]]) {
        if (await free(port)) continue;
        console.error(`DECISION CARD PROBE FAIL: port ${port} (${label}) is already owned — refusing to drive it.`);
        process.exitCode = 1;
        return;
    }
    const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    const server = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const mock = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-provider.cjs'), String(MOCK_PORT)], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: {
            ...process.env,
            MOCK_TOOL_CALL: '1',
            MOCK_TOOL_NAME: 'present_trade',
            MOCK_SKILL_ARGS: JSON.stringify([PLAN_A, PLAN_B, PLAN_C, PLAN_D, RISK_TIGHTEN, RISK_LOOSEN, PLAN_E, GUARD_TIGHTEN, GUARD_LOOSEN, STRAT_PROPOSE, STRAT_ACTIVATE, SETTLEMENT_FIX]),
        },
    });
    let serverOut = '';
    let mockOut = '';
    const consoleLog = [];
    server.stdout.on('data', (d) => { serverOut += String(d); });
    server.stderr.on('data', (d) => { serverOut += String(d); });
    mock.stdout.on('data', (d) => { mockOut += String(d); });
    mock.stderr.on('data', (d) => { mockOut += String(d); });

    const wsTimers = [];
    try {
        if (!(await waitForServer(BASE))) {
            console.error('DECISION CARD PROBE FAIL: no vite dev server on', BASE, '\n', serverOut);
            process.exitCode = 1;
            return;
        }
        if (!(await waitForServer(`http://127.0.0.1:${MOCK_PORT}/models`))) {
            console.error('DECISION CARD PROBE FAIL: mock provider never came up');
            process.exitCode = 1;
            return;
        }
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        const pageErrors = [];
        page.on('pageerror', (err) => pageErrors.push(String(err && err.stack || err)));
        // HERMETIC MARKET DATA: the staleness walk needs a live mark, which
        // used to depend on the real Binance hosts answering from a
        // CORS-restricted browser — when every host was blocked the mark
        // vanished and the staleness check failed with no code change. A
        // synthetic tape (a flat walk around 64k, the same rows for every
        // interval) makes the walk deterministic: plan A (entry 84000, stop
        // 1000) stays FRESH (drift < half the stop) and plan C (entry 100,
        // stop 0.1) is always STALE. Also kills the CORS console noise.
        const synthKlines = (n) => Array.from({ length: n }, (_, i) => {
            const t = Date.now() - (n - i) * 900000;
            const o = 64000 + Math.round(Math.sin(i / 6) * 400);
            return [t, String(o), String(o + 300), String(o - 300), String(o + 100), '12.5', t + 899000, '100', 10, '6.25'];
        });
        await page.route(/binance\.com|fapi/, (route) => {
            const url = route.request().url();
            if (url.includes('/klines')) {
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(synthKlines(250)) });
            }
            return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        });
        // The mark stream too: a synthetic markPrice@1s push, so the live mark
        // is deterministic (the REST tape alone leaves the chart's mark null,
        // and the staleness walk degrades to 'not stale on that axis').
        await page.routeWebSocket(/fstream\.binance\.com/, (ws) => {
            const push = () => {
                try {
                    ws.send(JSON.stringify({ e: 'markPriceUpdate', p: '64100', i: '64100', P: '0.0001', T: Date.now() + 3600000 }));
                    ws.send(JSON.stringify({ e: '24hrTicker', c: '64100', P: '1.2', q: '1000' }));
                } catch { /* the page may have closed the socket */ }
            };
            push();
            const t = setInterval(push, 1000);
            t.unref?.();
            wsTimers.push(t);
        });
        page.on('console', (msg) => {
            consoleLog.push(`[console.${msg.type()}] ${msg.text().slice(0, 200)}`);
            if (consoleLog.length > 400) consoleLog.splice(0, consoleLog.length - 400);
        });
        page.on('requestfailed', (req) => consoleLog.push(`[reqfail] ${req.url().slice(0, 120)} ${req.failure() && req.failure().errorText}`));

        await seed(page);
        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction(() => !document.querySelector('#splash'), null, { timeout: 45000 });
        const ws = page.locator('input[placeholder="Create New Workspace"]');
        if (await ws.count()) {
            await ws.first().fill('Probe User');
            await page.locator('button').filter({ hasText: /^Enter$/ }).first().click();
            await sleep(1500);
        }
        await page.waitForSelector('[data-testid="trade-view"]', { timeout: 60000 });
        const aiTab = page.locator('[role="tab"]', { hasText: /^AI$/ }).first();
        if (await aiTab.count()) await aiTab.click();
        await sleep(500);

        // ── Turn 1 (PLAN_A): present → Ask-why → Approve → receipt → Undo ──
        await sendInDock(page, 'PROBE_TOOL_ROUND present plan A');
        const cardA = await waitForCard(page, 'trade-proposal-card', 'Probe plan A');
        if (!cardA) { await dumpTranscriptState(page, 'plan A card never mounted'); throw new Error('plan A card never rendered'); }
        check('a presented plan renders the decision card', true);
        const hasSimBadge = (await cardA.locator('[data-testid="simulated-badge"]').count()) > 0;
        const fillAssumptionsText = await cardA.locator('[data-testid="fill-assumptions"]').innerText().catch(() => '');
        check('the proposal card renders the monochrome Simulated badge and explicit fill assumptions',
            hasSimBadge && /Simulated.*fee.*spread.*slip.*gap-open.*nothing executed on any exchange/i.test(fillAssumptionsText),
            `badge=${hasSimBadge} assumptions=${fillAssumptionsText}`);
        mkdirSync(path.join(ROOT, 'docs', 'evidence'), { recursive: true });
        await shootCard(page, '.probe-artifacts/decision-card-presented.png', cardA, 'presented card');
        await shootCard(page, path.join(ROOT, 'docs', 'evidence', 'stop2-decision-cards.png'), cardA, 'stop2 decision card');

        // Ruling 1's zero-loss: the [Desk | Chat] layout switch with a
        // PENDING card on screen. Both modes render the same workspace and
        // the same chatStore, so the card must survive the switch in BOTH
        // directions — and the approve that follows proceeds normally.
        await page.evaluate(() => document.querySelector('[data-testid="layout-pill-chat"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await sleep(600);
        const cardInChat = await waitForCard(page, 'trade-proposal-card', 'Probe plan A', 20000);
        check('the Desk-to-Chat switch is zero-loss with a pending card', !!cardInChat,
            cardInChat ? 'card renders in Chat' : 'the card vanished in Chat');
        if (cardInChat) await shootCard(page, '.probe-artifacts/decision-card-chat-mode.png', cardInChat, 'chat-mode card');
        await page.evaluate(() => document.querySelector('[data-testid="layout-pill-desk"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await sleep(600);
        const cardBackInDesk = await waitForCard(page, 'trade-proposal-card', 'Probe plan A', 20000);
        check('the Chat-to-Desk switch keeps the pending card actionable', !!cardBackInDesk,
            cardBackInDesk ? 'card renders in Desk' : 'the card vanished in Desk');

        const beforeApprove = pendingRows(await readTrades(page));
        check('nothing logs until you approve', beforeApprove.length === 0,
            `${beforeApprove.length} pending row(s) before the tap`);

        // Ask-why: the composer pre-fills with the pushback prompt; nothing is
        // sent and the card stays.
        await cardA.locator('[data-testid="proposal-ask-why"]').click();
        await sleep(400);
        const draft = await page.evaluate(() => {
            const ta = document.querySelector('textarea');
            return ta ? ta.value : '';
        });
        check('Ask-why pre-fills the composer with the pushback prompt',
            /Why this trade\?/.test(draft) && /invalidat/i.test(draft),
            draft.slice(0, 120));

        await approveToUndoWindow(page, consoleLog, cardA);
        const afterApprove = await waitForPendingRows(page, 1);
        check('one Approve logs exactly one PENDING journal row', afterApprove.length === 1,
            `${afterApprove.length} pending row(s) after the tap: ${JSON.stringify((await readTrades(page)).map((r) => [r.id, r.outcome]))}`);
        await shootCard(page, '.probe-artifacts/decision-card-approved.png', cardA, 'approved card');
        const secondApprove = await cardA.locator('[data-testid="proposal-approve"]').count();
        check('an approved card offers no second Approve tap', secondApprove === 0,
            `${secondApprove} approve button(s) still visible on the card`);

        // The undo window is 12s and the receipt turns push the card around
        // the virtualized window — tap Undo FIRST (with the scroll-retry),
        // then assert the notes, which stay in the thread either way.
        for (let i = 0; i < 8 && (await cardA.locator('[data-testid="proposal-undo"]').count()) === 0; i++) {
            await scrollTranscriptUp(page, 1200);
            await sleep(250);
        }
        const undoVisible = (await cardA.locator('[data-testid="proposal-undo"]').count()) > 0;
        if (undoVisible) await cardA.locator('[data-testid="proposal-undo"]').click();
        let undone = false;
        for (let i = 0; i < 24 && !undone; i++) {
            await sleep(500);
            const rows = pendingRows(await readTrades(page));
            const buttonsBack = (await cardA.locator('[data-testid="proposal-approve"]').count()) > 0;
            undone = rows.length === 0 && buttonsBack;
        }
        check('Undo deletes the row and restores the card', undone,
            `rows=${JSON.stringify((await readTrades(page)).map((r) => r.outcome))}`);
        const receiptSeen = await waitForTextScrolling(page, 'Plan approved — logged & monitoring', 15000);
        check('the approval receipt reaches the conversation', receiptSeen);
        const undoNote = await waitForTextScrolling(page, 'Plan approval undone', 25000);
        check('the undo note reaches the thread', undoNote);

        // ── Turn 2 (PLAN_B): a re-approve after undo is a FRESH decision ────
        await sendInDock(page, 'PROBE_TOOL_ROUND present plan B');
        const cardB = await waitForCard(page, 'trade-proposal-card', 'Probe plan B');
        if (!cardB) { await dumpTranscriptState(page, 'plan B card never mounted'); throw new Error('plan B card never rendered'); }
        await approveToUndoWindow(page, consoleLog, cardB);
        const reapproved = await waitForPendingRows(page, 1);
        check('a re-approve after an undo logs a fresh row', reapproved.length === 1,
            `${reapproved.length} pending row(s)`);

        // The undo window lapses: the approved plan settles into the logged row.
        await sleep(13500);
        const lapsed = (await cardB.locator('[data-testid="proposal-undo-window"]').count()) === 0;
        const stillLogged = pendingRows(await readTrades(page)).length === 1;
        check('past the undo window the approval settles and the row stands', lapsed && stillLogged,
            `undoWindowGone=${lapsed} rowIntact=${stillLogged}`);
        const settled = await waitForTestidScrolled(page, 'proposal-logged-row');
        check('the settled row says the trade is tracked', settled);

        // ── Turn 3 (PLAN_C): a STALE plan needs a re-confirm ────────────────
        await sendInDock(page, 'PROBE_TOOL_ROUND present plan C');
        let cardC = await waitForCard(page, 'trade-proposal-card', 'Probe plan C');
        if (!cardC) { await dumpTranscriptState(page, 'plan C card never mounted'); throw new Error('plan C card never rendered'); }
        await shootCard(page, '.probe-artifacts/decision-card-stale.png', cardC, 'stale card');
        let staleShown = false;
        for (let i = 0; i < 16 && !staleShown; i++) {
            staleShown = (await cardC.locator('[data-testid="proposal-stale"]').count()) > 0;
            if (!staleShown) await sleep(500);
        }
        check('a plan priced far from the live mark shows the staleness block', staleShown);
        // The reads re-locate the card each try: the autopilot's scanning
        // notices re-flow the virtualized transcript and can detach the card
        // mid-read (a race, not an app failure).
        let beforeTap = '';
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                beforeTap = await cardC.locator('[data-testid="proposal-approve"]').innerText({ timeout: 8000 });
                break;
            } catch {
                const again = await waitForCard(page, 'trade-proposal-card', 'Probe plan C', 15000);
                if (again) cardC = again;
                await sleep(600);
            }
        }
        await cardC.locator('[data-testid="proposal-approve"]').click();
        // Poll briefly for a SECOND row: one appearing within this window is
        // the silent approval this check exists to refuse.
        const afterFirstTap = await waitForPendingRows(page, 2, 4000);
        const noSilentLog = afterFirstTap.length === 1; // still only plan B's row
        check('the first tap on a stale plan does not approve silently',
            /Re-confirm/i.test(beforeTap) && noSilentLog,
            `buttonBefore="${beforeTap.replace(/\s+/g, ' ').slice(0, 40)}" rows=${JSON.stringify(afterFirstTap.map((r) => r.outcome))}`);
        await approveToUndoWindow(page, consoleLog, cardC);
        const staleRows = await waitForPendingRows(page, 2);
        check('the re-confirm tap approves the stale plan', staleRows.length === 2,
            `${staleRows.length} pending row(s)`);

        // ── Turn 4 (PLAN_D): Reject records the decline ─────────────────────
        await sendInDock(page, 'PROBE_TOOL_ROUND present plan D');
        const cardD = await waitForCard(page, 'trade-proposal-card', 'Probe plan D');
        if (!cardD) { await dumpTranscriptState(page, 'plan D card never mounted'); throw new Error('plan D card never rendered'); }
        await cardD.locator('[data-testid="proposal-decline-reason"]').fill('R:R too thin for the regime');
        await cardD.locator('[data-testid="proposal-reject"]').click();
        await sleep(1500);
        const rejectGone = (await cardD.locator('[data-testid="trade-proposal-card"]').count()) === 0;
        const declines = await readDeclines(page);
        const recorded = declines.some((d) => d.source === 'desk' && /R:R too thin for the regime/.test(d.reason || ''));
        check('Reject resolves the card and records the decline with its reason',
            rejectGone && recorded,
            `cardGone=${rejectGone} declines=${JSON.stringify(declines).slice(0, 160)}`);
        const rejectLogged = pendingRows(await readTrades(page)).length === 2;
        check('a rejected plan logs nothing', rejectLogged,
            `${pendingRows(await readTrades(page)).length} pending row(s)`);

        // ── Turn 5 (RISK TIGHTEN): one tap applies ──────────────────────────
        await sendInDock(page, 'PROBE_TOOL_ROUND propose a risk change');
        const cardR1 = await waitForCard(page, 'risk-change-card', 'The range is tight');
        if (!cardR1) { await dumpTranscriptState(page, 'risk tighten card never mounted'); throw new Error('risk tighten card never rendered'); }
        const tightenText = await cardText(page, 'risk-change-card', 'The range is tight');
        check('a risk change renders the card with the before/after and its direction',
            /tightens/i.test(tightenText) && /0\.5/.test(tightenText),
            tightenText.replace(/\s+/g, ' ').slice(0, 140));
        await shootCard(page, '.probe-artifacts/decision-card-risk-tighten.png', cardR1, 'risk tighten card');

        await cardR1.locator('[data-testid="risk-change-confirm"]').click();
        let riskApplied = false;
        for (let i = 0; i < 12 && !riskApplied; i++) {
            await sleep(500);
            riskApplied = (await readRiskPercent(page)) === 0.5;
        }
        check('a TIGHTENING risk change applies with one tap', riskApplied,
            `riskPercent=${await readRiskPercent(page)}`);
        const appliedVisible = (await page.locator('[data-testid="risk-change-applied"]').count()) > 0;
        check('the applied card carries the revert window', appliedVisible);
        const appliedNote = await waitForTextScrolling(page, 'The trader CONFIRMED your proposal', 15000);
        check('the applied note reaches the thread', appliedNote);

        // ── Turn 6 (RISK LOOSEN): the explicit second tap ───────────────────
        await sendInDock(page, 'PROBE_TOOL_ROUND propose another risk change');
        const cardR2 = await waitForCard(page, 'risk-change-card', 'risk per trade goes back up');
        if (!cardR2) {
            await dumpTranscriptState(page, 'risk loosen card never mounted');
            await page.screenshot({ path: '.probe-artifacts/decision-card-riskLoosen-timeout.png' });
            throw new Error('risk loosen card never rendered');
        }
        const armVisible = (await cardR2.locator('[data-testid="risk-change-arm"]').count()) > 0;
        check('a LOOSENING risk change asks for the explicit confirm', armVisible);
        await cardR2.locator('[data-testid="risk-change-arm"]').click();
        await sleep(300);
        await cardR2.locator('[data-testid="risk-change-confirm"]').click();
        let riskLoosened = false;
        for (let i = 0; i < 12 && !riskLoosened; i++) {
            await sleep(500);
            riskLoosened = (await readRiskPercent(page)) === 2;
        }
        check('the LOOSENING change applies only on the second tap', riskLoosened,
            `riskPercent=${await readRiskPercent(page)}`);

        // ── Revert inside the window: the replaced value comes back ─────────
        // The applied card drops the reason text, so the rationale-scoped
        // locator cannot see it — the newest applied card's revert is the one
        // this turn produced.
        const revertVisible = (await page.locator('[data-testid="risk-change-revert"]').count()) > 0;
        if (revertVisible) await page.locator('[data-testid="risk-change-revert"]').last().click();
        let riskReverted = false;
        for (let i = 0; i < 12 && !riskReverted; i++) {
            await sleep(500);
            riskReverted = (await readRiskPercent(page)) === 0.5;
        }
        check('the revert puts the replaced value back', revertVisible && riskReverted,
            `revertButton=${revertVisible} riskPercent=${await readRiskPercent(page)}`);
        const revertedNote = await waitForTextScrolling(page, 'The trader reverted your confirmed change', 15000);
        check('the revert note reaches the thread', revertedNote);

        // ── Turn 7 (GUARD WALK): the deterministic session guard ────────────
        // The agent proposes the trade cap DOWN to 1 — a tighten, one tap —
        // and the guard now refuses every new log: plan E's Approve button is
        // DOWN and the card prints the standing reason. The only way back is
        // the gated one: the agent proposes the cap UP to 8, the loosen needs
        // the explicit second tap, and the same approve now lands. No row is
        // written while the guard stands down.
        await sendInDock(page, 'PROBE_TOOL_ROUND present plan E');
        const cardE = await waitForCard(page, 'trade-proposal-card', 'Probe plan E');
        if (!cardE) { await dumpTranscriptState(page, 'plan E card never mounted'); throw new Error('plan E card never rendered'); }

        await sendInDock(page, 'PROBE_TOOL_ROUND tighten the trade cap');
        const cardG1 = await waitForCard(page, 'risk-change-card', 'one attempt today');
        if (!cardG1) { await dumpTranscriptState(page, 'guard tighten card never mounted'); throw new Error('guard tighten card never rendered'); }
        await cardG1.locator('[data-testid="risk-change-confirm"]').click();
        let capTightened = false;
        for (let i = 0; i < 12 && !capTightened; i++) {
            await sleep(500);
            capTightened = (await readGuardCap(page)) === 1;
        }
        check('a TIGHTENING guard change applies with one tap (cap down to 1)', capTightened,
            `guardMaxTradesPerDay=${await readGuardCap(page)}`);

        // The guard verdict recomputes on the settings write: the card's own
        // Approve goes down with the reason printed. Wait for the repaint —
        // the listener push lands within a tick.
        let blockSeen = null;
        for (let i = 0; i < 10 && !blockSeen; i++) {
            await sleep(400);
            blockSeen = await cardE.evaluate((el) => {
                const block = el.querySelector('[data-testid="proposal-guard-block"]');
                const btn = el.querySelector('[data-testid="proposal-approve"]');
                return btn && btn.disabled && block ? block.textContent : null;
            });
        }
        check('the guard stands the session down on the card (Approve down, reason printed)',
            !!blockSeen, blockSeen ? blockSeen.slice(0, 120) : 'no guard block on the card');
        await shootCard(page, '.probe-artifacts/decision-card-guard-block.png', cardE, 'guard block card');

        const rowsBeforeGuard = pendingRows(await readTrades(page)).length;
        // A disabled button cannot be clicked through Playwright's actionability
        // rules — assert the no-write property by trying the click and polling
        // for the row that must never appear.
        await cardE.locator('[data-testid="proposal-approve"]').click({ force: true, timeout: 3000 }).catch(() => {});
        await sleep(2500);
        const rowsAfterGuardTap = pendingRows(await readTrades(page)).length;
        check('a guarded approve logs nothing', rowsAfterGuardTap === rowsBeforeGuard,
            `rows ${rowsBeforeGuard} -> ${rowsAfterGuardTap}`);

        await sendInDock(page, 'PROBE_TOOL_ROUND loosen the trade cap');
        const cardG2 = await waitForCard(page, 'risk-change-card', 'cap goes back up');
        if (!cardG2) { await dumpTranscriptState(page, 'guard loosen card never mounted'); throw new Error('guard loosen card never rendered'); }
        const armG = (await cardG2.locator('[data-testid="risk-change-arm"]').count()) > 0;
        check('a LOOSENING guard change asks for the explicit confirm', armG);
        await cardG2.locator('[data-testid="risk-change-arm"]').click();
        await sleep(300);
        await cardG2.locator('[data-testid="risk-change-confirm"]').click();
        let capLoosened = false;
        for (let i = 0; i < 12 && !capLoosened; i++) {
            await sleep(500);
            capLoosened = (await readGuardCap(page)) === 8;
        }
        check('the LOOSENING guard change applies only on the second tap (cap up to 8)', capLoosened,
            `guardMaxTradesPerDay=${await readGuardCap(page)}`);

        // The same plan, the same approve — now it lands: one new PENDING row
        // and the undo window on the card.
        await approveToUndoWindow(page, consoleLog);
        // The journal save is debounced — poll for the row instead of reading
        // once (a single early read read the PRE-approve count and failed the
        // check on a timing artifact).
        const rowsAfterLoosen = (await waitForPendingRows(page, rowsBeforeGuard + 1, 15000)).length;
        check('the guarded recourse: the loosened cap lets the approve log', rowsAfterLoosen === rowsBeforeGuard + 1,
            `rows ${rowsBeforeGuard} -> ${rowsAfterLoosen}`);

        // ── Turn 8 (STRATEGY WALK): propose → activation card → confirm → revert
        // The agent PROPOSES a draft plan, then PROPOSES its activation. The
        // card is the only writer: the confirm moves the plan through the
        // SAME writer the Settings screen uses, and the revert puts the draft
        // status back inside the window.
        await sendInDock(page, 'PROBE_TOOL_ROUND propose a strategy plan');
        let stratDraft = 'missing';
        for (let i = 0; i < 20 && stratDraft !== 'draft'; i++) {
            await sleep(500);
            stratDraft = await readStrategyStatus(page);
        }
        check('a proposed strategy plan lands in the notebook as a draft', stratDraft === 'draft',
            `status=${stratDraft}`);

        await sendInDock(page, 'PROBE_TOOL_ROUND activate the probe strategy');
        const cardS = await waitForCard(page, 'strategy-activation-card', 'activate');
        if (!cardS) { await dumpTranscriptState(page, 'strategy activation card never mounted'); throw new Error('strategy activation card never rendered'); }
        const stratText = await cardText(page, 'strategy-activation-card', 'activate');
        check('the strategy activation card shows the before/after and what changes',
            /draft/i.test(stratText) && /active/i.test(stratText) && /every seat/i.test(stratText),
            stratText.replace(/\s+/g, ' ').slice(0, 160));
        await shootCard(page, '.probe-artifacts/decision-card-strategy-activation.png', cardS, 'strategy activation card');

        await cardS.locator('[data-testid="strategy-activation-confirm"]').click();
        let stratApplied = false;
        for (let i = 0; i < 12 && !stratApplied; i++) {
            await sleep(500);
            stratApplied = (await page.locator('[data-testid="strategy-activation-applied"]').count()) > 0;
        }
        let stratActive = false;
        for (let i = 0; i < 12 && !stratActive; i++) {
            await sleep(500);
            stratActive = (await readStrategyStatus(page)) === 'active';
        }
        const appliedTextS = (await page.locator('[data-testid="strategy-activation-applied"]').last().innerText().catch(() => 'NO CARD'));
        check('the confirmed activation applies through the notebook writer', stratApplied && stratActive,
            `appliedCard=${stratApplied} status=${await readStrategyStatus(page)} card=${appliedTextS.replace(/\s+/g, ' ').slice(0, 180)}`);
        const appliedNoteS = await waitForTextScrolling(page, 'The trader CONFIRMED your proposal', 15000);
        check('the strategy note reaches the thread', appliedNoteS);

        // The applied card may sit above the virtualized window: the strategy
        // note turn pushed the newest rows down. Sweep up until the button
        // mounts before counting or clicking it.
        let revertBtnS = 0;
        for (let i = 0; i < 10; i++) {
            revertBtnS = await page.locator('[data-testid="strategy-activation-revert"]').count();
            if (revertBtnS) break;
            await scrollTranscriptUp(page, 900);
            await sleep(300);
        }
        if (revertBtnS) await page.locator('[data-testid="strategy-activation-revert"]').last().click();
        let stratDraftAgain = false;
        for (let i = 0; i < 12 && !stratDraftAgain; i++) {
            await sleep(500);
            stratDraftAgain = (await readStrategyStatus(page)) === 'draft';
        }
        check('the revert puts the draft status back', revertBtnS > 0 && stratDraftAgain,
            `revertButton=${revertBtnS} status=${await readStrategyStatus(page)}`);

        // ── Evidence captures (UI audit bugs 2 + 12) ────────────────────────
        // The FULL card set lands in docs/evidence next to the layout
        // evidence, every one through shootCard's guards: no modal over the
        // shot (bug 2), the target scrolled into view and asserted inside the
        // viewport (bug 12 — the stale decision-card-*.png set died of the
        // opposite). The shape the probe never drove is here too: a settlement
        // correction on a SEEDED row (the executor refuses a hallucinated id).
        // The stats card's evidence lives in parity-proof-probe (P-5), which
        // drives get_setup_history_stats on its own harness page and captures
        // docs/evidence/stop2-stats-card.png through the same guards.
        const evidenceDir = path.join(ROOT, 'docs', 'evidence');
        mkdirSync(evidenceDir, { recursive: true });

        await sendInDock(page, 'PROBE_TOOL_ROUND propose a settlement correction');
        const cardSC = await waitForCard(page, 'settlement-correction-card', 'recorded backwards');
        if (!cardSC) { await dumpTranscriptState(page, 'settlement correction card never mounted'); throw new Error('settlement correction card never rendered'); }
        const scText = await cardText(page, 'settlement-correction-card', 'recorded backwards');
        check('a settlement correction renders the confirmation card with its reason',
            /WIN/i.test(scText) && /recorded backwards/.test(scText),
            scText.replace(/\s+/g, ' ').slice(0, 140));
        await shootCard(page, path.join(evidenceDir, 'stop2-settlement-correction.png'), cardSC, 'settlement correction card');

        // The rest of the set: the cards this run already stood up, captured
        // into docs/evidence the same way (the .probe-artifacts copies stay
        // for the failure triage).
        const riskCards = page.locator('[data-testid="trade-chat-panel"] [data-testid="risk-change-card"]');
        if (await riskCards.count() > 0) {
            await shootCard(page, path.join(evidenceDir, 'stop2-risk-change.png'), riskCards.last(), 'risk change card');
        }
        const presentedCards = page.locator('[data-testid="trade-chat-panel"] [data-testid="trade-proposal-card"]');
        if (await presentedCards.count() > 0) {
            await shootCard(page, path.join(evidenceDir, 'stop2-presented.png'), presentedCards.last(), 'presented plan card');
        }

        check('zero pageerrors across the decision-card run', pageErrors.length === 0,
            pageErrors.slice(0, 3).join(' | '));
        await browser.close();
    } catch (err) {
        console.error('DECISION CARD PROBE FAIL (driver):', err && err.message || err);
        console.error('  [mock]', mockOut.slice(-400).split('\n').join(' | '));
        for (const line of consoleLog.slice(-14)) console.error('  ·', line);
        process.exitCode = 1;
    } finally {
        for (const t of wsTimers) clearInterval(t);
        server.kill();
        mock.kill();
    }
    if (failures.length) {
        console.error(`\nDECISION CARD PROBE FAILED — ${failures.length} check(s):`);
        for (const f of failures) console.error(' • ' + f);
        process.exitCode = 1;
        return;
    }
    if (process.exitCode !== 1) {
        console.log('\nDECISION CARD PROBE OK — the card presents, Ask-why pre-fills, Approve logs one');
        console.log('row with a receipt the thread reads, Undo reverses the whole approval, a stale');
        console.log('plan needs a re-confirm, Reject records the decline, and a risk change applies');
        console.log("through the trader's own settings path (one tap tight, two taps loose, revert).");
        console.log('The session guard stands a consumed session down on the card and the writer');
        console.log('alike, and the only way back is a gated risk-change card (tight one tap,');
        console.log('loose two taps). A strategy plan proposed as a draft can be proposed');
        console.log('active by the agent and applied only by the tap, through the same writer');
        console.log('Settings uses, with the same revert window.');
    }
}

void main();
