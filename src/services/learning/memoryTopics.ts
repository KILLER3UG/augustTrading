/**
 * memoryTopics — the topic index over the trader notebook (gap 2 of
 * docs/plan/open-items.md).
 *
 * The reference reads memory as CONTENT: named topics, each with a one-line
 * summary and an "Updated" stamp, into a detail view. August stores memory as
 * FILES in folders, so its memory surface made the user browse storage and
 * read raw markdown to find out what the app believed. This module derives
 * the topic view from the notebook that already exists — no second store, no
 * mirror to drift: every row IS a notebook file, read live on each mount.
 *
 * What counts as a topic:
 *   - a file the TRADER owns (`autoManaged` is the harness's own diary,
 *     profile and rules — those have their own surfaces and regenerate, so
 *     listing them here would promise a Delete that does not stick);
 *   - not a skill (the `skills` folder is the Skills tab's library — one
 *     record, one surface);
 *   - with content (an empty template is not a belief).
 *
 * Summary rule: the first line of prose, headings skipped. One derivation in
 * one module so the index row and the detail panel can never describe the
 * same file two different ways.
 *
 * THE VOCABULARY LIVES HERE, and it used to live in a component. The list's
 * date column (`memoryUpdatedLabel`) was exported from
 * `components/learn/MemoryTopicsCard.tsx`, and the Settings profile card
 * imported it FROM THAT COMPONENT — a component reaching into another
 * component for a word. It is a vocabulary, so it belongs beside the
 * derivation it belongs to.
 */

import type { MemoryFile } from '../../types';
import { phtDay, phtDayKey } from '../../utils/timezone';

export interface MemoryTopic {
    /** The notebook file — identity, not a copy: every action targets it. */
    file: MemoryFile;
    /** One line of prose: what this entry says, not what it is called. */
    summary: string;
    /** The folder name this entry lives in, for grouping. */
    folderName: string;
}

/** First line of actual prose, with markdown furniture skipped. An entry
 *  whose content is all headings has no summary, and says so honestly. */
export const topicSummaryOf = (content: string): string =>
    topicParts(content).summary;

/** The entry split at its first line of prose: the summary IS that line — the
 *  WHOLE line, because a truncated summary would drop its tail from the
 *  details block and no view of the entry would ever show it — and the details
 *  are everything after it, so the detail view can print Summary and Details
 *  without printing the same sentence twice. Truncation for a list row is a
 *  DISPLAY decision and belongs to the row (`clampLine`), not to the
 *  derivation. */
export const topicParts = (content: string): { summary: string; details: string } => {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i].trim();
        if (!raw) continue;
        if (raw.startsWith('#') || raw.startsWith('>') || raw.startsWith('---')) continue;
        const text = raw
            .replace(/^[-*+]\s+/, '')                  // list bullets
            .replace(/^\*\*(.+?)\*\*:?/, '$1')         // bold lead-ins
            .replace(/[*_`]/g, '')                     // inline marks
            .trim();
        if (!text) continue;
        return {
            summary: text,
            details: lines.slice(i + 1).join('\n').trim(),
        };
    }
    return { summary: 'No summary yet — this entry has only headings.', details: lines.join('\n').trim() };
};

/** The list row's one-liner: the summary clamped for DISPLAY, with the
 *  ellipsis saying the entry holds more (its detail view shows all of it). */
export const clampLine = (text: string, max = 140): string =>
    text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Title Case for a name that arrived as a slug.
 *
 * The reference's memory list names its entries the way a person would
 * ("Recent Work", "Model Landscape", "Logic Circuit Design"), and so do its
 * section headings. We keep the case of the words we are given and only
 * capitalise the first letter — an acronym in the file name stays as the
 * trader wrote it, because guessing "VLM" out of "vlm" would be inventing a
 * fact the notebook never wrote.
 */
const titleWords = (raw: string): string => {
    const words = raw.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!words) return '';
    return words
        .split(' ')
        .map(w => (w.length ? w.charAt(0).toUpperCase() + w.slice(1) : w))
        .join(' ');
};

/**
 * The DISPLAY name of a notebook entry.
 *
 * The file is `recurring-mistakes.md`; the entry is "Recurring Mistakes". The
 * slug stays the IDENTITY — the tooltip, and everything that writes to the
 * notebook — and this is the LABEL, the one a reader sees. A list of file
 * names is a directory listing, not a catalogue; the same argument the
 * skills catalogue settled (E-55, "a skill is NAMED, not listed as a file")
 * applies to the entries the catalogue is a catalogue OF.
 */
export const memoryEntryLabel = (name: string): string => {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return 'Untitled';
    const withoutExt = trimmed.replace(/\.(md|markdown)$/i, '');
    return titleWords(withoutExt) || 'Untitled';
};

/** What a stored memory row is CALLED: the short title the writer saved, else
 *  the humanized slug. A slug is an identity chosen for stability, not a name —
 *  once a fact is described in a whole sentence the slug outgrows the column —
 *  so a titled row shows the title and a legacy row keeps the derivation. */
export const memoryEntryTitle = (entry: { slug: string; title?: string }): string => {
    const title = (entry.title ?? '').trim();
    return title || memoryEntryLabel(entry.slug);
};

/**
 * The DISPLAY name of a notebook SECTION — the folder the entries live in.
 *
 * `market-conditions` is a folder id; "Market Conditions" is what a reader
 * sees above its rows. The grouping itself is the real one (the notebook's own
 * folders), so only the wording is translated.
 */
export const memorySectionLabel = (folderName: string): string => {
    const trimmed = (folderName ?? '').trim();
    if (!trimmed) return 'Notebook';
    return titleWords(trimmed) || 'Notebook';
};

const isSkillFile = (file: MemoryFile, folderNamesById: Map<string, string>): boolean =>
    folderNamesById.get(file.folderId) === 'skills';

/**
 * The index. Pure: takes a notebook store's shape, returns rows newest-first.
 * Kept a parameter (not a direct store read) so the derivation is testable
 * without the notebook, and so both the card and the panel derive from the
 * same function on the same input.
 */
export const memoryTopicsFromStore = (
    files: MemoryFile[],
    folders: Array<{ id: string; name: string }>,
): MemoryTopic[] => {
    const folderNamesById = new Map(folders.map(f => [f.id, f.name]));
    return files
        // `enabled` too: a note the trader switched off was still listed to the
        // model, which reads as "this is in force" (the 2026-10-27 audit M-3).
        .filter(file => file.enabled !== false && !file.autoManaged && !isSkillFile(file, folderNamesById))
        .filter(file => file.content.trim().length > 0)
        .map(file => ({
            file,
            // The ROW's summary is clamped for display; the panel reads the
            // same entry through `topicParts` and shows the whole line.
            summary: clampLine(topicSummaryOf(file.content)),
            folderName: folderNamesById.get(file.folderId) ?? 'notebook',
        }))
        .sort((a, b) => (memoryTimestamp(b.file.updatedAt) ?? 0) - (memoryTimestamp(a.file.updatedAt) ?? 0));
};

/**
 * The file's own timestamp, in either of the shapes a notebook holds it.
 *
 * `MemoryFile.updatedAt` is typed as epoch milliseconds, and that is what the
 * app writes. But the SAME field arrives as an ISO string from a seeded or
 * restored notebook — the app's own render-probe fixture writes one — and the
 * two readers disagreed: the detail's calendar date printed it (the formatter
 * took a string) while the list's column said "unknown" and the elapsed
 * parenthetical said "NaNd ago". Both are wrong about a date the file HAS.
 *
 * So the field is read ONCE, here, and both surfaces read the answer. A file
 * with no date still gets no date: this never substitutes one.
 */
export const memoryTimestamp = (at: number | string | undefined | null): number | null => {
    if (at === undefined || at === null || at === '') return null;
    if (typeof at === 'number') return Number.isFinite(at) ? at : null;
    const parsed = Date.parse(at);
    return Number.isFinite(parsed) ? parsed : null;
};

/** The elapsed word alone, for list rows: `now`, `45m ago`, `6h ago`, `8d
 *  ago`. The ONE duration formatter for this surface — the card's stamp and
 *  the detail's parenthetical must never disagree about how stale an entry
 *  is. */
export const relativeElapsed = (at: number | undefined | null, now = Date.now()): string => {
    if (!at) return '';
    const mins = Math.round((now - at) / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m ago`;
    const h = Math.round(mins / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
};

/** The "Last updated" line the detail view leads with. Absolute date plus the
 *  elapsed word, because "Updated 3d" answers "how stale" and the date
 *  answers "when exactly" — the two questions are not the same one. */
export const topicUpdatedLine = (file: MemoryFile, now = Date.now()): string => {
    const at = memoryTimestamp(file.updatedAt);
    if (at === null) return 'Last updated unknown';
    const date = new Date(at).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
    });
    return `Last updated ${date} (${relativeElapsed(at, now)})`;
};

/** The list's date column — ONE formatter for every memory surface.
 *
 * The reference writes the column two ways: "Updated Aug 21" for an entry
 * that has settled, and "Updated 4 days ago" for one that is still moving.
 * This keeps that rule and uses the repo's own clock (PHT day keys, so a
 * trading evening does not split across two days) and the repo's own date
 * formatter (`phtDay`).
 *
 * It lives HERE, beside the derivation it belongs to, because a vocabulary
 * that lives in a component is a component other components have to import —
 * which is how the Settings profile card ended up importing a word from the
 * memory LIST.
 */
const dayIndex = (ms: number): number =>
    Math.floor(Date.parse(`${phtDayKey(ms)}T00:00:00Z`) / 86_400_000);

export const memoryUpdatedLabel = (at: number | string | undefined | null, now = Date.now()): string => {
    // No timestamp means no timestamp. The column says so rather than
    // printing a date the notebook never had.
    const ms = memoryTimestamp(at);
    if (ms === null || ms === 0) return 'Updated unknown';
    const days = dayIndex(now) - dayIndex(ms);
    if (days <= 0) return 'Updated today';
    if (days < 7) return `Updated ${days} day${days === 1 ? '' : 's'} ago`;
    return `Updated ${phtDay(ms)}`;
};

/**
 * Listing-first recall for the NOTEBOOK (the topics are its subjects): a
 * compact always-injected index — slug (the file stem), one ≤150-char
 * summary, the folder — with bodies read on demand via the notebook tools.
 * Profile memory already has its own always-loaded index
 * (profileMemory.buildProfileMemoryIndex); this is the other store's, built
 * from the same topics the Memory panel shows, so prompt and UI cannot
 * disagree about what the notebook holds. Takes the store as parameters like
 * every function here — the module reads nothing on its own. Empty string
 * when the notebook has no topics, so it composes into any prompt block.
 */
export const buildNotebookTopicsIndex = (
    files: MemoryFile[],
    folders: Array<{ id: string; name: string }>,
    maxLines = 12,
): string => {
    const topics = memoryTopicsFromStore(files, folders);
    if (topics.length === 0) return '';
    const shown = topics.slice(0, maxLines);
    const lines = shown.map(t => {
        const slug = t.file.name.replace(/\.md$/i, '');
        const summary = t.summary.length > 150 ? `${t.summary.slice(0, 149)}…` : t.summary;
        return `- ${slug} (${t.folderName}) — ${summary}`;
    });
    const dropped = topics.length - shown.length;
    return [
        `## Notebook topics — ${topics.length} subject${topics.length === 1 ? '' : 's'}. One line each; the full note is one recall/get_notebook_map away.`,
        ...lines,
        dropped > 0 ? `…and ${dropped} more — get_notebook_map lists every file.` : '',
    ].filter(Boolean).join('\n');
};
