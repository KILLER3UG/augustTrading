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
/** The store's hard limits. Exported so the consolidation pass and the UI use
 *  the same numbers the write path enforces. */
export const PROFILE_MEMORY_MAX_ENTRIES = 40;
export const PROFILE_MEMORY_MAX_BODY_CHARS = 2_000;
const MAX_ENTRIES = PROFILE_MEMORY_MAX_ENTRIES;
const MAX_BODY_CHARS = PROFILE_MEMORY_MAX_BODY_CHARS;
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
        body: input.body.trim().slice(0, MAX_BODY_CHARS),
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
    if (created && all.filter(e => !e.deletedAt).length >= MAX_ENTRIES) {
        // The ceiling refuses instead of evicting. `rememberWithConsolidation`
        // frees room first (merge the two oldest non-sensitive rows) and is the
        // path the `remember` tool takes; a caller that skips it gets this
        // refusal rather than a silent drop of the trader's oldest fact.
        return {
            entry, created: true, persisted: false,
            error: `the memory is full (${all.length} facts, cap ${MAX_ENTRIES}) and nothing was written — forget a fact, or let consolidation merge two`,
        };
    }
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

/** How many index lines a prompt gets (capped; older entries fall off — the
 *  newest remember more, like this environment trimming its index). */
const INDEX_MAX_LINES = 30;
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
export const buildProfileMemoryIndex = (username?: string, maxLines = INDEX_MAX_LINES): string => {
    // A sensitive fact never rides the always-on index: this block is injected
    // into every turn, including turns that have nothing to do with health,
    // money or identity. It stays readable by explicit slug when the trader
    // asks; it is not advertised to every future prompt.
    // Observed/inferred rows are CONTEXT, not instructions: they never ride the
    // always-on index. A reader that wants them asks by slug (read_memory), and
    // the row itself carries its tag.
    const visible = listProfileMemories(username)
        .filter(e => !e.sensitive && e.tag !== 'observed' && e.tag !== 'inferred');
    if (visible.length === 0) return '';
    const newest = visible.slice(-maxLines);
    const sections = orderMemorySections(visible.map(memorySectionOf));
    const sectionLine = sections.length
        ? `SECTIONS (display groups; reuse one, or pass a concise new name like "Trading" or "Risk"): ${sections.slice(0, 6).map(s => s.slice(0, 20)).join(' · ')}`
        : '';
    const lines = newest.map(e => {
        const tagMark = e.tag === 'observed' ? ' ·observed' : e.tag === 'inferred' ? ' ·inferred' : '';
        const aliasSource = (e.aliases ?? []).map(a => a.trim()).filter(Boolean);
        const aliasMark = aliasSource.length
            ? ` ~${aliasSource.slice(0, INDEX_ALIAS_MAX).map(a => a.slice(0, INDEX_ALIAS_CHARS)).join(', ')}`
            : '';
        const descMax = Math.max(40, INDEX_LINE_MAX - aliasMark.length);
        const desc = e.description.length > descMax ? `${e.description.slice(0, descMax - 1)}…` : e.description;
        return `- [${e.kind}] ${e.slug}${tagMark}${aliasMark} — ${desc}`;
    });
    const dropped = visible.length - newest.length;
    return [
        `## Your memory about this user — ${visible.length} entr${visible.length === 1 ? 'y' : 'ies'}. These are collaboration facts (who they are, how they want you to work, their trading habits and ongoing context); market lessons belong in the notebook. When one matters, pull its full body with read_memory(slug). If this session teaches you something durable about the USER, save it with remember (update an existing slug rather than duplicating), and pass the section it belongs in.`,
        sectionLine,
        ...lines,
        dropped > 0 ? `…${dropped} older entr${dropped === 1 ? 'y' : 'ies'} not listed — read_memory with slug "all" shows every entry.` : '',
    ].filter(Boolean).join('\n');
};

/** Test hook: wipe the store. */
export const __clearProfileMemoriesForTests = (username?: string): void => {
    try { localStorage.removeItem(storageKey(username || getActiveUsername())); } catch { /* noop */ }
};
