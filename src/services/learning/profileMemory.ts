/**
 * profileMemory — August's counterpart to this coding agent's memory system.
 *
 * The trader NOTEBOOK (MemoryFilesService) remembers what the MARKET taught
 * the models. This remembers what the USER taught the assistant — the small,
 * durable facts about the collaboration itself, in the same shape this
 * environment's memory has:
 *
 *   • one fact per entry, with a short kebab-case slug, a one-line
 *     description (used to decide relevance), and a body holding the fact;
 *   • four kinds — 'user' (who they are), 'feedback' (how they want the
 *     assistant to work — bodies carry **Why** + **How to apply**),
 *     'project' (ongoing work/constraints not derivable from the journal),
 *     'reference' (pointers to external things);
 *   • the INDEX (slug + one-line description per entry) is injected into
 *     every Chart AI system prompt and every analysis-pipeline memory block —
 *     always loaded, like this environment's MEMORY.md;
 *   • bodies are pulled on demand via the read_memory desk tool, not dumped;
 *   • the model maintains it itself: remember (upsert by slug — update over
 *     duplicate), forget (wrong memories get deleted, not left to rot).
 *
 * Per-user localStorage blob (`profile_memory_v1_${user}`), bounded — same
 * persistence grain as chatSessions, so no new storage path.
 */

import { getActiveUsername } from '../../utils/activeUser';
import { filterMemoryWrite } from '../../utils/memoryWriteFilters';
import { getHarnessSettings } from '../../utils/harnessSettings';
import { contentWords, jaccard, overlap } from '../../utils/textOverlap';
import { UNBOUNDED_INDEX_LINES } from '../../utils/promptIndexBudget';
import { memorySectionOf, normalizeMemorySection, orderMemorySections } from './memorySections';

export type ProfileMemoryKind = 'user' | 'feedback' | 'project' | 'reference';

export interface ProfileMemoryEntry {
    /** Short kebab-case slug — the entry's identity (upsert key). */
    slug: string;
    /** The row's display name, 2–5 words. A slug is chosen for stability and
     *  can outgrow the label column ("august-signal-first-harness-…"), so the
     *  writer names the row separately; absent on legacy rows, where the page
     *  humanizes the slug. */
    title?: string;
    /** One line, ≤ ~140 chars: how to decide relevance. */
    description: string;
    kind: ProfileMemoryKind;
    /** The fact itself (markdown). feedback/project bodies should carry
     *  **Why:** / **How to apply:** lines. */
    body: string;
    /** Provenance: who wrote it — the model via remember(), the automatic
     *  trader learner ('auto'), or a human edit. Absent on legacy rows. */
    source?: 'model' | 'auto' | 'user';
    /** The two-author vocabulary the trader can audit: who wrote the row. */
    author?: 'trader' | 'model';
    createdAt: string;
    updatedAt: string;
    /** Optimistic-lock counter, incremented on every write. Absent on legacy
     *  rows — read as 1, so a first if_version against a legacy row succeeds
     *  and stamps the field from then on. */
    version?: number;
    /** Provenance of the fact: 'stated' (the USER said it — the only tag the
     *  chat agent may write), 'observed' (a system path watched behaviour) or
     *  'inferred'. Absent on legacy rows reads as 'stated' — that is what
     *  every pre-field row was. */
    tag?: 'stated' | 'observed' | 'inferred';
    /** A sensitive-category fact (health / finances / identity). Stored only
     *  when the user's setting allows, and excluded from pre-reads and
     *  unattended contexts. */
    sensitive?: boolean;
    /** Extra match strings the deterministic pre-read may hit on, beyond the
     *  slug's own words ("bun" for user-runs-bun). */
    aliases?: string[];
    /** What the fact is ABOUT. `kind` says where it came from (a user fact, a
     *  piece of feedback, project context); this says whose or what the claim
     *  concerns, which is what decides whether it applies to a new question.
     *  Absent on legacy rows, where `subjectOf()` derives it from `kind` rather
     *  than pretending the record has no subject. */
    subject?: 'profile' | 'preference' | 'topic' | 'area' | 'person';
    /** The display section on Settings → Memory ("Trading", "Risk", …). The
     *  model names it on write; a new name creates a new section. Absent on
     *  legacy rows, where the page falls back to `subject`. */
    section?: string;
    /** The conversation this was written in. Provenance the trader can act on:
     *  "which session did it learn this in" has an answer, and a fact the model
     *  cannot place is a fact the trader cannot audit. */
    sourceSession?: string;
    /** The exact tool call / turn that produced the write. */
    sourceTurnId?: string;
    /** Soft delete: the row leaves every reader but stays restorable for 30
     *  days. `deletedBy` says whose hand removed it. */
    deletedAt?: string;
    deletedBy?: 'trader' | 'model';
    /** The row as it read BEFORE this edit — "now X, previously Y". One
     *  generation deep; the history is provenance, not a version store. */
    previous?: { body: string; description: string; updatedAt: string };
    /** Other lines whose content now lives inside this one — written by the
     *  consolidation merge, which absorbs its inputs and deletes them. This is
     *  a HISTORY, not a live dependency: the named slugs are already gone, and
     *  forgetting the survivor must not pretend it never carried them.
     *
     *  It is also what makes "delete anything derived solely from it" decidable
     *  — see `forgetProfileMemory`. A row whose ONLY source is the line being
     *  forgotten goes with it; a merge survivor does not, because it was derived
     *  from more than that one line. */
    derivedFrom?: string[];
}

const KEY_PREFIX = 'profile_memory_v1';
/** The store's SOFT thresholds. Neither refuses a write any more: the owner's
 *  ruling is that capacity must not limit the model, so a large store is a
 *  warning a person can act on, never a wall. Exported so the UI and the
 *  background consolidation pass read the same numbers. */
export const PROFILE_MEMORY_SOFT_ENTRY_COUNT = 200;
export const PROFILE_MEMORY_MAX_BODY_CHARS = 20_000;
const MAX_DESC_CHARS = 160;
const MAX_TITLE_CHARS = 60;

const storageKey = (user: string): string => `${KEY_PREFIX}_${user}`;

const KINDS: readonly string[] = ['user', 'feedback', 'project', 'reference'];

export const normalizeKind = (v: unknown): ProfileMemoryKind | null =>
    typeof v === 'string' && KINDS.includes(v) ? v as ProfileMemoryKind : null;

const SUBJECTS: readonly ProfileMemoryEntry['subject'][] =
    ['profile', 'preference', 'topic', 'area', 'person'];

export const normalizeSubject = (v: unknown): ProfileMemoryEntry['subject'] | null =>
    SUBJECTS.includes(v as ProfileMemoryEntry['subject']) ? v as ProfileMemoryEntry['subject'] : null;

/** Every record has a subject, including the ones written before the field
 *  existed — derived from the one thing they do carry. A reader that returned
 *  undefined would make half the store look like it was about nothing. */
export const subjectOf = (e: ProfileMemoryEntry): NonNullable<ProfileMemoryEntry['subject']> =>
    e.subject ?? (e.kind === 'user' ? 'profile'
        : e.kind === 'feedback' ? 'preference'
            : e.kind === 'project' ? 'area' : 'topic');

/** Kebab-case slug from a name (stable, collision-safe enough). */
export const slugify = (name: string): string =>
    (name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

const readAll = (user: string): ProfileMemoryEntry[] => {
    try {
        const raw = localStorage.getItem(storageKey(user));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((e): e is ProfileMemoryEntry => {
            const v = e as ProfileMemoryEntry;
            return !!v && typeof v === 'object'
                && typeof v.slug === 'string' && typeof v.description === 'string'
                && typeof v.body === 'string' && normalizeKind(v.kind) !== null;
        });
    } catch (err) {
        // A read that cannot happen must not look like an empty notebook: the
        // prompt would silently forget every fact the trader taught it.
        console.error('[profileMemory] read FAILED — memory is unavailable this turn:', err);
        return [];
    }
};

const writeAll = (user: string, entries: ProfileMemoryEntry[]): void => {
    try {
        // Written AS GIVEN. This used to end `entries.slice(-MAX_ENTRIES)`, so a
        // store at the cap silently dropped its oldest fact on the next write
        // while the tool answered `saved: true` — a fact the trader was told was
        // kept, gone with no receipt. The cap refuses growth in
        // `rememberProfileMemory` instead; a delete still shrinks normally.
        localStorage.setItem(storageKey(user), JSON.stringify(entries));
    } catch (err) {
        // The cache is not a store here: readAll() re-reads localStorage, so a
        // swallowed throw means the tool says "saved" and the next turn knows
        // nothing. Log it and let the caller report the failure.
        console.error('[profileMemory] write FAILED — the fact is NOT on disk:', err);
        throw err;
    }
    // Nudge any open Settings → Memory card to re-read.
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('august-profile-memory'));
};

/** How full the store is, as a WARNING (never a refusal). The UI and the
 *  background consolidation pass read this; the write path does not. */
export interface ProfileMemoryPressure {
    entries: number;
    bytes: number;
    /** 'ok' below the soft count, 'soft' at or above it. */
    level: 'ok' | 'soft';
    /** One plain-English line, or '' when there is nothing to say. */
    message: string;
}

export const profileMemoryPressure = (username?: string): ProfileMemoryPressure => {
    const user = username || getActiveUsername();
    let raw = '';
    try { raw = localStorage.getItem(storageKey(user)) ?? ''; } catch { /* unreadable counts as empty */ }
    const entries = listProfileMemories(user).length;
    const bytes = raw.length * 2;
    if (entries < PROFILE_MEMORY_SOFT_ENTRY_COUNT) return { entries, bytes, level: 'ok', message: '' };
    return {
        entries, bytes, level: 'soft',
        message: `Memory holds ${entries} entries — nothing is blocked, but consolidating or forgetting a few near-duplicates keeps the index readable.`,
    };
};

/** All entries for the active user, oldest first. */
export const listProfileMemories = (username?: string): ProfileMemoryEntry[] =>
    readAll(username || getActiveUsername()).filter(e => !e.deletedAt);

/** Soft-deleted rows, newest first — the undo list behind the 30-day window. */
export const listDeletedProfileMemories = (username?: string): ProfileMemoryEntry[] =>
    readAll(username || getActiveUsername())
        .filter(e => Boolean(e.deletedAt))
        .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));

export const getProfileMemory = (slug: string, username?: string): ProfileMemoryEntry | undefined =>
    listProfileMemories(username).find(e => e.slug === slug);

/**
 * Create or UPSERT by slug (update in place beats a near-duplicate, mirroring
 * this environment's "update the file rather than create a duplicate").
 * Returns the entry + whether it was new.
 */
export type RememberResult =
    /** `persisted:false` means the entry was built but storage refused it —
     *  the caller must NOT report success. */
    | { entry: ProfileMemoryEntry; created: boolean; conflict?: false; persisted?: boolean; error?: string }
    /** `if_version` did not match: nothing was written. `current` is the row
     *  that IS stored, so the caller can merge and retry in the same turn
     *  instead of overwriting a concurrent edit blind. */
    | { conflict: true; current: ProfileMemoryEntry };

export const rememberProfileMemory = (input: {
    slug?: string; name?: string; description: string; kind: ProfileMemoryKind; body: string;
    /** The row's display name (2–5 words). Omitted on an update keeps the
     *  existing title — an edit to the fact is not a rename. */
    title?: string;
    source?: ProfileMemoryEntry['source'];
    /** Provenance of the fact — only 'stated' is writable by the chat agent;
     *  'observed'/'inferred' come from separate system paths. */
    tag?: ProfileMemoryEntry['tag'];
    author?: ProfileMemoryEntry['author'];
    sourceTurnId?: string;
    /** Sensitive-category flag (the caller decides, from the user's setting,
     *  whether a detected sensitive write is refused or flagged). */
    sensitive?: boolean;
    /** Extra match strings for the deterministic pre-read. */
    aliases?: string[];
    /** What the fact is about; derived from `kind` when omitted. */
    subject?: ProfileMemoryEntry['subject'];
    /** The display section; omitted keeps an existing row's section and falls
     *  back to the subject for a new one. */
    section?: string;
    /** The conversation the write happened in, stamped by the caller that knows. */
    sourceSession?: string;
    /** Absorbed-line history, written by the consolidation merge. An ordinary
     *  write leaves this untouched (see the entry build): an edit to the
     *  survivor must not cost it the record of what it ate. */
    derivedFrom?: string[];
    /** Optimistic lock: when given and a row with this slug already exists,
     *  the write only lands if the row's version is exactly this. */
    ifVersion?: number;
}, username?: string): RememberResult => {
    const user = username || getActiveUsername();
    const slug = input.slug?.trim() ? slugify(input.slug) : slugify(input.name || input.description);
    const now = new Date().toISOString();
    const subjectField = normalizeSubject(input.subject);
    const sectionField = normalizeMemorySection(input.section);
    const all = readAll(user);
    const idx = all.findIndex(e => e.slug === (slug || ''));
    if (idx >= 0 && typeof input.ifVersion === 'number' && (all[idx].version ?? 1) !== input.ifVersion) {
        return { conflict: true, current: all[idx] };
    }
    const prior = idx >= 0 ? all[idx] : undefined;
    // The same gate as the remember tool, enforced at the STORE so a human
    // edit cannot bypass it: a secret is refused, a sensitive fact is flagged,
    // and sensitive storage is refused when the setting is off (the 2026-10-27 audit
    // M-2's privacy half — the edit path used to store either unflagged).
    const verdict = filterMemoryWrite(`${input.description}
${input.body}`);
    const sensitive = input.sensitive === true || verdict.sensitive;
    const titleField = (input.title ?? '').trim().replace(/\s+/g, ' ');
    const entry: ProfileMemoryEntry = {
        slug: slug || `memory-${Date.now().toString(36)}`,
        ...(titleField ? { title: titleField.slice(0, MAX_TITLE_CHARS) } : {}),
        description: input.description.trim().slice(0, MAX_DESC_CHARS),
        kind: input.kind,
        body: input.body.trim().slice(0, PROFILE_MEMORY_MAX_BODY_CHARS),
        ...(input.source ? { source: input.source } : {}),
        ...(input.tag ? { tag: input.tag } : {}),
        ...(input.author ? { author: input.author } : {}),
        ...(input.sourceTurnId?.trim() ? { sourceTurnId: input.sourceTurnId.trim().slice(0, 120) } : {}),
        // Re-saving a soft-deleted slug revives it; the merge below overrides
        // the old tombstone with these two cleared fields.
        deletedAt: undefined,
        deletedBy: undefined,
        ...(sensitive ? { sensitive: true } : {}),
        ...(input.aliases ? { aliases: input.aliases.map(a => a.trim()).filter(Boolean).slice(0, 8) } : {}),
        ...(subjectField ? { subject: subjectField } : {}),
        ...(sectionField ? { section: sectionField } : {}),
        ...(input.sourceSession?.trim() ? { sourceSession: input.sourceSession.trim().slice(0, 80) } : {}),
        // Absorbed history is the merge's, not the caller's: an explicit list
        // wins, and an ordinary edit keeps what the row already carried. Without
        // the fallback, the next `remember` on a survivor would silently erase
        // the provenance that `forgetProfileMemory`'s cascade rule reads.
        ...(input.derivedFrom?.length
            ? { derivedFrom: [...new Set(input.derivedFrom.map(s => s.trim()).filter(Boolean))].slice(0, 12) }
            : prior?.derivedFrom?.length ? { derivedFrom: prior.derivedFrom } : {}),
        createdAt: now,
        updatedAt: now,
        version: idx >= 0 ? (prior!.version ?? 1) + 1 : 1,
        // "now X, previously Y": one generation of provenance, stamped only
        // when the body actually changed — re-saving identical text is not
        // history, it is churn.
        ...(idx >= 0 && prior!.body !== input.body.trim()
            ? { previous: { body: prior!.body, description: prior!.description, updatedAt: prior!.updatedAt } }
            : {}),
    };
    const created = idx < 0;
    if (verdict.refused) return { entry, created, persisted: false, error: verdict.refused };
    if (sensitive && getHarnessSettings().sensitiveMemoryEnabled !== true) {
        return {
            entry, created, persisted: false,
            error: 'this fact is in a sensitive category and sensitive memory is off — nothing was written',
        };
    }
    // NO ENTRY CAP. A hard ceiling used to refuse the write once the store held
    // 40 facts; capacity must never be the reason the seat cannot remember
    // something the trader told it. A large store is reported as pressure (see
    // `profileMemoryPressure`) so a person can merge or forget, not blocked.
    if (created) {
        all.push(entry);
    } else {
        all[idx] = { ...all[idx], ...entry, createdAt: all[idx].createdAt };
    }
    try {
        writeAll(user, all);
        return { entry, created, persisted: true };
    } catch (err) {
        return { entry, created, persisted: false, error: err instanceof Error ? err.message : String(err) };
    }
};

export interface ForgetResult {
    /** False when no line had that slug — the caller said nothing was forgotten. */
    gone: boolean;
    /** Every slug this call removed, the named one first. Longer than one when
     *  a line was the ONLY source of another line. */
    removed: string[];
    /** The named line's own absorbed history, when it had one — the slugs whose
     *  content this row was carrying. Nothing else is deleted for them; they
     *  were already merged away, and a forget that could not say so would be
     *  silently erasing more of the trader's record than it names. */
    carried: string[];
    /** The 30-day undo deadline, when the delete succeeded. */
    undoUntil?: string;
}

/**
 * Forget a line — and, per the record's own provenance, anything derived
 * SOLELY from it.
 *
 * The rule is transitive and it is narrow: a row goes with the named slug only
 * when its `derivedFrom` list resolves entirely to slugs that are already
 * doomed by this same delete. A merge survivor keeps its facts (it was built
 * from more than one line, so "solely" does not apply) and nothing else is
 * touched. Written as a loop rather than a single check because A derived from
 * B derived from C must all fall, and a one-level check would strand C's copy.
 *
 * Every caller now reads `.gone` rather than the bare return: a truthy
 * `ForgetResult` would otherwise report success on a forget that deleted
 * nothing.
 */
export const forgetProfileMemory = (
    slug: string,
    username?: string,
    by: 'trader' | 'model' = 'trader',
): ForgetResult => {
    const user = username || getActiveUsername();
    const all = readAll(user);
    const target = all.find(e => e.slug === slug && !e.deletedAt);
    if (!target) return { gone: false, removed: [], carried: [] };
    const doomed = new Set<string>([slug]);
    for (let grew = true; grew;) {
        grew = false;
        for (const e of all) {
            if (e.deletedAt || doomed.has(e.slug)) continue;
            const src = e.derivedFrom ?? [];
            if (src.length > 0 && src.every(s => doomed.has(s))) { doomed.add(e.slug); grew = true; }
        }
    }
    const deletedAt = new Date().toISOString();
    const next = all.map(e => doomed.has(e.slug) && !e.deletedAt
        ? { ...e, deletedAt, deletedBy: by, updatedAt: deletedAt, version: (e.version ?? 1) + 1 }
        : e);
    try {
        writeAll(user, next);
    } catch {
        return { gone: false, removed: [], carried: [] };
    }
    return {
        gone: true,
        removed: [slug, ...all.filter(e => doomed.has(e.slug) && e.slug !== slug && !e.deletedAt).map(e => e.slug)],
        carried: target.derivedFrom ?? [],
        undoUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    };
};

/** Undo a soft delete. False when the slug is not currently deleted. */
export const restoreProfileMemory = (slug: string, username?: string): boolean => {
    const user = username || getActiveUsername();
    const all = readAll(user);
    const idx = all.findIndex(e => e.slug === slug && Boolean(e.deletedAt));
    if (idx < 0) return false;
    const restored = { ...all[idx] };
    delete restored.deletedAt;
    delete restored.deletedBy;
    all[idx] = restored;
    try {
        writeAll(user, all);
        return true;
    } catch {
        return false;
    }
};

/** The undo window is a hard 30 days; a cleanup pass may call this. */
export const purgeDeletedProfileMemories = (username?: string, days = 30): number => {
    const user = username || getActiveUsername();
    const all = readAll(user);
    const cutoff = Date.now() - Math.max(1, days) * 86_400_000;
    const next = all.filter(e => !e.deletedAt || Date.parse(e.deletedAt) >= cutoff);
    const removed = all.length - next.length;
    if (removed > 0) {
        try { writeAll(user, next); } catch { return 0; }
    }
    return removed;
};

/**
 * Delete one line by slug, with NO derivation cascade.
 *
 * This is what the consolidation pass retires: an input it has just absorbed
 * into the survivor. It must not cascade, because the survivor's `derivedFrom`
 * names exactly these slugs — running the trader-facing `forgetProfileMemory`
 * here would delete the merged row moments after writing it, on a two-candidate
 * merge whose whole provenance list is the one loser being retired. Same store,
 * same write path, different operation: the trader forgetting a fact is not the
 * consolidator consuming one.
 */
export const retireMergedMemory = (slug: string, username?: string): boolean => {
    const user = username || getActiveUsername();
    const all = readAll(user);
    const next = all.filter(e => e.slug !== slug);
    if (next.length === all.length) return false;
    try {
        writeAll(user, next);
        return true;
    } catch {
        return false;
    }
};

// ─── Search, update, similarity (the memory_* tools) ────────────────────────

export interface ProfileMemorySearchHit {
    entry: ProfileMemoryEntry;
    /** Relevance, higher is better. Deterministic — no model, no embeddings. */
    score: number;
    /** Which fields matched, so the tool can say WHY a row came back. */
    matchedIn: Array<'slug' | 'title' | 'description' | 'alias' | 'body'>;
}

export interface ProfileMemorySearchOptions {
    /** Free-text query. Empty returns everything (the full index read). */
    query?: string;
    /** Restrict to a display section ("Trading", "Risk", …). Case-insensitive. */
    section?: string;
    /** Restrict to one of the four provenance kinds. */
    kind?: ProfileMemoryKind;
    limit?: number;
    /** Include rows a reader would normally keep out of a bulk pull — sensitive
     *  rows and observed/inferred context. Off by default, exactly like
     *  `read_memory`'s bulk read. */
    includeRestricted?: boolean;
}

const SEARCH_DEFAULT_LIMIT = 12;

/**
 * Ranked search over slug, title, description, aliases and body.
 *
 * The index alone could not answer "what do you know about my risk rules?"
 * unless the caller already knew a slug, so every recall question cost a full
 * `read_memory(["all"])` dump. Weights put identity first (an exact slug is
 * almost certainly the row the caller meant), then the words chosen to be
 * findable (title, aliases, description), then the body. Recency breaks ties,
 * because two rows matching equally usually means the newer one is the intent.
 */
export const searchProfileMemories = (
    options: ProfileMemorySearchOptions = {},
    username?: string,
): ProfileMemorySearchHit[] => {
    const query = (options.query ?? '').trim();
    const wanted = contentWords(query);
    const section = normalizeMemorySection(options.section);
    const limit = Math.max(1, Math.min(200, options.limit ?? SEARCH_DEFAULT_LIMIT));
    const pool = listProfileMemories(username).filter(e => {
        if (!options.includeRestricted && (e.sensitive || e.tag === 'observed' || e.tag === 'inferred')) return false;
        if (options.kind && e.kind !== options.kind) return false;
        if (section && memorySectionOf(e).toLowerCase() !== section.toLowerCase()) return false;
        return true;
    });
    const newest = Date.now();
    const scored: ProfileMemorySearchHit[] = [];
    for (const entry of pool) {
        const matchedIn: ProfileMemorySearchHit['matchedIn'] = [];
        let score = 0;
        if (wanted.size === 0) {
            score = 1;
        } else {
            if (wanted.has(slugify(entry.slug)) || entry.slug === slugify(query)) { score += 1000; matchedIn.push('slug'); }
            const slugHits = countShared(wanted, contentWords(entry.slug.replace(/-/g, ' ')));
            if (slugHits) { score += slugHits * 40; if (!matchedIn.includes('slug')) matchedIn.push('slug'); }
            const aliasHits = (entry.aliases ?? []).reduce(
                (sum, a) => sum + (a.trim() && wanted.has(a.trim().toLowerCase()) ? 3 : countShared(wanted, contentWords(a))),
                0,
            );
            if (aliasHits) { score += aliasHits * 25; matchedIn.push('alias'); }
            const titleHits = countShared(wanted, contentWords(entry.title ?? ''));
            if (titleHits) { score += titleHits * 20; matchedIn.push('title'); }
            const descHits = countShared(wanted, contentWords(entry.description));
            if (descHits) { score += descHits * 12; matchedIn.push('description'); }
            const bodyHits = Math.min(10, countShared(wanted, contentWords(entry.body)));
            if (bodyHits) { score += bodyHits * 3; matchedIn.push('body'); }
        }
        if (wanted.size > 0 && score === 0) continue;
        // Recency: at most 5 points, so it can only order rows that already matched.
        const ageDays = Math.max(0, (newest - Date.parse(entry.updatedAt || entry.createdAt || '')) / 86_400_000);
        score += Math.max(0, 5 - ageDays / 30);
        scored.push({ entry, score: Math.round(score * 100) / 100, matchedIn });
    }
    return scored.sort((a, b) => b.score - a.score || String(b.entry.updatedAt).localeCompare(String(a.entry.updatedAt))).slice(0, limit);
};

const countShared = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const word of a) if (b.has(word)) shared += 1;
    return shared;
};

/** The thresholds the create-path similarity refusal is built on. Exported so a
 *  contract pins the same numbers the write path enforces. */
export const MEMORY_DUPLICATE_SCORE_MIN = 0.62;

export interface MemoryDuplicateMatch {
    slug: string;
    title?: string;
    description: string;
    score: number;
    reason: string;
}

/**
 * Is this candidate already said by an existing row? Containment in either
 * direction (`overlap`), weighted like the skill redundancy scan: the
 * description decides relevance, the body carries the fact, the title is a
 * label. A row that already CONTAINS the candidate is the one to update — the
 * refusal names it so the model merges instead of minting a twin.
 */
export const findSimilarMemory = (
    candidate: { title?: string; description: string; body: string },
    username?: string,
    excludeSlug?: string,
): MemoryDuplicateMatch | null => {
    const desc = contentWords(candidate.description);
    const title = contentWords(candidate.title ?? '');
    const body = contentWords(candidate.body);
    let best: MemoryDuplicateMatch | null = null;
    for (const entry of listProfileMemories(username)) {
        if (excludeSlug && entry.slug === excludeSlug) continue;
        const descScore = overlap(desc, contentWords(entry.description));
        const bodyScore = overlap(body, contentWords(entry.body));
        const titleScore = jaccard(title, contentWords(entry.title ?? entry.slug.replace(/-/g, ' ')));
        const score = descScore * 0.5 + bodyScore * 0.35 + titleScore * 0.15;
        if (score < MEMORY_DUPLICATE_SCORE_MIN) continue;
        const reason = descScore >= 0.6
            ? 'the description names the same fact'
            : bodyScore >= 0.6
                ? 'the body already carries this'
                : 'the title and description overlap';
        if (!best || score > best.score) {
            best = { slug: entry.slug, ...(entry.title ? { title: entry.title } : {}), description: entry.description, score: Math.round(score * 100) / 100, reason };
        }
    }
    return best;
};

export type MemoryUpdateMode = 'replace' | 'append' | 'patch';

export type MemoryUpdateResult =
    | { ok: true; entry: ProfileMemoryEntry; mode: MemoryUpdateMode; previous?: ProfileMemoryEntry['previous'] }
    | { ok: false; reason: string; current?: ProfileMemoryEntry };

/**
 * Edit an existing row. Three modes, one write path:
 *
 *  · replace — the whole body becomes `body`.
 *  · append  — `body` is added as a new paragraph; the old text is kept.
 *  · patch   — `oldStr` must occur EXACTLY ONCE in the body and is replaced by
 *              `newStr`. Zero or several occurrences refuse: a blind replace
 *              would silently rewrite a fact the caller never named.
 *
 * Version-checked when `ifVersion` is supplied, and the version it read comes
 * back on conflict so the caller can merge and retry in the same turn. It never
 * overwrites blindly.
 */
export const updateProfileMemory = (
    input: {
        slug: string;
        mode: MemoryUpdateMode;
        body?: string;
        oldStr?: string;
        newStr?: string;
        title?: string;
        description?: string;
        aliases?: string[];
        section?: string;
        ifVersion?: number;
    },
    username?: string,
): MemoryUpdateResult => {
    const user = username || getActiveUsername();
    const all = readAll(user);
    const idx = all.findIndex(e => e.slug === input.slug.trim() && !e.deletedAt);
    if (idx < 0) return { ok: false, reason: `no memory with slug "${input.slug}"` };
    const prior = all[idx];
    if (typeof input.ifVersion === 'number' && (prior.version ?? 1) !== input.ifVersion) {
        return { ok: false, reason: 'version conflict — nothing was written', current: prior };
    }
    let nextBody: string;
    if (input.mode === 'replace') {
        if (typeof input.body !== 'string') return { ok: false, reason: 'replace needs `body`', current: prior };
        nextBody = input.body.trim();
    } else if (input.mode === 'append') {
        if (typeof input.body !== 'string' || !input.body.trim()) return { ok: false, reason: 'append needs `body`', current: prior };
        nextBody = `${prior.body.trimEnd()}\n\n${input.body.trim()}`;
    } else {
        const oldStr = input.oldStr ?? '';
        const newStr = input.newStr ?? '';
        if (!oldStr) return { ok: false, reason: 'patch needs `old_str`', current: prior };
        const occurrences = prior.body.split(oldStr).length - 1;
        if (occurrences === 0) return { ok: false, reason: 'patch: `old_str` does not occur in the body — read it and copy the text exactly', current: prior };
        if (occurrences > 1) return { ok: false, reason: `patch: \`old_str\` occurs ${occurrences} times — include more surrounding text so exactly one match is replaced`, current: prior };
        nextBody = prior.body.replace(oldStr, newStr);
    }
    if (!nextBody.trim()) return { ok: false, reason: 'the edit would leave an empty body', current: prior };
    if (nextBody.length > PROFILE_MEMORY_MAX_BODY_CHARS) {
        return { ok: false, reason: `the edited body is ${nextBody.length} chars, over the ${PROFILE_MEMORY_MAX_BODY_CHARS} limit — split it or trim it`, current: prior };
    }
    const now = new Date().toISOString();
    const titleField = (input.title ?? '').trim().replace(/\s+/g, ' ');
    const sectionField = normalizeMemorySection(input.section);
    const entry: ProfileMemoryEntry = {
        ...prior,
        body: nextBody,
        updatedAt: now,
        version: (prior.version ?? 1) + 1,
        ...(titleField ? { title: titleField.slice(0, MAX_TITLE_CHARS) } : {}),
        ...(input.description?.trim() ? { description: input.description.trim().slice(0, MAX_DESC_CHARS) } : {}),
        ...(input.aliases ? { aliases: input.aliases.map(a => a.trim()).filter(Boolean).slice(0, 8) } : {}),
        ...(sectionField ? { section: sectionField } : {}),
        ...(prior.body !== nextBody
            ? { previous: { body: prior.body, description: prior.description, updatedAt: prior.updatedAt } }
            : {}),
    };
    all[idx] = entry;
    try {
        writeAll(user, all);
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err), current: prior };
    }
    return { ok: true, entry, mode: input.mode, ...(entry.previous ? { previous: entry.previous } : {}) };
};

/** A one-line index entry is shortened only when a caller explicitly passes a
 *  small cap; with the cap lifted, the description rides whole. */
const INDEX_LINE_MAX = 150;
/** Two aliases, twenty characters each: enough to carry the trader's own word
 *  for a fact, not enough to turn the index into a keyword dump. */
const INDEX_ALIAS_MAX = 2;
const INDEX_ALIAS_CHARS = 20;

/**
 * The always-loaded memory index for prompts — one line per entry:
 * `- [kind] slug ~aliases — description`. Empty string when nothing is stored,
 * so it composes cleanly into any prompt. The aliases ride the line because
 * they are the words the trader actually uses: a slug is the store's naming,
 * and a seat that cannot see "bun" on the row has to guess whether
 * `user-pkg-mgr` matters before it spends a read. Bodies still come through
 * read_memory; the line stays inside INDEX_LINE_MAX by shortening the
 * description, not the aliases, so the added words never grow the block.
 */
export const buildProfileMemoryIndex = (username?: string, maxLines = UNBOUNDED_INDEX_LINES): string => {
    // A sensitive fact never rides the always-on index: this block is injected
    // into every turn, including turns that have nothing to do with health,
    // money or identity. It stays readable by explicit slug when the trader
    // asks; it is not advertised to every future prompt.
    // Observed/inferred rows are CONTEXT, not instructions: they never ride the
    // always-on index. A reader that wants them asks by slug (memory_read), and
    // the row itself carries its tag.
    const visible = listProfileMemories(username)
        .filter(e => !e.sensitive && e.tag !== 'observed' && e.tag !== 'inferred');
    if (visible.length === 0) return '';
    const capped = Number.isFinite(maxLines) && maxLines > 0 ? maxLines : UNBOUNDED_INDEX_LINES;
    const newest = capped === UNBOUNDED_INDEX_LINES ? visible : visible.slice(-capped);
    // GROUPED BY SECTION, not one flat list. The section is the tool-facing
    // category (memory_read filters on it, memory_add writes it), so the index
    // has to show the same grouping the tools use or the model has to invent a
    // name and hope it matches.
    const sections = orderMemorySections(visible.map(memorySectionOf));
    const sectionLine = sections.length
        ? `SECTIONS (display groups; reuse one, or pass a concise new name like "Trading" or "Risk"): ${sections.slice(0, 6).map(s => s.slice(0, 20)).join(' · ')}`
        : '';
    const lineFor = (e: ProfileMemoryEntry): string => {
        const tagMark = e.tag === 'observed' ? ' ·observed' : e.tag === 'inferred' ? ' ·inferred' : '';
        const aliasSource = (e.aliases ?? []).map(a => a.trim()).filter(Boolean);
        const aliasMark = aliasSource.length
            ? ` ~${aliasSource.slice(0, INDEX_ALIAS_MAX).map(a => a.slice(0, INDEX_ALIAS_CHARS)).join(', ')}`
            : '';
        const descMax = capped === UNBOUNDED_INDEX_LINES ? Number.MAX_SAFE_INTEGER : Math.max(40, INDEX_LINE_MAX - aliasMark.length);
        const desc = e.description.length > descMax ? `${e.description.slice(0, descMax - 1)}…` : e.description;
        return `- [${e.kind}] ${e.slug}${tagMark}${aliasMark} — ${desc}`;
    };
    const bySection = new Map<string, ProfileMemoryEntry[]>();
    for (const entry of newest) {
        const label = memorySectionOf(entry);
        bySection.set(label, [...(bySection.get(label) ?? []), entry]);
    }
    const lines: string[] = [];
    for (const label of orderMemorySections([...bySection.keys()])) {
        const rows = bySection.get(label) ?? [];
        if (rows.length === 0) continue;
        lines.push(`### ${label}`);
        for (const row of rows) lines.push(lineFor(row));
    }
    const dropped = visible.length - newest.length;
    return [
        `## Your memory about this user — ${visible.length} entr${visible.length === 1 ? 'y' : 'ies'}. These are collaboration facts (who they are, how they want you to work, their trading habits and ongoing context); market lessons belong in the notebook. When one matters, pull its full body with memory_read. When you do not know a slug or a category, call memory_read with a query or a section — it searches slug, title, description, aliases and body. If this session teaches you something durable about the USER, save it with memory_add (it refuses a near-duplicate and names the row to edit instead), and EDIT an existing row with memory_update, which needs the version memory_read shows you.`,
        sectionLine,
        ...lines,
        dropped > 0 ? `…${dropped} older entr${dropped === 1 ? 'y' : 'ies'} not listed — read_memory with slug "all" shows every entry.` : '',
    ].filter(Boolean).join('\n');
};

/** Test hook: wipe the store. */
export const __clearProfileMemoriesForTests = (username?: string): void => {
    try { localStorage.removeItem(storageKey(username || getActiveUsername())); } catch { /* noop */ }
};
