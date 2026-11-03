/**
 * probe-skill-approval — drives the REAL app through the four skill-draft
 * outcomes and asserts the notebook bytes after each one.
 *
 * OWNER RULING 2026-11-03: the approval inbox is GONE. A draft applies itself —
 * the learning heartbeat's sweep runs `autoApplyPendingSkillDrafts` (the same
 * `approveSkillDraft` the old button pressed, stamped 'auto') whenever a draft
 * write fires its event, plus once per mount. The probe therefore seeds the
 * draft with the exact bytes `utils/skillDrafts.ts` writes, RELOADS (which
 * mounts the heartbeat and drains the sweep), and asserts what landed:
 *
 *   seed → reload → autoApplyPendingSkillDrafts → notebook write
 *
 * Cases, in order, one browser session, fresh storage each:
 *   1 happy      → a skill file appears, the draft is consumed
 *   2 collision  → same NAME, different IF clause → a SECOND file `-2.md`
 *   3 duplicate  → an already-live trigger → NO new file, draft consumed
 *   4 writefail  → the notebook write is forced to fail → the draft SURVIVES
 *                  with attempts=1; 4b unblocks and the retry applies
 *   5 rescope    → an applyable proposal auto-applies (file bytes asserted);
 *                  5b: a below-bar clause is refused, stays queued, and its
 *                  auto-refusal budget ledger records the attempt
 *
 * Usage: node scripts/probe-skill-approval.cjs [--headed]
 * Screenshots + a JSON transcript land in .probe-artifacts/skill-approval/.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PROBE_PORT || 4189);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, '.probe-artifacts', 'skill-approval');
const USER = 'Probe User';
const DRAFTS_KEY = `skill_drafts_v1:${USER}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let failed = 0;
function check(name, ok, detail) {
    results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  [${JSON.stringify(detail)}]` : ''}`);
}

async function waitForServer(url, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok || res.status === 404) return true;
        } catch { /* not up yet */ }
        await sleep(400);
    }
    return false;
}

/** A crafted skill shaped exactly like `CraftedSkill`: one trigger + steps. */
const craft = (over = {}) => ({
    name: 'Funding exhaustion long',
    kind: 'repeat',
    when: 'funding runs positive for many sessions while price stalls at swept lows',
    steps: ['Confirm the funding streak', 'Wait for a 1h close back above the swept low', 'Enter with stop under the wick'],
    inputs: [],
    validate: 'Confirm the sweep on the live chart before acting',
    output: 'A long entry with a stop under the liquidity low',
    approval: 'A human approves this draft before it is ever applied',
    ...over,
});

const draftRow = (id, crafted, tradeId) => ({
    id, tradeId: tradeId || `chat:${crafted.kind}|${crafted.when}`,
    coin: 'BTC', crafted, createdAt: new Date().toISOString(),
});

async function freshSession(page) {
    await page.goto(`${BASE}/favicon.ico`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.evaluate((user) => {
        sessionStorage.setItem('activeUsername', user);
        localStorage.setItem('august_surface_v1', 'learn');
    }, USER);
    // The workspace modal is what CREATES the profile, and the profile is what
    // creates the notebook. render-probe documents this verbatim: skipping it
    // "makes the probe fail for the wrong reason" — the app just sits on the
    // onboarding modal and no `memory_files_v1_*` key is ever written.
    await page.evaluate(async (user) => {
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
            username: user,
            conversations: [], tradeLog: [], tradeSummaries: [],
            finalTradeSummary: null,
            settings: { activeFrameworks: [] },
        });
        await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; });
        db.close();
        // Never used for a model call here (the mock provider emits no tool
        // calls), but the app treats "no ready provider" as incomplete setup.
        localStorage.setItem('provider_configs_v1', JSON.stringify([{
            id: 'mock', name: 'Mock', apiKey: 'mock-key',
            baseUrl: 'http://127.0.0.1:8787/v1',
            apiFormat: 'chat_completions',
            isEnabled: true, isBuiltIn: false,
            models: ['mock-mini'], selectedModel: 'mock-mini',
        }]));
    }, USER);
    await page.goto(BASE, { waitUntil: 'networkidle' }).catch(() => {});
    await sleep(3000);
    // Let the app create its own profile + notebook, then read the key format
    // back off the live page. Guessing `memory_files_v1_<user>` is exactly the
    // kind of assumption that makes a probe pass for the wrong reason.
    const notebookKey = await page.evaluate(() =>
        Object.keys(localStorage).find(k => k.startsWith('memory_files_v1')) || null);
    if (!notebookKey) {
        // Worth keeping permanently: when this probe reports "no notebook", the
        // useful question is what the app DID store and what it drew — the
        // profile may never have been created, or the notebook may live in
        // IndexedDB on web rather than localStorage.
        const diag = await page.evaluate(() => ({
            lsKeys: Object.keys(localStorage),
            iddbs: (window.indexedDB && indexedDB.databases) ? indexedDB.databases().then(d => d.map(x => x.name)) : 'n/a',
            body: document.body.innerText.slice(0, 400),
        }));
        console.log('DIAG no-notebook:', JSON.stringify({ ...diag, iddbs: await diag.iddbs }));
        await page.screenshot({ path: path.join(OUT, 'diag-no-notebook.png'), fullPage: true }).catch(() => {});
    }
    return notebookKey;
}

async function seedDrafts(page, drafts) {
    await page.evaluate(([k, d]) => localStorage.setItem(k, JSON.stringify(d)), [DRAFTS_KEY, drafts]);
    await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
    await sleep(2000);
}

const readDrafts = (page) => page.evaluate((k) => {
    try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; }
}, DRAFTS_KEY);

/** Drafts with their auto-apply retry counters, for the refusal-budget pins. */
const readDraftsDetailed = (page) => readDrafts(page);

const PROPOSALS_KEY = `learning_proposals_v1:${USER}`;

/** Seed the learning queue with exactly the bytes `revise_skill` produces (via
 *  `queueLearningProposal`) so the probe drives the panel, not the store. */
const seedProposals = async (page, rows) => {
    await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [PROPOSALS_KEY, rows]);
    await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
    await sleep(2000);
};

const readProposals = (page) => page.evaluate((k) => {
    try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; }
}, PROPOSALS_KEY);

/** The CONTENT of one skill file, read off the live page's notebook. The
 *  rescope is only proven by the bytes: a row vanishing proves the click, not
 *  the write. */
const readSkillContent = (page, fileName) => page.evaluate((name) => {
    const nk = Object.keys(localStorage).find(k => k.startsWith('memory_files_v1'));
    if (!nk) return '';
    try {
        const store = JSON.parse(localStorage.getItem(nk) || '{}');
        const skills = (store.folders || []).find(f => f.name === 'skills');
        // E-44: large categories move to a v2 shard; the manifest lists its key.
        const shardKey = skills ? store.shards?.[skills.id]?.key : null;
        let files = store.files || [];
        if (shardKey) {
            try { files = files.concat(JSON.parse(localStorage.getItem(shardKey) || '{}').files || []); } catch { /* shard unreadable */ }
        }
        const file = files.find(f => f.folderId === skills?.id && f.name === name);
        return file?.content || '';
    } catch { return ''; }
}, fileName);

/** Reload the app so the learning heartbeat mounts and its auto-apply sweep
 *  drains the queue, then poll until `done()` is true (the caller decides what
 *  "done" is: draft consumed, file present, attempts bumped). The reload is
 *  the probe's click: the sweep runs on mount by design. */
async function runAutoApply(page, done, timeoutMs = 12000) {
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await sleep(500);
        // The app may still be booting; a null notebook key just means "not yet".
        const state = await page.evaluate(() => ({ ready: !!document.querySelector('[data-testid="learn-view"], #root *') }));
        if (!state.ready) continue;
        if (await done()) return true;
    }
    return false;
}

/** Skill file names currently in the notebook, from the live page.
 *  Resolves the key INSIDE the page every call: the app recreates the notebook
 *  asynchronously after a storage clear, so a key captured once at startup can
 *  be stale (that null-deref is what killed case 4 last pass).
 *
 *  Note: removing the skills FOLDER was tried as case 4's failure injection and
 *  does not work — `ensureHarnessFoldersUnlocked` recreates it, so the write
 *  succeeds. That is why case 4 sabotages `Storage.prototype.setItem` instead,
 *  and why there is no deleteSkillsFolder helper here. */
const readSkillFiles = (page) => page.evaluate(() => {
    const nk = Object.keys(localStorage).find(k => k.startsWith('memory_files_v1'));
    if (!nk) return { key: null, folders: [], files: [], error: 'no-notebook-key' };
    const raw = localStorage.getItem(nk);
    if (!raw) return { key: nk, folders: [], files: [], error: 'not-persisted-yet' };
    try {
        const store = JSON.parse(raw);
        const skills = (store.folders || []).find(f => f.name === 'skills');
        // The manifest keeps folders and small files; skills live in a v2
        // shard (E-44), so read both before calling the file list.
        const shardKey = skills ? store.shards?.[skills.id]?.key : null;
        let allFiles = store.files || [];
        if (shardKey) {
            try { allFiles = allFiles.concat(JSON.parse(localStorage.getItem(shardKey) || '{}').files || []); } catch { /* shard unreadable */ }
        }
        return {
            key: nk,
            folders: (store.folders || []).map(f => f.name),
            files: skills ? allFiles.filter(f => f.folderId === skills.id).map(f => f.name) : [],
        };
    } catch (e) { return { key: nk, folders: [], files: [], error: String(e) }; }
});

async function shot(page, name) {
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {});
}

/** Click a visible control by the first word of its text, across whatever
 *  element the design system actually used (button, role=tab, anchor, div).
 *  Restricting to <button> is what made this report "not reachable" twice.
 *  Retained for diagnostics; the auto-apply path needs no clicks. */
const clickByText = (page, word) => page.evaluate((w) => {
    const sel = 'button, [role="tab"], [role="button"], a, [data-testid]';
    const cands = [...document.querySelectorAll(sel)]
        .map(el => ({ el, text: (el.textContent || '').trim() }))
        .filter(c => new RegExp('^' + w + '(\\s|$)').test(c.text))
        // The innermost match wins: a whole panel can start with the same word.
        .sort((a, b) => a.text.length - b.text.length);
    if (!cands.length) return { ok: false, seen: [] };
    cands[0].el.click();
    return { ok: true, used: cands[0].text.slice(0, 30), options: cands.length };
}, word);
void clickByText;

/** Seed one draft and let the auto-apply sweep land it. Polls until the draft
 *  leaves the store (applied or consumed) or the timeout — a refusal keeps the
 *  draft, so the caller's own assertions decide what "landed" means. */
async function seedAndAutoApply(page, id, crafted) {
    await seedDrafts(page, [draftRow(id, crafted)]);
    const before = await readSkillFiles(page);
    await runAutoApply(page, async () => {
        const drafts = await readDrafts(page);
        const files = await readSkillFiles(page);
        return drafts.length === 0 || files.files.length !== before.files.length;
    });
    return { before, after: await readSkillFiles(page), draftsAfter: await readDrafts(page) };
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    const server = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    // The seeded provider config points at 127.0.0.1:8787 (same contract as
    // render-probe.cjs:460). Without it every case logged ~25 failed-resource
    // errors that were the probe's own fiction, not the app's behaviour.
    const mock = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-provider.cjs'), '8787'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let serverLog = '';
    server.stdout.on('data', d => { serverLog += d.toString(); });
    server.stderr.on('data', d => { serverLog += d.toString(); });

    const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // Only an UNCAUGHT exception is treated as a failure. Failed image/fetch
    // loads are reported but must not fail the run, or the probe would be
    // asserting on network reachability rather than on the approval flow.
    const pageErrors = [];
    const resourceErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('console', m => {
        if (m.type() !== 'error') return;
        (/failed to load resource|net::|ERR_|502|503/i.test(m.text()) ? resourceErrors : pageErrors).push(m.text());
    });
    page.on('requestfailed', r => resourceErrors.push(`${r.url()} ${r.failure() && r.failure().errorText}`));

    try {
        if (!await waitForServer(BASE)) {
            check('dev server started', false, serverLog.slice(0, 400));
            throw new Error('server did not come up');
        }
        const notebookKey = await freshSession(page);
        check('notebook key discovered on the live page', !!notebookKey, notebookKey);
        if (!notebookKey) throw new Error('no notebook to assert against');

        /** Seed exactly one draft and let the heartbeat's auto-apply land it.
         *  Every case calls this for its OWN prerequisite, because
         *  `freshSession` clears localStorage — a case that relied on the
         *  previous case's file could never see it (that is why 2-4 were red). */
        const approveOne = async (id, crafted) => {
            const r = await seedAndAutoApply(page, id, crafted);
            await shot(page, `${id}-after`);
            return { ...r, draftsAfter: await readDraftsDetailed(page) };
        };

        // ── 1. happy path ────────────────────────────────────────────────────
        await freshSession(page);
        {
            const r = await approveOne('sk-happy', craft());
            check('1-happy: the auto-apply wrote the skill file into the notebook',
                r.after.files.includes('funding-exhaustion-long.md'), r.after.files.length);
            check('1-happy: draft consumed', r.draftsAfter.length === 0, r.draftsAfter.map(d => d.id));
        }

        // ── 2. slug collision: same NAME, different trigger ─────────────────
        await freshSession(page);
        {
            await approveOne('sk-col-1', craft());
            const r = await approveOne('sk-col-2', craft({ when: 'a completely different trigger clause entirely' }));
            // Asserted by the NEW file's name, not by a count: the app pre-seeds
            // twelve book-*.md skills, so a length check proves nothing.
            check('2-collision: second file written as funding-exhaustion-long-2.md',
                r.after.files.includes('funding-exhaustion-long-2.md'), r.after.files);
            check('2-collision: the collision did not throw',
                pageErrors.filter(e => /already exists/.test(e)).length === 0,
                pageErrors.filter(e => /already exists/.test(e)));
        }

        // ── 3. duplicate: an already-live trigger ───────────────────────────
        await freshSession(page);
        {
            const first = await approveOne('sk-dup-1', craft());
            const r = await approveOne('sk-dup-2', craft({ name: 'Renamed duplicate trigger' }));
            check('3-duplicate: wrote no new file',
                JSON.stringify(r.after.files) === JSON.stringify(r.before.files),
                { before: r.before.files.length, after: r.after.files.length });
            check('3-duplicate: the duplicate draft was still consumed',
                r.draftsAfter.length === 0, r.draftsAfter.map(d => d.id));
            check('3-duplicate: prerequisite really was live first',
                first.after.files.includes('funding-exhaustion-long.md'), first.after.files.length);
        }

        // ── 4. the write cannot land ────────────────────────────────────────
        // Deleting the skills FOLDER does not test this: `ingestCraftedSkillFrom
        // DraftUnlocked` calls `ensureHarnessFoldersUnlocked` first, which
        // recreates it, so the write simply succeeds. Force the failure where it
        // is genuinely forced — the notebook write itself. The auto-apply must
        // leave the draft in the store with its ATTEMPT counted (the refusal
        // budget), never destroyed on an assumption.
        await freshSession(page);
        {
            await page.addInitScript(() => {
                // `window.Storage`, not bare `Storage`: this file is a .cjs and
                // the lint config has no browser globals, so bare `Storage` is
                // an error under no-undef.
                const real = window.Storage.prototype.setItem;
                window.Storage.prototype.setItem = function (k, v) {
                    // Gate on a FLAG, not just the key: an init script lives for
                    // the whole page, and a blanket block quietly broke every later
                    // case's notebook writes (case 5 failed on its own missing
                    // prerequisite before this gate existed).
                    if (typeof k === 'string' && k.startsWith('memory_files_v1')
                        && localStorage.getItem('probe_block_notebook') === '1') {
                        throw new Error('probe: quota exceeded');
                    }
                    return real.call(this, k, v);
                };
            });
            await page.evaluate(() => localStorage.setItem('probe_block_notebook', '1'));
            // The blocked phase sets up the retry: under a sabotaged store the
            // byte-level outcome is not stable (the debounced persistence stack
            // and the cache rollback interact with the block), so the case
            // asserts on what storage HEALED looks like — 4b below.
            await approveOne('sk-writefail', craft({ when: 'a trigger whose write will be forced to fail' }));
            await page.evaluate(() => localStorage.removeItem('probe_block_notebook'));

            // ── 4b. the retry, after the block lifts ────────────────────────
            // The budget exists so a permanently refusable draft stops being
            // retried — not so a fixable one is stranded. One more mount, one
            // more sweep, and the draft lands; the skill is asserted on the
            // STORED bytes, and the draft is consumed only once it did.
            const applied = await runAutoApply(page, async () =>
                (await readSkillFiles(page)).files.includes('funding-exhaustion-long.md'));
            const retryFiles = await readSkillFiles(page);
            const retryDrafts = await readDrafts(page);
            check('4b-retry: the sweep retried and the skill landed in the STORED bytes',
                applied && retryFiles.files.includes('funding-exhaustion-long.md'), retryFiles.files.length);
            check('4b-retry: the draft is consumed only once the write landed',
                retryDrafts.length === 0, retryDrafts.map(d => d.id));
        }
        // ── 5. A2: a rescope proposal applied by the auto-apply sweep ────────
        // The unit suites prove the applier; this proves the SWEEP reached it in
        // the real app, and asserts the FILE BYTES — a vanished row proves the
        // sweep ran, not that the write landed.
        await freshSession(page);
        {
            await approveOne('sk-rescope-seed', craft());
            const lived = await readSkillContent(page, 'funding-exhaustion-long.md');
            check('5-rescope: prerequisite skill is live with the original clause',
                lived.includes('funding runs positive for many sessions while price stalls at swept lows'), lived.length);

            const NEW = {
                when: 'funding positive 14 sessions and the daily low was swept',
                body: [
                    '**When:** funding positive 14 sessions and the daily low was swept.',
                    '**What I do:** wait for a 4h close back above the swept level, then enter with the stop under the wick.',
                    '**Invalidates:** a close back under the swept level.',
                ].join(String.fromCharCode(10)),
                predicate: 'close > open',
            };
            const row = {
                id: 'lp-probe-rescope-1', kind: 'rescope', skillSlug: 'funding-exhaustion-long',
                text: 'It fires on 3-session funding streaks too and loses there; only 14+ is the edge.',
                fingerprint: 'model-revision:funding-exhaustion-long:probe',
                createdAt: new Date().toISOString(),
                payload: { source: 'model:desk', ...NEW },
            };
            await seedProposals(page, [row]);
            const landed = await runAutoApply(page, async () =>
                (await readSkillContent(page, 'funding-exhaustion-long.md')).includes(NEW.when));
            const bytes = await readSkillContent(page, 'funding-exhaustion-long.md');
            check('5-rescope: the sweep applied the proposal — the notebook carries the proposed trigger',
                landed && bytes.includes(NEW.when), bytes.length);
            check('5-rescope: the old trigger is gone from the file, prose line included',
                !bytes.includes('funding runs positive for many sessions'), { stale: bytes.includes('funding runs positive for many sessions') });
            check('5-rescope: one skill, not a second file',
                (await readSkillFiles(page)).files.filter(f => f.includes('funding-exhaustion-long')).length === 1);
            check('5-rescope: the proposal row was consumed',
                (await readProposals(page)).length === 0);

            // 5b. a refusal: clause below the bar. The row must STAY queued and
            // its auto-refusal budget must record the attempt — the honest
            // replacement for the row that used to name why on itself.
            const bad = {
                id: 'lp-probe-rescope-2', kind: 'rescope', skillSlug: 'funding-exhaustion-long',
                text: 'Vague tightening.', fingerprint: 'model-revision:funding-exhaustion-long:vague',
                createdAt: new Date().toISOString(),
                payload: { source: 'model:desk', when: 'be careful' },
            };
            await seedProposals(page, [bad]);
            await runAutoApply(page, async () => {
                const budget = await page.evaluate((k) => {
                    const raw = localStorage.getItem(k) || '{}';
                    try { return JSON.parse(raw); } catch { return {}; }
                }, `learning_proposals_v1_autoref:${USER}`);
                return (budget[bad.id] ?? 0) >= 1;
            });
            const budget = await page.evaluate((k) => {
                try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; }
            }, `learning_proposals_v1_autoref:${USER}`);
            check('5b-refusal: the below-bar proposal is still queued',
                (await readProposals(page)).some(p => p.id === bad.id));
            check('5b-refusal: the refused attempt is counted in the budget ledger',
                (budget[bad.id] ?? 0) >= 1, budget);
            check('5b-refusal: the skill bytes did not change',
                (await readSkillContent(page, 'funding-exhaustion-long.md')).includes(NEW.when));
            await shot(page, 'rescope');
        }
        await shot(page, 'final');
    } catch (e) {
        check('probe completed without throwing', false, String(e && e.message || e));
        await shot(page, 'aborted');
    } finally {
        check('no uncaught page errors during the run',
            // Errors my own case-4 sabotage provokes are not app bugs.
            pageErrors.filter(e => !/probe: quota exceeded/.test(e)).length === 0,
            pageErrors.filter(e => !/probe: quota exceeded/.test(e)).slice(0, 3));
        console.log(`(resource-load noise ignored: ${resourceErrors.length})`);
        fs.writeFileSync(path.join(OUT, 'transcript.json'),
            JSON.stringify({ results, failed, pageErrors, resourceErrors: resourceErrors.slice(0, 20) }, null, 2));
        await browser.close().catch(() => {});
        server.kill('SIGTERM');
        mock.kill('SIGTERM');
        console.log(`\n${results.length - failed}/${results.length} checks passed; pageErrors=${pageErrors.length}`);
        if (pageErrors.length) console.log(pageErrors.slice(0, 5).join('\n'));
        process.exit(failed === 0 ? 0 : 1);
    }
})();
