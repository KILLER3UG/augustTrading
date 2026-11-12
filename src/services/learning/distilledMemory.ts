/**
 * distilledMemory — the notebook side of insight store unification (plan
 *). Attributed insights (severity lessons, provider-attributed
 * post-mortem lessons) used to live in a standalone Preferences key
 * (`attributed_insights_kb_<user>`) — a third parallel memory store with its
 * own cap and no review UI. They now live IN the trader notebook as one
 * auto-managed file per insight in the `distilled/` folder, so the notebook
 * is the one store, one cap, one UI (MemoryFilesManager) for everything the
 * harness learns.
 *
 * Read/write shape mirrors MemoryFilesService itself: a synchronous write-
 * through facts cache (so a write is visible to the next sync read — the
 * idempotent severity/provider upserts depend on that) hydrated from the
 * notebook, with every mutation serialized through the notebook write lock.
 * The notebook is the single persistent store; the cache only mirrors it.
 *
 * Provenance: every fact carries a `distilled:<fingerprint>` source tag —
 * The normalized-insight slug the distill path keys on. A fact whose
 * fingerprint already exists is updated in place instead of duplicated.
 */

import { AttributedInsight, MemoryFile, UserProfile } from '../../types';
import {
    createMemoryFolderUnlocked,
    createMemoryFileUnlocked,
    deleteMemoryFileUnlocked,
    getMemoryFiles,
    slugifyName,
    subscribeMemoryFilesChanged,
    updateMemoryFileUnlocked,
    withNotebookWriteLock,
} from './MemoryFilesService';
import { getPreferenceObject, removePreference, PREF_KEYS } from '../infrastructure/PreferencesService';
import { getUserProfile, saveUserProfile } from '../infrastructure/dbService';

export const DISTILLED_FOLDER_NAME = 'distilled';
/** Same cap the old pref store enforced (most recent 200). Over cap we prune
 *  the least useful facts: lowest quality first, oldest as the tiebreak. */
export const DISTILLED_FACT_CAP = 200;

const activeUsername = (): string =>
    typeof localStorage !== 'undefined'
        ? (localStorage.getItem('last_active_user') || 'default')
        : 'default';

// ─── Fingerprint (the normalizer, minimal form) ────────────────────────

/**
 * Deterministic insight fingerprint: lowercase, numbers/dates/trade ids and
 * path-like tokens stripped, whitespace collapsed, capped. Two insights that
 * "say the same thing about the same setup" normalize to the same slug, so
 * re-recording a lesson updates its fact instead of piling up near-duplicates.
 */
export const normalizeInsightFingerprint = (text: string): string => {
    const slug = text
        .toLowerCase()
        // numbers, decimals, R-magnitudes, timestamps — magnitudes change on
        // re-record; the shape of the lesson must not
        .replace(/\b[\d,.]+(r|x|%|usd)?\b/g, ' ')
        // path-like tokens and ids (severity-t-123, provider-x-0)
        .replace(/\b[\w-]*\d[\w-]*\b/g, ' ')
        .replace(/[^a-z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
        .trim();
    return slug || 'unclassifiable';
};

// ─── Serialization (frontmatter block inside the file content) ──────────────

const esc = (v: string): string => v.replace(/\n/g, ' ');

const serializeFact = (i: AttributedInsight): string => {
    const provider = typeof i.sourceProvider === 'string' ? i.sourceProvider : String(i.sourceProvider);
    const fm = [
        '---',
        `id: ${esc(i.id)}`,
        `source: distilled:${normalizeInsightFingerprint(i.insight)}`,
        `provider: ${esc(provider)}`,
        `category: ${i.category}`,
        i.scope ? `scope: ${esc(i.scope)}` : null,
        `quality: ${i.qualityScore}`,
        `validated: ${i.wasValidated}`,
        `used: ${i.timesUsed}`,
        `helpful: ${i.timesHelpful}`,
        `nothelpful: ${i.timesNotHelpful ?? 0}`,
        `created: ${esc(i.createdAt)}`,
        `trade: ${esc(i.tradeId)}`,
        '---',
    ].filter((l): l is string => l !== null);

    // Graph keys the notebook map links on (coin:/direction:/family:/regime:)
    // derived from category+scope so distilled facts join the memory graph.
    const graphKeys: string[] = [];
    if (i.category === 'coin' && i.scope) graphKeys.push(`coin: ${i.scope}`);
    if (i.category === 'family' && i.scope) graphKeys.push(`family: ${i.scope}`);
    if (i.category === 'regime' && i.scope) graphKeys.push(`regime: ${i.scope}`);

    return [...fm, '', `# Distilled lesson — distilled:${normalizeInsightFingerprint(i.insight)}`, ...graphKeys, '', i.insight, ''].join('\n');
};

const parseFact = (file: MemoryFile): AttributedInsight | null => {
    const m = file.content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return null;
    const meta: Record<string, string> = {};
    for (const line of m[1].split('\n')) {
        const kv = line.match(/^([a-zA-Z]+):\s*(.*)$/);
        if (kv) meta[kv[1].trim()] = kv[2].trim();
    }
    if (!meta.id || !meta.created) return null;
    // The rendered body is: title line, optional graph-key lines, then the
    // insight text. The title/keys are notebook chrome (the map builder
    // links on them) — the insight is what remains.
    const bodyLines = file.content.slice(m[0].length).split('\n');
    while (bodyLines.length > 0) {
        const line = bodyLines[0].trim();
        if (line === '' || /^#\s/.test(line) || /^(coin|family|regime):\s/.test(line)) {
            bodyLines.shift();
            continue;
        }
        break;
    }
    const insight = bodyLines.join('\n').trim();
    if (!insight) return null;
    const category = ['global', 'coin', 'pattern', 'regime', 'family']
        .find(c => c === meta.category) as AttributedInsight['category'] | undefined;
    return {
        id: meta.id,
        insight,
        sourceProvider: meta.provider || 'unknown',
        category: category ?? 'global',
        scope: meta.scope,
        qualityScore: Number.isFinite(Number(meta.quality)) ? Number(meta.quality) : 50,
        wasValidated: meta.validated === 'true',
        timesUsed: Number(meta.used) || 0,
        timesHelpful: Number(meta.helpful) || 0,
        timesNotHelpful: Number(meta.nothelpful) || 0,
        createdAt: meta.created,
        tradeId: meta.trade || '',
    };
};

// ─── Sync facts cache (write-through mirror of the notebook) ────────────────

let factsCache: AttributedInsight[] | null = null;
/** Facts written this session whose notebook file may not have landed yet —
 *  overlaid on the files at hydrate so a notification-driven re-hydrate
 *  mid-burst never drops a fact from view. */
const pendingWrites = new Map<string, AttributedInsight>();
/** The notebook writes are fire-and-forget, so a failure never reaches the
 *  caller that queued it. These make it visible to the one caller that owes a
 *  durability decision — the frozen-insight migration, which must NOT clear
 *  the profile's copy of a fact whose notebook write did not land. */
let distilledWriteFailures = 0;
let lastDistilledWriteError: string | null = null;

const distilledFolderId = (): string | null =>
    getMemoryFiles().folders.find(f => f.name === DISTILLED_FOLDER_NAME)?.id ?? null;

const factsFromFiles = (): AttributedInsight[] => {
    const folderId = distilledFolderId();
    if (!folderId) return [];
    return getMemoryFiles().files
        .filter(f => f.folderId === folderId)
        .map(parseFact)
        .filter((i): i is AttributedInsight => i !== null);
};

const hydrate = (): AttributedInsight[] => {
    ensureSubscription();
    const merged = factsFromFiles();
    for (const [id, fact] of pendingWrites) {
        if (!merged.some(f => f.id === id)) merged.push(fact);
    }
    factsCache = merged;
    return merged;
};

/** Drop the mirror cache — next read re-hydrates from the notebook. */
export const resetDistilledCache = (): void => { factsCache = null; };

// Notebook writes (ours or harness ones) may change the distilled folder —
// re-derive on the next read. The pending overlay keeps in-flight writes
// visible. Subscribed lazily (not at module eval): MemoryFilesService
// re-exports from MemoryRetrievalService, so module-graph cycles can reach
// this file while its imports are still initializing.
let subscribed = false;
const ensureSubscription = (): void => {
    if (subscribed) return;
    subscribed = true;
    try {
        subscribeMemoryFilesChanged(() => { resetDistilledCache(); });
    } catch (e) {
        console.warn('[distilledMemory] Could not subscribe to notebook changes:', e);
    }
};

const factFileName = (i: AttributedInsight): string => {
    const base = slugifyName(i.id.replace(/^insight-/, 'fact-')) || 'fact';
    return `${base}.md`;
};

/**
 * All distilled facts for the active user, in notebook order (oldest first —
 * the old store treated the tail as "newest", and `.slice(-3)` consumers
 * rely on that).
 */
export const loadDistilledFacts = (): AttributedInsight[] =>
    factsCache ?? hydrate();

export const findDistilledByFingerprint = (fingerprint: string): AttributedInsight | null =>
    loadDistilledFacts().find(f => normalizeInsightFingerprint(f.insight) === fingerprint) ?? null;

// ─── Write side (serialized through the notebook write lock) ────────────────

const pruneOverCapUnlocked = async (username: string): Promise<void> => {
    const folderId = distilledFolderId();
    if (!folderId) return;
    const files = getMemoryFiles().files.filter(f => f.folderId === folderId);
    if (files.length <= DISTILLED_FACT_CAP) return;
    const ranked = files
        .map(f => ({ f, fact: parseFact(f) }))
        .sort((a, b) => {
            const q = (a.fact?.qualityScore ?? 50) - (b.fact?.qualityScore ?? 50);
            if (q !== 0) return q;
            return (a.fact?.createdAt ?? '').localeCompare(b.fact?.createdAt ?? '');
        });
    for (const { f } of ranked.slice(0, files.length - DISTILLED_FACT_CAP)) {
        await deleteMemoryFileUnlocked(f.id, username);
    }
};

/**
 * Upsert one fact. Idempotent on both id (same fact id → the existing file
 * is updated, feedback counters survive) and fingerprint (a different id
 * saying the same thing merges into the existing file, keeping its feedback
 * counters). The cache mutation is synchronous; the notebook file write
 * serializes through the write lock.
 *
 * Returns the EFFECTIVE stored fact — when the fingerprint merge fired, the
 * caller's id was absorbed into the existing fact, and the returned record
 * carries that (real, stored) id so downstream usage marks and lookups land
 * on the actual row.
 */
export const writeDistilledFact = (incoming: AttributedInsight): Promise<AttributedInsight> => {
    return Promise.resolve(mergeDistilledFact(incoming));
};

/**
 * Synchronous merge decision + write-through cache update for one fact;
 * the notebook file write is scheduled through the write lock. Returns the
 * effective stored fact (see writeDistilledFact).
 */
export const mergeDistilledFact = (incoming: AttributedInsight): AttributedInsight => {
    ensureSubscription();
    const username = activeUsername();
    const fp = normalizeInsightFingerprint(incoming.insight);

    // Fingerprint merge decision (sync — the cache is authoritative for
    // this session): an existing fact with the same normalized shape
    // absorbs the new text and keeps its feedback counters.
    let finalFact = incoming;
    let targetFileName: string | null = null;
    const byFp = findDistilledByFingerprint(fp);
    if (byFp && byFp.id !== incoming.id) {
        finalFact = {
            ...byFp,
            insight: incoming.insight,
            qualityScore: Math.max(byFp.qualityScore, incoming.qualityScore),
            timesUsed: byFp.timesUsed + incoming.timesUsed,
            timesHelpful: byFp.timesHelpful + incoming.timesHelpful,
            timesNotHelpful: (byFp.timesNotHelpful ?? 0) + (incoming.timesNotHelpful ?? 0),
            wasValidated: byFp.wasValidated || incoming.wasValidated,
        };
        targetFileName = factFileName(byFp);
    }

    // Sync cache update (write-through — the next sync read must see this).
    if (factsCache) {
        const idx = factsCache.findIndex(f => f.id === finalFact.id);
        if (idx >= 0) factsCache[idx] = finalFact;
        else factsCache.push(finalFact);
        if (finalFact.id !== incoming.id) {
            const dropIdx = factsCache.findIndex(f => f.id === incoming.id);
            if (dropIdx >= 0) factsCache.splice(dropIdx, 1);
        }
    }
    pendingWrites.set(finalFact.id, finalFact);
    if (finalFact.id !== incoming.id) pendingWrites.delete(incoming.id);

    // Notebook persistence (serialized; the cache already reflects it). The
    // lock promise is NOT awaited here — the sync caller cannot wait — but a
    // rejection is recorded so the migration's flush can refuse to clear the
    // profile's copy of a fact that is not actually on disk.
    void withNotebookWriteLock(async () => {
        try {
            let folder = getMemoryFiles().folders.find(f => f.name === DISTILLED_FOLDER_NAME);
            if (!folder) folder = await createMemoryFolderUnlocked(DISTILLED_FOLDER_NAME, username);

            const content = serializeFact(finalFact);
            const files = getMemoryFiles().files;
            const byId = files.find(f => f.folderId === folder.id && parseFact(f)?.id === finalFact.id);
            const target = byId
                ?? (targetFileName
                    ? files.find(f => f.folderId === folder.id && f.name === targetFileName)
                    : undefined)
                ?? files.find(f => f.folderId === folder.id && f.name === factFileName(finalFact));
            if (target) {
                await updateMemoryFileUnlocked(target.id, { content }, username);
            } else {
                await createMemoryFileUnlocked(folder.id, targetFileName ?? factFileName(finalFact), content, username, true);
            }
            await pruneOverCapUnlocked(username);
        } finally {
            pendingWrites.delete(finalFact.id);
            resetDistilledCache();
        }
    }).catch((err: unknown) => {
        distilledWriteFailures += 1;
        lastDistilledWriteError = err instanceof Error ? err.message : String(err);
        console.error('[distilledMemory] notebook write FAILED — the fact is NOT on disk:', err);
    });
    return finalFact;
};

/** Resolves once every scheduled fact write has landed, and says whether they
 *  did. The frozen-insight migration owes the trader's data a durability
 *  decision: it clears the profile's only other copy of a fact, so it must
 *  refuse when the notebook write failed rather than report success. */
export const flushDistilledWrites = async (): Promise<{ ok: boolean; error?: string }> => {
    const failuresBefore = distilledWriteFailures;
    await withNotebookWriteLock(() => Promise.resolve());
    if (distilledWriteFailures !== failuresBefore) {
        return { ok: false, error: lastDistilledWriteError ?? 'the notebook write failed' };
    }
    return { ok: true };
};

// ─── One-time legacy migration ──────────────────────────────────────────────

/**
 * Move the old pref-store rows into the notebook once, then retire the key.
 * Called from initPatternMemoryService on boot; safe to re-run (records that
 * already migrated fingerprint-merge instead of duplicating, and the key is
 * removed after a successful pass).
 */
export const migrateLegacyAttributedInsights = async (): Promise<number> => {
    let migrated = 0;
    try {
        const username = activeUsername();
        const legacy = await getPreferenceObject<AttributedInsight[]>(
            `${PREF_KEYS.ATTRIBUTED_INSIGHTS}_${username}`
        );
        if (Array.isArray(legacy) && legacy.length > 0) {
            for (const i of legacy) {
                if (!i?.id || !i?.insight) continue;
                await writeDistilledFact(i);
                migrated++;
            }
            resetDistilledCache();
        }
        if (migrated > 0 || legacy !== undefined) {
            await removePreference(`${PREF_KEYS.ATTRIBUTED_INSIGHTS}_${username}`);
        }
        if (migrated > 0) {
            console.log(`[distilledMemory] Migrated ${migrated} attributed insights into the notebook`);
        }
    } catch (e) {
        console.warn('[distilledMemory] Legacy insight migration failed (will retry next boot):', e);
    }
    return migrated;
};

// ─── Frozen-field migration (the profile-borne insight stores) ──────────────

/**
 * The shape the frozen fields carried before the store was deleted. The
 * fields are gone from `UserProfile`, but older profiles still carry them in
 * their stored blob — this is what the migration reads out.
 */
interface FrozenTradeInsight {
    id?: unknown;
    insight?: unknown;
    sourceTradeId?: unknown;
    coin?: unknown;
    pattern?: unknown;
    direction?: unknown;
    createdAt?: unknown;
}

const asInsight = (v: unknown): FrozenTradeInsight | null =>
    (v && typeof v === 'object') ? v as FrozenTradeInsight : null;

/**
 * Move the frozen `insightKnowledgeBase` fields — BOTH the top-level
 * `UserProfile` field and the `GlobalMemory.insightKnowledgeBase` field —
 * into the notebook's distilled/ folder, then clear them from the stored
 * profile. Called from useUserProfileLoader.loadUserData right after
 * `setAttributedInsightsUser`, BEFORE the profile is applied to state: the
 * clear lands in storage first, so `applyLoadedProfile` reads a profile that
 * no longer carries the frozen fields and the persistence round-trip cannot
 * write them back.
 *
 * Safe to re-run: each fact lands through `writeDistilledFact`, whose
 * fingerprint merge absorbs a repeat into the existing fact (counters kept).
 * A failed write skips the clear entirely — the frozen fields stay in the
 * stored profile and the next boot retries (no data loss).
 *
 * Every migrated fact is verbatim, attributed to sourceProvider 'legacy'
 * (an honest provenance label: no provider ever reviewed it), quality 50 —
 * the neutral mid-scale, since the store's `useCount` was birth strength,
 * not measured usefulness.
 */
export const migrateFrozenTradeInsights = async (username: string): Promise<number> => {
    let migrated = 0;
    try {
        const profile = await getUserProfile(username);
        if (!profile) return 0;
        // Structural read: the fields no longer exist on UserProfile by type,
        // but the stored blob still carries them.
        const carrier = profile as unknown as {
            insightKnowledgeBase?: { insights?: unknown[] };
            globalMemory?: { insightKnowledgeBase?: { insights?: unknown[] } };
        };
        const frozen: FrozenTradeInsight[] = [
            ...(Array.isArray(carrier.insightKnowledgeBase?.insights) ? carrier.insightKnowledgeBase.insights : []),
            ...(Array.isArray(carrier.globalMemory?.insightKnowledgeBase?.insights) ? carrier.globalMemory.insightKnowledgeBase.insights : []),
        ]
            .map(asInsight)
            .filter((t): t is FrozenTradeInsight => t !== null);

        for (const t of frozen) {
            if (typeof t.id !== 'string' || !t.id) continue;
            if (typeof t.insight !== 'string' || !t.insight.trim()) continue;
            // Category from scope presence: a coin-scoped lesson is a coin
            // fact, a pattern-scoped one a pattern fact, the rest global.
            const coin = typeof t.coin === 'string' && t.coin.trim() ? t.coin.trim() : null;
            const pattern = typeof t.pattern === 'string' && t.pattern.trim() ? t.pattern.trim() : null;
            await writeDistilledFact({
                id: `legacy-${t.id}`,
                insight: t.insight,
                sourceProvider: 'legacy',
                category: coin ? 'coin' : pattern ? 'pattern' : 'global',
                scope: coin ?? pattern ?? undefined,
                qualityScore: 50,
                wasValidated: false,
                timesUsed: 0,
                timesHelpful: 0,
                timesNotHelpful: 0,
                createdAt: typeof t.createdAt === 'string' && t.createdAt ? t.createdAt : new Date().toISOString(),
                tradeId: typeof t.sourceTradeId === 'string' ? t.sourceTradeId : '',
            });
            migrated++;
        }
        if (migrated > 0) resetDistilledCache();

        // The writes above were queued, not awaited. Flush them and REFUSE to
        // clear the frozen fields unless every one landed: the stored profile
        // is the fact's only other copy, so clearing it behind a failed write
        // destroys the row. The fields stay, and the next boot re-runs the
        // batch — an already-landed fact fingerprint-merges instead of
        // duplicating, so the retry is safe.
        const landed = await flushDistilledWrites();
        if (!landed.ok) {
            console.warn(`[distilledMemory] ${migrated} insight(s) did NOT reach the notebook (${landed.error ?? 'write failed'}) — the frozen fields are KEPT and the next boot retries`);
            return migrated;
        }

        // Clear the frozen fields so no save carries them again.
        const patch: Record<string, unknown> = { insightKnowledgeBase: undefined };
        if (carrier.globalMemory && 'insightKnowledgeBase' in carrier.globalMemory) {
            patch.globalMemory = { ...carrier.globalMemory, insightKnowledgeBase: undefined };
        }
        if (migrated > 0 || patch.globalMemory) {
            await saveUserProfile(username, patch as unknown as Partial<UserProfile>);
            if (migrated > 0) {
                console.log(`[distilledMemory] Migrated ${migrated} frozen trade insights into the notebook and cleared the frozen fields`);
            }
        }
    } catch (e) {
        console.warn('[distilledMemory] Frozen insight migration failed (frozen fields kept, will retry next boot):', e);
    }
    return migrated;
};
