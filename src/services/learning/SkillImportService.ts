/**
 * SkillImportService — import skill files the user brings from outside
 * (a .md export from another august profile, a shared file, etc.) into
 * the harness's skills folder so the models can USE them in debates.
 *
 * A skill is a folder, and an imported file is stored VERBATIM: its head
 * keeps every key and comment the author wrote, and its siblings keep their
 * role paths. Imports report read, text-safety, path and write failures,
 * missing body/description, and near-duplicates already in the library.
 * Binary assets are not supported: the notebook stores text only.
 */

import { importSkillToLibrary } from './SkillFileService';
import { scanSkillText, skillSupportRefs, resolveSiblingUrl, SKILL_SUPPORT_REF_MAX } from '../../utils/skillFrontmatter';
import { getActiveUsername } from '../../utils/activeUser';
import { slugifyName } from './MemoryFilesService';

export interface SkillImportResult {
    imported: string[];
    skipped: string[];
    failed: Array<{ name: string; reason: string }>;
}

/**
 * Import raw skill markdown (one entry per file). A picked FOLDER keeps its
 * shape: a `SKILL.md` claims its siblings as bundled files under the same
 * skill. Every outcome is reported; nothing is silently dropped.
 */
export const importSkillFiles = async (files: Array<SkillFileRead & { content: string }>): Promise<SkillImportResult> => {
    const username = getActiveUsername();
    const result: SkillImportResult = { imported: [], skipped: [], failed: [] };
    if (files.length === 0) return result;
    const segsOf = (f: SkillFileRead): string[] =>
        f.relPath ? f.relPath.split(/[/\\]/).filter(Boolean) : [f.name];

    const roots = files
        .filter(f => {
            const segs = segsOf(f);
            return segs.length >= 2 && segs[segs.length - 1].toLowerCase() === 'skill.md';
        })
        .map(head => {
            const folder = segsOf(head).slice(0, -1);
            const key = folder.map(s => s.toLowerCase());
            const siblings = files.filter(f => {
                if (f === head) return false;
                const segs = segsOf(f).map(s => s.toLowerCase());
                return segs.length > key.length && key.every((s, i) => segs[i] === s);
            });
            return {
                folder,
                head,
                support: siblings.map(f => ({ rel: segsOf(f).slice(folder.length).join('/'), file: f })),
            };
        });
    const claimed = new Set<SkillFileRead>([
        ...roots.map(r => r.head),
        ...roots.flatMap(r => r.support.map(s => s.file)),
    ]);
    const singles = files.filter(f => !claimed.has(f));

    for (const root of roots) {
        const group = [root.head, ...root.support.map(s => s.file)];
        const findings = group.flatMap(f => scanSkillText(f.content).map(x => `${f.name}: ${x.what}`));
        if (findings.length > 0) {
            result.failed.push({ name: root.head.relPath ?? root.head.name, reason: `refused by the import scan: ${findings.join('; ')}` });
            continue;
        }
        try {
            const outcome = await importSkillToLibrary({
                name: root.folder[root.folder.length - 1] || root.head.name.replace(/\.md$/i, ''),
                slug: root.folder[root.folder.length - 1],
                content: root.head.content,
                support: root.support.map(s => ({ path: s.rel, content: s.file.content })),
            }, username);
            if (!outcome.ok) {
                result.failed.push({ name: root.head.relPath ?? root.head.name, reason: outcome.reason });
                continue;
            }
            result.imported.push(...outcome.importedPaths.map(path => `${outcome.slug}/${path}`));
            result.failed.push(...outcome.failures.map(reason => ({ name: outcome.slug, reason })));
        } catch (err) {
            result.failed.push({ name: root.head.relPath ?? root.head.name, reason: err instanceof Error ? err.message : String(err) });
        }
    }

    for (const file of singles) {
        const findings = scanSkillText(file.content);
        if (findings.length > 0) {
            result.failed.push({ name: file.name, reason: `refused by the import scan: ${findings.map(f => f.what).join('; ')}` });
            continue;
        }
        try {
            const outcome = await importSkillToLibrary({
                name: file.name.replace(/\.md$/i, ''),
                content: file.content,
            }, username);
            if (outcome.ok) {
                result.imported.push(...outcome.importedPaths.map(path => `${outcome.slug}/${path}`));
                result.failed.push(...outcome.failures.map(reason => ({ name: outcome.slug, reason })));
            } else if (outcome.matches) result.skipped.push(file.relPath ?? file.name);
            else result.failed.push({ name: file.relPath ?? file.name, reason: outcome.reason });
        } catch (err) {
            result.failed.push({ name: file.relPath ?? file.name, reason: err instanceof Error ? err.message : String(err) });
        }
    }
    return result;
};

/** A URL import is the folder import with a web server in place of the picked
 *  folder (item 6): the SKILL.md, plus the references/, templates/, scripts/
 *  and assets/ siblings its body names, handed to importSkillFiles with the
 *  same relPaths a folder pick would have produced. That is deliberate — ONE
 *  bundling path, ONE import scan, ONE confirmation, not a URL-shaped second
 *  one a reviewer would have to audit twice.
 *
 *  Every rule ends in a refusal that reaches the receipt, never a silent drop:
 *    https only, for the head and for every sibling;
 *    a sibling must resolve on the head's own host and stay under the head's
 *    own folder (resolveSiblingUrl decides that before a request leaves);
 *    ≤12 siblings, ≤200kB each and ≤600kB for the batch — the batch total is
 *    applied in body order after the fetches settle, so two concurrent
 *    siblings cannot both spend the same bytes;
 *    one 20s deadline shared by the concurrent sibling fetches, so the import
 *    cannot outlast the user's patience;
 *    a body that is not text — a NUL byte or an undecodable one — is refused
 *    on its content, never on its extension.
 *  A script is fetched AS TEXT and nothing ever runs it; it still rides the
 *  scanSkillText the folder import already applies to every file in a group,
 *  which is what keeps a `scripts/payload.sh` out of the library rather than
 *  executing it. */
const HEAD_TIMEOUT_MS = 15_000;
const HEAD_MAX_CHARS = 400_000;
const SIBLING_TIMEOUT_MS = 20_000;
const SIBLING_MAX_CHARS = 200_000;
const BATCH_MAX_CHARS = 600_000;

export interface UrlSkillFetch {
    /** Every file this fetch produced, head first, each carrying the relPath
     *  that makes importSkillFiles bundle the siblings under the skill's slug.
     *  Absent only when the head itself could not be fetched. */
    files?: Array<SkillFileRead & { content: string }>;
    /** A sibling the body named that did NOT arrive, with the reason. */
    refused?: Array<{ path: string; reason: string }>;
    error?: string;
}

/** What a timed-out fetch looks like, told from any other throw. */
const fetchFailure = (err: unknown, timeoutNote: string): string => {
    if (err instanceof Error) {
        return err.name === 'TimeoutError' || err.name === 'AbortError' ? timeoutNote : err.message;
    }
    return String(err);
};

/** The notebook stores text and the L2 reader hands it to a model, so a
 *  binary body is refused on its CONTENT, not on its extension: a NUL byte or
 *  a UTF-8 replacement character means the bytes were never text, whatever
 *  they were named. */
const looksBinary = (text: string): boolean => text.includes('\u0000') || text.includes('\uFFFD');

/** The folder name the fetched files claim to have arrived in. A spec-shaped
 *  `…/my-skill/SKILL.md` keeps its own folder; a bare `…/my-skill.md` gets a
 *  folder named after the file, so its siblings still group under one root. */
const folderOf = (head: URL): string => {
    const segs = head.pathname.split('/').filter(Boolean);
    const file = decodeURIComponent(segs.pop() ?? '');
    const parent = segs.length ? decodeURIComponent(segs[segs.length - 1]) : '';
    const stem = file.replace(/\.md$/i, '');
    const candidate = parent || (stem && stem.toLowerCase() !== 'skill' ? stem : '');
    return slugifyName(candidate) || 'imported-skill';
};

export const fetchSkillFromUrl = async (rawUrl: string): Promise<UrlSkillFetch> => {
    const raw = rawUrl.trim();
    if (!/^https:\/\//i.test(raw)) return { error: 'only https:// URLs are fetched' };
    let head: URL;
    try { head = new URL(raw) } catch { return { error: 'that is not a URL' } }
    const folder = folderOf(head);

    let headText: string;
    try {
        const res = await fetch(head.toString(), { signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
        if (!res.ok) return { error: `the URL answered ${res.status}` };
        const text = await res.text();
        if (text.length > HEAD_MAX_CHARS) return { error: `the URL returned ${(text.length / 1000).toFixed(0)}kB of text — over the 400kB fetch cap` };
        if (looksBinary(text)) return { error: 'the URL is not text — a skill import stores markdown, and a binary body is never read' };
        headText = text;
    } catch (err) {
        return { error: fetchFailure(err, `the fetch timed out after ${HEAD_TIMEOUT_MS / 1000}s`) };
    }

    // The head is always named SKILL.md with a two-segment relPath, whatever
    // the URL's last segment was spelled: that pair is how importSkillFiles
    // recognises a folder root and starts bundling.
    const files: Array<SkillFileRead & { content: string }> = [
        { name: 'SKILL.md', content: headText, relPath: `${folder}/SKILL.md` },
    ];
    const refused: Array<{ path: string; reason: string }> = [];

    const found = skillSupportRefs(headText);
    if (found.length === 0) return { files, refused };
    const candidates = found.slice(0, SKILL_SUPPORT_REF_MAX);
    if (found.length > SKILL_SUPPORT_REF_MAX) {
        refused.push({ path: '(the rest)', reason: `the body names more than ${SKILL_SUPPORT_REF_MAX} support files and only the first ${SKILL_SUPPORT_REF_MAX} are fetched` });
    }

    // One deadline for the whole concurrent sibling fetch — AbortSignal is
    // shareable, and a per-file timer would let 12 slow files run 12×20s.
    const deadline = AbortSignal.timeout(SIBLING_TIMEOUT_MS);
    type Sibling = { path: string; text?: string; reason?: string };
    const settled = await Promise.all(candidates.map(async (ref): Promise<Sibling> => {
        const target = resolveSiblingUrl(head, ref);
        if (!target.ok) return { path: ref, reason: target.reason };
        try {
            const res = await fetch(target.url, { signal: deadline });
            if (!res.ok) return { path: ref, reason: `the URL answered ${res.status}` };
            const text = await res.text();
            if (looksBinary(text)) return { path: ref, reason: 'the file is not text — only text is storable in the notebook' };
            if (text.length > SIBLING_MAX_CHARS) return { path: ref, reason: `${(text.length / 1000).toFixed(0)}kB — over the ${SIBLING_MAX_CHARS / 1000}kB per-file cap` };
            return { path: ref, text };
        } catch (err) {
            return { path: ref, reason: fetchFailure(err, `the fetch did not finish inside the ${SIBLING_TIMEOUT_MS / 1000}s batch window`) };
        }
    }));

    // Batch budget, applied in body order so the receipt is reproducible: the
    // files a skill names first are the ones it most likely needs.
    let room = BATCH_MAX_CHARS - headText.length;
    for (const s of settled) {
        if (s.reason) { refused.push({ path: s.path, reason: s.reason }); continue; }
        const text = s.text ?? '';
        if (text.length > room) {
            refused.push({ path: s.path, reason: `the batch was already at its ${(BATCH_MAX_CHARS / 1000).toFixed(0)}kB cap` });
            continue;
        }
        room -= text.length;
        files.push({ name: s.path.split('/').pop() ?? `${folder}.md`, content: text, relPath: `${folder}/${s.path}` });
    }
    return { files, refused };
};

/** Read a FileList of .md files into per-file outcomes. One unreadable
 *  file must NOT sink the batch (matches the service's "report, never
 *  silently drop" contract): successes carry content, failures carry a
 *  reason and surface as normal import failures in the UI. */
export interface SkillFileRead {
    name: string;
    content?: string;
    error?: string;
    /** The path inside the picked folder, when the picker supplied one
     *  (webkitRelativePath). This is what lets a FOLDER import keep its
     *  shape: `my-skill/references/checklist.md` knows it belongs to the
     *  skill whose SKILL.md sits in `my-skill/`. */
    relPath?: string;
}

export const readSkillFiles = async (fileList: FileList | File[]): Promise<SkillFileRead[]> => {
    const files = Array.from(fileList);
    const results = await Promise.allSettled(
        files.map(file => new Promise<{ name: string; content: string; relPath?: string }>((resolve, reject) => {
            const rel = file.webkitRelativePath;
            const reader = new FileReader();
            reader.onload = () => {
                if (typeof reader.result !== 'string') {
                    reject(new Error('File is not readable as text'));
                } else if (looksBinary(reader.result)) {
                    reject(new Error('The file is not text — binary assets are not supported by the notebook'));
                } else {
                    resolve({ name: file.name, content: reader.result, ...(rel ? { relPath: rel } : {}) });
                }
            };
            reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
            reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled`));
            reader.readAsText(file);
        })),
    );
    return results.map((r, i) =>
        r.status === 'fulfilled'
            ? r.value
            : {
                name: files[i].name,
                ...(files[i].webkitRelativePath ? { relPath: files[i].webkitRelativePath } : {}),
                error: r.reason instanceof Error ? r.reason.message : String(r.reason),
            },
    );
};
