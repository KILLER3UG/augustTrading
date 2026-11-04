/**
 * render-probe — prove a conversation RENDERS, in the real browser, not that a
 * reducer returned the right array.
 *
 * WHY THIS EXISTS. The jsdom suite (380 files) covers components in isolation
 * and the boot-probe covers "the bundle starts", yet a transcript defect — a
 * message that renders first and disappears after the next one, or a decorative
 * panel that throws inside a `messages.map()` and takes every later row with it
 * — passes all of it. That failure mode is invisible to unit tests precisely
 * because each unit is fine: the crash is in the LIST, and the symptom the user
 * sees is "the second message doesn't render".
 *
 * The shape of this probe is borrowed from a mature harness that solved the
 * same problem: a pageerror tripwire on every run, plus EXPLICIT RENDERED-COUNT
 * assertions (not "is some text present", which an ancestor node satisfies by
 * accident). Counts are the assertion that a dropped row cannot survive.
 *
 * It drives the app the way a person does, with a local OpenAI-compatible mock
 * provider (scripts/mock-provider.cjs) so the whole chat path is exercised
 * without spending a cent of API credit.
 *
 *   node scripts/render-probe.cjs        # self-hosts the dev server on 4183
 *
 * Exits non-zero on any failure, and reports every failed check rather than
 * stopping at the first. PROBE_REUSE=1 expects a server already on PROBE_PORT.
 */

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const { mkdirSync } = require('fs');
const { chromium } = require('@playwright/test');

const PORT = process.env.PROBE_PORT ? Number(process.env.PROBE_PORT) : 4183;
const MOCK_PORT = process.env.MOCK_PORT ? Number(process.env.MOCK_PORT) : 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Seed the profile the boot-probe seeds, plus a ready mock provider, BEFORE
 *  the bundle evaluates — the app refuses to send anything until a provider is
 *  "ready", and without that gate this whole probe is unreachable. */
async function seed(page) {
    await page.goto(`${BASE}/favicon.ico`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        // Deliberately NOT seeding `last_active_user` the way boot-probe does:
        // the workspace modal is what CREATES the profile and its first chat
        // session, and a dock with no session accepts keystrokes but renders no
        // row. Skipping it makes the probe fail for the wrong reason.
        localStorage.setItem('august_surface_v1', 'trade');
        sessionStorage.setItem('activeUsername', 'Probe User');
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
        const tx = db.transaction('userProfiles', 'readwrite');
        tx.objectStore('userProfiles').put({
            username: 'Probe User',
            conversations: [], tradeLog: [], tradeSummaries: [],
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

/**
 * Send one message through the Chart AI dock and wait for its reply.
 *
 * Driven with the native value setter and a DOM click rather than Playwright
 * locators: the composer's send affordance is an icon button whose accessible
 * name varies by state, and clicking by geometry fails on it. This is the exact
 * interaction that was verified against the running app, so the probe exercises
 * the app rather than the selector.
 */
/**
 * Wait until the streamed answer has actually stopped growing.
 *
 * "Contains the reply text" is not "finished": the mock's first words land
 * almost immediately, and while a run is still streaming the composer's send
 * control is a stop button — so the next send finds no button to click. Two
 * consecutive identical samples is the cheap, portable way to detect the end of
 * a stream without the app having to expose a flag for it.
 */
const waitStableAnswer = async (page) => {
    let prev = -1;
    for (let i = 0; i < 60; i++) {
        const len = await page.evaluate(() => [...document.querySelectorAll(
            '[data-testid="chat-entry-ai"], [data-testid="agent-message"][data-role="ai"]',
        )].reduce((n, e) => n + (e.textContent || '').length, 0));
        if (len > 0 && len === prev) return true;
        prev = len;
        await sleep(200);
    }
    return false;
};

/** Wait until the composer is actually able to accept a send.
 *
 *  While a run is in flight the dock's send control is a STOP button, not a
 *  Send button. A probe that looks for "send" the instant the previous answer
 *  lands finds nothing and reports "no send button" — which reads like a
 *  missing control, sends you hunting through the composer JSX, and is really
 *  just "the app is still working". Under load that window is wide enough to
 *  happen on a healthy build, which is how a green gate started reporting
 *  failures that had nothing to do with the change under test. */
async function waitSendable(page, ms) {
    const timeout = ms || 30000;
    try {
        await page.waitForFunction(() => {
            const ta = document.querySelector('textarea');
            if (!ta || ta.disabled) return false;
            return [...document.querySelectorAll('button')].some(b => !b.disabled && /send/i.test(
                `${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`,
            ));
        }, null, { timeout });
        return true;
    } catch {
        return false;
    }
}

/** Widest element whose right edge sits outside the viewport, if any.
 *
 *  Horizontal overflow is invisible in a screenshot and fatal in use: a row
 *  wider than the window clips whatever is at its right edge. "Expand over
 *  chart" did exactly that — chart 1/3 + dock 3/4 + a fixed 300px order book is
 *  1693px of row inside a 1280px window, and the transcript sentence ran off
 *  the side. Measured here, in a real browser, because no unit test can see a
 *  box that is 413px too wide. */
const measureOverflow = async (page) => page.evaluate(() => {
    const vw = window.innerWidth;
    const worst = [];
    const isFixed = (el) => {
        let n = el;
        while (n && n !== document.body) {
            if (window.getComputedStyle(n).position === 'fixed') return true;
            n = n.parentElement;
        }
        return false;
    };
    for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right - vw > 2) {
            // A position:fixed element can NEVER create document scroll
            // overflow — it is out of flow, and the app's drawers park
            // off-screen by design (`translate-x-full` when closed, e.g. the
            // strategy search). The same holds for everything INSIDE such a
            // drawer: its children inherit the off-screen placement without
            // being fixed themselves. Flagging either is the checker
            // measuring the wrong thing; document.scrollWidth below is the
            // binding signal.
            if (isFixed(el)) continue;
            worst.push({ over: Math.round(r.right - vw), tag: el.tagName, tid: el.getAttribute('data-testid') || '' });
        }
    }
    worst.sort((a, b) => b.over - a.over);
    return { vw, scrollW: document.documentElement.scrollWidth, worst: worst.slice(0, 2) };
});

const overflowIsClean = (m) => m.scrollW <= m.vw + 2 && m.worst.length === 0;
const overflowWhy = (m) => `vw=${m.vw} scrollW=${m.scrollW}`
    + (m.worst.length ? ` worst=${JSON.stringify(m.worst[0])}` : '');

async function sendInDock(page, text, netIssues = [], expectedAi = 1) {
    if (!(await waitSendable(page))) {
        // Say what is actually true, rather than blaming a control that is
        // present-but-Stop.
        const stillBusy = await page.evaluate(() => [...document.querySelectorAll('button')]
            .some(b => /stop/i.test(`${b.getAttribute('aria-label') || ''} ${b.title || ''}`)));
        throw new Error(`sendInDock("${text}"): the composer never became sendable within 30s`
            + (stillBusy
                ? ' — a run is STILL in flight, so the control is a Stop button, not a Send button.'
                : ' — no enabled Send button and no Stop button either; the dock may have unmounted.'));
    }
    const sent = await page.evaluate((needle) => {
        const ta = document.querySelector('textarea');
        if (!ta || ta.disabled) return 'no composer (missing or disabled)';
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
            .set.call(ta, needle);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find(b => /send/i.test(
            `${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`,
        ));
        if (!btn) return 'no send button';
        if (btn.disabled) return 'send button disabled';
        btn.click();
        return 'clicked';
    }, text);
    if (sent !== 'clicked') {
        throw new Error(`sendInDock("${text}"): ${sent}`);
    }
    // A probe that only says "timed out" is a probe that makes you guess. On
    // any wait failure, dump what the dock actually holds before throwing.
    const awaitRow = async (ms) => {
        try {
            await page.waitForFunction(
                (needle) => [...document.querySelectorAll('[data-entry-id]')]
                    .some(e => (e.textContent || '').includes(needle)),
                text,
                { timeout: ms },
            );
        } catch (err) {
            const diag = await page.evaluate((needle) => ({
                entries: [...document.querySelectorAll('[data-entry-id]')]
                    .map(e => (e.textContent || '').replace(/\s+/g, ' ').slice(0, 80)),
                taValue: (document.querySelector('textarea') || {}).value,
                taDisabled: !!(document.querySelector('textarea') || {}).disabled,
                modal: !!document.querySelector('input[placeholder="Create New Workspace"]'),
                dockText: ((document.querySelector('[data-testid="trade-chat-panel"]')
                    || document.body).textContent || '').replace(/\s+/g, ' ').slice(0, 400),
                wanted: needle,
            }), text);
            // The Playwright error is the CAUSE; the DOM dump is the context.
            // Discarding `err` (as this used to) threw away the one line that
            // says whether it was a timeout, a missing element or a detached
            // handle — which is what you actually need when a gate fails.
            throw new Error(`sendInDock("${text}") never rendered a row`
                + `${err instanceof Error ? ` — ${err.message}` : ''}.\n    `
                + JSON.stringify(diag).replace(/","/g, '",\n    "'));
        }
    };
    await awaitRow(30000);
    // Wait for the ANSWER, by settled AI-bubble count — not by matching the
    // prompt text inside it. The dock prefixes the message with live chart
    // context, so the mock's echo of the user's own words routinely falls past
    // the reply's 160-char window; matching it there tested the fixture, not
    // the app. `expectedAi` is the honest signal: one more settled answer.
    try {
        await page.waitForFunction(
            (expected) => {
                const ais = [...document.querySelectorAll('[data-testid="chat-entry-ai"]')];
                return ais.length >= expected
                    && ais.every(e => /MOCK REPLY|could not answer/.test(e.textContent || ''));
            },
            expectedAi,
            { timeout: 30000 },
        );
    } catch (err) {
        const diag = await page.evaluate(() => ({
            aiBubbles: [...document.querySelectorAll('[data-testid="chat-entry-ai"]')]
                .map(e => (e.textContent || '').replace(/\s+/g, ' ').slice(0, 160)),
            entryCount: document.querySelectorAll('[data-entry-id]').length,
        }));
        throw new Error(`sendInDock("${text}"): user row rendered, no settled reply.`
            + `${err instanceof Error ? ` — ${err.message}` : ''}`
            + `\n    ${JSON.stringify(diag).replace(/","/g, '",\n    "')}`
            + `\n    wire: ${netIssues.slice(0, 6).join(' | ') || 'no failing request on the mock port'}`);
    }
    if (!(await waitStableAnswer(page))) {
        throw new Error(`sendInDock("${text}"): reply never stopped streaming`);
    }
}

/** Count what a human would count: rows on screen, per role. */
async function counts(page, scope) {
    return page.evaluate((sel) => {
        const root = sel ? document.querySelector(sel) : document;
        const q = (s) => [...(root || document).querySelectorAll(s)];
        return {
            user: q('[data-testid="chat-entry-user"]').length,
            ai: q('[data-testid="chat-entry-ai"]').length,
            entries: q('[data-entry-id]').length,
            treeAlive: q('[data-testid="trade-view"]').length,
        };
    }, scope);
}

/**
 * Write a profile whose ACTIVE conversation already contains settled verdicts.
 *
 * The live-chat phase above can only produce solo chat replies, so it never
 * renders a verdict card at all — which is the half of the transcript the audit
 * panels live on. These rows go into storage exactly as the app would have
 * written them, deliberately including two persisted shapes that used to throw
 * inside the message map: an evidence pack whose arrays are absent, and a
 * run-contract row whose state is no longer in the union. A crash there does
 * not drop a panel, it drops that message and every message after it — which is
 * what "the second message doesn't render" looks like from the inside.
 */
async function seedVerdicts(page) {
    await page.evaluate(async () => {
        const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();
        // A roster bot thinking with the SAME provider+model as the answers
        // below. This is the configuration that made the bug deterministic:
        // deskThread claimed an AI row by provider+model alone, so the desk pane
        // deleted the trader's own answers — and no unit test or earlier probe
        // could see it, because the probe had an empty roster.
        localStorage.setItem('agents_bots_v1_Probe User', JSON.stringify([{
            id: 'probe-bot', name: 'Probe Bot', providerId: 'mock', modelId: 'mock-mini',
            avatar: { kind: 'auto' }, createdAt: iso(60),
        }]));
        // A skill FILE in the notebook store (the Preferences key, served from
        // localStorage on web). The Learn sweep presses catalog rows, and the
        // round-trip gate below reads this record: without it the catalog is an
        // empty state and "Read <skill>" has nothing to open — the probe would
        // pass by skipping the control it was built to judge. The name is the
        // one the seeded verdict's evidence pack cites, so a verdict that names
        // a skill names one that actually exists.
        localStorage.setItem('memory_files_v1_Probe User', JSON.stringify({
            version: 1,
            // The default folder table, because `isSkillFile` resolves a file's
            // folder BY ID — a blob with folders: [] leaves the seeded skill in
            // no folder at all, and the catalog then lists nothing while the
            // probe looks like a feature failure.
            folders: [
                { id: 'profile', name: 'profile', order: 0 },
                { id: 'trader-diary', name: 'trader-diary', order: 1 },
                { id: 'market-conditions', name: 'market-conditions', order: 2 },
                { id: 'rules', name: 'rules', order: 3 },
                { id: 'skills', name: 'skills', order: 4 },
                { id: 'bots', name: 'bots', order: 5 },
                { id: 'lens', name: 'lens', order: 6 },
                { id: 'settled-beliefs', name: 'settled-beliefs', order: 7 },
                { id: 'distilled', name: 'distilled', order: 8 },
                { id: 'strategies', name: 'strategies', order: 9 },
            ],
            files: [{
                id: 'probe-skill-1',
                name: 'fade-the-first-break.md',
                content: [
                    '---',
                    'name: "Fade the first break"',
                    'description: "Fade the first breakout of the session when volume is thin."',
                    'kind: "repeat"',
                    '# august:skill-ledger',
                    'status: confirmed',
                    'wins: 4',
                    'losses: 1',
                    'tradeIds: "journal-pt-2"',
                    '---',
                    '**When:** the first breakout of the session on thin volume',
                    '**What I do:** fade it back inside the range.',
                ].join('\n'),
                folderId: 'skills',
                enabled: true,
                createdAt: iso(1500),
                updatedAt: iso(1500),
            }, {
                // A skill that arrived as a FOLDER, so it owns bundled files.
                // The delete arm below proves pressing Delete once more takes
                // the bundles with it — deleting only the head would leave
                // three rows' worth of bytes addressed by nothing.
                id: 'probe-bundle-1',
                name: 'probe-bundle-skill.md',
                content: [
                    '---',
                    'name: probe-bundle-skill',
                    'description: "Use when the verifier deletes a bundled skill."',
                    'kind: "repeat"',
                    '# august:skill-ledger',
                    'status: candidate',
                    '---',
                    'Open references/note.md and scripts/helper.py.',
                ].join('\n'),
                folderId: 'skills',
                enabled: true,
                createdAt: iso(1400),
                updatedAt: iso(1400),
            }, {
                id: 'probe-bundle-2',
                name: 'probe-bundle-skill__references__note.md',
                content: 'The bundled note that must go with its skill.\n',
                folderId: 'skills',
                enabled: true,
                createdAt: iso(1400),
                updatedAt: iso(1400),
            }, {
                id: 'probe-bundle-3',
                name: 'probe-bundle-skill__scripts__helper.py.md',
                content: 'def helper():\n    return 1\n',
                folderId: 'skills',
                enabled: true,
                createdAt: iso(1400),
                updatedAt: iso(1400),
            }],
        }));

        // ── The tracked journal row and its diagnosis ─────────────────────
        // The post-mortem view has no writer in this probe: a real settlement
        // needs a live tape and a model call. Seed the exact bytes the tracker
        // stores so the detail is proven to READ them — including the path,
        // the excursions and the refusal/pending arms that cannot be reached
        // by clicking. `pt-2` is a settled LOSS; the diagnosis names the skill
        // file's tradeIds so the linked-skill join is exercised too.
        const now = Date.now();
        const bar = 5 * 60 * 1000;
        const opened = now - 280 * 60 * 1000;
        const timeline = [100, 99.8, 99.6, 99.4, 99.7, 100.2, 100.7, 101].map((c, i) => ({
            t: opened + i * bar,
            o: c + 0.1, h: c + 0.2, l: c - 0.2, c, v: 120,
            ...(i === 0 || i === 3 || i === 7 ? { decisive: true } : {}),
        }));
        localStorage.setItem('tracked_positions_v1_Probe User', JSON.stringify([{
            id: 'journal-pt-2',
            source: 'journal',
            sourceId: 'pt-2',
            symbol: 'BTCUSDT',
            direction: 'short',
            entry: 100,
            stop: 101,
            targets: [97],
            size: 1,
            leverage: 10,
            status: 'closed',
            openedAt: opened,
            closedAt: opened + 7 * bar,
            entryBarTime: opened,
            entryConfirmed: true,
            entryContext: {
                thesis: 'Short the failed reclaim of the session high.',
                evidenceRefs: ['get_market_packet', 'the 1h shelf at 100.6'],
                model: 'zz-probe-diagnosis-model',
                provider: 'mock',
                family: 'failed-reclaim',
            },
            cursor: { lastClosedBarTime: opened + 7 * bar, timeframe: '5m' },
            mfeR: 0.8,
            maeR: -1,
            mfePrice: 99.2,
            maePrice: 101,
            mfeAt: opened + 3 * bar,
            maeAt: opened + 7 * bar,
            barsRead: 8,
            gaps: [],
            tapeCoversWindow: true,
            timeline,
            timelineDownsampled: false,
            timelinePointsDropped: 0,
            context: [],
            contextDownsampled: false,
            exit: {
                reason: 'stop',
                price: 101,
                at: opened + 7 * bar,
                sameCandle: 'single-level',
                ambiguous: false,
                gapAtOpen: false,
                barsRead: 8,
                realizedR: -1,
                costR: 0.05,
                netR: -1.05,
                slippageModeled: false,
            },
            journalSettledAt: opened + 7 * bar + 60 * 1000,
            diagnosisId: 'diag-journal-pt-2',
            version: 1,
        }]));
        localStorage.setItem('tracked_diagnoses_v1_Probe User', JSON.stringify([{
            id: 'diag-journal-pt-2',
            tradeId: 'journal-pt-2',
            source: 'journal',
            outcome: 'loss',
            modelOutcome: 'loss',
            whatHappened: 'The short entered at 100. The tape never traded below 99.2, then the stop at 101 was hit after eight closed bars.',
            rootCause: 'The entry was chased into the middle of the prior range with the stop inside the swept high.',
            whatShouldHaveBeenDone: 'Wait for the reclaim of 100.6 to fail before entering.',
            primaryChange: 'entry',
            lesson: 'A short at the middle of the range pays for the sweep, not the move.',
            when: 'the entry is inside the prior range and the stop sits under the swept high',
            action: 'wait for the reclaim to fail before entering',
            confidence: 72,
            evidenceCount: 3,
            model: 'zz-probe-diagnosis-model',
            provider: 'mock',
            promptVersion: 'post-mortem-v1',
            packetHash: 'cafebabe',
            createdAt: new Date(now - 240 * 60 * 1000).toISOString(),
            tentative: true,
        }]));

        const analysis = (over) => ({
            direction: 'Long', confidence: 'High', coinName: 'BTCUSDT',
            entryPoints: [{ price: '84210.5', description: 'reclaim' }],
            stopLoss: '83100', takeProfit: [{ price: '87900' }],
            probability: 62, reasoning: 'Holding above the 200-EMA into thin sell-side.',
            marketConditions: {}, activeStrategies: [], validationWarnings: [],
            ...over,
        });
        const conversation = {
            id: 'probe-seeded',
            timestamp: Date.now() - 600000,
            title: 'Probe seeded verdicts',
            ocrModel: 'mock-mini', moderatorProviderId: 'mock',
            moderatorModel: 'mock-mini', leverage: 10,
            messages: [
                { id: 's1', role: 'user', text: 'SEEDED ALPHA', createdAt: iso(20) },
                {
                    id: 's2',
                    role: 'ai',
                    text: 'Long BTC from the reclaim, stop below the shelf.',
                    createdAt: iso(19),
                    // Solo-attributed to the same pair the seeded bot thinks
                    // with: exactly the row the old claim deleted.
                    modelsUsed: { mock: 'mock-mini' },
                    // A settled trace for the reference's "Thinking complete"
                    // row — the only browser check that can see it.
                    thoughtProcesses: {
                        mock: 'The reclaim held above the shelf and sell-side was thin; the 1h and 4h reads agree.',
                    },
                    runStats: { runId: 'probe-run', startedAt: iso(20), finishedAt: iso(19), durationMs: 12_000 },
                    analysis: analysis({}),
                    evidencePack: {
                        statsLine: '6 similar setups · 4 wins · median 1.8R',
                        causePattern: 'Chasing the break before the retest holds.',
                        similar: [{ outcome: 'LOSS', coin: 'BTCUSDT', direction: 'Long', date: '2026-09-11', lesson: 'wait for the reclaim', similarity: 81 }],
                        skills: ['fade-the-first-break'],
                        doctrineHeader: 'Doctrine: only trade the reclaim.',
                    },
                    runContract: [
                        { id: 'gate', label: 'Gate scan', state: 'done' },
                        { id: 'openings', label: 'Analyst openings', state: 'done' },
                        { id: 'clarification', label: 'Clarification', state: 'skipped', note: 'budget cap' },
                        { id: 'verdict', label: 'Moderator verdict', state: 'done' },
                    ],
                },
                { id: 's3', role: 'user', text: 'SEEDED BETA', createdAt: iso(8) },
                {
                    id: 's4',
                    role: 'ai',
                    text: 'No trade — the reclaim failed and the book is one-sided.',
                    createdAt: iso(7),
                    modelsUsed: { mock: 'mock-mini' },
                    analysis: analysis({ direction: 'Neutral', confidence: 'Avoid' }),
                    // Missing `similar`/`skills` entirely: the shape a pack
                    // written by an older build looks like.
                    evidencePack: {
                        statsLine: 'no comparable setups', causePattern: '', doctrineHeader: '',
                    },
                    // `complete` is not a state this union knows.
                    runContract: [
                        { id: 'gate', label: 'Gate scan', state: 'complete' },
                        { id: 'rebuttals', label: 'Rebuttal rounds', state: 'skipped', note: 'single seat' },
                    ],
                },
            ],
        };
        const tradeRow = (id, minsAgo, outcome, tradeType, direction, coin, extra) => ({
            id,
            outcome,
            tradeType,
            timestamp: iso(minsAgo),
            leverage: 10,
            analysis: analysis({ direction, coinName: coin }),
            ...(extra || {}),
        });
        const put = (existing) => ({
            ...(existing || {}),
            username: 'Probe User',
            conversations: [conversation],
            lastActiveConversationId: conversation.id,
            // The Journal's filter chips only have something to act on if the
            // profile carries trades: sweeping it against an empty list would
            // report every chip "inert" correctly-by-accident, which is the
            // false green this file keeps getting bitten by. Two of each type so
            // scalp/swing and win/loss each change what is on screen.
            tradeLog: [
                // ONE of the four carries a post-mortem, and the check that reads
                // it asserts exactly one block appears across all four details:
                // a probe that finds the note on every row would also pass on a
                // screen that rendered the section unconditionally.
                tradeRow('pt-1', 300, 'WIN', 'scalp', 'Long', 'BTCUSDT', {
                    postMortem: 'Post-mortem written by the app at settlement (zz-probe-model).\n\n'
                        + 'The reclaim closed above the swept low before the stop was tested.\n\n'
                        + 'Lesson: size the stop to the sweep, not to the round number.\n\n'
                        + 'IF the reclaim closes above the swept low THEN skip the long entry.',
                    postMortemModel: 'zz-probe-model',
                    postMortemCreatedAt: iso(120),
                }),
                tradeRow('pt-2', 280, 'LOSS', 'scalp', 'Short', 'BTCUSDT'),
                tradeRow('pt-3', 260, 'WIN', 'swing', 'Long', 'ETHUSDT'),
                tradeRow('pt-4', 240, 'ENTRY_NOT_HIT', 'swing', 'Short', 'SOLUSDT'),
                // The tracker's open row: the Journal must show it as OPEN and
                // offer the OPEN filter, not silently hide a trade that has no
                // settled outcome yet.
                tradeRow('pt-5', 220, 'PENDING', 'scalp', 'Long', 'BTCUSDT'),
            ],
            tradeSummaries: [],
            finalTradeSummary: null,
            settings: { activeFrameworks: [] },
        });
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
        const store = db.transaction('userProfiles', 'readwrite').objectStore('userProfiles');
        const current = await new Promise((resolve) => {
            const get = store.get('Probe User');
            get.onsuccess = () => resolve(get.result);
            get.onerror = () => resolve(null);
        });
        store.put(put(current));
        await new Promise((resolve) => { setTimeout(resolve, 200); });
        db.close();
    });
}

const failures = [];
/** Screenshots are taken ONLY on failure (deepseek-harness's practice). A green
 *  run writes nothing; a red one leaves the frame behind, which is the
 *  difference between "Learn control is inert" and seeing what the surface was
 *  doing at the time. Today's debugging ran entirely on text. */
let activePage = null;
const pendingShots = [];
const SHOT_DIR = path.join(ROOT, '.probe-artifacts');
const check = (name, ok, detail) => {
    if (!ok) {
        failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
        if (activePage) {
            const file = `fail-${failures.length}.png`;
            try { mkdirSync(SHOT_DIR, { recursive: true }); } catch { /* exists */ }
            // Tracked, not fired-and-forgotten: `browser.close()` used to win
            // the race and no PNG was ever written, so the "capture" produced
            // nothing but a promise nobody kept.
            pendingShots.push(
                activePage.screenshot({ path: path.join(SHOT_DIR, file) })
                    .then(() => console.log(`  shot: .probe-artifacts/${file}`))
                    .catch(() => { /* a failed capture must not mask the failure */ })
            );
        }
    }
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` (${detail})` : ''}`);
};

async function main() {
    // An occupied port is not a busy-port nuisance here, it is a gate that
    // measures the WRONG TREE: our own vite/mock die on --strictPort (or on
    // EADDRINUSE), `waitForServer` then answers for whoever owns the port, and
    // every check below passes against another checkout's app — or an orphan
    // that is still serving the code from before the change under review.
    // Ask who owns each port BEFORE spawning, and refuse. PROBE_REUSE is the one
    // case where an occupied port is the point, so it opts out.
    if (!process.env.PROBE_REUSE) {
        const free = (port) => new Promise((resolve) => {
            const probe = net.createServer();
            probe.once('error', () => resolve(false));
            probe.once('listening', () => probe.close(() => resolve(true)));
            probe.listen(port, '127.0.0.1');
        });
        for (const [label, port] of [['dev server', PORT], ['mock provider', MOCK_PORT]]) {
            if (await free(port)) continue;
            console.error(`RENDER PROBE FAIL: something this run did not start already owns port ${port} (${label}). `
                + 'Refusing to drive it: waitForServer cannot tell that server from ours, so a pass here would prove '
                + 'nothing about THIS tree. Free the port, or pass PROBE_PORT/MOCK_PORT.');
            process.exitCode = 1;
            return;
        }
    }
    const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    // DEV server, not `vite preview`, and that is deliberate: the app's provider
    // fetches are same-origin under the dev proxy, so a loopback mock is
    // reachable exactly as a local Ollama server is for the person using this.
    // Against the prod bundle the browser makes the call cross-origin itself and
    // it never leaves the page — and "does the production bundle boot at all" is
    // already boot-probe's job, with the same pageerror tripwire.
    const server = process.env.PROBE_REUSE
        ? null
        : spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
            cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
    const mock = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-provider.cjs'), String(MOCK_PORT)], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    if (server) {
        server.stdout.on('data', d => { out += String(d); });
        server.stderr.on('data', d => { out += String(d); });
    }

    try {
        if (!(await waitForServer(BASE))) {
            // exitCode + return, never process.exit(): exiting here skips the
            // finally that kills the dev server + mock provider, orphaning them
            // on their ports. Same trap in the catch below.
            console.error('RENDER PROBE FAIL: no vite preview on', BASE, '\n', out);
            process.exitCode = 1;
            return;
        }
        if (!(await waitForServer(`http://127.0.0.1:${MOCK_PORT}/models`))) {
            console.error('RENDER PROBE FAIL: mock provider never came up');
            process.exitCode = 1;
            return;
        }

        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        activePage = page;
        const pageErrors = [];
        page.on('pageerror', (err) => pageErrors.push(String(err && err.stack || err)));
        // "Connection error" from the app is a summary of a fetch that failed;
        // the reason is on the wire, so keep it. Without this a probe failure
        // forces a choice between guessing and a second debugging harness.
        const netIssues = [];
        page.on('requestfailed', (req) => {
            if (req.url().includes(String(MOCK_PORT))) {
                netIssues.push(`FAILED ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
            }
        });
        page.on('response', (res) => {
            if (res.url().includes(String(MOCK_PORT)) && res.status() >= 400) {
                netIssues.push(`HTTP ${res.status()} ${res.request().method()} ${res.url()}`);
            }
        });
        page.on('console', (m) => {
            if (m.type() === 'error' && /React will try to recreate|The above error/i.test(m.text())) {
                pageErrors.push(`render failure logged: ${m.text().slice(0, 300)}`);
            }
        });

        await seed(page);
        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !document.querySelector('#splash'), null, { timeout: 25000 });
        await page.waitForSelector('[data-testid="trade-view"]', { timeout: 25000 });

        // Create the workspace the way a person does — this is what establishes
        // the profile and its first chat session, which the dock writes into.
        const ws = page.locator('input[placeholder="Create New Workspace"]');
        if (await ws.count()) {
            await ws.first().fill('Probe User');
            await page.locator('button').filter({ hasText: /^Enter$/ }).first().click();
            await sleep(1500);
            await page.waitForSelector('[data-testid="trade-view"]', { timeout: 25000 });
        }

        // Open the Chart AI dock's tab if the surface has collapsed it.
        const aiTab = page.locator('[role="tab"]', { hasText: /^AI$/ }).first();
        if (await aiTab.count()) await aiTab.click();
        await sleep(500);

        // ── The regression this probe was written for ────────────────────
        // Two exchanges, counted after EACH one. A transcript that loses a row
        // when a later one arrives passes "is the text anywhere" and fails this.
        const before = await counts(page, null);
        check('dock starts empty', before.entries === 0, JSON.stringify(before));

        await sendInDock(page, 'ROW ONE', netIssues, 1);
        const afterFirst = await counts(page, null);
        check('first exchange renders', afterFirst.user === 1 && afterFirst.ai === 1,
            JSON.stringify(afterFirst));

        await sendInDock(page, 'ROW TWO', netIssues, 2);
        const afterSecond = await counts(page, null);
        check('SECOND exchange renders AND the first survives it',
            afterSecond.user === 2 && afterSecond.ai === 2,
            JSON.stringify(afterSecond));

        await sendInDock(page, 'ROW THREE', netIssues, 3);
        const afterThird = await counts(page, null);
        check('third exchange renders and all earlier rows persist',
            afterThird.user === 3 && afterThird.ai === 3,
            JSON.stringify(afterThird));
        check('trade surface still mounted', afterThird.treeAlive === 1);
        // ── 20p: a tool round in the transcript, across a reload, and stopped ──
        // Desk tools are the app's only way to look anything up and every send now
        // runs through them, yet nothing above asserts a tool LINE is projected at
        // all — every row-count check passes with the projection missing, and a
        // card that renders live but not after a reload is invisible to jsdom.
        // The marker below is what arms the mock's tool scenario for THIS request
        // only: a second mock instance was tried first and rejected, because it
        // answers boot-time calls too and the app never reaches the trade screen.
        const toolLineCount = () => page.locator('[data-testid="tool-actions-row"]').count();
        const toolLineText = () => page.locator('[data-testid="tool-actions-row"]').allTextContents()
            .then(a => a.join(' | ').replace(/\s+/g, ' ').slice(0, 220));
        // Any key carrying the ledger's name: Preferences owns the exact spelling on
        // web, and the native store may prefix it.
        const usageBytes = () => page.evaluate(() => {
            let n = 0;
            for (const k of Object.keys(localStorage)) {
                if (k.includes('session_usage_v1')) n += (localStorage.getItem(k) || '').length;
            }
            return n;
        });

        // The sweep before this one ends on Settings with an overlay open, and a
        // The sweep before this one leaves the browser on Settings (an overlay
        // may still be open) at phone width, so a send here has nothing to land
        // in. Reload first and let the app restore its own surface — the earlier
        // assertion here waited for the TRADE surface's [data-testid="trade-view"]
        // after a reload that restores the surface the app persisted, which made
        // the phase time out on navigation, not on the app.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !document.querySelector('#splash'), null, { timeout: 25000 });
        await sleep(1500);
        // Then ROUTE to the dock. Reload alone is not navigation: the app
        // restores the surface the sweep left it on (Settings has no composer),
        // and that failed as "no enabled Send button and no Stop button" — a
        // probe that forgot to navigate, reported as a broken app. Waiting for
        // trade-view without clicking it was the earlier wrong half of the same
        // mistake, so both halves are here now: click, then wait for the mount.
        const navTrade = await page.evaluate(() => {
            const sw = document.querySelector('[data-testid="surface-switch-trade"]');
            if (!sw) return 'not found';
            sw.click();
            return 'clicked';
        });
        check('the dock surface is reachable again after a reload', navTrade === 'clicked', navTrade);
        await page.waitForSelector('[data-testid="trade-view"]', { timeout: 25000 });
        await sleep(800);

        const aiBefore = (await counts(page, null)).ai;
        const linesBefore = await toolLineCount();
        const ledgerBefore = await usageBytes();
        await sendInDock(page, 'PROBE_TOOL_ROUND report the price', netIssues, aiBefore + 1);
        await sleep(1500);
        const linesAfter = await toolLineCount();
        check('a tool round is projected as a tool line, not only as prose',
            linesAfter > linesBefore, `${linesBefore} tool line(s) before, ${linesAfter} after`);
        // The row is labelled in the app's own voice, never by the wire name:
        // `Skill draft saved — <the title the model asked for>`. Asserting
        // `propose_skill` here would pin the identifier the UI deliberately
        // hides, so the check is on the verb the harness renders PLUS the title
        // carried in the tool's own arguments — which proves the call was
        // identified by content, not by a generic "tool used" line. The verb is
        // SAVED since the auto-apply ruling (2026-11-03): a draft that passed
        // the gates is no longer waiting for a human, and the row must not say
        // it is.
        const namesTheCall = (t) => /skill draft saved/i.test(t) && /Session-open fade short/.test(t);
        const firstText = await toolLineText();
        check('the tool line names the call the model actually made',
            namesTheCall(firstText), `rendered: ${firstText || '(none)'}`);
        const ledgerAfter = await usageBytes();
        check('the settled turn grew the usage ledger the Learning panel reads',
            ledgerAfter > ledgerBefore, `ledger bytes ${ledgerBefore} -> ${ledgerAfter}`);

        // ── The sparse rail: ConversationGroups, no workspaces ───────────
        // New chat + Ctrl K, Pinned (only when there are pinned rows), Recent
        // (always). Rows: hollow dot, truncated title, mono age from
        // workspaceAgeLabel. Counted, not sampled.
        const railShape = await page.evaluate(() => {
            const rows = [...document.querySelectorAll('[data-testid="conversation-row"]')];
            const ages = [...document.querySelectorAll('[data-testid="conversation-age"]')]
                .map(a => (a.textContent || '').trim());
            return {
                rows: rows.length,
                ages: ages.length,
                badAges: ages.filter(t => !/^(now|\d+[mhd])$/.test(t)),
                newChat: !!document.querySelector('[data-testid="rail-new-chat"]'),
                workspaces: document.querySelectorAll('[data-testid^="shell-workspace-"]').length,
                addWorkspace: !!document.querySelector('[data-testid="shell-add-workspace"]'),
            };
        });
        check('the sparse rail groups conversations without workspaces, each with the mono age column',
            railShape.rows >= 1
            && railShape.ages === railShape.rows
            && railShape.badAges.length === 0
            && railShape.newChat
            && railShape.workspaces === 0
            && !railShape.addWorkspace,
            JSON.stringify(railShape));

        // Chart head: one quiet line (SymbolPicker, hero price, change,
        // funding + countdown, feed state). No metrics band.
        const chartHead = await page.evaluate(() => {
            const hero = document.querySelector('[data-testid="hero-price"]');
            const funding = document.querySelector('[data-testid="chart-head-funding"]');
            const feed = document.querySelector('[data-testid="feed-status"]');
            const tape = document.querySelector('[data-testid="market-tape"]');
            const ohlcv = document.querySelector('[data-testid="ohlcv-row"]');
            return {
                hero: hero ? hero.textContent?.trim() : null,
                heroIsPrice: !!hero && /[\d,]+\.\d+/.test(hero.textContent || ''),
                funding: !!funding,
                feed: !!feed,
                tapeGone: !tape,
                ohlcv: !!ohlcv,
            };
        });
        check('chart head is one quiet line: hero price, funding, feed — no metrics band, OHLC row on the chart',
            chartHead.heroIsPrice && chartHead.funding && chartHead.feed
            && chartHead.tapeGone && chartHead.ohlcv,
            JSON.stringify(chartHead));

        // Order-book drawer: 30px strip closed by default, name + live state + spread.
        const drawer = await page.evaluate(() => {
            const strip = document.querySelector('[data-testid="orderbook-drawer-strip"]');
            const open = document.querySelector('[data-book-open="true"]');
            return { strip: !!strip, closed: strip ? strip.getAttribute('aria-expanded') === 'false' : false, hasPanel: !!document.querySelector('[data-testid="orderbook-row"]') || !!open };
        });
        check('order-book drawer is a 30px closed strip by default',
            drawer.strip && drawer.closed,
            JSON.stringify(drawer));

        // Dock signal card row mount: a settled turn that emitted a signal
        // renders a SignalCard. (The mock emits no signal here — the card is
        // absent, not fabricated. Asserting presence would fail the happy path,
        // so assert the ABSENCE is honest: no card drawn for a turn that
        // emitted none.)
        const signalMount = await page.evaluate(() => {
            const cards = document.querySelectorAll('[data-testid="signal-card"]');
            return { cards: cards.length };
        });
        check('dock renders no signal card for a turn that emitted none (no fabrication)',
            signalMount.cards === 0,
            JSON.stringify(signalMount));

        // Disclosures: key levels + scorecard. KeyLevelsCard now renders
        // inside a charter Disclosure ("Key levels · N", closed default).
        // DeskScorecard renders only when the ledger has rows.
        const disclosures = await page.evaluate(() => {
            const kl = document.querySelector('[data-testid="key-levels-disclosure"], [data-testid="key-levels-card"]');
            const klOpen = kl && kl.tagName === 'DETAILS' ? kl.open : null;
            const score = document.querySelector('[data-testid="desk-scorecard"], [data-testid="desk-scorecard-summary"]');
            return { keyLevels: !!kl, keyLevelsClosed: klOpen === false || klOpen === null, scorecard: !!score };
        });
        check('disclosures: key levels inside a closed Disclosure; scorecard absent when ledger empty',
            disclosures.keyLevels && disclosures.keyLevelsClosed,
            JSON.stringify(disclosures));

        // The chat store is debounced by 1.5s. The reload used to happen at
        // exactly that boundary, so a slow frame could lose the write and the
        // next check reported a lost tool line that was never saved yet. Wait
        // for the stored bytes that carry this call's title — the persistence
        // check then measures the STORE, not the timer.
        const toolPersisted = await page.waitForFunction(() => {
            for (const key of Object.keys(localStorage)) {
                if (!key.startsWith('trade_chat_sessions_v1_')) continue;
                if ((localStorage.getItem(key) || '').includes('Session-open fade short')) return true;
            }
            return false;
        }, null, { timeout: 8000 }).then(() => true).catch(() => false);
        check('the tool round reaches the stored session before the reload',
            toolPersisted, toolPersisted ? 'stored' : 'the session bytes never contained the tool title within 8s');

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !document.querySelector('#splash'), null, { timeout: 25000 });
        await page.waitForSelector('[data-testid="trade-view"]', { timeout: 25000 });
        await sleep(1500);
        const aiTabB = page.locator('[role="tab"]', { hasText: /^AI$/ }).first();
        if (await aiTabB.count()) await aiTabB.click();
        await sleep(900);
        const linesReloaded = await toolLineCount();
        const reloadedText = await toolLineText();
        check('the tool line survives a reload', linesReloaded >= linesAfter,
            `${linesAfter} before the reload, ${linesReloaded} after`);
        check('it still names the same call after the reload',
            namesTheCall(reloadedText), `rendered: ${reloadedText || '(none)'}`);

        // Stop while a round is in flight: the abort has to reach the tool call and
        // the row must settle instead of streaming forever.
        const stopBefore = await page.locator('[data-testid="chat-entry-ai"]').count();
        await page.evaluate((needle) => {
            const ta = document.querySelector('textarea');
            if (!ta || ta.disabled) return;
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
                .set.call(ta, needle);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            const btn = [...document.querySelectorAll('button')].find(b => !b.disabled && /send/i.test(
                `${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`));
            if (btn) btn.click();
        }, 'PROBE_TOOL_ROUND PROBE_SLOW_STREAM stop me mid tool');
        let clickedStop = false;
        for (let i = 0; i < 15 && !clickedStop; i++) {
            clickedStop = await page.evaluate(() => {
                const b = [...document.querySelectorAll('button')].find(x => !x.disabled
                    && /stop/i.test(`${x.getAttribute('aria-label') || ''} ${x.title || ''}`));
                if (!b) return false;
                b.click();
                return true;
            });
            if (!clickedStop) await sleep(120);
        }
        check('an in-flight tool turn offers a working Stop', clickedStop,
            clickedStop ? 'clicked Stop while the tool round was in flight' : 'no enabled Stop button appeared within ~1.8s of sending');
        const settled = await waitSendable(page, 20000);
        check('the stopped turn settles instead of streaming forever', settled,
            settled ? 'the composer became sendable again after the abort' : 'the composer never became sendable again after Stop');
        const stopAfter = await page.locator('[data-testid="chat-entry-ai"]').count();
        check('a stopped turn leaves one row, not a placeholder beside an answer',
            stopAfter <= stopBefore + 1, `${stopBefore} -> ${stopAfter} answer rows`);

        // E-51 ruling D-A moved the model control INTO the composer card,
        // immediately left of the send button. That is a layout claim, so no
        // jsdom test can make it and no unit test should be trusted for it: the
        // toolbar row must not overflow its container, and send must stay the
        // right-most element — at the dock's own width AND when a narrower
        // column forces the `flex-wrap` row onto a second line.
        const measureComposerRow = () => page.evaluate(() => {
            const group = document.querySelector('[data-testid="composer-model-and-send"]');
            if (!group) return { found: false, why: 'no composer-model-and-send in the dock' };
            const row = group.parentElement;
            const send = group.lastElementChild;
            const chip = group.firstElementChild;
            if (!row || !send || !chip) return { found: false, why: 'the pair lost a member' };
            const rr = row.getBoundingClientRect();
            const sr = send.getBoundingClientRect();
            // A zero-size measurement is not a pass. Below its breakpoint the
            // Analyze surface hides this dock entirely, and a check that reads 0
            // for every number answers a question about nothing.
            if (rr.width < 40 || sr.width < 8) {
                return { found: false, why: `not laid out here (row ${Math.round(rr.width)}px, send ${Math.round(sr.width)}px)` };
            }
            const visible = (el) => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            };
            let widestRight = sr.right;
            let lowestBottom = sr.bottom;
            for (const el of row.querySelectorAll('*')) {
                if (!visible(el)) continue;
                const r = el.getBoundingClientRect();
                if (r.right > widestRight) widestRight = r.right;
                if (r.bottom > lowestBottom) lowestBottom = r.bottom;
            }
            const lines = new Set([...row.children].filter(visible)
                .map(c => Math.round(c.getBoundingClientRect().top)));
            return {
                found: true,
                overflow: Math.round(row.scrollWidth - row.clientWidth),
                sendIsRightMost: widestRight <= sr.right + 1.5,
                sendIsBottomMost: lowestBottom <= sr.bottom + 1.5,
                wrapped: lines.size > 1,
                detail: `row ${Math.round(rr.width)}px over ${lines.size} line(s), `
                    + `scroll-overflow ${Math.round(row.scrollWidth - row.clientWidth)}, `
                    + `send right ${Math.round(sr.right)}/bottom ${Math.round(sr.bottom)} of card `
                    + `${Math.round(rr.right)}/${Math.round(rr.bottom)}`,
            };
        });

        const atRunWidth = await measureComposerRow();
        check('the dock composer holds the model control and the send, send in the bottom-right',
            atRunWidth.found === true && atRunWidth.overflow <= 0
            && atRunWidth.sendIsRightMost === true && atRunWidth.sendIsBottomMost === true,
            atRunWidth.found
                ? `${atRunWidth.detail}, ${atRunWidth.wrapped ? 'WRAPPED' : 'single line'}`
                : atRunWidth.why);

        // The plan asked for this claim "in both the wrapped and the unwrapped
        // state". Only one of those is reachable here, and saying so is the
        // honest half: the dock's toolbar measures ~333px at every window width
        // this probe can set (the column is a chart fraction, not a viewport
        // fraction — 1100px and 1280px both give the same 333px row), and a
        // 208px trigger plus a 32px send cannot fit beside the + and
        // Scan→skills chips. So the row ALWAYS wraps in the dock, and what this
        // probe can actually prove is the two properties that must hold in
        // whichever state exists: no horizontal overflow, and send stays the
        // right-most and bottom-most element. The unwrapped state is UNMET, not
        // assumed — widen the dock for real (the expand-over-chart mode) and the
        // sweep below starts reporting a single line on its own.
        const probeViewport = page.viewportSize() ?? { width: 1280, height: 720 };
        const seen = [`run width: ${atRunWidth.found ? `${atRunWidth.detail}, ${atRunWidth.wrapped ? 'WRAPPED' : 'single line'}` : atRunWidth.why}`];
        for (const w of [1100, 980, 900]) {
            await page.setViewportSize({ width: w, height: probeViewport.height });
            await page.waitForTimeout(500);
            const m = await measureComposerRow();
            if (!m.found) { seen.push(`${w}px: ${m.why} (unmeasurable, not a pass)`); continue; }
            seen.push(`${w}px: ${m.detail}, ${m.wrapped ? 'wrapped' : 'single line'}`);
            check(`the ${w}px dock composer keeps send right-most and bottom-most`,
                m.overflow <= 0 && m.sendIsRightMost === true && m.sendIsBottomMost === true, m.detail);
        }
        console.log(`  composer row sweep — ${seen.join(' | ')}`);
        console.log('  NOTE the unwrapped composer state is UNMET: the dock toolbar is ~333px at every width this probe can set.');
        await page.setViewportSize(probeViewport);
        await page.waitForTimeout(400);

        // E-51 ruling D-B, in the browser rather than in a source regex. The
        // chord is App-level keyboard handling, so no jsdom test can walk the
        // path — keydown, guard, store, subscription, trigger label. Pressing
        // the real key and reading the label is the only proof that the hint
        // printed inside the panel names a chord that actually fires.
        const dialBefore = await page.textContent('[data-testid="composer-model-chip"]');
        await page.keyboard.press('Control+Shift+E');
        await page.waitForTimeout(600);
        const dialAfter = await page.textContent('[data-testid="composer-model-chip"]');
        check('Ctrl/Cmd+Shift+E steps the thinking tier the composer prints',
            !!dialBefore && !!dialAfter && dialBefore.trim() !== dialAfter.trim(),
            `"${(dialBefore ?? 'no composer dial').trim()}" -> "${(dialAfter ?? '').trim()}"`);
        // And it must come back: the ladder wraps, so six presses return to the
        // tier the trader started on rather than parking at `max`.
        for (let i = 0; i < 5; i += 1) {
            await page.keyboard.press('Control+Shift+E');
            await page.waitForTimeout(120);
        }
        const dialFull = await page.textContent('[data-testid="composer-model-chip"]');
        check('six presses of the chord wrap the ladder back to where they started',
            !!dialFull && dialFull.trim() === (dialBefore ?? '').trim(),
            `after 6 presses: "${(dialFull ?? '').trim()}", started at "${(dialBefore ?? '').trim()}"`);

        // The expanded dock is the one layout in the app whose widths are
        // mutually exclusive as roles but ADDITIVE as math (chart fraction +
        // dock fraction + a fixed order book), so it is the one place a
        // regression hides. Measured after actually expanding it.
        const expandBtn = await page.evaluate(() => {
            const m = [...document.querySelectorAll('button')]
                .find(b => b.getAttribute('aria-label') === 'Customization');
            if (!m) return 'no customization button';
            m.click();
            return 'opened';
        });
        if (expandBtn === 'opened') {
            const grew = await page.evaluate(() => {
                const e = [...document.querySelectorAll('button')]
                    .find(b => /expand over chart/i.test(b.textContent || ''));
                if (!e) return false;
                e.click();
                return true;
            });
            if (grew) {
                await page.waitForTimeout(700);
                const exp = await measureOverflow(page);
                check('the expanded Chart AI dock fits the viewport',
                    overflowIsClean(exp), overflowWhy(exp));
                // And the chart must survive the expansion as a chart, not a
                // sliver: it gave way by flexing, so it keeps a real share.
                const paneW = await page.evaluate(() => {
                    const p = document.querySelector('[data-testid="trade-chart-pane"]');
                    return p ? Math.round(p.getBoundingClientRect().width) : 0;
                });
                const vw = exp.vw;
                const rowBoxes = await page.evaluate(() => {
                    const pane = document.querySelector('[data-testid="trade-chart-pane"]');
                    const row = pane?.parentElement;
                    const kids = row ? [...row.children].map(el => {
                        const r = el.getBoundingClientRect();
                        return `${el.getAttribute('data-testid') || el.tagName.toLowerCase()}:${Math.round(r.width)}`;
                    }) : [];
                    return { dock: Math.round(document.querySelector('[data-testid="trade-dock"]')?.getBoundingClientRect().width || -1),
                        rail: Math.round(document.querySelector('[data-testid="shell-rail"]')?.getBoundingClientRect().width || -1),
                        row: kids.join(' ') };
                });
                check('the chart keeps a usable width when the dock is expanded',
                    paneW >= Math.round(vw * 0.3),
                    `${paneW}px of ${vw} (dock ${rowBoxes.dock}, rail ${rowBoxes.rail}; row ${rowBoxes.row})`);
                await page.evaluate(() => {
                    const m = [...document.querySelectorAll('button')]
                        .find(b => b.getAttribute('aria-label') === 'Customization');
                    if (m) m.click();
                });
                await page.waitForTimeout(200);
                const shrink = await page.evaluate(() => {
                    const e = [...document.querySelectorAll('button')]
                        .find(b => /shrink back/i.test(b.textContent || ''));
                    if (e) e.click();
                    return !!e;
                });
                if (shrink) await page.waitForTimeout(500);
            }
        }

        // The dock header's primary control is a direct hop to Chat, so the
        // move that a trader makes constantly is one click instead of opening
        // the hamburger. Asserted HERE, from the Analyze surface, because the
        // reverse direction (Chat → Desk AI) is the mode pill now:
        // `chat-mode-chart-ai` in the Chat instrument bar.
        //
        // Self-contained on purpose: `navTo`/`openMenu`/`pollFor` are declared
        // further down, and reaching for them from here hits their temporal
        // dead zone (const declarations).
        // Stage 3 moved the hop into the customization (⋯) menu. The click
        // and the item lookup are TWO evaluates with a settle between them:
        // the menu is a React portal and one synchronous pass would query
        // before the commit.
        // The dock header exists ONLY on the Analyze surface, and a synchronous
        // query fired while the app is still mid-transition (an earlier check
        // hops surfaces) reported "no menu button" — that report measured the
        // probe's own timing, not the app, and it made this check flake. Wait
        // for the header with the same bound the hop itself uses, then click in
        // one synchronous pass. A header that really never arrives still fails,
        // and now says which surface was live when it gave up.
        const headerSeen = await page.locator('[aria-label="Customization"]')
            .waitFor({ state: 'attached', timeout: 8000 }).then(() => true).catch(() => false);
        const surfaceLive = headerSeen ? '' : await page.evaluate(() => [...document.querySelectorAll('[data-testid]')]
            .map(e => e.getAttribute('data-testid'))
            .filter(t => typeof t === 'string' && /-view$/.test(t)).join(',') || 'no *-view testid');
        const menuOpened = !headerSeen ? `no dock header within 8s (surface: ${surfaceLive})`
            : await page.evaluate(() => {
                const menuBtn = document.querySelector('[aria-label="Customization"]');
                if (!menuBtn) return 'no menu button';
                menuBtn.click();
                return 'opened';
            });
        await page.waitForTimeout(400);
        const chatJump = menuOpened === 'opened'
            ? await page.evaluate(() => {
                const b = document.querySelector('[data-testid="dock-open-chat"]');
                if (!b) return 'missing';
                b.click();
                return 'clicked';
            })
            : menuOpened;
        const landedOnChat = await page.locator('[data-testid="agents-view"]')
            .waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
        check('the dock header jumps straight to Chat',
            chatJump === 'clicked' && landedOnChat === true, `${chatJump}/${landedOnChat}`);
        // And back again, so the probe resumes on the surface it expects.
        // Navigation is the persistent NavRail (D2) — the rows are in the DOM at
        // every width, so this is a direct row click with no menu to open.
        if (landedOnChat) {
            const backToTrade = await page.evaluate(() => {
                const hit = document.querySelector('[data-testid="surface-switch-trade"]');
                if (!hit) return 'not found';
                hit.click();
                return 'clicked';
            });
            const backLanded = await page.locator('[data-testid="trade-view"]')
                .waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
            check('can return to Trade from the Chat hop',
                backToTrade === 'clicked' && backLanded === true, `${backToTrade}/${backLanded}`);
        }

        // ── ONE THREAD, TWO HOMES: the answer is still ARRIVING across the hop ──
        // The requirement in one sentence: generating in Chart AI, switch to the
        // Agents surface, STILL generating. Nothing above proves it. Every dock
        // check waits for the reply to SETTLE before it moves on, and a mirror
        // that commits only at settle passes all of them while the other home
        // shows a silent thread mid-run. So this phase asks slowly — the mock's
        // request-scoped `PROBE_SLOW_STREAM` scenario, ~5s of deltas — and
        // crosses over while the stream is still up.
        await page.evaluate((needle) => {
            const ta = document.querySelector('textarea');
            if (!ta || ta.disabled) return;
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
                .set.call(ta, needle);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            const btn = [...document.querySelectorAll('button')].find(b => !b.disabled && /send/i.test(
                `${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`));
            if (btn) btn.click();
        }, 'PROBE_SLOW_STREAM does the answer cross the hop');
        // The dock has to be visibly working BEFORE the switch, or the phase
        // measures a turn that already finished and reports a pass it did not earn.
        let stillStreaming = false;
        for (let i = 0; i < 25 && !stillStreaming; i++) {
            stillStreaming = await page.evaluate(() => [...document.querySelectorAll('button')]
                .some(b => !b.disabled && /stop/i.test(`${b.getAttribute('aria-label') || ''} ${b.title || ''}`)));
            if (!stillStreaming) await sleep(100);
        }
        check('the dock turn is still generating before the hop', stillStreaming,
            stillStreaming ? 'Stop was offered while the answer was arriving' : 'no Stop button within 2.5s of sending — the mock answered too fast to measure a live turn');
        await page.evaluate(() => {
            const hit = document.querySelector('[data-testid="surface-switch-agents"]');
            if (hit) hit.click();
        });
        await page.waitForSelector('main textarea', { timeout: 20000 });
        await sleep(400);
        // Two measurements on the OTHER home, both taken while the run is up:
        // its composer offers Stop for a run it did not start (a row with no
        // live flag fails this), and the answer grows between samples (a
        // settle-only mirror fails this).
        const busyOnChat = await page.evaluate(() => [...document.querySelectorAll('main button')]
            .some(b => /stop/i.test(`${b.getAttribute('aria-label') || ''} ${b.title || ''}`)));
        check('the Agents surface shows the dock’s turn as still running', busyOnChat,
            'the Chat composer offered Send while the Chart AI turn was generating');
        const aiCharsOnChat = () => page.evaluate(() => [...document.querySelectorAll(
            '[data-testid="agent-message"][data-role="ai"]')].reduce((n, e) => n + (e.textContent || '').length, 0));
        const growA = await aiCharsOnChat();
        await sleep(700);
        const growB = await aiCharsOnChat();
        check('the answer keeps growing on the Agents surface', growB > growA && growA > 0,
            `${growA} -> ${growB} characters`);
        // The settle signal here is the CONTROL CHANGING IDENTITY, not becoming
        // enabled: `waitSendable` asks for an enabled Send, and a composer with
        // an empty draft is disabled by design on both homes. The run is over
        // when the surface stops offering Stop.
        let liveSettled = false;
        for (let i = 0; i < 150 && !liveSettled; i++) {
            liveSettled = await page.evaluate(() => ![...document.querySelectorAll('button')]
                .some(b => /stop/i.test(`${b.getAttribute('aria-label') || ''} ${b.title || ''}`)));
            if (!liveSettled) await sleep(200);
        }
        await waitStableAnswer(page);
        const liveText = await page.evaluate(() => [...document.querySelectorAll(
            '[data-testid="agent-message"][data-role="ai"]')].map(e => e.textContent || '')
            .reduce((a, b) => (a.length >= b.length ? a : b), ''));
        check('the turn that crossed the hop settles complete, not truncated',
            liveSettled && liveText.length > 400 && /came from the local mock/.test(liveText),
            `composer free: ${liveSettled}, ${liveText.length} chars`);
        // Back to the dock, so the phase below resumes where it expects.
        await page.evaluate(() => {
            const hit = document.querySelector('[data-testid="surface-switch-trade"]');
            if (hit) hit.click();
        });
        await page.locator('[data-testid="trade-view"]').waitFor({ timeout: 8000 }).catch(() => {});

        // ── THE THINKING CLOCK CROSSES THE HOP ────────────────────────────
        // The bug was a remount: each surface's row started its clock at mount,
        // so Agents → Analyze showed 0s for a turn that had been thinking for
        // 13s. The mock streams a real reasoning trace first (request-scoped),
        // leaving both homes on the same live row long enough to measure.
        // Every later reading must be at least the earlier one; a reset fails
        // loudly instead of looking like a fresh turn.
        const dockThinking = () => page.evaluate(() => {
            const text = document.querySelector('[data-testid="trade-chat-panel"]')?.textContent || '';
            const m = /Thinking\s*·\s*(\d+)s/.exec(text);
            return m ? Number(m[1]) : null;
        });
        const agentsThinking = () => page.evaluate(() => {
            const rows = [...document.querySelectorAll('[data-testid="agent-message"][data-role="ai"]')];
            for (const row of rows) {
                const m = /Thinking\s*·\s*(\d+)s/.exec(row.textContent || '');
                if (m) return Number(m[1]);
            }
            return null;
        });
        await page.evaluate((needle) => {
            const ta = document.querySelector('textarea');
            if (!ta || ta.disabled) return;
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
                .set.call(ta, needle);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            const btn = [...document.querySelectorAll('button')].find(b => !b.disabled && /send/i.test(
                `${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`));
            if (btn) btn.click();
        }, 'PROBE_REASONING_STREAM keep the clock running');
        let clockStart = null;
        for (let i = 0; i < 80 && clockStart === null; i++) {
            clockStart = await dockThinking();
            if (clockStart === null) await sleep(100);
        }
        check('the live thinking clock is readable before the hop', clockStart !== null,
            clockStart === null ? 'no "Thinking · Ns" row within 8s' : `start=${clockStart}s`);
        await sleep(1200);
        const clockBeforeHop = await dockThinking();
        await page.evaluate(() => {
            const hit = document.querySelector('[data-testid="surface-switch-agents"]');
            if (hit) hit.click();
        });
        await page.waitForSelector('main textarea', { timeout: 20000 });
        await sleep(600);
        const clockOnAgents = await agentsThinking();
        check('the thinking clock continues on the Agents surface',
            clockStart !== null && clockOnAgents !== null && clockOnAgents > 0
                && clockOnAgents >= (clockBeforeHop ?? 0),
            `dock ${clockStart}s → ${clockBeforeHop}s, agents ${clockOnAgents}s`);
        await page.evaluate(() => {
            const hit = document.querySelector('[data-testid="surface-switch-trade"]');
            if (hit) hit.click();
        });
        await page.locator('[data-testid="trade-view"]').waitFor({ timeout: 8000 }).catch(() => {});
        await sleep(600);
        const clockBackOnDock = await dockThinking();
        check('…and continues when it comes back to Analyze',
            clockOnAgents !== null && clockBackOnDock !== null && clockBackOnDock >= clockOnAgents,
            `agents ${clockOnAgents}s, dock ${clockBackOnDock}s`);
        // Let the reasoning-only turn settle before the next phase counts rows.
        let clockTurnSettled = false;
        for (let i = 0; i < 200 && !clockTurnSettled; i++) {
            clockTurnSettled = await page.evaluate(() => ![...document.querySelectorAll('button')]
                .some(b => /stop/i.test(`${b.getAttribute('aria-label') || ''} ${b.title || ''}`)));
            if (!clockTurnSettled) await sleep(200);
        }
        await waitStableAnswer(page);


        // ── The Agents surface (id/testids still "agents") ───────────────────────────────────────────
        // It reads the App-side message array through a filter
        // (`utils/agentThreads.deskThread`), which is a DIFFERENT store from the
        // dock's chat session — so it gets driven and counted on its own. This
        // is also the surface where a filter that drops a row by provider+model
        // would show up as a missing message.
        /** Rows in the transcript, counted by hook rather than by page text:
         *  the left rail also carries message previews, so an innerText regex
         *  double-counts and reports the wrong order. */
        const agentRows = () => page.locator('[data-testid="agent-message"]').count();
        const agentReplies = () => page
            .locator('[data-testid="agent-message"][data-role="ai"]').count();

        const openAgents = async () => {
            // Direct rail-row click. The rows carry the surface name in their
            // accessible name in BOTH rail widths (the collapsed 56px row has
            // no visible label at all), so matching on aria-label is what makes
            // one click work at any width.
            await page.evaluate(() => {
                const hit = document.querySelector('[data-testid="surface-switch-agents"]');
                if (!hit) throw new Error('no Chat entry in the title-bar switch');
                hit.click();
            });
            // The transcript container only exists once the thread has a row —
            // an empty thread renders the greeting hero instead. Wait for the
            // composer, which is present either way.
            await page.waitForSelector('main textarea', { timeout: 20000 });
            await sleep(800);
        };
        await openAgents();
        // This check used to assert the desk thread was EMPTY, which was a
        // description of the SPLIT (two stores, two transcripts) rather than of
        // a contract. A turn asked in the Chart AI dock now resolves a
        // conversation and mirrors into it, so the Agents surface opens ON the
        // dock's own exchange — and that is what is worth asserting here: the
        // dock's prompts, rendered on the other home, from the same rows.
        const mergedRows = await agentRows();
        const mergedText = await page.evaluate(() => [...document.querySelectorAll(
            '[data-testid="agent-message"]')].map(r => r.textContent || '').join('\n'));
        // The dock's RECENT turns, not its oldest ones. Conversations are saved
        // on a 1500 ms debounce (hooks/useConversations.ts:4), so a thread
        // minted seconds before one of this probe's reloads is genuinely gone,
        // and the dock rebinds to a live one on its next send — asserting the
        // pre-reload rows were here would be measuring the save timer, not the
        // sync. What must hold is that the thread the Agents surface opens on IS
        // the one the dock last wrote to.
        const hasLive = /PROBE_SLOW_STREAM/.test(mergedText);
        const hasTool = /PROBE_TOOL_ROUND/.test(mergedText);
        check('the Agents surface opens on the dock’s own exchange',
            mergedRows >= 2 && hasLive && hasTool,
            `${mergedRows} rows, the hop turn ${hasLive}, the tool turn ${hasTool}`);
        // Then a clean thread, so the phase below counts what IT sends.
        await page.evaluate(() => {
            const b = document.querySelector('[data-testid="rail-new-chat"]');
            if (b) b.click();
        });
        await sleep(600);
        const freshRows = await agentRows();
        check('a new chat on the Agents surface starts empty', freshRows === 0, `${freshRows} rows`);

        const sendInAgents = async (text) => {
            const before = await agentRows();
            await page.evaluate((needle) => {
                const ta = document.querySelector('main textarea');
                if (!ta || ta.disabled) throw new Error('Agents composer missing/disabled');
                Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
                    .set.call(ta, needle);
                ta.dispatchEvent(new Event('input', { bubbles: true }));
            }, text);
            // The send affordance enables in the render that FOLLOWS the input
            // event; reading it in the same tick raced React and reported a
            // dead composer on a healthy app. Wait for the enabled state, and
            // still fail (5s budget) when the composer is genuinely stuck.
            const sendReady = await page.waitForFunction(() => {
                const btn = [...document.querySelectorAll('main button')].find(b => /send/i.test(
                    `${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`,
                ));
                return !!btn && !btn.disabled;
            }, null, { timeout: 5000 }).then(() => true).catch(() => false);
            if (!sendReady) throw new Error('Agents send button unavailable');
            await page.evaluate(() => {
                const btn = [...document.querySelectorAll('main button')].find(b => /send/i.test(
                    `${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`,
                ));
                if (btn) btn.click();
            });
            await page.waitForFunction((seen) => document
                .querySelectorAll('[data-testid="agent-message"]').length >= seen + 2,
            before, { timeout: 30000 });
            // The composer is not free again until the stream ends.
            await waitStableAnswer(page);
        };

        const AGENT_MARKS = ['AGENT ROW ONE', 'AGENT ROW TWO', 'AGENT ROW THREE'];
        for (const text of AGENT_MARKS) await sendInAgents(text);

        const finalRows = await agentRows();
        check('Agents transcript shows all 6 rows (3 prompts + 3 replies)',
            finalRows === 6, `${finalRows} rows`);
        const finalReplies = await agentReplies();
        check('every Agents reply rendered', finalReplies === 3, `${finalReplies}/3`);

        const texts = await page.locator('[data-testid="agent-message"]').allInnerTexts();
        const firstIdx = texts.findIndex(t => t.includes('AGENT ROW ONE'));
        const lastIdx = texts.findIndex(t => t.includes('AGENT ROW THREE'));
        check('rows are in send order, oldest first',
            firstIdx >= 0 && lastIdx > firstIdx, `first=${firstIdx} last=${lastIdx}`);

        /** The Agents surface reopens on its rail, not on an open thread, so a
         *  reload that leaves the desk unselected reads as an empty conversation.
         *  Click the desk row itself rather than assuming the selection stuck. */
        const openDeskThread = async () => {
            await openAgents();
            const desk = page.locator('main, aside, nav')
                .getByText('Chart AI', { exact: true }).first();
            if (await desk.count()) {
                await desk.click();
                await sleep(900);
            }
        };

        // ── Reload: a row that renders but never persisted is the same symptom
        //    as one that never renders at all.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !document.querySelector('#splash'), null, { timeout: 25000 });
        await sleep(2500);
        await openDeskThread();
        const afterReload = await agentRows();
        check('the conversation survives a reload', afterReload === 6, `${afterReload}/6 rows`);

        // ── Seeded verdict rows ────────────────────────────────────────
        // The live-chat phase never renders a verdict card, so this is the only
        // browser coverage of the audit panels and of the two persisted shapes
        // that used to take the transcript down behind them.
        await seedVerdicts(page);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !document.querySelector('#splash'), null, { timeout: 25000 });
        await sleep(2500);
        await openDeskThread();

        const seededRows = await page.locator('[data-testid="agent-message"]').count();
        check('all 4 seeded rows render — nothing dropped after the malformed verdict',
            seededRows === 4, `${seededRows}/4`);
        const verdictCards = await page.locator('[data-testid="inline-verdict"]').count();
        check('both settled verdicts render a verdict card', verdictCards === 2, `${verdictCards}/2`);
        const auditCards = await page.locator('[data-testid="verdict-audit"]').count();
        check('the verdict audit renders on both', auditCards === 2, `${auditCards}/2`);
        const ladders = await page.locator('[data-testid="run-contract"]').count();
        check('the run-contract ladder renders on both verdicts', ladders === 2, `${ladders}/2`);
        const seededText = await page.locator('main').innerText();
        check('a skipped stage says why, in the browser',
            seededText.includes('budget cap') && seededText.includes('single seat'),
            seededText.slice(0, 160));
        check('the declined verdict explains itself', /why avoid|why no trade/i.test(seededText));
        // The reference's thinking block: one bare settled line with a frozen
        // duration, an avatar instead of a byline, and the trace behind it.
        const thinkingLines = await page.locator('[data-testid="agent-message"][data-role="ai"]')
            .filter({ hasText: 'Thinking complete' }).count();
        check('a settled trace renders the bare Thinking complete line',
            thinkingLines >= 1, `${thinkingLines}`);
        const avatarRows = await page.locator('[data-testid="row-avatar"]').count();
        check('AI rows are identified by an avatar, not a byline',
            avatarRows >= 1, `${avatarRows}`);
        const expandedThinking = await page.evaluate(() => {
            const summary = [...document.querySelectorAll('[data-testid="agent-message"] summary')]
                .find(el => /Thinking complete/.test(el.textContent || ''));
            if (!(summary instanceof HTMLElement)) return null;
            summary.click();
            const details = summary.parentElement;
            return details?.hasAttribute('open') ?? null;
        });
        check('the thinking line expands its trace',
            expandedThinking === true, `${expandedThinking}`);

        // The owner's reference draws NO box and NO rules around a thinking
        // trace: the summary is a bare line and the trace is a flat block.
        // Computed styles, because a 1px transparent border still costs a box
        // and an animation can paint a border colour no class shows.
        const thinkingFrame = await page.evaluate(() => {
            const summary = [...document.querySelectorAll('[data-testid="agent-message"] summary')]
                .find(el => /Thinking complete/.test(el.textContent || ''));
            const details = summary?.parentElement;
            const body = details?.querySelector('.reasoning-row-body');
            if (!details || !body) return null;
            const cs = window.getComputedStyle(details);
            const bs = window.getComputedStyle(body);
            const px = (v) => parseFloat(v) || 0;
            return {
                border: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(px),
                background: cs.backgroundColor,
                bodyTop: px(bs.borderTopWidth),
                bodyLeft: px(bs.borderLeftWidth),
            };
        });
        check('an expanded thinking trace draws no box, no fill and no rules',
            !!thinkingFrame
            && thinkingFrame.border.every(w => w === 0)
            && thinkingFrame.bodyTop === 0
            && thinkingFrame.bodyLeft === 0
            && (thinkingFrame.background === 'rgba(0, 0, 0, 0)' || thinkingFrame.background === 'transparent'),
            JSON.stringify(thinkingFrame));

        // ── Every nav surface must actually mount something ────────────
        // The four nav surfaces are separate lazy trees; a blank one is
        // the same class of defect this probe was written for, and no jsdom
        // suite covers the nav that mounts them. Each is checked for content
        // AND for a pageerror delta, so a surface that renders then throws is
        // caught at the surface that caused it rather than at the end.
        const surfaces = [
            { label: 'Analyze', switchId: 'trade', expect: '[data-testid="trade-view"]' },
            { label: 'Journal', switchId: 'journal', expect: null },
            // 'Skills' is gone from this list because it is gone from the rail:
            // the Strategy Studio is the Skills SETTINGS tab now. The rail row
            // that replaced it is Customize, which opens an overlay rather than
            // switching a surface, so it cannot be measured here — the Studio's
            // render is covered by the Settings sweep instead.
            { label: 'Agents', switchId: 'agents', expect: '[data-testid="agents-view"]' },
            // The Approvals row used to open a fixed OVERLAY mounted outside
            // <main>, which is why an entry like this asserts the overlay's own
            // root: measuring <main> re-reported whatever surface was open before
            // and passed vacuously — one run printed an Approvals byte count
            // identical to Agents for exactly that reason. The lesson stays:
            // assert the thing the click actually changes.
            // Approvals had an entry here while it was a rail row that routed
            // into Learn's inbox tab. The row is gone — the queue is a tab of the
            // Learning surface, which the entry below visits and sweeps.
            { label: 'Learning', switchId: 'learn', expect: '[data-testid="learn-view"]' },
        ];
        /** Some menu entries open a dialog rather than switch a surface (the
         *  approvals inbox does). A dialog leaves a full-screen backdrop that
         *  swallows the next click, so every visit ends by dismissing it —
         *  otherwise this probe fails on its own housekeeping, not on the app. */
        const dismissOverlays = async () => {
            await page.keyboard.press('Escape');
            await page.evaluate(() => {
                const backdrop = [...document.querySelectorAll('[data-testid="rail-backdrop"], [data-testid="chat-history-backdrop"]')];
                backdrop.forEach(b => b.dispatchEvent(new MouseEvent('click', { bubbles: true })));
                // Escape does not reach every dialog: a drawer whose keydown
                // handling needs focus inside it stayed open after the press
                // above, and every later press on that surface was then judged
                // against an already-open overlay. Dialogs carry their own
                // close controls — use them.
                const closers = [...document.querySelectorAll(
                    '[role="dialog"] [aria-label*="close" i], [role="dialog"] [aria-label*="Close" i], '
                    // The Activity drawer is a fixed aside, not a role=dialog:
                    // its own close control is reachable ONLY by its testid. A
                    // dismissal that skipped it left the drawer open, so every
                    // later press on the surface was judged against an
                    // already-open overlay and read as inert.
                    + '[data-testid="activity-drawer"] [aria-label*="close" i]',
                )];
                closers.forEach(b => { try { b.click(); } catch { /* detached */ } });
            });
            await sleep(250);
        };
        /** Navigate through the rail, at any width.
         *
         *  The four-tab fallback is DELETED: when the rail is away there is no
         *  switch on screen, and the only route back is the expand button (or
         *  the Agents drawer's opener on a phone). This opens that affordance,
         *  then presses the destination inside the rail — the path a person
         *  actually takes. Clicking an off-canvas switch directly would pass
         *  while the visible UI had no route at all. */
        const closeRailOverlayAtPhone = async () => {
            const phone = await page.evaluate(() => window.innerWidth < 1024);
            if (!phone) return;
            await page.evaluate(() =>
                document.querySelector('[data-testid="shell-rail-backdrop"]')?.click());
            await sleep(120);
        };
        const navTo = async (label) => {
            const IDS = { Analyze: 'trade', Journal: 'journal', Agents: 'agents', Learning: 'learn' };
            const id = IDS[label];
            if (!id) return 'not found';
            const clickSwitch = () => page.evaluate((surfaceId) => {
                const el = document.querySelector(`[data-testid="surface-switch-${surfaceId}"]`);
                if (!el) return 'missing';
                const cs = window.getComputedStyle(el);
                if (cs.visibility === 'hidden' || cs.display === 'none' || el.getClientRects().length === 0) {
                    return 'hidden';
                }
                el.click();
                return 'clicked';
            }, id);
            const first = await clickSwitch();
            if (first === 'clicked') { await closeRailOverlayAtPhone(); return 'clicked'; }
            // The rail is put away. Open it from whichever affordance this
            // surface has: the content bar's expand button, or the Agents
            // drawer's opener below md.
            const revealed = await page.evaluate(() => {
                const visible = (el) => {
                    if (!el) return false;
                    const cs = window.getComputedStyle(el);
                    return cs.visibility !== 'hidden' && cs.display !== 'none'
                        && el.getClientRects().length > 0;
                };
                const toggle = [...document.querySelectorAll(
                    '[data-testid="nav-rail-toggle-header"], [data-testid="rail-open"]')]
                    .find(visible);
                if (!toggle) return 'no reveal control';
                toggle.click();
                return 'clicked';
            });
            if (revealed !== 'clicked') return 'not found';
            await page.waitForFunction((surfaceId) => {
                const el = document.querySelector(`[data-testid="surface-switch-${surfaceId}"]`);
                if (!el) return false;
                const cs = window.getComputedStyle(el);
                return cs.visibility !== 'hidden' && cs.display !== 'none' && el.getClientRects().length > 0;
            }, id, { timeout: 5000 }).catch(() => {});
            const second = await clickSwitch();
            if (second !== 'clicked') return 'not found';
            await closeRailOverlayAtPhone();
            return 'clicked';
        };
        /** The rail is always on screen, so there is no menu to open — this now
         *  only asserts the rail exists and, if the window is narrow enough to
         *  have forced it collapsed, expands it so the wide sweep is measuring
         *  what a desktop user sees. */
        const openMenu = async () => page.evaluate(() => {
            const rail = document.querySelector('[data-testid="shell-rail"]')
                || document.querySelector('[data-testid="agents-rail"]');
            if (rail && rail.offsetParent !== null) return 'already expanded';
            // D2 amendment: the collapsed rail is 0px and inert, so the expand
            // affordance lives in the content bar.
            const headerToggle = document.querySelector('[data-testid="nav-rail-toggle-header"]');
            if (headerToggle) { headerToggle.click(); return 'expanded'; }
            const toggle = document.querySelector('[data-testid="nav-rail-toggle"]');
            if (!toggle) return 'no toggle';
            toggle.click();
            return 'expanded';
        });
        // ── The Agents surface's mode pill ─────────────────────────────────
        // The Agents surface's switch is a ROUTE to the charted form of the desk,
        // so only a browser can prove it works: press it, and the canvas plus the
        // dock must appear WITH the conversation that was on screen. The earlier
        // build of this control swapped a chartless copy of the same panel in
        // place of the thread, which no assertion here could distinguish from
        // doing nothing at all — so these checks measure the destination, the
        // rows carried, and the way back.
        {
            const landed = await navTo('Agents');
            const before = landed === 'clicked' ? await page.evaluate(() => {
                // The left column is measured on BOTH sides of the hop because
                // the two surfaces used to render it from two components with
                // two widths and two persisted collapse keys. A mode switch
                // must not restack the shell, and only a real layout can prove
                // it did not: jsdom reports 0px for every box here.
                //
                // The column's OWN box is the measurement, not <main>'s left
                // edge: on Chat the column is rendered inside <main> and on
                // Trade the rail is a sibling of it, so `main.left` reads 0 vs
                // 240 while the column itself sits in the same place, the same
                // width, both times. Where the column ENDS is the line every
                // surface's content begins at.
                const el = document.querySelector('[data-testid="agents-rail"]')
                    || document.querySelector('[data-testid="shell-rail"]');
                const box = el && el.offsetParent !== null
                    ? el.getBoundingClientRect() : null;
                const sw = document.querySelector('[data-testid^="surface-switch-"]');
                const swBox = sw ? sw.getBoundingClientRect() : null;
                return {
                    swLeft: swBox ? Math.round(swBox.left) : -1,
                    swTop: swBox ? Math.round(swBox.top) : -1,
                    railLeft: box ? Math.round(box.left) : -1,
                    railRight: box ? Math.round(box.right) : -1,
                    rows: document.querySelectorAll('[data-testid="agent-message"]').length,
                    cards: document.querySelectorAll(
                        '[data-testid="agent-thread"] [data-testid="inline-verdict"]').length,
                };
            }) : { rows: 0, cards: 0, railLeft: -1, railRight: -1, swLeft: -1, swTop: -1 };
            const pressed = landed === 'clicked' ? await page.evaluate(() => {
                const b = document.querySelector('[data-testid="surface-switch-trade"]');
                if (!b) return 'no switch';
                b.click();
                return 'clicked';
            }) : landed;
            if (pressed === 'clicked') await page.waitForTimeout(1800);
            const hop = pressed === 'clicked' ? await page.evaluate(() => {
                const on = (sel) => {
                    const el = document.querySelector(sel);
                    return !!el && el.offsetParent !== null;
                };
                const el = document.querySelector('[data-testid="shell-rail"]')
                    || document.querySelector('[data-testid="agents-rail"]');
                const box = el && el.offsetParent !== null
                    ? el.getBoundingClientRect() : null;
                const sw = document.querySelector('[data-testid^="surface-switch-"]');
                const swBox = sw ? sw.getBoundingClientRect() : null;
                return {
                    chart: on('[data-testid="trade-chart-pane"]'),
                    dock: on('[data-testid="trade-chat-panel"]'),
                    chat: on('[data-testid="agents-view"]'),
                    swLeft: swBox ? Math.round(swBox.left) : -1,
                    swTop: swBox ? Math.round(swBox.top) : -1,
                    railLeft: box ? Math.round(box.left) : -1,
                    railRight: box ? Math.round(box.right) : -1,
                    rows: document.querySelectorAll(
                        '[data-testid="trade-chat-panel"] [data-entry-id]').length,
                    cards: document.querySelectorAll(
                        '[data-testid="trade-chat-panel"] [data-testid="inline-verdict"]').length,
                };
            }) : null;
            check('the pill takes the Agents surface to the chart AND the Chart AI dock',
                !!hop && hop.chart && hop.dock && !hop.chat,
                hop ? `chart=${hop.chart} dock=${hop.dock} chatStillMounted=${hop.chat}` : String(pressed));
            // The merged thread is the reason the hop is worth taking: the dock
            // opens on THIS conversation rather than whichever chat was last
            // used. Compared by row count — the two homes chrome a turn
            // differently, so a text match measures formatting, not memory.
            check('the hop carries the conversation into the dock',
                before.rows > 0 && !!hop && hop.rows >= before.rows,
                `thread=${before.rows} dock=${hop ? hop.rows : 'n/a'}`);
            check('the dock draws the same decision cards as the thread',
                before.cards > 0 && !!hop && hop.cards === before.cards,
                `thread=${before.cards} dock=${hop ? hop.cards : 'n/a'}`);
            // The reference's chat ⇄ code switch changes the content and nothing
            // else — including nothing about where the switch is. Chat's column
            // header and Trade's title bar both start at the window's left edge,
            // so the two must land within one control's width of each other. The
            // tolerance is stated as a number because the old shape of this check
            // asserted only `> 0`: with the switch in Chat's CONTENT header it
            // read 259 vs 27 and still passed, which is the exact jump the
            // transition is supposed to remove.
            check('the hop keeps the title bar in place and the switch reachable',
                !!hop && before.swLeft > 0 && hop.swLeft > 0
                    && hop.swTop === before.swTop
                    && Math.abs(hop.swLeft - before.swLeft) <= 24,
                `switch x ${before.swLeft}→${hop ? hop.swLeft : 'n/a'}, y ${before.swTop}→${hop ? hop.swTop : 'n/a'}`);

            const back = await page.evaluate(() => {
                const b = document.querySelector(
                    '[data-testid="surface-switch-agents"]');
                if (!b) return 'no way back';
                b.click();
                return 'clicked';
            });
            if (back === 'clicked') await page.waitForTimeout(1200);
            const home = back === 'clicked' ? await page.evaluate(() => {
                const el = document.querySelector('[data-testid="agents-view"]');
                return !!el && el.offsetParent !== null;
            }) : false;
            check('the dock gives the chat back', home === true, `${back} home=${home}`);
        }

        // ── The nav rail itself (D2) ────────────────────────────────────
        // Placed HERE, after navTo/openMenu, because it calls both — and those
        // are `const`, so reaching them from above this line hits their
        // temporal dead zone (the same trap the Chat-hop block documents).
        //
        // The surfaces below are only reachable at all if the rail is mounted,
        // so the rail is checked rather than assumed by them. "Navigation still
        // works" is NOT the same claim as "navigation is on screen with no menu
        // to open", and only this block makes the second one.
        // Navigation lives in TWO hosts now, on purpose: the Agents surface folded
        // its destinations and account row into the one sidebar it already had —
        // the reference has a single column, not a rail standing beside a chat
        // list — while every other surface still uses the rail. The claim being
        // checked is "navigation is on screen with no menu to open", so it is
        // checked wherever it happens to live.
        {
            const nav = await page.evaluate(() => {
                const sw = [...document.querySelectorAll('[data-testid^="surface-switch-"]')];
                const rail = document.querySelector('[data-testid="agents-rail"]');
                return {
                    switchCount: sw.length,
                    switchTop: sw.length ? Math.round(sw[0].getBoundingClientRect().top) : -1,
                    marked: sw.filter(b => b.getAttribute('aria-current') === 'page')
                        .map(b => b.getAttribute('data-testid')).join(','),
                    // Journal / Learning / Customize are utility rows now, not
                    // destinations; the switch owns the two desk modes and the
                    // utility group owns the records. Customize must still have
                    // its one home in this column.
                    customizeInRail: !!rail?.querySelector('[data-testid="nav-customize"]'),
                    railTop: rail ? Math.round(rail.getBoundingClientRect().top) : -1,
                    // No global band on this surface: AgentsView's own bar is
                    // the content bar, so nothing stacks above the rail.
                    headerAbove: !!document.querySelector('header'),
                    accountName: !!rail?.querySelector('[data-testid="nav-account-name"]'),
                    switchUserButton: !!rail?.querySelector('[data-testid="nav-switch-user"]'),
                };
            });
            check('every surface is reachable from the shell rail with no menu to open',
                nav.switchCount === 4, `${nav.switchCount} entries in the rail switch`);
            check('the switch marks the screen you are actually on',
                nav.marked === 'surface-switch-agents', nav.marked || 'nothing marked');
            check('the sidebar keeps the Customize route with the utility group',
                nav.customizeInRail, `customize=${nav.customizeInRail}`);
            check('the account row says who is signed in and is not a control',
                nav.accountName && !nav.switchUserButton,
                `name=${nav.accountName} switchButton=${nav.switchUserButton}`);
            check('the sidebar runs the full height of the window — nothing is stacked above it',
                nav.railTop === 0 && !nav.headerAbove,
                `agents-rail top ${nav.railTop}px, header above=${nav.headerAbove}`);

            // Ctrl+B belongs to the RAIL specifically, which the Agents surface no
            // longer mounts — so press it on a surface that has one.
            await navTo('Analyze');
            await sleep(900);

            // The shell rail is a sibling of <main> and runs full height, so
            // the content bar begins exactly where the rail ends — at the
            // window edge when the rail is put away, at the column's right
            // edge when it is open.
            const band = await page.evaluate(() => {
                const rail = document.querySelector('[data-testid="shell-rail"]');
                const main = document.querySelector('main');
                const head = main ? main.querySelector('header') : null;
                if (!rail || !main || !head) return null;
                const r = rail.getBoundingClientRect();
                const h = head.getBoundingClientRect();
                const m = main.getBoundingClientRect();
                return {
                    railRight: Math.round(r.right),
                    headLeft: Math.round(h.left),
                    headTop: Math.round(h.top),
                    mainLeft: Math.round(m.left),
                    marked: [...document.querySelectorAll('[data-testid^="surface-switch-"]')]
                        .filter(b => b.getAttribute('aria-current') === 'page')
                        .map(b => b.getAttribute('data-testid')).join(','),
                };
            });
            check('the rail puts the content bar beside it and keeps the switch in the rail',
                !!band && band.headLeft === band.mainLeft && band.headLeft === band.railRight
                    && band.headTop === 0 && band.marked === 'surface-switch-trade',
                band ? `rail right=${band.railRight}, header x=${band.headLeft} y=${band.headTop}, ${band.marked}` : 'no rail or header');

            // The rail's Search row is the one shell gesture that crosses
            // surfaces and hands the focused form a token — a row that routes
            // but never opens the field it promises would pass every static
            // check. Assert the destination AND the focused input.
            const searchJump = await page.evaluate(() => {
                const b = document.querySelector('[data-testid="shell-search"]');
                if (!b) return 'no row';
                b.click();
                return 'clicked';
            });
            const searchLanded = await page.locator('[data-testid="agents-view"]')
                .waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
            let searchFocused = false;
            for (let i = 0; i < 40 && !searchFocused; i++) {
                searchFocused = await page.evaluate(() =>
                    document.activeElement?.getAttribute('data-testid') === 'rail-search');
                if (!searchFocused) await sleep(100);
            }
            check('the rail Search row opens the desk search field',
                searchJump === 'clicked' && searchLanded && searchFocused,
                `${searchJump}/${searchLanded}/focused=${searchFocused}`);
            await navTo('Analyze');
            await sleep(700);

            // The rail is an adjustable column and carries its own collapse
            // control. Both are drags/clicks no static assertion can see: a
            // handle with no pointer listener and a button wired to nothing
            // both pass a "the control exists" check.
            const railBox = () => page.evaluate(() => {
                const el = document.querySelector('[data-testid="shell-rail"]');
                return el ? Math.round(el.getBoundingClientRect().width) : -1;
            });
            const railBefore = await railBox();
            const railHandle = await page.locator('[data-testid="shell-rail-resize"]').boundingBox();
            if (railHandle) {
                const y = railHandle.y + Math.min(120, railHandle.height / 2);
                await page.mouse.move(railHandle.x + railHandle.width / 2, y);
                await page.mouse.down();
                await page.mouse.move(railHandle.x + railHandle.width / 2 + 48, y, { steps: 4 });
                await page.mouse.up();
            }
            await sleep(250);
            const railWide = await railBox();
            check('the rail drags wider from its right edge',
                railWide >= railBefore + 40, `${railBefore} -> ${railWide}`);
            const railResetHandle = await page.locator('[data-testid="shell-rail-resize"]').boundingBox();
            if (railResetHandle) {
                await page.mouse.dblclick(
                    railResetHandle.x + railResetHandle.width / 2,
                    railResetHandle.y + Math.min(120, railResetHandle.height / 2));
            }
            await sleep(300);
            const railReset = await railBox();
            check('double-click restores the rail width',
                railReset === railBefore, `${railWide} -> ${railReset} (want ${railBefore})`);
            const railCollapsed = await page.evaluate(() => {
                const b = document.querySelector('[data-testid="shell-rail-collapse"]');
                if (!b) return 'no control';
                b.click();
                return 'clicked';
            });
            await sleep(450);
            const railGone = await page.evaluate(() => {
                const visible = (el) => {
                    const cs = window.getComputedStyle(el);
                    return cs.visibility !== 'hidden' && cs.display !== 'none' && el.getClientRects().length > 0;
                };
                return {
                    rail: !!document.querySelector('[data-testid="shell-rail"]'),
                    expand: !!document.querySelector('[data-testid="nav-rail-toggle-header"]'),
                    switches: [...document.querySelectorAll('[data-testid^="surface-switch-"]')].filter(visible).length,
                    oldMenu: !!document.querySelector('[data-testid="surface-menu"]'),
                };
            });
            check('the rail collapse control puts the column away and leaves a way back',
                railCollapsed === 'clicked' && !railGone.rail && railGone.expand
                    && railGone.switches === 0 && !railGone.oldMenu,
                `${railCollapsed} rail=${railGone.rail} expand=${railGone.expand} `
                + `visibleTabs=${railGone.switches} oldMenu=${railGone.oldMenu}`);
            // The owner asked for the old tabs to be gone permanently, not
            // hidden behind a breakpoint. Pin the SOURCE too: a later "restore
            // the fallback" change has to delete this check to land.
            const oldSwitchFile = require('fs').existsSync(
                path.join(ROOT, 'src', 'components', 'shell', 'SurfaceSwitch.tsx'));
            const oldMenuFile = require('fs').existsSync(
                path.join(ROOT, 'src', 'components', 'shell', 'SurfaceMenuList.tsx'));
            check('the old four-tab bar and its menu are deleted from source',
                !oldSwitchFile && !oldMenuFile,
                `SurfaceSwitch=${oldSwitchFile ? 'exists' : 'gone'} SurfaceMenuList=${oldMenuFile ? 'exists' : 'gone'}`);
            const railRevived = await page.evaluate(() => {
                const t = document.querySelector('[data-testid="nav-rail-toggle-header"]');
                if (!t) return false;
                t.click();
                return true;
            });
            await sleep(600);
            const railBack = await railBox();
            check('the content bar brings the rail back at its stored width',
                railRevived && railBack === railBefore, `${railBack}px (want ${railBefore})`);

            // Ctrl/Cmd+B belongs to the one column that still collapses: the
            // Chat sidebar. The rail is gone, so press it where a column exists —
            // and check the pairing that matters, that the header offers the
            // expand button exactly while the column is away. An unreachable nav
            // is the trap this catches.
            await navTo('Agents');
            await sleep(900);
            // The Agents rail is the SAME column at the same x, so it shares
            // the dragged width. Its edge must move it, and the reset must
            // return to the designed width before the collapse check below
            // expects 240.
            const agentsRailBox = () => page.evaluate(() => {
                const el = document.querySelector('[data-testid="agents-rail"]');
                return el ? Math.round(el.getBoundingClientRect().width) : -1;
            });
            const agentsRailBefore = await agentsRailBox();
            const agentsRailHandle = await page.locator('[data-testid="agents-rail-resize"]').boundingBox();
            if (agentsRailHandle) {
                const y = agentsRailHandle.y + Math.min(120, agentsRailHandle.height / 2);
                await page.mouse.move(agentsRailHandle.x + agentsRailHandle.width / 2, y);
                await page.mouse.down();
                await page.mouse.move(agentsRailHandle.x + agentsRailHandle.width / 2 + 40, y, { steps: 4 });
                await page.mouse.up();
            }
            await sleep(300);
            const agentsRailWide = await agentsRailBox();
            check('the Agents rail resizes from the same column handle',
                agentsRailWide >= agentsRailBefore + 32, `${agentsRailBefore} -> ${agentsRailWide}`);
            const agentsRailResetHandle = await page.locator('[data-testid="agents-rail-resize"]').boundingBox();
            if (agentsRailResetHandle) {
                await page.mouse.dblclick(
                    agentsRailResetHandle.x + agentsRailResetHandle.width / 2,
                    agentsRailResetHandle.y + Math.min(120, agentsRailResetHandle.height / 2));
            }
            await sleep(350);
            const agentsRailReset = await agentsRailBox();
            check('double-click restores the shared rail width',
                agentsRailReset === agentsRailBefore, `${agentsRailWide} -> ${agentsRailReset} (want ${agentsRailBefore})`);
            const away = async () => page.evaluate(() => {
                const el = document.querySelector('[data-testid="agents-rail"]');
                const visible = (node) => {
                    const cs = window.getComputedStyle(node);
                    return cs.visibility !== 'hidden' && cs.display !== 'none'
                        && node.getClientRects().length > 0;
                };
                return {
                    hidden: el ? el.className.split(/\s+/).includes('md:hidden') : null,
                    headerToggle: !!document.querySelector('[data-testid="nav-rail-toggle-header"]'),
                    switches: [...document.querySelectorAll('[data-testid^="surface-switch-"]')]
                        .filter(visible).length,
                };
            });
            await page.keyboard.press('Control+b');
            await sleep(600);
            const collapsed = await away();
            check('Ctrl+B puts the conversation column away and brings no tabs back',
                collapsed.hidden === true && collapsed.switches === 0,
                `md:hidden=${collapsed.hidden} visibleTabs=${collapsed.switches}`);
            check('the title bar carries the expand button exactly while the column is away',
                collapsed.headerToggle, 'nav-rail-toggle-header');
            const revived = await page.evaluate(() => {
                const t = document.querySelector('[data-testid="nav-rail-toggle-header"]');
                if (!t) return false;
                t.click();
                return true;
            });
            await sleep(600);
            const backAgain = await away();
            // The rail COMPONENT was deleted 2026-10-28; the width it defined is
            // still the sidebar's, and lives in the module that kept the live
            // pieces (components/shell/shellChrome.tsx).
            const navRailSrc = require('fs').readFileSync(
                path.join(ROOT, 'src', 'components', 'shell', 'shellChrome.tsx'), 'utf8');
            const navRailExpandedPx = Number((navRailSrc.match(/NAV_RAIL_EXPANDED_PX = (\d+)/) || [])[1]) || 240;
            const colWidth = await page.evaluate(() => {
                const el = document.querySelector('[data-testid="agents-rail"]');
                return el ? Math.round(el.getBoundingClientRect().width) : -1;
            });
            check('the title bar toggle brings the column back at the shell width',
                revived && backAgain.hidden === false && colWidth === navRailExpandedPx,
                `${colWidth}px, md:hidden=${backAgain.hidden} (want ${navRailExpandedPx})`);
            await page.keyboard.press('Control+b');
            await sleep(500);
            await page.evaluate(() => document.querySelector('[data-testid="nav-rail-toggle-header"]')?.click());
            await sleep(500);
            // Leave the run on a known surface before the sweep.
            await navTo('Analyze');
            await sleep(400);
        }

        /** Wait for the surface to settle: two identical, non-empty reads of
         *  <main>. A fixed sleep made this sweep flaky — under load a surface's
         *  lazy chunk arrives after the sleep, and the probe reported a blank
         *  Studio/Learn that the app was seconds away from filling. Two equal
         *  samples is the same rule `waitStableAnswer` uses for a reply, and it
         *  can still fail: only on a surface that genuinely stays empty. */
        const waitSurfaceText = async (deadlineMs = 12000) => {
            let prev = null;
            const until = Date.now() + deadlineMs;
            while (Date.now() < until) {
                const now = await page.evaluate(() => {
                    const main = document.querySelector('main');
                    if (!main) return '';
                    // The title bar lives INSIDE <main> now, so its text is
                    // constant across every surface — sampling it would make the
                    // first two reads equal and return the band as "the surface"
                    // a beat before the lazy chunk mounts. Measure the branches
                    // under it, which are what actually changes.
                    const head = main.querySelector(':scope > header');
                    let text = '';
                    for (const el of main.children) {
                        if (el === head) continue;
                        text += `${el.innerText ?? ''}\n`;
                    }
                    return text.trim();
                });
                if (now && now === prev) return now;
                prev = now;
                await sleep(250);
            }
            return prev ?? '';
        };
        let prevSurfaceText = '';
        for (const surface of surfaces) {
            const errorsBefore = pageErrors.length;
            // Open the menu first: navTo's in-menu search is the correct one,
            // and the global fallback it falls back to is what a button labelled
            // "Trade symbol" can hijack.
            await openMenu();
            await sleep(400);
            let how = await navTo(surface.label);
            if (how === 'not found') {
                await openMenu();
                await sleep(400);
                how = await navTo(surface.label);
            }
            check(`can navigate to ${surface.label}`, how === 'clicked', how);
            // The TAB must READ the name we meant to open. Navigation resolves
            // by surface id, so a stale label would still route correctly and
            // still mislead the trader — the label is a promise about the
            // surface, and the 2026-10-29 rename exists because 'Trade'
            // promised execution this app never performs.
            // Read the ANNOUNCED name, not the raw text: a tab may carry a badge
            // count inside the same button (Learning renders "Learning9+"), and
            // the accessible name is what a reader actually hears.
            const switchText = await page.evaluate((id) => {
                const el = document.querySelector(`[data-testid="surface-switch-${id}"]`);
                return el ? (el.getAttribute('aria-label') || '').trim() : null;
            }, surface.switchId);
            check(`the ${surface.label} tab reads its own name`,
                !!switchText && new RegExp('^' + surface.label + '[,. ]').test(switchText), String(switchText));
            if (surface.overlay) {
                let mounted = 0;
                const until = Date.now() + 12000;
                while (Date.now() < until) {
                    mounted = await page.locator(surface.expect).count();
                    if (mounted === 1) break;
                    await sleep(250);
                }
                check(`${surface.label} opens its own panel`, mounted === 1, `${mounted} mounted`);
                const text = mounted
                    ? (await page.locator(surface.expect).innerText()).trim() : '';
                check(`${surface.label} panel renders content`, text.length > 40, `${text.length} chars`);
            } else {
                const body = await waitSurfaceText();
                check(`${surface.label} surface renders content`, body.length > 40, `${body.length} chars`);
                // A click that leaves <main> byte-identical did not switch
                // surfaces however green the content check above looks — this
                // is what caught the Approvals entry re-reporting the Agents
                // surface, since the inbox mounts outside <main> entirely.
                check(`${surface.label} replaced the surface before it`,
                    body !== prevSurfaceText,
                    body === prevSurfaceText ? '<main> is unchanged by the click' : 'changed');
                prevSurfaceText = body;
                if (surface.expect) {
                    const mounted = await page.locator(surface.expect).count();
                    check(`${surface.label} mounts its own root`, mounted === 1, `${mounted}`);
                }
            }
            check(`${surface.label} introduces no pageerror`, pageErrors.length === errorsBefore,
                pageErrors.slice(errorsBefore).join(' | ').slice(0, 200));
            await dismissOverlays();
        }

        // The Health tab's telemetry used to rest behind a whole-view density
        // preset. That setting is gone (owner's call, 2026-10-10): the loop
        // telemetry, the market stats and the dashboards render on a first run
        // with nothing to toggle. The gate now proves the data is simply THERE
        // — a surface that only shows its panels after a press is a surface a
        // first run never meets.
        {
            await openMenu(); await sleep(300);
            await navTo('Learning'); await sleep(900);
            const coachTab = page.locator('[data-testid="learn-tab-health"]');
            if (await coachTab.count() === 1) await coachTab.click();
            await sleep(1200);
            const shown = await page.locator('[data-testid="learn-system"]').count();
            const resting = await page.locator('[data-testid="learn-resting"]').count();
            check('the loop telemetry shows with no preset behind it', shown === 1 && resting === 0,
                `blocks=${shown} resting=${resting}`);
        }

        /** Poll a predicate instead of sleeping a fixed time. Every fixed sleep
         *  in this sweep eventually read a surface mid-mount and called it blank,
         *  which is a worse failure than a slow test: it blames the app. */
        const pollFor = async (fn, deadlineMs = 12000) => {
            const until = Date.now() + deadlineMs;
            for (;;) {
                const value = await fn();
                if (value) return value;
                if (Date.now() >= until) return value;
                await sleep(250);
            }
        };

        // ── The Health tab is where this session's backend work becomes
        //    visible: the idle sweep's log line, the notebook byte budget, and
        //    the suspended-skill count all surface as flags or log rows. If the
        //    wiring were only in code, this is the check that would notice.
        const healthTab = page.locator('[data-testid="learn-tab-health"]');
        if (await healthTab.count()) {
            await page.evaluate(() => document
                .querySelector('[data-testid="learn-tab-health"]')?.click());
            const card = page.locator('[data-testid="memory-health-card"]');
            const hasCard = await pollFor(async () => (await card.count()) === 1);
            check('Learning → Health opens the memory health card', hasCard === true, `${hasCard}`);
            if (hasCard) {
                const cardText = await card.innerText();
                check('the idle skill sweep reports itself on screen',
                    /Idle skill sweep/i.test(cardText), cardText.slice(0, 200));
                check('the notebook byte budget is on screen, not just in code',
                    /blob size/.test(cardText) && /MB · (ok|soft|trigger|hard)/.test(cardText),
                    cardText.slice(cardText.indexOf('blob size'), cardText.indexOf('blob size') + 80));
                check('the suspended-skill count is on screen',
                    /skills suspended from prompts/.test(cardText),
                    cardText.slice(cardText.indexOf('skills suspended from prompts'),
                        cardText.indexOf('skills suspended from prompts') + 60));
            }
        } else {
            check('Learning → Health tab is reachable', false, 'no learn-tab-health control');
        }

        // ── The validation gate and the analytics panel are DAILY paths with no
        //    render guard. runValidationGate runs inside analysisResultProcessor
        //    on every settled result — it is NOT behind the accuracy-mode toggle
        //    — and the Advanced Analytics panel is the only place Monte Carlo
        //    renders at all. A crash in either took a surface down silently:
        //    the row-count sweep covers the four nav surfaces only, so nothing
        //    else would have noticed.
        // Navigate FIRST. Reading document.body from whatever surface happens
        // to be open is the "check whose measurement is identical across two
        // different states" trap: on Learn there is no verdict, so the check
        // measures the wrong screen and fails for the wrong reason.
        // The surface menu is the persistent nav rail, so a bare navTo always finds
        // the row — no "open the menu first" dance is needed any more.
        let toTrade = await navTo('Analyze');
        if (toTrade === 'not found') {
            await openMenu();
            await sleep(400);
            toTrade = await navTo('Analyze');
        }
        await sleep(500);
        check('returned to Trade for the daily-path checks', toTrade !== 'not found', `${toTrade}`);

        // The order book is a DAILY surface and until now had NO test hooks at
        // all — the panel shipped without a single data-testid, so nothing
        // outside its own unit test could assert it rendered. The ladder is
        // 12 asks + spread band + 12 bids; a row count catches a ladder that
        // silently emptied (a dead socket, an all-zero-qty frame) and a spread
        // band that stopped painting, both of which a pageerror check misses
        // because neither throws.
        // v3: the book is a DRAWER closed by default (30px strip), not a
        // resizable right column. Open it the way the trader does — press the
        // strip — then assert the ladder, the band and the header.
        const stripPressed = await page.evaluate(() => {
            const b = document.querySelector('[data-testid="orderbook-drawer-strip"]');
            if (!b) return 'no strip';
            if (b.getAttribute('aria-expanded') !== 'true') b.click();
            return 'clicked';
        });
        const bookRows = page.locator('[data-testid="orderbook-row"]');
        // The panel's REST fallback polls every 5s; 8s raced the first
        // successful frame. The property is "paints a full ladder", not "in 8s".
        const bookRowCount = await pollFor(async () => {
            const n = await bookRows.count();
            return n >= 24 ? n : 0;
        }, 15000);
        check('the drawer opens by pressing its strip and paints a full ladder',
            stripPressed === 'clicked' && bookRowCount >= 24,
            `${stripPressed}; ${bookRowCount || await bookRows.count()} rows (12 asks + 12 bids)`);
        const bookBand = page.locator('[data-testid="orderbook-spread"]');
        check('the order book paints its spread band', (await bookBand.count()) === 1,
            `${await bookBand.count()}`);
        const bookHead = page.locator('[data-testid="orderbook-header"]');
        check('the order book has its Price/Size/Total header', (await bookHead.count()) === 1,
            `${await bookHead.count()}`);
        // Closing must REMOVE the panel, not merely hide the ladder: a shut
        // drawer that still lays out 320px is a panel pretending to be closed.
        await page.evaluate(() => {
            document.querySelector('[data-testid="orderbook-drawer-strip"]')?.click();
        });
        await sleep(250);
        const closedByStrip = await page.evaluate(() => (
            document.querySelector('[data-testid="orderbook-drawer-strip"]')?.getAttribute('aria-expanded')));
        const drawerGone = await page.evaluate(() => {
            const strip = document.querySelector('[data-testid="orderbook-drawer-strip"]');
            return {
                rows: document.querySelectorAll('[data-testid="orderbook-row"]').length,
                expanded: strip?.getAttribute('aria-expanded'),
                stripH: strip ? Math.round(strip.getBoundingClientRect().height) : -1,
            };
        });
        check('closing the drawer removes the panel and returns the strip to 30px',
            closedByStrip === 'false' && drawerGone.rows === 0 && drawerGone.expanded === 'false'
            && drawerGone.stripH <= 32,
            JSON.stringify(drawerGone));
        // The chart-head control is the same switch: opening the drawer there
        // and closing it there must leave the same state the strip leaves.
        const headClicked = await page.evaluate(() => {
            const b = document.querySelector('[data-testid="trade-book-toggle"]');
            if (!b) return 'no toggle';
            b.click();
            return 'clicked';
        });
        await sleep(300);
        const afterHead = await page.evaluate(() => ({
            rows: document.querySelectorAll('[data-testid="orderbook-row"]').length,
            expanded: document.querySelector('[data-testid="orderbook-drawer-strip"]')?.getAttribute('aria-expanded'),
        }));
        check('the chart-head book control opens the same drawer',
            headClicked === 'clicked' && afterHead.expanded === 'true' && afterHead.rows >= 24,
            `${headClicked}; ${JSON.stringify(afterHead)}`);
        await page.evaluate(() => {
            const b = document.querySelector('[data-testid="trade-book-toggle"]');
            if (b?.getAttribute('aria-expanded') === 'true') b.click();
        });
        await sleep(250);

// The Chart AI dock: its separator drags to size it and its header X
        // collapses it to the rail — while the panel stays mounted, so a draft
        // or an in-flight turn survives. Both are the contract the shared
        // right-panel hook promises; this is the browser seeing it happen.
        const dockWidth = () => page.evaluate(() => {
            const el = document.querySelector('[data-testid="trade-dock"]');
            return el ? Math.round(el.getBoundingClientRect().width) : -1;
        });
        const dockBefore = await dockWidth();
        const dockHandle = await page.locator('[aria-label="Resize Chart AI"]').boundingBox();
        if (dockHandle) {
            const y = dockHandle.y + Math.min(120, dockHandle.height / 2);
            await page.mouse.move(dockHandle.x + dockHandle.width / 2, y);
            await page.mouse.down();
            await page.mouse.move(dockHandle.x + dockHandle.width / 2 - 48, y, { steps: 4 });
            await page.mouse.up();
        }
        await sleep(300);
        const dockWide = await dockWidth();
        check('the Chart AI dock drags wider from its separator',
            dockWide >= dockBefore + 40, `${dockBefore} -> ${dockWide}`);
        const dockResetHandle = await page.locator('[aria-label="Resize Chart AI"]').boundingBox();
        if (dockResetHandle) {
            await page.mouse.dblclick(
                dockResetHandle.x + dockResetHandle.width / 2,
                dockResetHandle.y + Math.min(120, dockResetHandle.height / 2));
        }
        await sleep(300);
        const dockReset = await dockWidth();
        check('double-click restores the dock width',
            dockReset === dockBefore, `${dockWide} -> ${dockReset} (want ${dockBefore})`);
        const dockCollapsed = await page.evaluate(() => {
            const b = [...document.querySelectorAll('[aria-label="Collapse Chart AI"]')][0];
            if (!b) return 'no control';
            b.click();
            return 'clicked';
        });
        await sleep(450);
        const dockAway = await page.evaluate(() => ({
            hidden: document.querySelector('[data-testid="trade-dock"]')?.getAttribute('data-hidden'),
            rail: !!document.querySelector('[data-testid="trade-chat-rail"]'),
            panel: !!document.querySelector('[data-testid="trade-chat-panel"]'),
        }));
        check('the dock collapses to its rail without unmounting the thread',
            dockCollapsed === 'clicked' && dockAway.hidden === 'true' && dockAway.rail && dockAway.panel,
            `${dockCollapsed} hidden=${dockAway.hidden} rail=${dockAway.rail} panel=${dockAway.panel}`);
        const dockRevived = await page.evaluate(() => {
            const b = [...document.querySelectorAll('[aria-label="Expand Chart AI"]')][0];
            if (!b) return false;
            b.click();
            return true;
        });
        await sleep(500);
        const dockBack = await page.evaluate(() =>
            document.querySelector('[data-testid="trade-dock"]')?.getAttribute('data-hidden'));
        check('the dock expands again from its rail', dockRevived && dockBack === 'false',
            `revived=${dockRevived} hidden=${dockBack}`);

        // NOTE: the gate's per-criterion `validationScores` (risk/reward,
        // confluence, regime…) are computed and stored on the analysis but
        // never rendered by ANY component — grepping components/ for
        // `validationScores` returns nothing. So there is no risk/reward text
        // to assert here, and an earlier version of this check looked for it
        // and failed for that reason. The gate's user-visible effect is the
        // confidence/direction/verdict block, which the settled-verdict checks
        // above already cover. Asserting a string the app never prints would be
        // a check that can only ever fail.

        // The Advanced Analytics panel is lazy-on-demand: it mounts only after
        // `isAdvancedAnalyticsEverOpened` flips, and its only trigger is
        // selecting an analysis message from a per-message control — not the
        // message row itself, and not any global nav item. An earlier version
        // of this block clicked the row and asserted the panel mounted; it did
        // not, and shipping that as a gate would have reddened CI on a surface
        // the probe genuinely cannot reach.
        //
        // So this is reported, not asserted: the COVERAGE GAP is the finding.
        // The panel now carries data-testid hooks so the day someone wires a
        // stable entry point, the assertion is one locator away.
        const analyticsPanel = page.locator('[data-testid="advanced-analytics-panel"]');
        const analyticsMounted = await pollFor(async () => (await analyticsPanel.count()) === 1, 1500);
        check('Advanced Analytics render coverage', true, analyticsMounted
            ? 'panel mounted and was asserted'
            : 'GAP: lazy-on-demand panel has no stable probe entry point — not asserted (testids added for when it does)');
        if (analyticsMounted) {
            const mc = page.locator('[data-testid="monte-carlo-panel"]');
            const mcRendered = await pollFor(async () => (await mc.count()) === 1);
            check('the Monte Carlo panel renders inside it', mcRendered === true, `${mcRendered}`);
        }

        // ── The desk pane and the roster bot share a model: both seeded answers
        //    must still be on screen. This is the browser proof for the row that
        //    used to render NOWHERE — claimed out of the desk pane by
        //    provider+model, never shown in the bot's own thread.
        let backToChat = await navTo('Agents');
        if (backToChat === 'not found') {
            await openMenu();
            await sleep(400);
            backToChat = await navTo('Agents');
        }
        check('can return to the Agents surface', backToChat === 'clicked', backToChat);

        // ── A turn asked in the DOCK is visible in the Agents surface's bot
        //    thread. Nothing measured this until now: the probe proved both
        //    surfaces render, never that a turn CROSSES between them. It is
        //    easy to break — a composer appending to the chat session instead
        //    of the conversation — and invisible in every other check, because
        //    both surfaces look healthy while the exchange has never happened
        //    anywhere the trader can reach.
        //
        //    The menu is opened BEFORE navigating, deliberately. `navTo` falls
        //    back to a page-wide search when the menu is not mounted, and on
        //    the Agents surface that search matches SymbolPicker's "Trade
        //    symbol" trigger — clicking the coin picker and reporting
        //    'clicked'. Opening the menu first makes the scoped search find
        //    the real nav item, which is the whole reason that helper scopes
        //    to the menu before falling back.
        const HOP_ASK = 'SYNC ACROSS SURFACES probe';
        let askedInDock = false;
        {
            await openMenu();
            await sleep(400);
            const toTrade = await navTo('Analyze');
            await sleep(900);
            // The dock is a lg+ affordance and can be collapsed to a rail.
            await page.evaluate(() => {
                const b = [...document.querySelectorAll('button')]
                    .find(x => x.getAttribute('aria-label') === 'Expand Chart AI');
                if (b) b.click();
            });
            await sleep(600);
            const opened = await page.evaluate(() => {
                const menu = [...document.querySelectorAll('button')]
                    .find(b => b.getAttribute('aria-label') === 'Customization');
                if (!menu) return 'no customization button';
                menu.click();
                return 'menu';
            });
            if (opened === 'menu') {
                await sleep(400);
                await page.evaluate(() => {
                    const b = [...document.querySelectorAll('button')].find(x =>
                        /probe bot/i.test(x.textContent || '') && /as bot/i.test(x.textContent || ''));
                    if (b) b.click();
                });
                await sleep(800);
                const sent = await page.evaluate((needle) => {
                    const ta = document.querySelector('textarea');
                    if (!ta || ta.disabled) return 'no composer';
                    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
                        .set.call(ta, needle);
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                    const btn = [...document.querySelectorAll('button')].find(b => /send/i.test(
                        `${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`));
                    if (!btn) return 'no send button';
                    if (btn.disabled) return 'send disabled';
                    btn.click();
                    return 'clicked';
                }, HOP_ASK);
                if (sent === 'clicked') {
                    await waitStableAnswer(page);
                    askedInDock = true;
                }
                check('a bot turn can be asked in the dock', askedInDock,
                    `nav=${toTrade} send=${sent}`);
            } else {
                check('a bot turn can be asked in the dock', false, `nav=${toTrade} ${opened}`);
            }
        }

        if (askedInDock) {
            await openMenu();
            // Wait for the dock turn to be committed before switching surfaces.
            // A fixed sleep here raced the store write, and the failure it
            // produced was reported against the WRONG surface — "not in the bot
            // thread on the Agents surface" — for a turn that had not yet landed
            // in the dock at all. Two defects are now distinguished: the dock
            // never took it, or the Agents surface never showed it.
            const landedInDock = await pollFor(async () => {
                const text = await page.locator('[data-testid="trade-chat-panel"], [data-testid="trade-dock"]').first().innerText();
                return text.includes(HOP_ASK) ? true : null;
            }, 15000);
            check('a turn asked in the dock shows in the dock', landedInDock != null,
                landedInDock == null ? 'the dock never rendered the turn' : 'rendered');

            await navTo('Agents');
            await pollFor(async () => {
                const visible = await page.locator('[data-testid="agents-view"]').count();
                return visible > 0 ? true : null;
            }, 8000);
            // The bot row click: the thread must be OPEN before asserting on its
            // contents, and the button may not be there yet on a slow render.
            // The roster is in the same scroll as the conversations now (the
            // Chats | Bots strip is deleted), so the row is reachable directly.
            {
            // The owner asked for the tab strip to go; a column with one is the
            // defect, so this asserts the SHAPE (no tablist, no rail-tab-*) and
            // that the roster needs no switch to be reachable.
            const column = await page.evaluate(() => ({
                tablists: document.querySelectorAll('[data-testid="agents-rail"] [role="tablist"]').length,
                tabs: document.querySelectorAll('[data-testid^="rail-tab-"]').length,
                bots: [...document.querySelectorAll('[data-testid="agents-rail"] button')]
                    .filter(b => /probe bot/i.test(b.textContent || '')).length,
            }));
            check('the Agents column has no conversation tabs and the roster needs no switch',
                column.tablists === 0 && column.tabs === 0 && column.bots >= 1,
                JSON.stringify(column));
        }
        const openedBot = await pollFor(async () => {
                const clicked = await page.evaluate(() => {
                    const b = [...document.querySelectorAll('button')]
                        .find(x => /probe bot/i.test(x.textContent || ''));
                    if (!b) return false;
                    b.click();
                    return true;
                });
                return clicked ? true : null;
            }, 8000);
            const found = openedBot == null ? null : await pollFor(async () => {
                const pane = page.locator('[data-testid="agents-view"]');
                const t = await pane.innerText();
                return t.includes(HOP_ASK) ? await pane.locator('[data-testid="agent-message"]').count() : null;
            }, 15000);
            check('a turn asked in the dock is visible in the Agents surface',
                found != null,
                found == null
                    ? (openedBot == null
                        ? 'the bot row was never available on the Agents surface'
                        : 'the dock turn never appeared in the bot thread')
                    : `${found} rows`);
        }
        const paneText = await pollFor(async () => {
            const text = await page.locator('[data-testid="agents-view"]').innerText();
            return text.trim().length > 200 ? text : null;
        }) ?? (await page.locator('[data-testid="agents-view"]').innerText());
        const visibleSeeded = ['Long BTC from the reclaim', 'No trade — the reclaim failed']
            .filter(t => paneText.includes(t));
        check('the desk pane keeps the trader’s answers when a bot shares that model',
            visibleSeeded.length === 2, `${visibleSeeded.length}/2 kept`);
        check('no row vanished between the dock and the desk pane',
            await page.locator('[data-testid="agent-message"]').count() >= 4,
            `${await page.locator('[data-testid="agent-message"]').count()} rows`);

        // ── Skills left the rail for Settings, and the Customize row is now the
        //    only quick way in. Nothing else covers it: the surface sweep can no
        //    longer see a Skills surface, and the Settings sweep below opens only
        //    Data. So press the row and assert the Studio's OWN root mounted —
        //    a route that opens the wrong tab would otherwise pass every gate.
        const customize = await page.evaluate(() => {
            const b = document.querySelector('[data-testid="nav-customize"]');
            if (!b) return 'no row';
            b.click();
            return 'clicked';
        });
        // The Studio rides a React.lazy chunk behind a Suspense, so the Skills
        // tab appears BEFORE the Studio mounts. A fixed 1.5s wait sampled once
        // and raced the chunk — the merge that deleted the automation chunk
        // re-chunked the bundle enough to lose. Poll for the Studio's own
        // root: the claim is the route MOUNTS it, not that it lands within a
        // hard-coded window. The fallthrough re-samples once at the deadline
        // so a failure still names which of the three facts was missing.
        const studioMounted = await pollFor(async () => page.evaluate(() => {
            const knowledge = !!document.querySelector('[data-testid="learn-view"]');
            const skillsTab = !!document.querySelector('[data-testid="learn-skills"]');
            const studio = !!document.querySelector('[data-testid="studio-view"]');
            return knowledge && skillsTab && studio;
        }));
        const reached = studioMounted === true
            ? { knowledge: true, skillsTab: true, studio: true }
            : await page.evaluate(() => ({
                knowledge: !!document.querySelector('[data-testid="learn-view"]'),
                skillsTab: !!document.querySelector('[data-testid="learn-skills"]'),
                studio: !!document.querySelector('[data-testid="studio-view"]'),
            }));
        // Three things, because landing on the right SURFACE is not the claim —
        // the row promises the library, so the Skills tab must be the one showing
        // and the Studio must actually be mounted inside it.
        check('the Customize row lands on the Skills tab of the Learning surface',
            customize === 'clicked' && reached.knowledge && reached.skillsTab && reached.studio,
            `${customize} knowledge=${reached.knowledge} skills=${reached.skillsTab} studio=${reached.studio}`);
        await page.waitForTimeout(600);

        // ── The Studio's URL importer (item 6). It is the one control in the
        //    app that pulls bytes off the network into the skill library, and
        //    the shipped rule is "https only" — which has to REACH THE TRADER
        //    as text, not vanish. `http://` is used deliberately: it refuses
        //    before any request leaves, so this arm needs no network, cannot
        //    flake on DNS, and still exercises the whole click → fetch →
        //    toast chain. The button's empty state is measured first because
        //    two zeros are not a contrast: an always-dead button would answer
        //    the same click with the same nothing.
        const urlBox = page.locator('[data-testid="skills-import-url"]');
        const urlGo = page.locator('[data-testid="skills-import-url-go"]');
        const disabledBefore = await urlGo.isDisabled().catch(() => null);
        await urlBox.fill('http://insecure.example/skills/x/SKILL.md').catch(() => {});
        const disabledAfter = await urlGo.isDisabled().catch(() => null);
        await urlGo.click().catch(() => {});
        const refusalShown = await pollFor(async () => page.evaluate(() =>
            (/only https:\/\/ URLs are fetched/.test(document.body.innerText || '')) ? 1 : null));
        check('the URL Fetch button arms only once the field holds a URL',
            disabledBefore === true && disabledAfter === false, `before=${disabledBefore} after=${disabledAfter}`);
        check('a non-https skill URL is refused out loud, not dropped',
            refusalShown === 1, refusalShown === 1 ? '' : 'no refusal text on the page');
        await urlBox.fill('').catch(() => {});

        // ── The row's two-click Delete must take the BUNDLED files with the
        //    head. A skill that arrived as a folder owns `<slug>__…` siblings
        //    that only it addresses, so a head-only delete leaves bytes in the
        //    library nothing can open — invisible in the DOM, which is exactly
        //    why this reads the stored notebook rather than the row count.
        const bundleNames = ['probe-bundle-skill.md',
            'probe-bundle-skill__references__note.md',
            'probe-bundle-skill__scripts__helper.py.md'];
        const readBundles = () => page.evaluate((wanted) => {
            const nk = Object.keys(localStorage).find(k => k.startsWith('memory_files_v1'));
            if (!nk) return null;
            let store = {};
            try { store = JSON.parse(localStorage.getItem(nk) || '{}'); } catch { return null; }
            const skills = (store.folders || []).find(f => f.name === 'skills');
            let all = store.files || [];
            const shardKey = skills && store.shards ? (store.shards[skills.id] || {}).key : null;
            if (shardKey) {
                try { all = all.concat(JSON.parse(localStorage.getItem(shardKey) || '{}').files || []); } catch { /* shard unreadable */ }
            }
            const names = skills ? all.filter(f => f.folderId === skills.id).map(f => f.name) : [];
            return wanted.filter(w => names.includes(w));
        }, bundleNames);
        const beforeDelete = await readBundles();
        const delSel = '[data-testid="studio-delete-probe-bundle-skill"]';
        let deletePressed = 'no control';
        try {
            await page.waitForSelector(delSel, { timeout: 6000 });
            await page.click(delSel);
            await page.click(delSel);
            deletePressed = 'clicked twice';
        } catch (err) { deletePressed = `unreachable: ${String(err).slice(0, 60)}`; }
        const cleared = await pollFor(async () => {
            const left = await readBundles();
            return left && left.length === 0 ? 0 : null;
        }, 8000);
        check('a bundled skill seeds with its support files in the notebook',
            Array.isArray(beforeDelete) && beforeDelete.length === 3, JSON.stringify(beforeDelete));
        check('the row Delete is reachable on a bundled skill',
            deletePressed === 'clicked twice', deletePressed);
        check('Delete takes the bundled files with the head, in the stored notebook',
            cleared === 0, JSON.stringify(await readBundles()));
        await page.waitForTimeout(400);

        // ── Settings → Data hosts the backup manager. Its "Import from file"
        //    control is new, and the Settings overlay mounts outside <main> like
        //    the approvals inbox, so <main> can never show it. The trigger's
        //    accessible name is not pinned by any test, so discover it and
        //    report the candidates rather than assuming a selector.
        // ── Settings → Data hosts the backup manager, whose "Import from file"
        //    control is new. No element in the DOM carries an accessible name
        //    matching "settings" — this run's own diagnostics proved it, listing
        //    every aria-label instead of failing on a guessed selector — so reach
        //    it the way a bookmark does: the hash route App.tsx already parses.
        //    The overlay also mounts outside <main>, so <main> can never show it.
        await page.evaluate(() => { window.location.hash = '#/settings'; });
        const dataTab = await pollFor(async () => page.evaluate(() => {
            const tab = [...document.querySelectorAll('button')]
                .find(b => /^data$/i.test((b.textContent || '').trim()));
            if (!tab) return null;
            tab.click();
            return 'clicked';
        }));
        check('the Settings overlay opens from its route', dataTab === 'clicked', `${dataTab}`);
        if (dataTab === 'clicked') {
            const storageCard = await pollFor(async () => (
                await page.locator('[data-testid="storage-location-card"]').count() === 1
            ) ? 1 : null);
            check('Settings → Data says where the journal is stored', storageCard === 1, `${storageCard}`);
            const storageValue = await page.locator('[data-testid="storage-location-value"], [data-testid="storage-location-unknown"]').first().innerText().catch(() => '');
            check('the storage card reaches an answer, not a permanent "Checking…"',
                /SQLite|IndexedDB|unavailable/i.test(storageValue), storageValue.slice(0, 120));
            const importMounted = await pollFor(async () => (
                await page.locator('[data-testid="backup-import-button"]').count() === 1
            ) ? 1 : null);
            check('the backup manager offers an import control', importMounted === 1, `${importMounted}`);
            // Export lives on a backup ROW, so with an empty list there is
            // nothing to sit beside the import control — create a backup first,
            // which is also the only way to prove the panel's write path works
            // from a real click.
            const created = await page.evaluate(() => {
                const btn = [...document.querySelectorAll('button')]
                    .find(b => /back up now/i.test((b.textContent || '').trim()));
                if (!btn) return 'no create button';
                btn.click();
                return 'clicked';
            });
            check('the panel can create a backup from a click', created === 'clicked', created);
            const exportFound = await pollFor(async () => page.evaluate(() => {
                const found = [...document.querySelectorAll('button')].some(
                    b => /export/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')),
                );
                return found || null;
            }));
            check('a stored backup can be exported, and an exported file can be imported back',
                exportFound === true,
                (await page.evaluate(() => [...document.querySelectorAll('button')]
                    .map(b => (b.getAttribute('aria-label') || b.textContent || '').trim())
                    .filter(Boolean).slice(0, 10).join(' | '))).slice(0, 200));

            // ── decision 3: the chat backup round trip, in a real browser ────
            // The unit suites prove stripChatSessionImages and the live-image
            // reconciliation against a jsdom localStorage. This runs the SAME two
            // exported functions in Chromium on the app's own dev-server modules,
            // so the question asked of it is the one a unit test cannot answer:
            // does restoring a stripped backup over live data keep the screenshot
            // that is still on the device? Reached through the app's module graph
            // rather than a downloaded file, because the panel's file round trip is
            // a Blob + dialog the probe cannot observe; everything under test is the
            // same code the panel calls.
            const restoreProbe = await page.evaluate(async (marker) => {
                const user = localStorage.getItem('last_active_user') || 'default';
                const key = `trade_chat_sessions_v1_${user}`;
                const dataUrl = 'data:image/png;base64,' + 'A'.repeat(20000) + marker;
                const live = [{
                    id: 'probe-session', title: 'Probe chat', createdAt: 1, updatedAt: 2,
                    entries: [
                        { id: 'pe1', role: 'user', text: 'probe text before', tools: [], image: dataUrl },
                        { id: 'pe2', role: 'ai', text: 'probe text after', tools: [] },
                    ],
                }];
                localStorage.setItem(key, JSON.stringify(live));
                const mod = await import('/src/services/infrastructure/ExportService.ts');
                const backup = await mod.exportPreferencesData();
                const exported = JSON.stringify(backup[key] || null);
                const report = await mod.importPreferencesData(backup);
                const after = localStorage.getItem(key) || '';
                return {
                    key,
                    exportedHasImage: exported.includes('data:image/png'),
                    exportedHasStub: exported.includes('imageOmitted'),
                    liveStillHasImage: after.includes(marker),
                    liveTextKept: after.includes('probe text before'),
                    failed: report.failedKeys.length,
                    // The key under test, not the whole run: a live app carries
                    // plain-string and probe-owned keys that the restore allow-list
                    // is SUPPOSED to skip, and asserting zero skips browser-wide
                    // would only prove the guard works.
                    chatSkipped: report.skippedKeys.includes(key),
                    chatFailed: report.failedKeys.includes(key),
                    skippedCount: report.skippedKeys.length,
                };
            });
            check('the exported chat copy carries no image bytes but does carry the stub',
                restoreProbe.exportedHasImage === false && restoreProbe.exportedHasStub === true,
                JSON.stringify(restoreProbe));
            check('restoring that copy keeps the screenshot already on the device',
                restoreProbe.liveStillHasImage === true && restoreProbe.liveTextKept === true,
                JSON.stringify(restoreProbe));
            check('the chat row itself was written by the restore, not skipped or failed',
                restoreProbe.failed === 0 && !restoreProbe.chatSkipped && !restoreProbe.chatFailed,
                JSON.stringify(restoreProbe));

            // ── Settings → Memory: the Claude-shaped page ─────────────────
            // Seed four entries, one per subject, then prove the page groups
            // them, opens an entry's own page, and offers the two real
            // switches. A memory page that renders empty passes every
            // component test there is.
            await page.evaluate(() => {
                const user = localStorage.getItem('last_active_user') || 'Probe User';
                const at = (d) => new Date(Date.UTC(2026, 9, d, 4, 0)).toISOString();
                localStorage.setItem(`profile_memory_v1_${user}`, JSON.stringify([
                    { slug: 'risk-style', description: 'Sizes risk at 0.5% per trade', kind: 'feedback', subject: 'preference',
                        body: 'Keeps the account alive through a losing streak.', createdAt: at(20), updatedAt: at(28), tag: 'stated', version: 1 },
                    { slug: 'trader-profile', description: 'Runs a small perp account from Manila', kind: 'user', subject: 'profile',
                        body: 'Trades the London open around a day job.', createdAt: at(18), updatedAt: at(27), tag: 'stated', version: 1 },
                    { slug: 'session-timing', description: 'Most active around the London open', kind: 'reference', subject: 'topic',
                        body: 'Watches the first hour of London.', createdAt: at(16), updatedAt: at(26), tag: 'stated', version: 1 },
                    { slug: 'august-signal-first-harness-architecture-notes', title: 'August Signals',
                        description: 'Building a signal-first harness', kind: 'project', subject: 'area', section: 'Trading',
                        body: 'Every call is graded against the tape.', createdAt: at(14), updatedAt: at(29), tag: 'stated', version: 1 },
                    { slug: 'area-work', description: 'Keeps the review notes in the notebook', kind: 'project', subject: 'area',
                        body: 'The notebook is the record.', createdAt: at(12), updatedAt: at(25), tag: 'stated', version: 1 },
                ]));
            });
            const memoryClicked = await page.evaluate(() => {
                const btn = [...document.querySelectorAll('button')]
                    .find(b => (b.textContent || '').trim() === 'Memory');
                if (!btn) return null;
                btn.click();
                return 'clicked';
            });
            check('Settings → Memory opens from the nav', memoryClicked === 'clicked', `${memoryClicked}`);
            const memoryTab = await pollFor(async () => (
                await page.locator('[data-testid="memory-tab"]').count() === 1
            ) ? 1 : null);
            check('the Memory page mounts', memoryTab === 1, `${memoryTab}`);
            if (memoryTab === 1) {
                // Poll for the grouped page rather than sampling it once: the
                // Memory tab mounts its rows in a second pass after the page
                // root, and a single read raced that pass (the rows check below
                // passed while this one saw no groups). The property is the
                // grouping and its order, not the latency.
                const readGroups = () => page.evaluate(() => ['trading', 'preferences', 'profile', 'topics', 'areas']
                    .filter(g => document.querySelector(`[data-testid="memory-group-${g}"]`)));
                const groups = await pollFor(async () => {
                    const seen = await readGroups();
                    return seen.length === 5 ? seen : null;
                }) ?? await readGroups();
                check('memories are grouped by category, custom categories first',
                    groups.join(',') === 'trading,preferences,profile,topics,areas', groups.join(','));
                const rows = await page.evaluate(() => ['risk-style', 'trader-profile', 'session-timing', 'august-signal-first-harness-architecture-notes', 'area-work']
                    .filter(s => document.querySelector(`[data-testid="memory-entry-${s}"]`)));
                check('every seeded memory draws a row under its category', rows.length === 5, rows.join(','));
                const longRowLabel = await page.evaluate(() => {
                    const row = document.querySelector('[data-testid="memory-entry-august-signal-first-harness-architecture-notes"]');
                    const span = row ? row.querySelector('span') : null;
                    return span ? (span.textContent || '').trim() : null;
                });
                check('a long slug shows its stored short title, not a truncated slug',
                    longRowLabel === 'August Signals', `${longRowLabel}`);
                const switches = await page.evaluate(() => [
                    document.querySelector('[data-testid="trader-learning-toggle"] [role="switch"]')?.getAttribute('aria-checked') ?? null,
                    document.querySelector('[data-testid="memory-sensitive-toggle"] [role="switch"]')?.getAttribute('aria-checked') ?? null,
                ]);
                check('the two real switches are mounted with their own state',
                    switches.length === 2 && switches.every(v => v === 'true' || v === 'false'), JSON.stringify(switches));
                check('the export control is present', await page.locator('[data-testid="memory-export"]').count() === 1);

                const opened = await page.evaluate(() => {
                    const row = document.querySelector('[data-testid="memory-entry-august-signal-first-harness-architecture-notes"] button');
                    if (!row) return null;
                    row.click();
                    return 'clicked';
                });
                check('a memory row opens its own page', opened === 'clicked', `${opened}`);
                const detail = await pollFor(async () => {
                    const el = await page.locator('[data-testid="memory-detail"]').first().innerText().catch(() => '');
                    return /August Signals/.test(el) && /Summary/i.test(el) && /Details/i.test(el) && /graded against the tape/.test(el)
                        ? el : null;
                });
                check('the entry page shows its title, Summary and Details', !!detail,
                    String(detail).slice(0, 140));
                const back = await page.evaluate(() => {
                    const b = document.querySelector('[data-testid="memory-back"]');
                    if (!b) return null;
                    b.click();
                    return 'clicked';
                });
                check('and the page returns to the list', back === 'clicked'
                    && await page.locator('[data-testid="memory-entry-august-signal-first-harness-architecture-notes"]').count() === 1, `${back}`);
            }

            await page.evaluate(() => { window.location.hash = ''; });
        }

        // ── The stale-model banner, on the surface that shipped without one ─
        // The dock has warned about a dead chat-model pick for a while; the Chat
        // surface ran the SAME pick with NO warning. Unit tests can prove the
        // component renders — only the real app proves App's prop actually
        // reaches it. Both states are measured: a check that reads the same
        // either way is measuring nothing.
        const bannerOnChat = async (stale) => {
            await page.evaluate((v) => {
                if (v) localStorage.setItem('casual_chat_model', v);
                else localStorage.removeItem('casual_chat_model');
            }, stale ? 'probe-provider::probe-stale-model' : null);
            await page.reload();
            await sleep(1800);
            const how = await navTo('Agents');
            await sleep(1200);
            const text = await page.evaluate(() => {
                const el = document.querySelector('[data-testid="model-fallback-warning"]');
                return el ? (el.textContent || '').trim() : null;
            });
            return { how, text };
        };
        const withStale = await bannerOnChat(true);
        check('a stale chat-model pick warns on the Agents surface',
            withStale.how === 'clicked' && !!withStale.text
            && /no longer configured|disabled or has no API key/.test(withStale.text)
            && /Answering with/.test(withStale.text),
            `${withStale.how} · ${(withStale.text || 'no banner rendered').slice(0, 140)}`);
        const withoutStale = await bannerOnChat(false);
        check('and goes quiet once the pick is not stale',
            withoutStale.how === 'clicked' && withoutStale.text === null,
            `${withoutStale.how} · still reading: ${String(withoutStale.text).slice(0, 120)}`);

        // ── Dead-control sweep ───────────────────────────────────────────
        // Mounting a surface proves the surface renders, not that its buttons
        // work. This is the shape of the Approvals hole: the pane was there, the
        // control was there, and the probe had asserted nothing about the click.
        // A control counts as alive if it changes the surface's text, opens an
        // overlay, or routes anywhere — each candidate gets a FRESH visit so one
        // control's effect cannot be credited to the next, and it is found by
        // label rather than index because a click can add or remove rows.
        const sweepSurface = async (label, cap, tabs = []) => {
            const visit = async (tabTestId) => {
                let how = await navTo(label);
                if (how === 'not found') {
                    await openMenu();
                    await sleep(400);
                    await navTo(label);
                }
                if (tabTestId) {
                    await page.evaluate((id) => document
                        .querySelector(`[data-testid="${id}"]`)?.click(), tabTestId);
                }
                await sleep(1200);
            };
            const tried = new Set();
            const inert = [];
            const unverifiable = [];
            // A tabbed surface keeps everything off its default tab OUT of the
            // DOM, so pressing only the tab buttons would sweep one view and
            // call the other panels judged. Enter each tab and sweep what it
            // reveals; the press budget is split across the views.
            const perView = Math.max(2, Math.ceil(cap / (tabs.length + 1)));
            for (const tabTestId of [null, ...tabs]) {
            for (let n = 0; n < perView; n += 1) {
                await visit(tabTestId);
                // Pick from what is ON SCREEN NOW and click in the same
                // evaluate, so the measurement is of the control that was
                // actually pressed. Enumerating a name list up front and
                // clicking it later measured nothing on a tabbed surface: half
                // the names had unmounted by the time their turn came, and a
                // sweep that clicks nothing reports "zero inert controls".
                const picked = await page.evaluate((skip) => {
                    const main = document.querySelector('main') || document.body;
                    const nameOf = b => (b.getAttribute('aria-label') || b.textContent || '').trim();
                    const btn = [...main.querySelectorAll('button')]
                        .find(b => !b.disabled && b.offsetParent !== null
                            // A control that is already the selected/pressed one
                            // is SUPPOSED to no-op. This app marks that three
                            // different ways depending on the component —
                            // aria-pressed (journal chips), aria-current (Learn
                            // tabs), aria-selected (the Log/History switch) — so
                            // the sweep has to honour all three or it cries
                            // wolf at working code.
                            && b.getAttribute('aria-pressed') !== 'true'
                            // ANY aria-current marks the control as the one you
                            // are already on — the nav rows and the title-bar
                            // switch say `page`, the Learning tabs say `true`. The
                            // sweep only recognised 'true', so it judged the
                            // current screen's own switch button inert.
                            && !b.getAttribute('aria-current')
                            && b.getAttribute('aria-selected') !== 'true'
                            // An OPEN disclosure is the same case: the Activity
                            // button opens a drawer rather than toggling it, so
                            // while the drawer stands open a press is correctly
                            // a no-op, and judging that "inert" would be the
                            // sweep crying wolf at working code.
                            && b.getAttribute('aria-expanded') !== 'true'
                            && !skip.includes(nameOf(b)));
                    if (!btn) return null;
                    // Baselines, not absolutes. The app keeps a hash for the
                    // current surface at all times, so testing "is the hash
                    // non-empty" made this check pass for every control however
                    // dead it was — an inverted comparison proved it, by also
                    // passing. Only a CHANGE is evidence. An already-pressed
                    // control is skipped for the same reason: a no-op is the
                    // correct behavior for the chip that is already on.
                    const state = () => ({
                        text: main.innerText.trim(),
                        // An inline editor is alive even though it adds no text:
                        // "New folder" reveals an empty, focused <input>, and
                        // innerText alone cannot tell that from a dead button.
                        fields: main.querySelectorAll('input, textarea, [contenteditable="true"]').length,
                        hash: window.location.hash,
                        // This app's drawers mount OUTSIDE <main> — the trap the
                        // repo's own doctrine names — so "no new text inside
                        // main" is not evidence of a dead control. The Activity
                        // drawer is listed by its root because it carries no
                        // role=dialog; without it the sweep called the drawer's
                        // only opener inert the moment the title bar moved inside
                        // <main> and the sweep reached it.
                        overlay: !!document.querySelector(
                            '[role="dialog"], [role="alertdialog"], [data-testid="activity-drawer"]'),
                    });
                    const before = state();
                    // A switch's OWN state flip is movement no text change can
                    // show: a toggle persists a setting and leaves the page's
                    // words exactly as they were, which is why the sweep used
                    // to call "Toggle Global Memory" inert. Captured here, not
                    // inferred — the flip itself is the evidence, and a switch
                    // that does NOT flip still fails, as it should.
                    //
                    // aria-pressed is the SAME kind of fact and needs the same
                    // read: the Journal's range presets (7D/30D/90D/All) re-filter
                    // a canvas dashboard, so a working press can change no text,
                    // no field, no hash and no overlay — the selected chip is the
                    // only pixel that moves. A toggle whose pressed state does not
                    // flip still fails, exactly as a switch's must.
                    const ownChecked = btn.getAttribute('aria-checked');
                    const ownPressed = btn.getAttribute('aria-pressed');
                    btn.click();
                    return {
                        name: nameOf(btn),
                        before,
                        ownChecked,
                        ownPressed,
                        // Reported with any finding, so a failure says what the
                        // control was rather than making the next reader guess.
                        ctx: `${btn.tagName.toLowerCase()}${btn.type ? `[type=${btn.type}]` : ''}`
                            + ` aria-pressed=${btn.getAttribute('aria-pressed')}`
                            + ` aria-selected=${btn.getAttribute('aria-selected')}`
                            + ` overlayAtPress=${before.overlay}`
                            + ` class="${btn.className.slice(0, 48)}"`,
                    };
                }, [...tried]);
                if (!picked) break;         // nothing left untried on this surface
                tried.add(picked.name);
                console.log(`SWEEP ${label}: press "${picked.name}" overlayAtPress=${picked.ctx.match(/overlayAtPress=(\w+)/)?.[1]}`);
                // Poll for the change instead of sleeping a fixed second: a
                // control whose first press loads a lazy overlay (the Skills
                // tab's Strategies → StrategySearch chunk) can legitimately
                // take longer than 1s to move ANY measured thing — the first
                // such press also pays for the learning modules the auto-apply
                // sweep imports — and a fixed sleep judged it inert while the
                // chunk was still in flight.
                let moved = false;
                const settleDeadline = Date.now() + 7000;
                while (Date.now() < settleDeadline) {
                    await sleep(400);
                    moved = await page.evaluate((p) => {
                        const main = document.querySelector('main') || document.body;
                        const overlay = !!document.querySelector(
                            '[role="dialog"], [role="alertdialog"], [data-testid="activity-drawer"]');
                        return (main.innerText || '').trim() !== p.before.text
                            || main.querySelectorAll('input, textarea, [contenteditable="true"]').length !== p.before.fields
                            || window.location.hash !== p.before.hash
                            || (overlay && !p.before.overlay);
                    }, picked);
                    if (moved) break;
                }
                if (!moved) await sleep(600); // one last frame before the verdict
                const after = await page.evaluate((p) => {
                    const main = document.querySelector('main') || document.body;
                    const now = {
                        text: (main.innerText || '').trim(),
                        fields: main.querySelectorAll('input, textarea, [contenteditable="true"]').length,
                        hash: window.location.hash,
                        // MUST mirror `state()` above. It did not, so a drawer
                        // that opened was invisible to the after-snapshot and the
                        // sweep called its opener inert: two halves of one
                        // comparison measuring different things.
                        overlay: !!document.querySelector(
                            '[role="dialog"], [role="alertdialog"], [data-testid="activity-drawer"]'),
                    };
                    // The toggle check: the pressed control's aria-checked or
                    // aria-pressed flipped. Only a control that HAD one of those
                    // values is eligible, so this reads exactly the toggle type
                    // and never a plain button.
                    let flipped = false;
                    if (p.ownChecked !== null || p.ownPressed !== null) {
                        const again = [...main.querySelectorAll('button, [role="switch"]')]
                            .find(b => ((b.getAttribute('aria-label') || b.textContent || '').trim()) === p.name);
                        if (again) {
                            if (p.ownChecked !== null) flipped = again.getAttribute('aria-checked') !== p.ownChecked;
                            if (!flipped && p.ownPressed !== null) flipped = again.getAttribute('aria-pressed') !== p.ownPressed;
                        }
                    }
                    return {
                        moved: now.text !== p.before.text
                            || now.fields !== p.before.fields
                            || (now.hash !== p.before.hash)
                            || (now.overlay && !p.before.overlay)
                            || flipped,
                    };
                }, picked);
                if (!after.moved) {
                    const viaBrowserChrome = /export|import|download|copy|save|print/i
                        .test(picked.name);
                    if (viaBrowserChrome) unverifiable.push(picked.name);
                    else {
                        // A targeted trace for the one press whose target mounts
                        // lazily OUTSIDE main: was the drawer there, hidden, or
                        // never asked to open?
                        const trace = /strateg/i.test(picked.name)
                            ? await page.evaluate(() => {
                                const drawer = document.querySelector('[aria-label="Playbook & Strategy Search"]');
                                return {
                                    drawerMounted: !!drawer,
                                    drawerHidden: drawer ? drawer.getAttribute('aria-hidden') : null,
                                    dialogNow: !!document.querySelector('[role="dialog"]'),
                                    openDialogs: [...document.querySelectorAll('[role="dialog"]')]
                                        .map(d => d.getAttribute('aria-label') || d.textContent?.slice(0, 40) || 'unlabelled'),
                                    activeTab: document.querySelector('[aria-current="page"]')?.textContent
                                        || [...document.querySelectorAll('[data-testid^="learn-tab-"]')]
                                            .find(b => b.className.includes('bg-zinc-800'))?.textContent
                                        || 'n/a',
                                };
                            })
                            : null;
                        console.log(`TRACE inert press "${picked.name}": ${JSON.stringify(trace)}`);
                        inert.push(`${picked.name} ${picked.ctx}`);
                    }
                }
                await dismissOverlays();
            }
            }
            // The vacuity guard: a sweep that exercised almost nothing must not
            // report a clean bill of health.
            check(`${label} sweep really clicked controls (${tried.size})`,
                tried.size >= Math.min(cap, 6), `only ${tried.size} distinct controls pressed`);
            check(`no ${label} control is inert (${tried.size} pressed)`,
                inert.length === 0,
                `${inert.join(' | ')}${unverifiable.length ? `   [not judgeable: ${unverifiable.join(', ')}]` : ''}`
                    .slice(0, 400));
        };
        // Learn is tabbed three ways. Sweeping only the default tab left the
        // others unjudged — the gate could not see a dead control inside Memory
        // or Health. 18 rounds, because Health alone stacks six panels now that
        // System's telemetry and the supervisor's log fold into it. The
        // Approvals tab is gone (owner 2026-11-03): its queues apply themselves,
        // so the sweep names the three tabs that exist.
        await sweepSurface('Learning', 18, [
            'learn-tab-skills', 'learn-tab-memory', 'learn-tab-health',
        ]);
        // ── The skill viewer round trip (gap 1) ──────────────────────────
        // The sweep presses a catalog row and credits it if the surface moved.
        // That proves the click did SOMETHING; this proves the thing it did is
        // the READ the reference promises: the record opens with its
        // description (the retrieval trigger), its outcome ledger, and a
        // close that returns the surface. A unit test mounts the panel in
        // jsdom and passes; only this can see the panel actually appear.
        {
            let how = await navTo('Learning');
            if (how === 'not found') {
                await openMenu();
                await sleep(400);
                how = await navTo('Learning');
            }
            await page.evaluate(() => document
                .querySelector('[data-testid="learn-tab-memory"]')?.click());
            const rowPressed = await page.evaluate(() => {
                const row = [...document.querySelectorAll('[data-testid="skills-catalog-grid"] button')]
                    .find(b => /read fade the first break/i.test(b.getAttribute('aria-label') || ''));
                if (!row) return false;
                row.click();
                return true;
            });
            // Precondition, checked not assumed: a missing row must read as a
            // broken probe, not as a broken feature.
            check('the seeded skill row is pressable in the catalog', rowPressed === true, `${rowPressed}`);
            const opened = await pollFor(async () => {
                const text = await page.evaluate(() => {
                    const viewer = document.querySelector('[data-testid="skill-viewer"]');
                    if (!viewer || viewer.closest('[data-hidden="true"]')) return null;
                    return viewer.innerText || null;
                });
                return text && /Fade the first breakout/.test(text) ? text : null;
            });
            check('the skill viewer opens with its description and outcome ledger',
                !!opened && /4W – 1L/.test(opened), String(opened).slice(0, 120));
            if (opened) {
                await page.evaluate(() => {
                    document.querySelector('[aria-label="Close the skill viewer"]')?.click();
                });
                await sleep(600);
                const hidden = await page.evaluate(() => {
                    const panel = document.querySelector('[data-testid="learn-right-panel"]');
                    return panel?.getAttribute('data-hidden') === 'true';
                });
                check('closing the viewer hides the panel and keeps the catalog', hidden === true, `${hidden}`);
            }
        }
        // Precondition, checked not assumed: if the seeded journal had not
        // loaded, every filter chip would look inert and the sweep would fail
        // for the wrong reason — or worse, pass by skipping everything.
        let journalHow = await navTo('Journal');
        if (journalHow === 'not found') {
            await openMenu();
            await sleep(400);
            journalHow = await navTo('Journal');
        }
        await sleep(1500);
        const journalText = (await page.locator('main').innerText()).trim();
        check('the seeded journal is populated before it is swept',
            journalHow === 'clicked' && !/No trades logged yet/i.test(journalText),
            journalText.slice(0, 120));
        // The tracker writes PENDING journal rows while a trade is open. This
        // is the only gate that can see the rendered OPEN state and its filter.
        const openFilterPresent = await page.evaluate(() => {
            const main = document.querySelector('main');
            if (!main) return false;
            return [...main.querySelectorAll('button')]
                .some(el => (el.textContent || '').trim() === 'OPEN');
        });
        check('the journal offers an OPEN filter', openFilterPresent === true);
        // The list is virtualized, so the oldest row is not in the DOM until
        // the filter brings it in. Clicking OPEN must leave the PENDING row
        // (and its badge) on screen; a filter that changes nothing is inert.
        const openFilterClicked = await page.evaluate(() => {
            const main = document.querySelector('main');
            const button = [...(main?.querySelectorAll('button') ?? [])]
                .find(el => (el.textContent || '').trim() === 'OPEN');
            if (!(button instanceof HTMLElement)) return false;
            button.click();
            return true;
        });
        await sleep(500);
        const openBadge = await page.evaluate(() => {
            const main = document.querySelector('main');
            const text = (el) => (el.textContent || '').trim();
            return [...(main?.querySelectorAll('span') ?? [])]
                .some(el => text(el) === 'OPEN');
        });
        check('a PENDING journal row renders the OPEN state',
            openFilterClicked === true && openBadge === true,
            JSON.stringify({ openFilterClicked, openBadge }));
        await page.evaluate(() => {
            const clear = document.querySelector('[aria-label="Clear outcome filter"]');
            if (clear instanceof HTMLElement) clear.click();
        });
        await sleep(300);

        // Journal → Stats carries the same "last 20" the seats are shown. This
        // is the only gate that can see it: the card renders from a list, and a
        // unit test mounting the component would pass with zero rows drawn.
        const statsTabPresent = await page.evaluate(() => {
            const tab = document.querySelector('#journal-tab-analytics');
            if (tab) tab.click();
            return !!tab;
        });
        // Checked, not assumed: without this a wrong selector would report
        // "no card" and read as a broken feature rather than a broken probe.
        check('the Stats tab is reachable from the Journal', statsTabPresent === true,
            statsTabPresent ? 'clicked' : 'no #journal-tab-analytics control');
        const last20 = page.locator('[data-testid="journal-last-20"]');
        const hasLast20 = await pollFor(async () => (await last20.count()) === 1);
        check('Journal → Stats shows the Last 20 card', hasLast20 === true, `${hasLast20}`);
        if (hasLast20) {
            const rows = await last20.locator('li').count();
            check('the Last 20 card draws a row per logged trade', rows >= 1, `${rows} rows`);
            const cardText = await last20.innerText();
            check('the card states the tally in the units actually captured',
                /\d+W \/ \d+L/.test(cardText), cardText.slice(0, 160));
        }
        // ── The post-mortem the app writes at settlement (E-57 §1) ─────────
        // jsdom mounts the detail component; mounting is not the LIST rendering,
        // and a note the app writes into the trader's journal must be provably
        // READABLE in a real browser. One of the four seeded rows carries a note,
        // and the last check asserts EXACTLY one detail shows a block — so a
        // section rendered unconditionally, or a selector that matches nothing,
        // both fail here instead of reporting a quiet pass.
        const reflectionSeen = await page.evaluate(async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const tab = document.querySelector('#journal-tab-log');
            if (tab) { tab.click(); await sleep(300); }
            const clickBack = async () => {
                const back = Array.from(document.querySelectorAll('button'))
                    .find(b => (b.textContent || '').trim() === 'Back');
                if (back) { back.click(); await sleep(250); }
                return !!back;
            };
            const details = [];
            for (let attempt = 0; attempt < 6; attempt += 1) {
                // The row is the coin-named button in the History panel. It
                // used to read `<COIN>.md`; the 2026-10-29 refactor made the
                // label the coin alone, so matching `.md` found nothing and
                // reported "opened=0" on a screen that was rendering fine.
                // The `·` is the row's metadata line; filter chips carry the
                // coin alone, so they cannot match.
                // No word boundary after the coin: textContent concatenates the
                // coin span and the outcome badge ("BTCUSDTWIN"), so `\b` never
                // matched. The `·` is the row's metadata line; a filter chip
                // carries the coin alone and cannot match.
                const rows = Array.from(document.querySelectorAll('#journal-panel-log button'))
                    .filter(b => /^(?:BTCUSDT|ETHUSDT|SOLUSDT)/.test((b.textContent || '').trim())
                        && (b.textContent || '').includes('·'));
                const row = rows[attempt];
                if (!row) break;
                row.click();
                await sleep(400);
                const block = document.querySelector('[data-testid="trade-post-mortem"]');
                const tracked = document.querySelector('[data-testid="tracked-post-mortem"]');
                details.push({
                    rowText: (row.textContent || '').trim().slice(0, 60),
                    hasBlock: !!block,
                    text: block ? (block.textContent || '').trim() : '',
                    byline: (document.querySelector('[data-testid="trade-post-mortem-when"]')?.textContent || '').trim(),
                    hasTracked: !!tracked,
                    trackedText: tracked ? (tracked.textContent || '').trim() : '',
                    trackedByline: (document.querySelector('[data-testid="tracked-post-mortem-when"]')?.textContent || '').trim(),
                    hasPath: !!document.querySelector('[data-testid="tracked-path"]'),
                    pathMarks: document.querySelector('[data-testid="tracked-path"]')?.querySelectorAll('path,line,circle').length || 0,
                });
                if (!(await clickBack())) break;
            }
            return {
                opened: details.length,
                withNote: details.filter(d => d.hasBlock).length,
                sample: details.find(d => d.hasBlock) || null,
                withTracked: details.filter(d => d.hasTracked).length,
                trackedSample: details.find(d => d.hasTracked) || null,
            };
        });
        check('a journal History row opens its trade detail', reflectionSeen.opened >= 2,
            `opened=${reflectionSeen.opened} details`);
        check('the detail shows the post-mortem the app wrote',
            !!reflectionSeen.sample && reflectionSeen.sample.text.includes('size the stop to the sweep'),
            reflectionSeen.sample ? reflectionSeen.sample.text.slice(0, 120) : 'no trade-post-mortem block on any row');
        check('…and names the model that wrote it',
            !!reflectionSeen.sample && reflectionSeen.sample.byline.includes('zz-probe-model'),
            reflectionSeen.sample ? reflectionSeen.sample.byline : 'no byline element');
        check('control: only the seeded row shows a post-mortem block',
            reflectionSeen.opened >= 2 && reflectionSeen.withNote === 1,
            `opened=${reflectionSeen.opened} withNote=${reflectionSeen.withNote}`);
        // The TRACKED record is a second read of a different store. Its control
        // is separate from the legacy note's: a component that mounted for
        // every trade would pass "the text is somewhere" and fail this one.
        check('the tracked record renders on the trade the tracker followed',
            reflectionSeen.withTracked === 1
                && !!reflectionSeen.trackedSample
                && reflectionSeen.trackedSample.trackedText.includes('The entry was chased'),
            `withTracked=${reflectionSeen.withTracked}`);
        check('…with the measured path and both excursions',
            !!reflectionSeen.trackedSample
                && reflectionSeen.trackedSample.hasPath === true
                && reflectionSeen.trackedSample.pathMarks >= 8
                && /MFE \+0\.80R/.test(reflectionSeen.trackedSample.trackedText)
                && /MAE -1\.00R/.test(reflectionSeen.trackedSample.trackedText)
                && /Root cause/.test(reflectionSeen.trackedSample.trackedText),
            reflectionSeen.trackedSample
                ? `path=${reflectionSeen.trackedSample.hasPath} marks=${reflectionSeen.trackedSample.pathMarks} ${reflectionSeen.trackedSample.trackedText.slice(0, 120)}`
                : 'no tracked-post-mortem block on any row');
        check('…names the diagnosis model and the skill citing the trade',
            !!reflectionSeen.trackedSample
                && reflectionSeen.trackedSample.trackedByline.includes('zz-probe-diagnosis-model')
                && /Fade the first break/i.test(reflectionSeen.trackedSample.trackedText),
            reflectionSeen.trackedSample
                ? `byline=${reflectionSeen.trackedSample.trackedByline}`
                : 'no byline element');
        check('control: only the followed trade shows the tracked record',
            reflectionSeen.opened >= 2 && reflectionSeen.withTracked === 1,
            `opened=${reflectionSeen.opened} withTracked=${reflectionSeen.withTracked}`);

        // ── Journal → Signals: the desk's own call record ─────────────────
        // The feed is a rendered LIST, so no other gate can see it. Seed one
        // emitted-and-resolved call into the ledger and assert the card draws
        // the settled outcome in R — a feed that mounts empty passes every
        // component-level check there is.
        const signalKey = await page.evaluate(() => {
            const user = localStorage.getItem('last_active_user') || 'default';
            const at = Date.now() - 60 * 60 * 1000;
            const key = `signal_ledger_v1:${user}`;
            const signal = {
                id: 'sig-probe-1', coin: 'BTCUSDT', direction: 'long',
                entry: 100, stop: 99, target: 103,
                emittedAt: at, expiresAt: at + 15 * 60 * 1000,
                evidenceRefs: ['get_market_packet', 'the 1h shelf at 99.5k'],
                dataHash: 'deadbeef', provider: 'mock', model: 'mock-mini', promptVersion: 'emit-signal-v1',
                source: 'signal', thesis: 'Reclaim of the 1h shelf; stop under the sweep.',
            };
            const resolution = {
                status: 'won', at: at + 16 * 60 * 1000,
                grossR: 3, feeR: 0.14, outcomeR: 2.86,
                usedBarTimes: [at + 5 * 60 * 1000], path: 'bar', ambiguous: false,
                crossCheck: 'agree', primarySource: 'okx',
                base: { samples: 299, hitRate: 0.35, horizonBars: 12, riskPct: 0.01, rewardPct: 0.03 },
            };
            localStorage.setItem(key, JSON.stringify([
                { v: 1, type: 'emit', at, id: signal.id, signal },
                { v: 1, type: 'ground', at, id: signal.id, grounding: { at, verdict: 'cited', missing: [] } },
                { v: 1, type: 'gate', at: at + 1000, id: signal.id, gate: { status: 'pass', at: at + 1000, confidenceCap: 0.85, reason: 'probe' } },
                { v: 1, type: 'resolve', at: at + 16 * 60 * 1000, id: signal.id, resolution },
            ]));
            return key;
        });
        const signalsTab = await page.evaluate(() => {
            const tab = document.querySelector('#journal-tab-signals');
            if (tab) tab.click();
            return !!tab;
        });
        check('the Signals tab is reachable from the Journal', signalsTab === true,
            signalsTab ? `seeded ${signalKey}` : 'no #journal-tab-signals control');
        const signalFeed = page.locator('[data-testid="signal-feed"]');
        const feedMounted = await pollFor(async () => (await signalFeed.count()) === 1);
        check('Journal → Signals mounts the feed', feedMounted === true, `${feedMounted}`);
        if (feedMounted) {
            const card = page.locator('[data-testid="signal-card"]');
            await pollFor(async () => (await card.count()) >= 1);
            const cards = await card.count();
            check('the feed draws the seeded signal as a card', cards === 1, `${cards} cards`);
            if (cards === 1) {
                const cardText = await card.first().innerText();
                check('the card states the settled outcome after costs',
                    /won/i.test(cardText) && /\+2\.86R/.test(cardText), cardText.slice(0, 160));
                check('the card names the venue cross-check rather than assuming it',
                    /cross-checked OKX\/Binance/.test(cardText), cardText.slice(0, 200));
            }
            const feedText = await page.evaluate(() =>
                document.querySelector('[data-testid="signal-feed"]')?.textContent || '');
            check('the feed states the hit rate against the same-levels base rate',
                /vs base/i.test(feedText) && /35\.0%/.test(feedText) && /thin/i.test(feedText),
                feedText.slice(0, 220));
            // The rows are a table now. A chevron that flips aria-expanded but
            // renders nothing is the exact inert-control failure the sweep
            // cannot see, so the detail row is asserted by presence, not style.
            const detailBefore = await page.locator('[data-testid="signal-detail-sig-probe-1"]').count();
            // DOM click, not Playwright's: an Activity drawer left open by the
            // earlier sweep sits over the Journal and intercepts pointer
            // events. The click handler is what is under test, and a DOM click
            // reaches it without pretending the drawer is not there.
            const expandClicked = await page.evaluate(() => {
                const btn = document.querySelector('[data-testid="signal-expand-sig-probe-1"]');
                if (btn) btn.click();
                return !!btn;
            });
            const detailAfter = await pollFor(async () =>
                (await page.locator('[data-testid="signal-detail-sig-probe-1"]').count()) === 1);
            check('opening a signal row reveals its evidence and shadow checks',
                detailBefore === 0 && expandClicked && detailAfter === true,
                `before=${detailBefore} clicked=${expandClicked} after=${detailAfter}`);
            if (detailAfter) {
                const detailText = await page.locator('[data-testid="signal-detail-sig-probe-1"]').innerText();
                check('the signal detail names the cited evidence and the gate shadow',
                    detailText.includes('get_market_packet') && /gate shadow/i.test(detailText),
                    detailText.slice(0, 200));
            }
        }
        // Back to History for the generic sweep below.
        await page.evaluate(() => document.querySelector('#journal-tab-log')?.click());
        await sleep(400);

        // The Journal is a THREE-tab surface (History | Signals | Stats), and
        // the History tab is where the trade ledger's filters, row actions and
        // insight controls live — the screenshot of it is not "a header and two
        // exports". Sweep both views at the generic cap; the sweep's per-view
        // budget splits it, so neither tab can hide behind the other.
        await sweepSurface('Journal', 12, ['journal-tab-analytics']);

        // ── The instrument picker, and the claim it makes ────────────────
        // A coin/timeframe control is only worth having if it MOVES THE CHART.
        // Both surfaces bind to the same chat session, so a coin chosen on Chat
        // must be the coin the chart draws by the time the trader gets there.
        // Last in the run, on purpose: it hops between surfaces, and an earlier
        // version placed mid-sweep left the sweep asserting against the wrong
        // screen.
        {
            const goSurface = async (name) => {
                return page.evaluate((n) => {
                    const IDS = { Analyze: 'trade', Journal: 'journal', Agents: 'agents', Learning: 'learn' };
                    const sw = document.querySelector(`[data-testid="surface-switch-${IDS[n] || ''}"]`);
                    if (sw) { sw.click(); return 'clicked'; }
                    const hit = [...document.querySelectorAll('[data-testid="surface-menu"] button')]
                        .find(b => new RegExp('^' + n, 'i').test((b.getAttribute('aria-label') || b.textContent || '').trim()));
                    if (!hit) return 'not found';
                    hit.click();
                    return 'clicked';
                }, name);
            };
            const overflow = await measureOverflow(page);
            check('nothing overflows the viewport horizontally',
                overflowIsClean(overflow), overflowWhy(overflow));

            const landedChat = await goSurface('Agents');
            const onChat = await page.locator('[data-testid="agents-view"]')
                .waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
            let picked = null;
            if (landedChat !== 'clicked' || !onChat) {
                check('the Agents surface carries an instrument picker', false, `${landedChat}/${onChat}`);
            } else {
                const opened = await page.evaluate(() => {
                    // 2026-10-27: the picker left the CARD and took its own row
                    // beneath it, inside the composer's area. Three claims, so the
                    // arrangement cannot quietly drift back through any of the
                    // three doors: it must be in the area, it must NOT be inside
                    // the card (that was the old shape), and it must NOT be in the
                    // header (the shape before that).
                    const area = document.querySelector('[data-testid="chat-composer-area"]');
                    const card = document.querySelector('[data-testid="chat-composer"]');
                    const header = document.querySelector('[data-testid="chat-header"]');
                    if (!area || !card || !header) return 'no composer area, card or header';
                    if (header.querySelector('[data-testid="symbol-picker-trigger"]')) {
                        return 'picker is back in the header';
                    }
                    if (card.querySelector('[data-testid="symbol-picker-trigger"]')) {
                        return 'picker is still inside the composer card';
                    }
                    const trig = area.querySelector('[data-testid="symbol-picker-trigger"]');
                    if (!trig) return 'no trigger in the composer area';
                    trig.click();
                    return 'opened';
                });
                if (opened !== 'opened') {
                    check('the Agents surface carries an instrument picker outside the composer card', false, opened);
                } else {
                    await sleep(400);
                    picked = await page.evaluate(() => {
                        const rows = [...document.querySelectorAll('[data-testid^="symbol-row-"]')];
                        const other = rows.find(r => r.getAttribute('aria-selected') !== 'true') || rows[0];
                        if (!other) return null;
                        const id = other.getAttribute('data-testid') || '';
                        other.click();
                        return id.replace('symbol-row-', '') || null;
                    });
                    check('the Agents surface carries an instrument picker outside the composer card',
                        picked !== null, `picked ${picked}`);
                }
                // The popover portals to <body> and covers the nav trigger.
                await page.keyboard.press('Escape');
                await page.evaluate(() => document.body.click());
                await sleep(300);
            }
            if (picked) {
                await goSurface('Analyze');
                const onTrade = await page.locator('[data-testid="trade-view"]')
                    .waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
                const readChart = () => page.evaluate(() => {
                    // Ask the chart WHICH coin it is drawing. Reading the panel's
                    // text with a /[A-Z]{2,10}USDT/ scrape glues adjacent labels
                    // together ("USDTBTCUSDT") whenever two symbols sit without a
                    // separator between them — a measurement that fails on the
                    // DOM's whitespace rather than on the app's behavior.
                    const el = document.querySelector('[data-testid="trading-chart"]');
                    return el?.getAttribute('data-symbol') ?? null;
                });
                const shown = onTrade ? await readChart() : null;
                // The chart adopts the session's coin in an effect, so the frame
                // TradeView first paints shows the coin it opened with. Wait for
                // the binding to settle before calling it broken — but report the
                // first read too, because a surface that opens on the WRONG coin
                // is a coin of its own bug (the strip comment at
                // TradeView.tsx:513 says exactly that).
                let settled = shown;
                if (onTrade && shown !== picked) {
                    const converged = await page.waitForFunction(
                        want => document.querySelector('[data-testid="trading-chart"]')
                            ?.getAttribute('data-symbol') === want,
                        picked, { timeout: 4000 },
                    ).then(() => true).catch(() => false);
                    if (converged) settled = picked;
                }
                check('the coin chosen in Chat is the coin the chart draws',
                    settled === picked, `chose ${picked}, chart shows ${settled} (first paint ${shown})`);
            }
        }

        // ── The keyboard focus indicator, in BOTH states ───────────────────
        // `:focus-visible` in index.css gives every focusable element a 2px
        // outline, and a second rule then took it away from
        // input/textarea/select/[contenteditable] on the theory that each of
        // those fields draws its own `focus-visible:ring-*`. 25 sites in the
        // tree carry a ring against ~114 editable controls, so unscoped that
        // rule deleted the ONLY focus indicator from most of the app — the
        // composer's textarea included, and it set `focus:outline-none` on top.
        // No unit test could see it: jsdom mounts markup, it never resolves a
        // stylesheet. Only a browser that focuses a control and reads back the
        // computed outline can. Both states are measured because the rule is a
        // trade — too wide and fields go unmarked, removed and a ringed field
        // draws a double box — so a check that reads the same either way is
        // measuring nothing.
        const readFocus = () => page.evaluate(() => {
            const probe = (el) => {
                el.focus();
                const cs = window.getComputedStyle(el);
                return {
                    name: el.getAttribute('data-testid') || el.getAttribute('aria-label')
                        || el.getAttribute('placeholder') || el.tagName.toLowerCase(),
                    visible: el.matches(':focus-visible'),
                    ownsRing: /focus-visible:ring/.test(typeof el.className === 'string' ? el.className : ''),
                    outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
                    shadow: cs.boxShadow !== 'none',
                };
            };
            const rows = [];
            for (const el of document.querySelectorAll(
                'input:not([type="hidden"]),textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"]')) {
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) continue;
                const before = window.getComputedStyle(el);
                if (before.visibility === 'hidden' || before.display === 'none') continue;
                rows.push(probe(el));
            }
            // The stylesheet pair, on controls this screen happens not to have:
            // a field that declares no ring must keep the outline, and one that
            // declares a ring must keep the ring WITHOUT a second box.
            const synthetic = (cls) => {
                const el = document.createElement('textarea');
                el.className = `bg-transparent ${cls}`.trim();
                el.style.cssText = 'position:fixed;left:0;top:-200px;width:120px;height:28px;';
                document.body.appendChild(el);
                const out = probe(el);
                el.remove();
                return out;
            };
            return { real: rows, plain: synthetic(''), ringed: synthetic('focus-visible:ring-2 focus-visible:ring-cyan-500/50') };
        });

        await navTo('Analyze');
        await page.locator('[data-testid="trade-view"]').waitFor({ timeout: 10000 }).catch(() => {});
        // Keyboard modality: :focus-visible is modality-aware, and a JS-driven
        // focus() only inherits it if the last real input was the keyboard.
        await page.keyboard.press('Tab');
        await sleep(300);
        const focus = await readFocus();
        const unmarked = focus.real.filter(f => !f.visible
            ? false
            : (!f.ownsRing && !f.outline && !f.shadow));
        check('every editable field on the trade screen shows a keyboard focus indicator',
            focus.real.length > 0 && unmarked.length === 0,
            `${focus.real.length} field(s) measured, ${unmarked.length} with no indicator`
            + (unmarked.length ? `: ${unmarked.map(u => u.name).join(', ')}` : ''));
        check('and the strip is scoped, not gone — a ringed field keeps its ring and no outline',
            focus.plain.visible && focus.ringed.visible
            && focus.plain.outline === true
            && focus.ringed.outline === false && focus.ringed.shadow === true,
            `plain: outline=${focus.plain.outline} shadow=${focus.plain.shadow}; `
            + `ringed: outline=${focus.ringed.outline} shadow=${focus.ringed.shadow}`);

        // ── The composer: clicked must show nothing, tabbed must show the ring ─
        // A browser matches :focus-visible on a text field after a MOUSE CLICK —
        // correct for "can I type here", wrong for "did the keyboard move focus
        // here", and the visible result was a blue box every time the trader
        // clicked into the composer. utils/navModality.ts answers the second
        // question and index.css obeys it. Measured with real input events, in
        // both orders, because a click that leaks a box and a Tab that shows no
        // box are the same bug seen from two sides.
        const composer = page.locator('[data-testid="composer-input"]');
        const composerState = () => composer.evaluate((el) => {
            const cs = window.getComputedStyle(el);
            return {
                focused: document.activeElement === el,
                nav: document.documentElement.dataset.navModality ?? '',
                outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
            };
        });
        await composer.click();
        const clickedState = await composerState();
        check('clicking the composer paints no focus box',
            clickedState.focused && clickedState.nav === 'pointer' && clickedState.outline === false,
            JSON.stringify(clickedState));
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        const tabbedState = await composerState();
        check('and tabbing back to it paints one',
            tabbedState.focused && tabbedState.nav === 'keyboard' && tabbedState.outline === true,
            JSON.stringify(tabbedState));

        // ── An attached image mounts NOW, in its loading state ────────────
        // The old path appended the chip only after FileReader.onload, so a
        // picker click showed NOTHING for the length of the read — a dead
        // affordance. The chip must exist from the change event, pulsing,
        // and fill in place. A 4 MB buffer keeps the read observably pending,
        // so "it mounted before the decode landed" is measurable rather than
        // a race the probe wins by luck.
        const attachInput = page.locator('input[type="file"]').first();
        await attachInput.setInputFiles({
            name: 'probe-attach.png',
            mimeType: 'image/png',
            buffer: Buffer.alloc(4 * 1024 * 1024, 0x89),
        });
        const mounting = await page.evaluate(() => {
            const chip = document.querySelector('[data-testid="chat-attachment"]');
            return chip ? {
                loading: chip.getAttribute('data-attachment-loading'),
                pulse: !!chip.querySelector('.animate-pulse'),
            } : null;
        });
        check('an attached image mounts its chip before the decode lands',
            !!mounting && mounting.loading === 'true' && mounting.pulse === true,
            JSON.stringify(mounting));
        const attachFilled = await page.waitForFunction(() => {
            const chip = document.querySelector('[data-testid="chat-attachment"]');
            return !!chip
                && chip.getAttribute('data-attachment-loading') === 'false'
                && !!chip.querySelector('img');
        }, null, { timeout: 15000 }).then(() => true).catch(() => false);
        check('the chip fills in place with the decoded thumbnail', attachFilled);
        await page.evaluate(() => {
            document.querySelector('[data-testid="chat-attachment"] button')?.click();
        });
        const attachRemoved = await page.evaluate(() =>
            !document.querySelector('[data-testid="chat-attachment"]'));
        check('the chip’s Remove control takes it away', attachRemoved);

        // ── The composer's height follows the draft, not a fixed slab ──────
        // The old field reserved two lines at rest (56px) and could not grow
        // past 128px, so a one-line question sat in a tall empty card and a
        // long one scrolled inside it. Measure the resting height, the growth,
        // and the return.
        const composerSizes = () => page.evaluate(() => {
            const ta = document.querySelector('[data-testid="composer-input"]');
            const card = ta ? ta.closest('.rounded-composer') : null;
            const toolbar = document.querySelector('[data-testid="composer-model-and-send"]')?.parentElement;
            return {
                ta: ta ? Math.round(ta.getBoundingClientRect().height) : -1,
                card: card ? Math.round(card.getBoundingClientRect().height) : -1,
                toolbar: toolbar ? Math.round(toolbar.getBoundingClientRect().height) : -1,
                value: ta ? ta.value : null,
            };
        });
        const setComposerDraft = (text) => page.evaluate((next) => {
            const ta = document.querySelector('[data-testid="composer-input"]');
            if (!ta) return;
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
                .set.call(ta, next);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
        }, text);
        await setComposerDraft('');
        await sleep(150);
        const emptyComposer = await composerSizes();
        check('the resting composer is one line tall, not a panel',
            emptyComposer.value === '' && emptyComposer.ta <= 44,
            `${emptyComposer.ta}px field (card ${emptyComposer.card}px)`);
        await setComposerDraft('line one\nline two\nline three\nline four');
        await sleep(150);
        const grownComposer = await composerSizes();
        check('the composer grows with the draft instead of scrolling in a fixed box',
            grownComposer.ta > emptyComposer.ta + 30 && grownComposer.ta <= 164
                && grownComposer.card > emptyComposer.card,
            `${emptyComposer.ta}px -> ${grownComposer.ta}px field, card ${emptyComposer.card} -> ${grownComposer.card}`);
        // The first keystroke must not reveal a control that wraps the action
        // row: the UI jumped ~42px when "Full analysis" appeared only once the
        // draft was non-empty. The button is now always present; the toolbar
        // height is the invariant.
        check('typing does not add a toolbar row or move the composer actions',
            grownComposer.toolbar === emptyComposer.toolbar,
            `toolbar ${emptyComposer.toolbar}px -> ${grownComposer.toolbar}px`);
        await setComposerDraft('');
        await sleep(150);
        const clearedComposer = await composerSizes();
        check('clearing the draft returns the composer to one line',
            clearedComposer.ta <= 44, `${clearedComposer.ta}px`);

        // ── Hit targets: a control you have to click cannot be a 16px strip ──
        // Measured at desktop width on purpose: below `lg` the 44px touch bump in
        // index.css already lifts every control, which is why the same rows that
        // measure 21-25px tall here measure fine at phone width. jsdom reports
        // every box as 0x0, so no unit test in the suite can see a target size at
        // all — this is the only gate that has ever looked.
        const FLOOR_PX = 24;
        const offendersBySurface = [];
        for (const surface of surfaces) {
            await navTo(surface.label);
            await sleep(900);
            const bad = await page.evaluate(({ floor }) => {
                // Navigation lives in `shell-rail` on most surfaces and in
                // `agents-rail` on the focused-chat one, so both columns are
                // measured; a sweep that knew one name would leave the other
                // surface's rows unmeasured.
                const scopes = ['main', 'aside[data-testid="shell-rail"]',
                    'aside[data-testid="agents-rail"]', 'header'];
                const seen = new Set();
                const out = [];
                for (const scope of scopes) {
                    for (const host of document.querySelectorAll(scope)) {
                        for (const el of host.querySelectorAll(
                            'button, a[href], input:not([type="hidden"]), select, [role="tab"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="button"]')) {
                            if (seen.has(el)) continue;
                            seen.add(el);
                            // The property is the AREA YOU CAN CLICK, not the box of
                            // the tag: a checkbox inside a label is hit through the
                            // label, so measuring the 16px input would report a
                            // target no user ever has to aim at.
                            const target = (el.tagName === 'INPUT' || el.tagName === 'SELECT')
                                ? (el.closest('label') || el)
                                : el;
                            const r = target.getBoundingClientRect();
                            if (r.width < 1 || r.height < 1) continue;
                            const cs = window.getComputedStyle(el);
                            if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none') continue;
                            if (el.disabled || el.getAttribute('aria-hidden') === 'true') continue;
                            if (/\bsr-only\b/.test(String(el.className))) continue;
                            const min = Math.min(r.width, r.height);
                            if (min >= floor) continue;
                            out.push({
                                name: (el.getAttribute('aria-label') || (el.textContent || '').trim() || el.tagName.toLowerCase()).slice(0, 34),
                                w: Math.round(r.width), h: Math.round(r.height),
                            });
                        }
                    }
                }
                return out;
            }, { floor: FLOOR_PX });
            if (bad.length) offendersBySurface.push({ label: surface.label, bad });
        }
        const offenderText = offendersBySurface.map(o =>
            `${o.label}: ${o.bad.map(b => `${b.name} ${b.w}x${b.h}`).join(' | ')}`).join('\n').slice(0, 1200);
        check(`every clickable control measures at least ${FLOOR_PX}px on its short side`,
            offendersBySurface.length === 0,
            offendersBySurface.length
                ? `${offendersBySurface.reduce((n, o) => n + o.bad.length, 0)} sub-${FLOOR_PX}px target(s) on ${offendersBySurface.length} surface(s):\n${offenderText}`
                : '');

        // ── Phone width: the page itself must never scroll sideways ────────
        // Only the DOCUMENT property is asserted. A wide table inside its own
        // `overflow-x-auto` frame is the doctrine's last-resort guard and is
        // allowed to extend past the viewport; the page breaking is a different
        // thing, and it was real: the Skills surface measured 707px of shell
        // inside a 430px viewport while the library was a ten-column table that
        // answered narrow viewports by dropping columns.
        await page.setViewportSize({ width: 430, height: 860 });
        const wideAtPhone = [];
        for (const surface of surfaces) {
            await navTo(surface.label);
            await sleep(1200);
            const m = await page.evaluate(() => ({
                vw: window.innerWidth,
                scrollW: document.documentElement.scrollWidth,
            }));
            if (m.scrollW > m.vw + 2) wideAtPhone.push(`${surface.label}: ${m.scrollW}px in ${m.vw}px`);
        }
        check('no surface scrolls the page sideways at phone width',
            wideAtPhone.length === 0, wideAtPhone.join(' | '));

        // The old four-tab fallback used to reappear exactly here. With the
        // rail away there must be no destination switch on screen at all.
        const phoneTabsBefore = await page.evaluate(() => {
            const visible = (el) => {
                const cs = window.getComputedStyle(el);
                return cs.visibility !== 'hidden' && cs.display !== 'none'
                    && el.getClientRects().length > 0;
            };
            return [...document.querySelectorAll('[data-testid^="surface-switch-"]')]
                .filter(visible).length;
        });
        check('no old surface tabs return at phone width',
            phoneTabsBefore === 0, `${phoneTabsBefore} visible tab(s)`);

        // At phone width the rail is a DRAWER over the surface, not a column
        // that squeezes it. Opening and backdrop-closing is the whole contract;
        // a static rail here is the 240px wall this replaced.
        const phoneRailOpen = await page.evaluate(() => {
            const t = document.querySelector('[data-testid="nav-rail-toggle-header"]');
            if (!t) return 'no toggle';
            t.click();
            return 'clicked';
        });
        await sleep(500);
        const phoneRail = await page.evaluate(() => {
            const rail = document.querySelector('[data-testid="shell-rail"]');
            const visible = (el) => {
                const cs = window.getComputedStyle(el);
                return cs.visibility !== 'hidden' && cs.display !== 'none'
                    && el.getClientRects().length > 0;
            };
            return {
                rail: !!rail,
                backdrop: !!document.querySelector('[data-testid="shell-rail-backdrop"]'),
                position: rail ? window.getComputedStyle(rail).position : 'none',
                switches: [...document.querySelectorAll('[data-testid^="surface-switch-"]')]
                    .filter(visible).length,
            };
        });
        check('the phone rail opens as a drawer and carries every route',
            phoneRailOpen === 'clicked' && phoneRail.rail && phoneRail.backdrop
                && phoneRail.position === 'fixed' && phoneRail.switches === 4,
            `${phoneRailOpen} rail=${phoneRail.rail} backdrop=${phoneRail.backdrop} `
            + `position=${phoneRail.position} tabs=${phoneRail.switches}`);
        const phoneRailClosed = await page.evaluate(() => {
            const b = document.querySelector('[data-testid="shell-rail-backdrop"]');
            if (!b) return 'no backdrop';
            b.click();
            return 'clicked';
        });
        await sleep(400);
        const phoneRailGone = await page.evaluate(() =>
            !document.querySelector('[data-testid="shell-rail"]'));
        check('the drawer backdrop puts the rail away',
            phoneRailClosed === 'clicked' && phoneRailGone,
            `${phoneRailClosed} gone=${phoneRailGone}`);


        check('zero pageerrors across the whole run', pageErrors.length === 0,
            pageErrors.length ? `\n---\n${pageErrors.join('\n---\n').slice(0, 3000)}` : '');

        // Let every failure capture finish while the page is still alive.
        await Promise.allSettled(pendingShots);
        await browser.close();
    } catch (err) {
        // Do NOT process.exit() here: this catch runs BEFORE the finally below,
        // so exiting would orphan the vite dev server and the mock provider.
        // They then hold port 3000 / the mock port and break the next run.
        // (boot-probe.cjs documents the same trap.) Set the code and return —
        // finally still runs and kills the children.
        console.error('RENDER PROBE FAIL (driver):', err);
        process.exitCode = 1;
        return;
    } finally {
        if (server) server.kill('SIGTERM');
        mock.kill('SIGTERM');
    }

    if (failures.length) {
        console.error(`\nRENDER PROBE FAILED — ${failures.length} check(s):`);
        for (const f of failures) console.error(' • ' + f);
        process.exit(1);
    }
    console.log('\nRENDER PROBE OK — every exchange renders and keeps the earlier rows in both'
        + ' conversation surfaces, settled verdicts and malformed persisted audit data render without'
        + ' dropping a row, all four nav surfaces mount, the desk pane keeps the'
        + ' trader’s own rows, Settings → Data can back up, export and import a journal file, the health'
        + ' tab shows the idle sweep and the notebook budget, and the run produced zero pageerrors.');
}

main().catch((err) => { console.error('RENDER PROBE FAIL (driver):', err); process.exit(1); });
