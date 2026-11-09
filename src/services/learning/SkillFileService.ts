/**
 * SkillFileService — a skill is a DIRECTORY, and the file is the source of truth.
 *
 * Claude's shape, copied deliberately:
 *
 *   skills/<slug>/
 *   ├── SKILL.md          required
 *   ├── references/       opened on demand
 *   ├── templates/
 *   ├── scripts/          copied, never executed
 *   └── assets/
 *
 * The notebook stores files flat, so `MemoryFile.path` carries the logical
 * path while `name` stays the folder-unique storage key. Nothing here rewrites
 * a trader's prose except the one-time migration off the retired ledger
 * format; an update writes exactly the bytes it was given.
 *
 * There is no lifecycle, no ledger and no approval. A skill is context: the
 * index lists `slug + description`, and `skill_view` opens the body. What
 * replaces the old gates is ONE deterministic rule: a CREATE is refused while
 * a near-duplicate exists, and the refusal names the skill to update or merge.
 */

import {
    createMemoryFileUnlocked,
    deleteMemoryFileUnlocked,
    findFolderByName,
    getMemoryFiles,
    slugifyName,
    updateMemoryFileUnlocked,
    withNotebookWriteLock,
} from './MemoryFilesService';
import { getActiveUsername } from '../../utils/activeUser';
import { missingSkillSections, skillFormatIssues, SKILL_BODY_SECTIONS, SKILL_SUPPORT_ROLES } from '../../utils/skillFrontmatter';
import type { MemoryFile } from '../../types';

export const SKILL_FOLDER = 'skills';
export const SKILL_HEAD = 'SKILL.md';
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Support directories a skill folder may carry, in the order Claude lists them.
 *  The list lives in `utils/skillFrontmatter` (the utils layer owns the shared
 *  vocabulary, and a util may not import a service) and is re-exported here so
 *  the folder shape has one owner, not two copies that can drift. Same for the
 *  suggested body headings: the editor hint and the `skill_write` schema read
 *  `SKILL_BODY_SECTIONS` / `missingSkillSections` from there. */
export { missingSkillSections, SKILL_BODY_SECTIONS, SKILL_SUPPORT_ROLES };
export type SkillSupportRole = typeof SKILL_SUPPORT_ROLES[number];

/** Two skills whose descriptions/procedures overlap this much are the same
 *  procedure worded twice. A create is refused; the author updates or merges.
 *  Deliberately content-based: the old dedupe compared ONE trigger sentence,
 *  so a reworded duplicate sailed through. */
export const DUPLICATE_SCORE_MIN = 0.5;

export interface SkillFile {
    file: MemoryFile;
    slug: string;
    name: string;
    description: string;
    body: string;
    /** FNV-1a of the head file, the optimistic-concurrency token. */
    version: string;
    bundled: MemoryFile[];
}

export interface SkillIndexRow {
    slug: string;
    name: string;
    description: string;
    version: string;
    /** Every way this SKILL.md departs from the format (empty when it
     *  conforms), from `utils/skillFrontmatter` — the same check the editor
     *  and the Format action use, so the index cannot disagree with either.
     *  The PROMPT drops a row that carries any: a note is not procedure, and
     *  the next read must not be built on one. The desk index keeps the row
     *  and shows the reasons, because a writer that cannot see a skill cannot
     *  repair it. */
    formatIssues: string[];
    /** The skill's own bundled files, as paths relative to its folder. A
     *  merge DELETES these, so a writer that never saw them cannot know what
     *  it is destroying. The desk tool's index carries them; the prompt index
     *  line does not, because 30 rows of file lists is not context, it is a
     *  directory listing. */
    files: string[];
}

export interface SkillWriteReview {
    indexVersion?: string;
    opened: ReadonlyMap<string, string>;
}

// ─── Text helpers (pure) ────────────────────────────────────────────────────

const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could',
    'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'if', 'in', 'into',
    'is', 'it', 'its', 'not', 'of', 'on', 'once', 'only', 'or', 'should', 'so',
    'than', 'that', 'the', 'their', 'then', 'there', 'these', 'this', 'to', 'was',
    'were', 'when', 'where', 'which', 'while', 'who', 'will', 'with', 'would',
    'you', 'your',
    // The scaffolding words every skill sentence carries. Left in, a library of
    // "use this skill whenever…" boilerplate looked mutually similar and the
    // real signal — the trigger's own nouns — was diluted.
    'use', 'used', 'uses', 'using', 'skill', 'skills', 'note', 'notes',
]);

export const contentWords = (text: string): Set<string> => {
    const out = new Set<string>();
    for (const raw of (text || '').toLowerCase().split(/[^a-z0-9%$.-]+/)) {
        const word = raw.replace(/^[.-]+|[.-]+$/g, '');
        if (word.length >= 2 && !STOPWORDS.has(word)) out.add(word);
    }
    return out;
};

export const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const word of a) if (b.has(word)) shared += 1;
    const union = a.size + b.size - shared;
    return union === 0 ? 0 : shared / union;
};

/** FNV-1a. The version a caller passes back is the bytes it read. */
export const contentVersion = (content: string): string => {
    let hash = 2166136261;
    for (let i = 0; i < content.length; i += 1) {
        hash ^= content.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
};

const yamlString = (value: string): string => JSON.stringify(value);

const decodeScalar = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('"')) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (typeof parsed === 'string') return parsed;
        } catch { /* fall through to the raw text */ }
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1).replace(/''/g, "'");
    }
    return trimmed;
};

/** A YAML block-scalar header: `>` or `|`, then an optional chomping marker
 *  and/or explicit indent digit in either order. The chomp is read but every
 *  consumer of this parse wants prose without trailing newlines, so trailing
 *  blank lines are always dropped. */
const BLOCK_SCALAR = /^([>|])(?:([+-])?([1-9])?|([1-9])([+-])?)?$/;

const indentOf = (line: string): number => line.match(/^[ \t]*/)?.[0].length ?? 0;

/** Read one frontmatter key out of the head lines. Inline scalars go through
 *  `decodeScalar`; a block scalar (`description: >-`) collects its indented
 *  lines — literal (`|`) keeps the breaks, folded (`>`) joins the lines with
 *  spaces and blank lines as breaks. */
const scalarOf = (head: string[], key: string): string | undefined => {
    const openerIndex = head.findIndex(line => new RegExp(`^${key}:[ \\t]*(.*)$`, 'i').test(line));
    if (openerIndex < 0) return undefined;
    const openerLine = head[openerIndex];
    const inline = openerLine.slice(openerLine.indexOf(':') + 1).trim();
    const block = BLOCK_SCALAR.exec(inline);
    if (!block) return decodeScalar(inline || undefined);
    const literal = block[1] === '|';
    const explicitIndent = Number(block[3] ?? block[4] ?? 0);
    let contentIndent = explicitIndent > 0 ? indentOf(openerLine) + explicitIndent : -1;
    const content: string[] = [];
    for (let i = openerIndex + 1; i < head.length; i += 1) {
        const line = head[i];
        if (line.trim() === '') {
            content.push('');
            continue;
        }
        const indent = indentOf(line);
        if (contentIndent < 0) contentIndent = indent;
        if (indent < contentIndent) break;
        content.push(line.slice(contentIndent));
    }
    while (content.length > 0 && content[content.length - 1] === '') content.pop();
    if (content.length === 0) return undefined;
    if (literal) return content.join('\n');
    let folded = '';
    for (const line of content) {
        if (line === '') {
            folded += '\n';
            continue;
        }
        if (folded !== '' && !folded.endsWith('\n')) folded += ' ';
        folded += line;
    }
    return folded;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const OPEN_FENCE = /^---\r?\n/;
const KEY_LINE = /^[A-Za-z][\w-]*[ \t]*:/;
const BLOCK_OPENER_LINE = /^[A-Za-z][\w-]*:[ \t]*[>|](?:[+-][1-9]|[1-9][+-]|[+-]|[1-9])?[ \t]*$/;

export interface ParsedSkillMarkdown {
    name?: string;
    description?: string;
    body: string;
}

/** `name` + `description` off the frontmatter, the body after it. A file with
 *  no frontmatter still parses — its whole text is the body — because refusing
 *  a skill over a missing fence is a worse answer than serving its prose.
 *
 *  Two tolerances beyond the well-formed case, both for imported files this
 *  app did not write:
 *  · an UNCLOSED opening fence is salvaged — the leading run of `key:` lines
 *    (plus block-scalar continuations) is the head and everything after the
 *    first non-key line is the body, so the file does not wear its
 *    frontmatter as prose. The first non-key line ends the head, which makes
 *    this a heuristic for malformed input only;
 *  · block scalars (`description: >-`) are decoded, not served raw. */
export function parseSkillMarkdown(content: string): ParsedSkillMarkdown | null {
    const text = content || '';
    const match = FRONTMATTER.exec(text);
    let head: string[];
    let rest: string;
    if (match && KEY_LINE.test(match[1])) {
        // A head with no `key:` line is not frontmatter — it is a body that
        // opens with a horizontal rule and closes on another one.
        head = match[1].split(/\r?\n/);
        rest = match[2] || '';
    } else if (OPEN_FENCE.test(text)) {
        const lines = text.split(/\r?\n/);
        let i = 1;
        let inBlock = false;
        while (i < lines.length) {
            const line = lines[i];
            if (inBlock) {
                if (line.trim() === '' || /^[ \t]/.test(line)) {
                    i += 1;
                    continue;
                }
                break;
            }
            if (!KEY_LINE.test(line)) break;
            inBlock = BLOCK_OPENER_LINE.test(line);
            i += 1;
        }
        if (i <= 1) {
            // Nothing key-shaped after the fence — this was never frontmatter.
            const body = text.trim();
            return body ? { body } : null;
        }
        head = lines.slice(1, i);
        rest = lines.slice(i).join('\n');
    } else {
        const body = text.trim();
        return body ? { body } : null;
    }
    const name = scalarOf(head, 'name');
    const description = scalarOf(head, 'description');
    const body = rest.trim();
    if (!name && !description && !body) return null;
    return { name, description, body };
}

/** A browser textarea hands back \r\n for every newline, so a document typed
 *  in the library arrives with CRLF inside an otherwise LF document, and a
 *  merged skill can end up with both. Line endings are not prose: the service
 *  never rewrites a trader's words, but one skill's endings must not depend on
 *  which surface wrote it. */
const normalizeLineEndings = (text: string): string => text.replace(/\r\n?/g, '\n');

/** The exact bytes a write produces. No ledger, no app keys, no rewrites. */
export const composeSkillMarkdown = (name: string, description: string, body: string): string => [
    '---',
    `name: ${yamlString(name.trim())}`,
    `description: ${yamlString(description.trim())}`,
    '---',
    '',
    body.trim(),
    '',
].join('\n');

const updateSkillMarkdown = (content: string, name: string, description: string, body: string): string => {
    const match = FRONTMATTER.exec(content);
    if (!match) return composeSkillMarkdown(name, description, body);
    const parsed = parseSkillMarkdown(content);
    if (parsed?.name === name && parsed.description === description && parsed.body === body) return content;
    const fields = new Map([['name', name], ['description', description]]);
    const changed = new Set([
        ...(parsed?.name !== name ? ['name'] : []),
        ...(parsed?.description !== description ? ['description'] : []),
    ]);
    const seen = new Set<string>();
    const kept: string[] = [];
    let dropping = false;
    for (const line of match[1].split(/\r?\n/)) {
        const field = line.match(/^(name|description):/i)?.[1].toLowerCase();
        if (field) {
            seen.add(field);
            dropping = changed.has(field);
            const scalar = line.slice(line.indexOf(':') + 1).trim();
            const comment = scalar.match(/^("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|.*?)([ \t]+#.*)?$/)?.[2] ?? '';
            kept.push(dropping ? `${field}: ${yamlString(fields.get(field)!)}${comment}` : line);
        } else {
            const commentOrBlank = /^\s*(?:#|$)/.test(line);
            if (!commentOrBlank && !/^[ \t]/.test(line)) dropping = false;
            if (!dropping || commentOrBlank) kept.push(line);
        }
    }
    for (const [field, value] of fields) {
        if (!seen.has(field)) kept.push(`${field}: ${yamlString(value)}`);
    }
    const newline = '\n';
    const updatedBody = parsed?.body === body ? normalizeLineEndings(match[2]) : `${newline}${body}${newline}`;
    return `---${newline}${kept.join(newline)}${newline}---${newline}${updatedBody}`;
};

// ─── Folder resolution ──────────────────────────────────────────────────────

const skillsFolderId = (): string | null => findFolderByName(SKILL_FOLDER)?.id ?? null;

const slugOfPath = (path: string): string => path.split('/')[0] ?? '';

/** The slug a stored file belongs to, from its logical path when present and
 *  its legacy storage name otherwise. */
export const skillSlugOf = (file: MemoryFile): string | null => {
    if (file.path) {
        const slug = slugOfPath(file.path);
        return slug || null;
    }
    if (!/\.md$/i.test(file.name) && !file.name.includes('__')) return null;
    const base = file.name.replace(/\.md$/i, '');
    const [slug] = base.split('__');
    return slug || null;
};

const isBundledName = (file: MemoryFile): boolean => !file.path && file.name.includes('__');

/** The head file of a skill. Bundled files are not skills. */
export const isSkillFile = (file: MemoryFile): boolean => {
    const folder = findFolderByName(SKILL_FOLDER);
    if (!folder || file.folderId !== folder.id) return false;
    if (file.path) return file.path.toLowerCase() === `${slugOfPath(file.path)}/${SKILL_HEAD}`.toLowerCase();
    return /\.md$/i.test(file.name) && !isBundledName(file);
};

/** The logical path of a stored file, derived from the legacy name when the
 *  file predates the path field. */
export const skillPathOf = (file: MemoryFile): string | null => {
    if (file.path) return file.path;
    const slug = skillSlugOf(file);
    if (!slug) return null;
    if (!isBundledName(file)) return `${slug}/${SKILL_HEAD}`;
    const [, role, ...leaf] = file.name.split('__');
    if (!role || leaf.length === 0) return `${slug}/${file.name}`;
    const last = leaf.length - 1;
    if (/\.[^.]+\.md$/i.test(leaf[last])) leaf[last] = leaf[last].replace(/\.md$/i, '');
    return `${slug}/${role}/${leaf.join('/')}`;
};

const toSkillFile = (head: MemoryFile, all: MemoryFile[]): SkillFile => {
    const slug = skillSlugOf(head) ?? head.name.replace(/\.md$/i, '');
    const parsed = parseSkillMarkdown(head.content);
    const bundled = all.filter(f => f.id !== head.id && skillSlugOf(f) === slug && (isBundledName(f) || Boolean(f.path && f.path.includes('/'))));
    return {
        file: head,
        slug,
        name: parsed?.name || slug,
        description: parsed?.description || '',
        body: parsed?.body || '',
        version: contentVersion(head.content),
        bundled,
    };
};

/** Every skill in the library, newest write first. */
export const listSkillFiles = (): SkillFile[] => {
    const folder = findFolderByName(SKILL_FOLDER);
    if (!folder) return [];
    const all = getMemoryFiles().files.filter(f => f.folderId === folder.id);
    return all
        .filter(isSkillFile)
        .map(head => toSkillFile(head, all))
        .sort((a, b) => b.file.updatedAt - a.file.updatedAt);
};

export const getSkill = (slugOrName: string): SkillFile | null => {
    const wanted = (slugOrName || '').trim().toLowerCase();
    if (!wanted) return null;
    return listSkillFiles().find(s =>
        s.slug.toLowerCase() === wanted
        || s.name.toLowerCase() === wanted
        || s.file.name.replace(/\.md$/i, '').toLowerCase() === wanted,
    ) ?? null;
};

/** The whole library, one line per skill — what a writer must read first. */
export const skillIndexRows = (): SkillIndexRow[] => listSkillFiles().map(s => ({
    slug: s.slug,
    name: s.name,
    description: s.description,
    version: s.version,
    formatIssues: skillFormatIssues(s.file.content).map(i => i.what),
    files: s.bundled.map(f => skillPathOf(f)?.slice(s.slug.length + 1) ?? f.name),
}));

export const skillLibraryVersion = (skills: SkillFile[] = listSkillFiles()): string => contentVersion(
    JSON.stringify(skills.map(s => [s.slug, s.version, s.bundled.map(f => [skillPathOf(f), contentVersion(f.content)])])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
);

export const formatSkillIndex = (rows: SkillIndexRow[] = skillIndexRows()): string => {
    if (rows.length === 0) return '(the skills library is empty)';
    return rows.map(r => `- ${r.slug}: ${r.name} — ${r.description || '(no description)'}`).join('\n');
};

/** The answer a refused `skill_write` gives back, and the reason it is a long
 *  one: a create refusal carries the WHOLE library, not only the near-matches,
 *  because the writer's next move is to pick the row to update or merge and
 *  that decision needs the library; a stale-version refusal carries the current
 *  bytes, so the merge needs no second read. */
export const skillWriteRejection = (failure: SkillWriteFailure): string => {
    const extra = failure.reason === 'duplicate'
        ? `\n\nExisting library:\n${formatSkillIndex()}`
        : failure.current
            ? `\n\nCurrent content (version ${failure.current.version}):\n${failure.current.content}`
            : '';
    return `skill_write rejected: ${failure.message}${extra}`;
};

// ─── Duplicate detection ────────────────────────────────────────────────────

export interface DuplicateMatch {
    slug: string;
    name: string;
    description: string;
    score: number;
    reason: string;
}

/** Overlap in EITHER direction. Plain Jaccard divides by the UNION, so a short
 *  trigger that names exactly what a longer description already covers scores
 *  low and passes — the reworded duplicate the rule below promises to catch.
 *  `shared / min(|a|,|b|)` asks the question the refusal is actually built on:
 *  is everything this text says already said there? Empty on either side is 0,
 *  never a division by zero. */
export const overlap = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const word of a) if (b.has(word)) shared += 1;
    return shared / Math.min(a.size, b.size);
};

/** Score a candidate against every existing skill. Deterministic, pure over
 *  the given corpus, so a contract can pin the threshold. Description overlap
 *  carries the most weight (the description is the trigger); the name is
 *  Jaccard because a short name against a long one is not a copy. */
export const nearDuplicates = (
    candidate: { name: string; description: string; body: string },
    existing: SkillFile[],
    excludeSlug?: string,
): DuplicateMatch[] => {
    const desc = contentWords(candidate.description);
    const name = contentWords(candidate.name);
    const body = contentWords(candidate.body || '');
    const out: DuplicateMatch[] = [];
    for (const skill of existing) {
        if (excludeSlug && skill.slug === excludeSlug) continue;
        const descScore = overlap(desc, contentWords(skill.description));
        const nameScore = jaccard(name, contentWords(skill.name));
        const bodyScore = overlap(body, contentWords(skill.body || ''));
        const score = descScore * 0.55 + bodyScore * 0.25 + nameScore * 0.2;
        if (score < DUPLICATE_SCORE_MIN) continue;
        const reason = descScore >= 0.5
            ? 'the description names the same trigger'
            : bodyScore >= 0.5
                ? 'the procedure is the same work'
                : 'the name and trigger overlap';
        out.push({ slug: skill.slug, name: skill.name, description: skill.description, score, reason });
    }
    return out.sort((a, b) => b.score - a.score);
};

// ─── Writes ─────────────────────────────────────────────────────────────────

export interface SkillWriteInput {
    /** The skill's slug. An existing slug updates that skill; a new one creates it. */
    slug?: string;
    /** Display title. Required on create. */
    name?: string;
    description: string;
    body: string;
    /** Required for every existing target: the version the writer read. */
    ifVersion?: string;
    /** Slugs this write absorbs. They are DELETED after the survivor lands. */
    supersedes?: string[];
    /** Support files to write into the skill's folder, paths relative to it
     *  ("references/pullback-table.md"). Without this the folder shape the
     *  prompt promises was a shape only the importer could build: the model
     *  could write SKILL.md and nothing else, so "put the long material in
     *  references/" told it to do a thing it had no tool for. */
    files?: Array<{ path: string; content: string }>;
}

export interface SkillWriteFailure {
    ok: false;
    reason: 'not-found' | 'exists' | 'duplicate' | 'conflict' | 'invalid' | 'no-folder' | 'write-failed';
    message: string;
    /** Create refusals carry the skills to update or merge instead. */
    matches?: DuplicateMatch[];
    /** The current bytes + version on a conflict, so the writer can merge. */
    current?: { version: string; content: string };
    /** Confirmed survivor writes before a persistence failure; sources remain intact. */
    writtenPaths?: string[];
}

export type SkillWriteResult =
    | { ok: true; slug: string; created: boolean; version: string; merged: string[]; mergeFailures: string[]; files: string[] }
    | SkillWriteFailure;

const invalid = (message: string): SkillWriteFailure => ({ ok: false, reason: 'invalid', message });

const bundleStorageName = (folderId: string, slug: string, relativePath: string): string => {
    const base = `${slug}__${relativePath.split('/').map(s => s.replace(/[^A-Za-z0-9._-]/g, '')).join('__')}`;
    const stored = /\.(md|json)$/i.test(base) ? base : `${base}.md`;
    const names = new Set(getMemoryFiles().files.filter(f => f.folderId === folderId).map(f => f.name.toLowerCase()));
    const stem = stored.replace(/\.(md|json)$/i, '');
    const extension = stored.slice(stem.length);
    let candidate = stored;
    for (let i = 2; names.has(candidate.toLowerCase()); i += 1) candidate = `${stem}-${i}${extension}`;
    return candidate;
};

export const writeSkillFile = async (
    input: SkillWriteInput,
    username?: string,
    review?: SkillWriteReview,
): Promise<SkillWriteResult> => {
    const user = username || getActiveUsername() || 'default';
    const slug = input.slug ? slugifyName(input.slug) : slugifyName(input.name || (input.description || '').slice(0, 60));
    if (!slug || !SKILL_NAME_PATTERN.test(slug) || slug.length > SKILL_NAME_MAX) {
        return invalid(`A skill slug must be lowercase letters, digits and hyphens, up to ${SKILL_NAME_MAX} characters.`);
    }
    const description = (input.description || '').trim();
    if (!description) return invalid('A skill needs a description: what it does and when to use it.');
    if (description.length > SKILL_DESCRIPTION_MAX) return invalid(`The description is over ${SKILL_DESCRIPTION_MAX} characters.`);
    const body = normalizeLineEndings(input.body || '').trim();
    if (!body) return invalid('A skill needs a procedure body.');
    const supersedes = [...new Set((input.supersedes ?? []).map(s => slugifyName(s)))];
    if (supersedes.some(s => !s)) return invalid('Every supersedes entry must name a skill slug.');
    if (supersedes.includes(slug)) return invalid('A skill cannot supersede itself.');

    return withNotebookWriteLock(async (): Promise<SkillWriteResult> => {
        const folderId = skillsFolderId();
        if (!folderId) return { ok: false, reason: 'no-folder', message: 'This notebook has no skills folder.' };
        const all = listSkillFiles();
        if (review && review.indexVersion !== skillLibraryVersion(all)) {
            return invalid('The skills library changed or was not reviewed. Read skill_index again before writing.');
        }
        const existing = all.find(s => s.slug === slug);
        if (existing) {
            if (review && review.opened.get(slug) !== existing.version) {
                return invalid(`Read skill_view for "${slug}" first; its current version has not been opened.`);
            }
            if (existing.version !== input.ifVersion) {
                return {
                    ok: false,
                    reason: 'conflict',
                    message: 'An existing skill requires a matching ifVersion. Read skill_view first, merge your edit into the current bytes and retry with that version.',
                    current: { version: existing.version, content: existing.file.content },
                };
            }
        } else if (input.ifVersion !== undefined) {
            return { ok: false, reason: 'not-found', message: `No skill "${slug}" exists to update. Read skill_index again.` };
        }
        const absorbed: SkillFile[] = [];
        for (const loser of supersedes) {
            const target = all.find(s => s.slug === loser);
            if (!target) return { ok: false, reason: 'not-found', message: `Cannot merge: skill "${loser}" was not found.` };
            if (review && review.opened.get(loser) !== target.version) {
                return invalid(`Read skill_view for "${loser}" first; its current version has not been opened.`);
            }
            absorbed.push(target);
        }
        const name = (input.name || '').trim() || existing?.name || slug;
        // The scan runs on the UPDATE path too. A create-only rule left a door
        // open: rewriting skill A into skill B's wording — the exact redundancy
        // the owner asked to eliminate — was invisible, because only new slugs
        // were ever compared with the library.
        const rivals = all.filter(s => s.slug !== slug && !supersedes.includes(s.slug));
        const matches = nearDuplicates({ name, description, body }, rivals);
        if (matches.length > 0) {
            return {
                ok: false,
                reason: 'duplicate',
                message: existing
                    ? `Refused: this edit turns "${slug}" into a second copy of ${matches.map(m => m.slug).join(', ')} (${matches[0].reason}). Update that skill instead, or name it in supersedes and fold the two into one.`
                    : `Refused: this looks like an existing skill (${matches.map(m => m.slug).join(', ')}). Update one of them, or pass supersedes to merge them into this write.`,
                matches,
            };
        }

        const content = existing
            ? updateSkillMarkdown(existing.file.content, name, description, body)
            : composeSkillMarkdown(name, description, body);
        const bundle = new Map<string, MemoryFile>();
        const copies = new Map<string, MemoryFile>();
        for (const owner of [...(existing ? [existing] : []), ...absorbed]) {
            for (const file of owner.bundled) {
                const path = skillPathOf(file);
                const rel = path?.slice(owner.slug.length + 1);
                if (!path?.startsWith(`${owner.slug}/`) || !rel || rel.includes('\\')
                    || rel.split('/').some(s => !s || s === '.' || s === '..')) {
                    return invalid(`Cannot merge: "${file.name}" has an invalid bundled path.`);
                }
                const previous = bundle.get(rel);
                if (rel.toLowerCase() === SKILL_HEAD.toLowerCase() || (previous && previous.content !== file.content)) {
                    return {
                        ok: false,
                        reason: 'conflict',
                        message: `Cannot merge: bundled path "${rel}" has conflicting bytes (${previous ? skillPathOf(previous) : `${slug}/${SKILL_HEAD}`} and ${path}). Resolve the conflict first; nothing was changed.`,
                    };
                }
                if (!previous) {
                    bundle.set(rel, file);
                    if (owner !== existing) copies.set(rel, file);
                }
            }
        }

        const support: Array<{ rel: string; content: string }> = [];
        for (const file of input.files ?? []) {
            const rel = (file?.path ?? '').replace(/\\/g, '/');
            const parts = rel.split('/');
            if (!rel || rel.startsWith('/') || parts.some(p => !p || p === '.' || p === '..')) {
                return invalid(`Support path "${file?.path ?? ''}" must be relative to the skill folder, with no traversal.`);
            }
            if (!(SKILL_SUPPORT_ROLES as readonly string[]).includes(parts[0]) || parts.length < 2) {
                return invalid(`Support path "${rel}" must sit under one of ${SKILL_SUPPORT_ROLES.join(', ')}.`);
            }
            if (parts[parts.length - 1].toLowerCase() === SKILL_HEAD.toLowerCase()) {
                return invalid('SKILL.md is the head — write it with `body`, not as a support file.');
            }
            if (!(file?.content ?? '').trim()) return invalid(`Support file "${rel}" has no content.`);
            if (support.some(s => s.rel.toLowerCase() === rel.toLowerCase())) {
                return invalid(`Support path "${rel}" appears twice in one write.`);
            }
            support.push({ rel, content: normalizeLineEndings(file.content) });
        }

        const writtenPaths: string[] = [];
        let writingPath = `${slug}/${SKILL_HEAD}`;
        try {
            let head: MemoryFile;
            const headChanged = !existing || existing.file.content !== content || existing.file.path !== writingPath;
            if (existing) {
                head = existing.file;
                if (headChanged) await updateMemoryFileUnlocked(head.id, { content, path: writingPath }, user);
            } else {
                head = await createMemoryFileUnlocked(folderId, `${slug}.md`, content, user, false, writingPath);
            }
            const readBack = getMemoryFiles().files.find(f => f.id === head.id);
            if (!readBack || readBack.content !== content || readBack.path !== writingPath) {
                throw new Error('The head write could not be verified in the notebook.');
            }
            if (headChanged) writtenPaths.push(writingPath);
            for (const file of support) {
                writingPath = `${slug}/${file.rel}`;
                const savedFile = await createMemoryFileUnlocked(
                    folderId, bundleStorageName(folderId, slug, file.rel), file.content, user, false, writingPath,
                );
                const readBackFile = getMemoryFiles().files.find(f => f.id === savedFile.id);
                if (!readBackFile || readBackFile.content !== file.content || readBackFile.path !== writingPath) {
                    throw new Error('The support-file write could not be verified in the notebook.');
                }
                writtenPaths.push(writingPath);
            }
            for (const [rel, source] of copies) {
                writingPath = `${slug}/${rel}`;
                const copied = await createMemoryFileUnlocked(
                    folderId, bundleStorageName(folderId, slug, rel), source.content, user, false, writingPath,
                );
                const saved = getMemoryFiles().files.find(f => f.id === copied.id);
                if (!saved || saved.content !== source.content || saved.path !== writingPath) {
                    throw new Error('The bundled write could not be verified in the notebook.');
                }
                writtenPaths.push(writingPath);
            }
        } catch (e) {
            return {
                ok: false,
                reason: 'write-failed',
                message: `Could not persist "${writingPath}": ${e instanceof Error ? e.message : String(e)}. ${writtenPaths.length} survivor file writes completed; all superseded source skills were retained. Read skill_index and skill_view again before retrying.`,
                writtenPaths,
            };
        }

        const merged: string[] = [];
        const mergeFailures: string[] = [];
        for (const target of absorbed) {
            const doomed = [...target.bundled, target.file];
            const removed: string[] = [];
            try {
                for (const file of doomed) {
                    await deleteMemoryFileUnlocked(file.id, user);
                    if (getMemoryFiles().files.some(f => f.id === file.id)) throw new Error(`"${skillPathOf(file)}" was not removed`);
                    removed.push(skillPathOf(file) ?? file.name);
                }
                merged.push(target.slug);
            } catch (e) {
                mergeFailures.push(`${target.slug}: cleanup failed after removing ${removed.length}/${doomed.length} source files: ${e instanceof Error ? e.message : String(e)}. All bundled files are saved under "${slug}"; remaining source files were retained.`);
                for (const pending of absorbed.slice(absorbed.indexOf(target) + 1)) {
                    mergeFailures.push(`${pending.slug}: retained because source cleanup stopped after a failure.`);
                }
                break;
            }
        }

        return {
            ok: true,
            slug,
            created: !existing,
            version: contentVersion(content),
            merged,
            mergeFailures,
            files: writtenPaths.filter(p => p !== `${slug}/${SKILL_HEAD}`),
        };
    });
};

/** Remove one skill, head and bundled files. Returns what was removed. */
export const deleteSkillFile = async (slugOrName: string, username?: string): Promise<{ removed: string[]; error?: string }> => {
    const user = username || getActiveUsername() || 'default';
    const skill = getSkill(slugOrName);
    if (!skill) return { removed: [], error: `No skill "${slugOrName}".` };
    return withNotebookWriteLock(async () => {
        const removed: string[] = [];
        for (const f of [skill.file, ...skill.bundled]) {
            try {
                await deleteMemoryFileUnlocked(f.id, user);
                removed.push(skillPathOf(f) ?? f.name);
            } catch (e) {
                return { removed, error: e instanceof Error ? e.message : String(e) };
            }
        }
        return { removed };
    });
};

// ─── Import ─────────────────────────────────────────────────────────────────

export interface SkillImportInput {
    /** Fallback title when the file itself carries none. */
    name: string;
    /** Preferred folder slug; a collision gets a numeric suffix. */
    slug?: string;
    /** The SKILL.md bytes, stored VERBATIM. */
    content: string;
    /** Support files, paths relative to the skill folder
     *  ("references/x.md", "scripts/y.sh"). */
    support?: Array<{ path: string; content: string }>;
}

export type SkillImportOutcome =
    | {
        ok: true;
        slug: string;
        support: number;
        /** Paths relative to the skill folder, including SKILL.md. */
        importedPaths: string[];
        failures: string[];
    }
    | { ok: false; reason: string; matches?: DuplicateMatch[] };

const supportRoleOk = (path: string): boolean => {
    const role = path.split('/')[0];
    return (SKILL_SUPPORT_ROLES as readonly string[]).includes(role) && path.split('/').length >= 2;
};

/** Import one skill folder. The head is stored verbatim — an imported file
 *  belongs to its author, and the app never rewrites it. The duplicate scan
 *  still runs, because a second copy under a different name is the redundancy
 *  the library is supposed to avoid. */
export const importSkillToLibrary = async (
    input: SkillImportInput,
    username?: string,
): Promise<SkillImportOutcome> => {
    const user = username || getActiveUsername() || 'default';
    const parsed = parseSkillMarkdown(input.content);
    if (!parsed || !parsed.body) return { ok: false, reason: 'Not a skill file - the body is empty.' };
    const name = (parsed.name || input.name || '').trim() || 'skill';
    const description = (parsed.description || '').trim();
    if (!description) return { ok: false, reason: 'No description - a skill needs the line that says when to use it.' };
    // One rule, both doors: `skill_write` refuses a description over the cap,
    // so an import must not be allowed to smuggle a longer one in — the
    // description is what every seat's index line carries.
    if (description.length > SKILL_DESCRIPTION_MAX) {
        return { ok: false, reason: `Description is over ${SKILL_DESCRIPTION_MAX} characters — the index line every seat reads is capped.` };
    }
    const base = slugifyName(input.slug || name) || 'skill';
    return withNotebookWriteLock(async (): Promise<SkillImportOutcome> => {
        const folderId = skillsFolderId();
        if (!folderId) return { ok: false, reason: 'This notebook has no skills folder.' };
        const matches = nearDuplicates({ name, description, body: parsed.body }, listSkillFiles());
        if (matches.length > 0) {
            return {
                ok: false,
                reason: `Already in the library (${matches.map(m => m.slug).join(', ')}). Update that skill instead of importing a second copy.`,
                matches,
            };
        }
        const files = getMemoryFiles().files.filter(f => f.folderId === folderId);
        const existing = new Set(files.map(skillSlugOf));
        const names = new Set(files.map(f => f.name.toLowerCase()));
        let slug = base;
        for (let i = 2; existing.has(slug) || names.has(`${slug}.md`); i += 1) slug = `${base}-${i}`;
        try {
            const head = await createMemoryFileUnlocked(folderId, `${slug}.md`, normalizeLineEndings(input.content), user, false, `${slug}/${SKILL_HEAD}`);
            const readBack = getMemoryFiles().files.find(f => f.id === head.id);
            if (!readBack || readBack.content !== normalizeLineEndings(input.content) || readBack.path !== `${slug}/${SKILL_HEAD}`) {
                return { ok: false, reason: `The head write for "${slug}" could not be verified in the notebook; no support files were imported.` };
            }
        } catch (e) {
            return { ok: false, reason: `Could not import "${slug}/${SKILL_HEAD}": ${e instanceof Error ? e.message : String(e)}. No support files were imported.` };
        }
        const importedPaths = [SKILL_HEAD];
        const failures: string[] = [];
        for (const item of input.support ?? []) {
            const rel = item.path.replace(/\\/g, '/');
            if (!supportRoleOk(rel) || rel.includes(':') || Array.from(rel).some(c => c.charCodeAt(0) < 32)
                || rel.split('/').some(s => s === '..' || s === '.' || s === '')) {
                failures.push(`${item.path}: invalid support path; use a relative path under ${SKILL_SUPPORT_ROLES.join(', ')}.`);
                continue;
            }
            if (importedPaths.includes(rel)) {
                failures.push(`${item.path}: duplicate support path; the earlier imported file was retained.`);
                continue;
            }
            try {
                const file = await createMemoryFileUnlocked(
                    folderId, bundleStorageName(folderId, slug, rel), normalizeLineEndings(item.content), user, false, `${slug}/${rel}`,
                );
                const saved = getMemoryFiles().files.find(f => f.id === file.id);
                if (!saved || saved.content !== normalizeLineEndings(item.content) || saved.path !== `${slug}/${rel}`) {
                    failures.push(`${item.path}: the support write could not be verified in the notebook.`);
                    continue;
                }
                importedPaths.push(rel);
            } catch (e) {
                failures.push(`${item.path}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        return { ok: true, slug, support: importedPaths.length - 1, importedPaths, failures };
    });
};

// ─── Invoked skills (/slug) ─────────────────────────────────────────────────

export interface InvokedSkillRow {
    slug: string;
    found: boolean;
    name?: string;
    body?: string;
}

export const resolveInvokedSkills = (slugs: string[]): InvokedSkillRow[] =>
    slugs.map(slug => {
        const skill = getSkill(slug);
        return skill
            ? { slug, found: true, name: skill.name, body: skill.body }
            : { slug, found: false };
    });

export const formatInvokedSkillSection = (rows: InvokedSkillRow[]): string => {
    if (rows.length === 0) return '';
    const blocks = rows.map(row => row.found
        ? `### ${row.slug}${row.name ? ` — ${row.name}` : ''}\n${row.body?.trim() || '(empty skill body)'}`
        : `### ${row.slug} — not found\n(No notebook skill named "${row.slug}" exists. Continue without it; mention it is missing only if it changes the read.)`);
    return [
        '## Invoked notebook skills',
        'The trader explicitly invoked these notebook skills for THIS run. Apply them and say where they bit.',
        blocks.join('\n\n'),
    ].join('\n\n');
};

// ─── Migration off the retired format ───────────────────────────────────────

/** Every key the retired August format wrote. The ONE-TIME migration removes
 *  them; after that a skill file is never rewritten by the app again. */
const RETIRED_KEYS = new Set([
    'version', 'kind', 'coin', 'timeframe', 'source', 'direction', 'family', 'regime',
    'when', 'predicate', 'strategyFamily', 'signals', 'invalidation', 'horizon', 'sizing',
    'prior', 'audience', 'compatibility', 'approvedBy', 'approvedAt', 'whyAccepted',
    'reason', 'originBotId', 'originBotName', 'originMessageId', 'status', 'wins',
    'losses', 'sample', 'consecutiveLosses', 'recentOutcomes', 'netR', 'grossR',
    'netRKnown', 'netRUnknown', 'rSampled', 'tradeIds', 'evidenceCount', 'birthEvidence',
    'lastEvidenceAt', 'shadow', 'suspendedAt', 'disabledByUser', 'prediction',
    'supersededBy', 'revisedAt', 'manualOnly', 'modified', 'evalVerdict', 'lastEvalAt',
    'refinedAt', 'lastMatchedAt', 'evalStreak', 'controlIds', 'controlWins',
    'controlLosses', 'overriddenIds', 'crossRegimeIds', 'regimeStats',
    'claimTestedEvidence', 'history', 'previousVersion', 'demotion',
]);

export const LEGACY_LEDGER_MARKER = '# august:skill-ledger';

const deriveDescription = (frontmatter: string, body: string): string | undefined => {
    const when = frontmatter.match(/^when:[ \t]*(.+)$/mi)?.[1];
    const decodedWhen = decodeScalar(when);
    const fromBody = body.match(/^\*\*When:\*\*\s*(.+)$/im)?.[1]
        ?? body.match(/^##\s*When to use\s*\n+([^\n#]+)$/im)?.[1];
    const trigger = decodedWhen || fromBody;
    if (trigger) return `Use this skill whenever ${trigger.replace(/\s+/g, ' ').trim().replace(/\.+$/, '')}.`;
    const first = body.split(/\n\s*\n/).map(p => p.trim()).find(p => p && !/^[#*-0-9]/.test(p));
    return first ? first.slice(0, 280) : undefined;
};

/** Strip the ledger face and every retired key, keeping `name`, `description`,
 *  `license` and anything the author wrote that the app never owned. */
export const stripRetiredSkillContent = (content: string, slug: string): string => {
    const match = FRONTMATTER.exec(content);
    if (!match) return content;
    const lines = match[1].split(/\r?\n/);
    const kept: string[] = [];
    let dropping = false;
    for (const line of lines) {
        if (/^#\s*august:skill-ledger\b/i.test(line.trim())) break;
        const top = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):/);
        if (top) {
            dropping = RETIRED_KEYS.has(top[1]);
            if (!dropping) kept.push(line);
            continue;
        }
        if (dropping) continue;
        if (/^[ \t]/.test(line) || /^-\s/.test(line)) {
            if (kept.length > 0) kept.push(line);
            continue;
        }
        if (line.trim()) kept.push(line);
    }
    const frontmatter = kept.join('\n');
    const body = (match[2] || '').trim();
    const name = decodeScalar(frontmatter.match(/^name:[ \t]*(.+)$/mi)?.[1]) || slug;
    const description = decodeScalar(frontmatter.match(/^description:[ \t]*(.+)$/mi)?.[1])
        || deriveDescription(lines.join('\n'), body)
        || `The ${name} procedure.`;
    const rest = kept.filter(l => !/^(?:name|description):/i.test(l));
    return [
        '---',
        `name: ${yamlString(name)}`,
        `description: ${yamlString(description)}`,
        ...rest,
        '---',
        '',
        body,
        '',
    ].join('\n');
};

export interface SkillMigrationResult {
    checked: number;
    migrated: number;
    remaining: number;
    changed: string[];
}

/** Give every legacy skill its directory path and strip the retired ledger.
 *  Idempotent: a conforming file is never touched. */
export const migrateSkillLibrary = async (username: string): Promise<SkillMigrationResult> => withNotebookWriteLock(async () => {
    const folder = findFolderByName(SKILL_FOLDER);
    const out: SkillMigrationResult = { checked: 0, migrated: 0, remaining: 0, changed: [] };
    if (!folder) return out;
    const files = getMemoryFiles().files.filter(f => f.folderId === folder.id);
    for (const file of files) {
        out.checked += 1;
        const slug = skillSlugOf(file);
        if (!slug) { out.remaining += 1; continue; }
        const head = isSkillFile(file);
        const patch: Partial<MemoryFile> = {};
        if (!file.path) {
            if (head) patch.path = `${slug}/${SKILL_HEAD}`;
            else {
                const path = skillPathOf(file);
                if (path) patch.path = path;
            }
        }
        if (head && file.content.includes(LEGACY_LEDGER_MARKER)) {
            patch.content = stripRetiredSkillContent(file.content, slug);
        }
        if (Object.keys(patch).length === 0) continue;
        try {
            await updateMemoryFileUnlocked(file.id, patch, username);
            out.migrated += 1;
            out.changed.push(patch.path ?? file.name);
        } catch {
            out.remaining += 1;
        }
    }
    return out;
});
