/**
 * skillManage — the agent-facing lifecycle around the ONE skill pen.
 *
 * `writeSkillFile` (SkillFileService) stays the only writer of SKILL.md bytes.
 * This module adds what the pen deliberately does not own:
 *
 *   - `skill_manage`: create | patch | archive | unarchive, with structured
 *     playbook sections, a REGISTERED-TOOL check (a skill that names a desk
 *     tool that does not exist is refused — procedure that cannot be followed
 *     is not procedure), and a reversible sidecar receipt on every mutation.
 *   - Lifecycle metadata (created_by / status / pinned / last_used_at /
 *     source_session_id) in a SIDECAR store, NOT in SKILL.md. AGENTS.md rule 10
 *     forbids re-adding a status stamp to the skill file (and the legacy
 *     migration strips a `status:` frontmatter key on sight), so the file
 *     stays prose and the metadata stays queryable here.
 *   - The TRADING SAFETY GATE: an agent-created or agent-patched skill is
 *     `probation` — it is never self-promoted to `verified`. Promotion is
 *     gated on the empirical signal ledger (O-150): nEffective >=
 *     MIN_HOLDOUT_SAMPLE, computed the same way the harness holdout gate does.
 *   - The zero-LLM inactivity Curator: unused agent-created skills go
 *     `stale` at 14 days and `archived` at 30 — reversible, never a delete,
 *     and never touching user/bundled/pinned skills.
 *
 * Progressive disclosure already lives in SkillFileService: the prompt index
 * carries slug + description only, and `skill_view` opens the body on demand.
 * This module adds the status column and the archived filter on top.
 */

import {
    deleteSkillFile,
    getSkill,
    isBundledName,
    listSkillFiles,
    parseSkillMarkdown,
    skillIndexRows,
    writeSkillFile,
    type SkillIndexRow,
    type SkillWriteInput,
    type SkillWriteReview,
} from './SkillFileService';
import { updateMemoryFile } from './MemoryFilesService';
import { getPreference, setPreference } from '../infrastructure/PreferencesService';
import { getActiveUsername } from '../../utils/activeUser';
import { MIN_HOLDOUT_SAMPLE } from '../selfMod/harnessOptimization';
import { skillFormatIssues, missingSkillSections } from '../../utils/skillFrontmatter';
import { resolveProvenance, type Provenance, type ProvenanceInput } from './rejectedFingerprints';

export type SkillManageAction = 'create' | 'patch' | 'archive' | 'unarchive';
export type SkillStatus = 'probation' | 'verified' | 'stale' | 'archived';
export type SkillOrigin = 'bundled' | 'user' | 'agent' | 'review';

export const SKILL_STATUSES: readonly SkillStatus[] = ['probation', 'verified', 'stale', 'archived'];

/** The O-150 holdout floor a skill must clear before it may wear `verified`.
 *  Same number the harness-optimization holdout gate uses, on purpose: one
 *  empirical bar, not two. */
export { MIN_HOLDOUT_SAMPLE };

export interface SkillMeta {
    createdBy: SkillOrigin;
    status: SkillStatus;
    pinned?: boolean;
    lastUsedAt?: string;
    sourceSessionId?: string;
    createdAt: string;
    updatedAt: string;
    /** Optional WHY / WHICH MODEL for the mutation that last set this row.
     *  Sidecar only — never a status stamp in SKILL.md. The whole prior meta
     *  map is snapshotted into every undo, so provenance is reversible too. */
    provenance?: Provenance;
}

const META_KEY_PREFIX = 'skill_meta_v1_';

const metaKey = (username: string): string => `${META_KEY_PREFIX}${username}`;

/** The SYNC mirror of the lifecycle store. The prompt-index builder runs on
 *  the render path (synchronous), so it reads this cache — the same pattern
 *  the curated-memory snapshot uses. Primed once per boot/user switch; every
 *  write refreshes it. The async reads stay authoritative for tool calls. */
let metaCache: { owner: string; map: Record<string, SkillMeta> } | null = null;

/** Warm the sync mirror (once per boot / user switch). */
export const primeSkillMetaCache = async (username = getActiveUsername() || 'default'): Promise<void> => {
    await readMetaMap(username);
};

/** The last-known lifecycle map, synchronously. Empty before priming. */
export const getCachedSkillMetaMap = (username = getActiveUsername() || 'default'): Record<string, SkillMeta> =>
    (metaCache && metaCache.owner === username ? metaCache.map : {});

const readMetaMap = async (username: string): Promise<Record<string, SkillMeta>> => {
    try {
        const raw = await getPreference(metaKey(username));
        const parsed = raw ? (JSON.parse(raw) as Record<string, SkillMeta> | null) : null;
        const map = parsed && typeof parsed === 'object' ? parsed : {};
        metaCache = { owner: username, map };
        return map;
    } catch {
        return {};
    }
};

const writeMetaMap = async (username: string, map: Record<string, SkillMeta>): Promise<void> => {
    await setPreference(metaKey(username), JSON.stringify(map));
    metaCache = { owner: username, map };
};

export const getSkillMeta = async (
    slug: string,
    username = getActiveUsername() || 'default',
): Promise<SkillMeta | null> => {
    const map = await readMetaMap(username);
    return map[slug] ?? null;
};

/** The metadata a skill that has never been touched by this module carries.
 *  Bundled skills are seeded by bundledSkills; everything found in the
 *  notebook without a meta row is treated as trader-authored. */
export const defaultMetaFor = (slug: string, origin: SkillOrigin = 'user', nowMs = Date.now()): SkillMeta => ({
    createdBy: origin,
    status: origin === 'bundled' ? 'verified' : 'probation',
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
});

// ─── Registered-tool validation ─────────────────────────────────────────────

/**
 * Backticked tokens that READ as a tool call: `` `get_chart_view` `` after
 * "call/use/run/via/tool/invoke/load". A skill body that names a tool the
 * registry does not have is refused — the model would follow a procedure
 * whose step cannot be executed. Pure: the registry is injected, so the
 * check is testable offline and the executor passes the REAL names.
 */
const TOOL_CALL_CONTEXT = /\b(?:call|use|using|run|via|tool|invoke|load|open with)\b[^`\n]{0,32}`([a-z][a-z0-9_]{2,})`/gi;

export const findUnknownToolReferences = (
    body: string,
    knownTools: ReadonlySet<string>,
): string[] => {
    const unknown = new Set<string>();
    for (const match of (body || '').matchAll(TOOL_CALL_CONTEXT)) {
        const name = match[1];
        if (!knownTools.has(name)) unknown.add(name);
    }
    return [...unknown];
};

// ─── Section gate ───────────────────────────────────────────────────────────

/** The playbook sections `skill_manage` REQUIRES. `Procedure` accepts the
 *  repository's canonical `Steps` heading as the same section — one gate,
 *  two spellings, so a skill that passes this gate also passes the store's
 *  own format check. */
const REQUIRED_SECTION_PATTERNS: Array<{ label: string; re: RegExp }> = [
    { label: 'When to Use', re: /^#{1,6}[ \t]*when[ \t]+to[ \t]+use\b/im },
    { label: 'Procedure', re: /^#{1,6}[ \t]*(?:procedure|steps)\b/im },
    { label: 'Pitfalls', re: /^#{1,6}[ \t]*pitfalls\b/im },
    { label: 'Verification', re: /^#{1,6}[ \t]*verification\b/im },
];

export const missingPlaybookSections = (body: string): string[] =>
    REQUIRED_SECTION_PATTERNS.filter(p => !p.re.test(body || '')).map(p => p.label);

// ─── skill_manage core ──────────────────────────────────────────────────────

export interface SkillManageInput {
    action: SkillManageAction;
    slug?: string;
    name?: string;
    description?: string;
    /** create: the full body. patch: only new_text lands (old_text → new_text). */
    body?: string;
    /** patch: the exact body text to replace (must occur exactly once). */
    old_text?: string;
    /** patch: the replacement text. */
    new_text?: string;
    /** patch on an existing skill: the version the caller read (optimistic lock). */
    if_version?: string;
    /** create: how this skill came to be. The desk tool fixes 'agent'. */
    created_by?: SkillOrigin;
    source_session_id?: string;
    /** Optional WHY / WHICH MODEL for this mutation. Accepted both here and
     *  as the optional 5th positional provenance argument, so either call
     *  shape compiles. Persisted to the sidecar through `writeMetaMap` only. */
    provenance?: ProvenanceInput;
}

/**
 * Complete, reversible undo for ONE `skill_manage` mutation. The old receipt
 * carried only the meta sidecar, so a 1-click Undo restored the status badge
 * but left the new SKILL.md bytes (or, on a create, left the whole skill) in
 * place. `undoSkillManageMutation` consumes this and restores BOTH halves.
 */
export interface SkillManageUndoSnapshot {
    slug: string;
    action: SkillManageAction;
    /** True when this mutation created the skill — undo DELETES it. */
    created: boolean;
    /** Exact prior SKILL.md bytes; null when the skill did not exist. */
    priorFileContent: string | null;
    /** The whole prior sidecar map — restoring it also drops a created row. */
    priorMeta: Record<string, SkillMeta>;
}

export interface SkillManageReceipt {
    ok: boolean;
    action: SkillManageAction;
    slug: string;
    /** Prior lifecycle metadata, for the 1-click undo (Pass 2 UI). */
    undoSnapshot?: Record<string, SkillMeta>;
    /** Complete reversible snapshot (SKILL.md bytes + sidecar). */
    undoSkill?: SkillManageUndoSnapshot;
    /** patch only: the body bytes before the edit, so a content revert is a
     *  plain `patch` in the other direction. */
    priorBody?: string;
    /** The NEW rule in the exact shape learningPassWiring.emit fingerprints
     *  (`body | description`). Undo records THIS, never the restored bytes. */
    rejectedContent?: string;
    status?: SkillStatus;
    priorStatus?: SkillStatus;
    created?: boolean;
    /** The provenance stamped on this mutation's sidecar row (when supplied). */
    provenance?: Provenance;
    error?: string;
    /** create refusals name the near-duplicates to update or merge instead. */
    duplicates?: Array<{ slug: string; reason: string }>;
}

/**
 * Run one `skill_manage` action. All file writes go through `writeSkillFile`
 * (the ONE pen), so the duplicate scan, the security scan and the format
 * rules apply to agent-authored skills exactly as they do to every other
 * write — `skill_manage` adds the lifecycle gate on top, never a bypass.
 *
 * @param knownDeskTools the REAL tool names from DeskToolsService's registry —
 *   injected by the executor so this module stays independent of the whale.
 */
export const skillManage = async (
    input: SkillManageInput,
    knownDeskTools: ReadonlySet<string>,
    username = getActiveUsername() || 'default',
    review?: SkillWriteReview,
    provenanceArg?: ProvenanceInput | { provenance?: ProvenanceInput },
): Promise<SkillManageReceipt> => {
    const action = input?.action;
    if (action !== 'create' && action !== 'patch' && action !== 'archive' && action !== 'unarchive') {
        return { ok: false, action: 'create', slug: '', error: 'action must be create | patch | archive | unarchive.' };
    }
    const slug = (input.slug || '').trim().toLowerCase();
    if (!slug) return { ok: false, action, slug: '', error: 'slug is required.' };
    const existing = getSkill(slug);
    const metaMap = await readMetaMap(username);
    const undoSnapshot: Record<string, SkillMeta> = JSON.parse(JSON.stringify(metaMap));
    const undoSkill: SkillManageUndoSnapshot = {
        slug,
        action,
        created: action === 'create',
        priorFileContent: existing?.file.content ?? null,
        priorMeta: JSON.parse(JSON.stringify(metaMap)),
    };
    // WHY / WHICH MODEL — resolved once; `modelId` is only ever the injected
    // value, never inferred here. The 5th argument is the provenance object
    // itself (the Desktop tool passes rationale/modelId/recordedAt directly);
    // an `{ provenance: … }` wrapper is also accepted for symmetry with the
    // other stores. The undo snapshots above already captured the PRIOR meta
    // (incl. any prior provenance), so undo stays reversible.
    const fifth = provenanceArg && typeof provenanceArg === 'object' && 'provenance' in provenanceArg
        ? (provenanceArg as { provenance?: ProvenanceInput }).provenance
        : (provenanceArg as ProvenanceInput | undefined);
    const provenance = resolveProvenance(input.provenance ?? fifth ?? undefined);

    // ── archive / unarchive: lifecycle only, bytes untouched ────────────────
    if (action === 'archive' || action === 'unarchive') {
        if (!existing) {
            return { ok: false, action, slug, undoSnapshot, error: `No skill "${slug}" to ${action}.` };
        }
        const meta = metaMap[slug] ?? defaultMetaFor(slug, 'user');
        const priorStatus = meta.status;
        if (action === 'archive' && priorStatus === 'archived') {
            return { ok: false, action, slug, undoSnapshot, priorStatus, status: priorStatus, error: `"${slug}" is already archived.` };
        }
        if (action === 'unarchive' && priorStatus !== 'archived') {
            return { ok: false, action, slug, undoSnapshot, priorStatus, status: priorStatus, error: `"${slug}" is not archived (status: ${priorStatus}).` };
        }
        // Unarchive lands at PROBATION, never straight at verified: the
        // empirical gate is the only promotion path, and an archive/unarchive
        // round-trip is not evidence.
        meta.status = action === 'archive' ? 'archived' : 'probation';
        meta.updatedAt = new Date().toISOString();
        if (provenance) meta.provenance = provenance;
        metaMap[slug] = meta;
        await writeMetaMap(username, metaMap);
        return {
            ok: true, action, slug, undoSnapshot, undoSkill, rejectedContent: '',
            priorStatus, status: meta.status, created: false, provenance,
        };
    }

    // ── create / patch: through the ONE pen ─────────────────────────────────
    const createdBy: SkillOrigin = input.created_by ?? 'agent';
    if (action === 'create' && existing) {
        return { ok: false, action, slug, undoSnapshot, error: `Skill "${slug}" already exists — use action "patch".` };
    }
    if (action === 'patch' && !existing) {
        return { ok: false, action, slug, undoSnapshot, error: `No skill "${slug}" to patch — use action "create".` };
    }

    let writeInput: SkillWriteInput;
    let priorBody: string | undefined;
    if (action === 'create') {
        const body = (input.body ?? '').trim();
        if (!body) return { ok: false, action, slug, undoSnapshot, error: 'body is required to create a skill.' };
        const missing = missingPlaybookSections(body);
        if (missing.length > 0) {
            return {
                ok: false, action, slug, undoSnapshot,
                error: `A playbook needs these ## sections: ${missing.join(', ')}. Write the procedure, do not describe it.`,
            };
        }
        writeInput = { slug, name: input.name, description: input.description ?? '', body };
    } else {
        const parsed = parseSkillMarkdown(existing!.file.content);
        priorBody = parsed?.body ?? existing!.file.content;
        const oldText = input.old_text ?? '';
        const newText = input.new_text ?? '';
        if (!oldText.trim() || !newText.trim()) {
            return { ok: false, action, slug, undoSnapshot, priorBody, error: 'patch needs old_text and new_text — prefer a targeted patch over a rewrite.' };
        }
        // The version the caller read is MANDATORY on a patch, exactly as it
        // is for skill_write (AGENTS.md rule 10). Defaulting to the current
        // version let a model edit a skill it had never opened.
        if (!input.if_version) {
            return { ok: false, action, slug, undoSnapshot, priorBody, error: 'patch needs if_version — the version skill_view showed. Read the skill first.' };
        }
        const first = priorBody.indexOf(oldText);
        if (first < 0) {
            return { ok: false, action, slug, undoSnapshot, priorBody, error: 'old_text was not found in the skill body. Read skill_view first and copy the text exactly.' };
        }
        if (priorBody.indexOf(oldText, first + 1) >= 0) {
            return { ok: false, action, slug, undoSnapshot, priorBody, error: 'old_text occurs more than once in the body — include more surrounding text so the patch is unambiguous.' };
        }
        const patchedBody = priorBody.replace(oldText, newText);
        const missing = missingPlaybookSections(patchedBody);
        if (missing.length > 0) {
            return {
                ok: false, action, slug, undoSnapshot, priorBody,
                error: `This patch would drop required ## sections: ${missing.join(', ')}.`,
            };
        }
        writeInput = {
            slug,
            name: input.name ?? existing!.name,
            description: input.description ?? existing!.description,
            body: patchedBody,
            ifVersion: input.if_version ?? existing!.version,
        };
    }

    // REGISTERED-TOOL CHECK: the body may only name desk tools that exist.
    const unknownTools = findUnknownToolReferences(`${writeInput.description ?? ''}\n${writeInput.body ?? ''}`, knownDeskTools);
    if (unknownTools.length > 0) {
        return {
            ok: false, action, slug, undoSnapshot, priorBody,
            error: `Refused: the body names desk tools that do not exist (${unknownTools.map(t => `\`${t}\``).join(', ')}). `
                + 'A skill may only reference tools from the desk catalogue — fix the names or describe the step without naming a tool.',
        };
    }

    const writeResult = await writeSkillFile(writeInput, username, review);
    if (!writeResult.ok) {
        return {
            ok: false, action, slug, undoSnapshot, priorBody,
            error: `skill_write refused: ${writeResult.message}`,
            duplicates: writeResult.matches?.map(m => ({ slug: m.slug, reason: m.reason })),
        };
    }

    // LIFECYCLE: an agent-created skill starts at probation and STAYS there
    // until the ledger earns it a promotion. A patch is NEW procedure — even
    // a previously verified agent skill returns to probation so the CURRENT
    // bytes must earn their own evidence. Patching a user/bundled skill leaves
    // its origin and status untouched: the agent is not their owner.
    const priorMeta = metaMap[slug];
    const meta: SkillMeta = priorMeta
        ? { ...priorMeta, updatedAt: new Date().toISOString() }
        : defaultMetaFor(slug, createdBy === 'bundled' ? 'bundled' : createdBy, Date.now());
    if (!priorMeta && input.source_session_id) meta.sourceSessionId = input.source_session_id;
    if (meta.createdBy === 'agent' || meta.createdBy === 'review') meta.status = 'probation';
    if (provenance) meta.provenance = provenance;
    metaMap[slug] = meta;
    await writeMetaMap(username, metaMap);

    return {
        ok: true, action, slug, undoSnapshot, undoSkill, priorBody,
        rejectedContent: `${String(writeInput.body ?? '')} | ${String(writeInput.description ?? '')}`,
        created: action === 'create', status: meta.status,
        priorStatus: priorMeta?.status, provenance,
    };
};

// ─── EfficientSkill: post-verification pruning ──────────────────────────────

/** A verified playbook over this many chars is a prune candidate. Named so a
 *  contract can pin the ceiling; never raised to make a gate green. */
export const SKILL_PRUNE_MAX_CHARS = 2800;
/** Refuse a prune whose result would be thinner than this — a body that small
 *  has no redundant bulk to remove, so shrinking it further is damage. */
export const SKILL_PRUNE_MIN_CHARS = 1600;

export interface SkillPruneResult {
    ok: boolean;
    /** The deduplicated body, or the ORIGINAL verbatim on refusal. */
    prunedBody: string;
    /** Restore bytes: write `priorBody` back through `writeSkillFile`. */
    undoSnapshot: { priorBody: string };
    removed: number;
    reason?: string;
}

const BULLET_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING_LINE_RE = /^\s*#{1,6}\s/;
/** A line carrying a tool check or verification command is NEVER removed,
 *  even when textually duplicated: it is the playbook's PROOF, not bulk. */
const TOOL_CHECK_RE = /(`[a-z][a-z0-9_]{2,}`|\b(?:npm\s+run|node\s+--check|git\s+(?:status|diff)|check:[a-z-]+|--testid|curl\b|GET\s+\/|POST\s+\/|assert\s*\(|--verify|--confirm))/i;

/**
 * Deterministic, reversible, bullet-only compaction for an already-VERIFIED
 * playbook. Removes ONLY repeated bullet lines (normalized whitespace/case)
 * and runs of blank lines. Headings, prose that is not a duplicate, and every
 * line that carries a tool check / verification command are preserved.
 *
 * Both section validators must survive — `skillManage.missingPlaybookSections`
 * and `utils/skillFrontmatter.missingSkillSections` — or the skill drops out
 * of the prompt index. Any guard failure is a ZERO-CHANGE refusal, not a
 * partial rewrite. Pure: no clock, no store, no model.
 */
export const pruneVerifiedSkill = (
    body: string,
    opts: { maxChars?: number; minChars?: number } = {},
): SkillPruneResult => {
    const original = String(body ?? '');
    const undoSnapshot: SkillPruneResult['undoSnapshot'] = { priorBody: original };
    const refuse = (reason: string): SkillPruneResult => ({
        ok: false, prunedBody: original, undoSnapshot, removed: 0, reason,
    });
    const max = opts.maxChars ?? SKILL_PRUNE_MAX_CHARS;
    const min = opts.minChars ?? SKILL_PRUNE_MIN_CHARS;

    const lines = original.split('\n');
    const headings = lines.filter(l => HEADING_LINE_RE.test(l));
    const seen = new Set<string>();
    const kept: string[] = [];
    let removed = 0;
    let blankRun = 0;
    for (const line of lines) {
        if (!line.trim()) {
            blankRun += 1;
            if (blankRun > 1) { removed += 1; continue; }
            kept.push(line);
            continue;
        }
        blankRun = 0;
        if (!BULLET_LINE_RE.test(line) || HEADING_LINE_RE.test(line) || TOOL_CHECK_RE.test(line)) {
            kept.push(line);
            continue;
        }
        const key = line.trim().replace(/\s+/g, ' ').toLowerCase();
        if (seen.has(key)) { removed += 1; continue; }
        seen.add(key);
        kept.push(line);
    }
    const prunedBody = kept.join('\n');
    if (removed === 0) return refuse(original.length > max
        ? `No duplicate bullets or repeated blank lines to remove in this ${original.length}-char playbook.`
        : 'No duplicate bullets or repeated blank lines — nothing safe to remove.');
    if (prunedBody.length < min) return refuse(`Pruned body would be ${prunedBody.length} chars, below the ${min}-char floor.`);
    if (missingPlaybookSections(prunedBody).length > 0 || missingSkillSections(prunedBody).length > 0) {
        return refuse('Pruning would drop a required ## section.');
    }
    const survivors = new Set(prunedBody.split('\n'));
    if (headings.some(h => !survivors.has(h))) return refuse('Pruning would alter a required heading verbatim.');
    return { ok: true, prunedBody, undoSnapshot, removed };
};

// ─── Usage + promotion ──────────────────────────────────────────────────────

/** Stamp `last_used_at` when a skill is loaded/invoked (skill_view, /slug). */
export const touchSkillUsage = async (
    slug: string,
    nowMs = Date.now(),
    username = getActiveUsername() || 'default',
): Promise<void> => {
    const map = await readMetaMap(username);
    const meta = map[slug];
    if (!meta) return;
    const stamp = new Date(nowMs).toISOString();
    if (meta.lastUsedAt === stamp) return;
    meta.lastUsedAt = stamp;
    meta.updatedAt = stamp;
    map[slug] = meta;
    await writeMetaMap(username, map);
};

export interface SkillPromotionVerdict {
    promoted: boolean;
    slug: string;
    status: SkillStatus;
    nEffective?: number;
    required: number;
    reason: string;
    /** Present ONLY when post-verification pruning actually rewrote bytes.
     *  A `SkillManageUndoSnapshot` — feed it to `undoSkillManageMutation` to
     *  restore the pre-prune SKILL.md AND the verified sidecar together. */
    undoSnapshot?: SkillManageUndoSnapshot;
    pruned?: boolean;
    prunedCount?: number;
    notes?: string[];
}

/**
 * The ONLY path from probation to verified. Empirical, per O-150: the skill's
 * own record must clear `MIN_HOLDOUT_SAMPLE` effective (overlap-weighted)
 * samples. `evidence.nEffective` is injected by callers that already computed
 * it; otherwise it is computed from the settled signal ledger the same way
 * the harness holdout gate does. There is no "promote because it looks good".
 */
export const promoteSkillToVerified = async (
    slug: string,
    evidence?: { nEffective?: number },
    username = getActiveUsername() || 'default',
    provenance?: ProvenanceInput,
): Promise<SkillPromotionVerdict> => {
    const map = await readMetaMap(username);
    const meta = map[slug];
    if (!meta) {
        return { promoted: false, slug, status: 'probation', required: MIN_HOLDOUT_SAMPLE, reason: `No skill "${slug}" in the lifecycle store.` };
    }
    if (meta.createdBy !== 'agent' && meta.createdBy !== 'review') {
        return { promoted: false, slug, status: meta.status, required: MIN_HOLDOUT_SAMPLE, reason: `Only agent-authored skills are promotion-gated ("${slug}" is ${meta.createdBy}).` };
    }
    let nEffective = evidence?.nEffective;
    if (typeof nEffective !== 'number') {
        try {
            const { readSignals } = await import('../signals/signalLedger');
            const { computeNEffective } = await import('../analysis/journalTools');
            const rows = readSignals(username).filter(r => r.resolution && r.signal.source === 'signal');
            nEffective = computeNEffective(rows.map(r => ({ emittedAt: r.signal.emittedAt, resolvedAt: r.resolution!.at }))).nEffective;
        } catch {
            nEffective = 0;
        }
    }
    if (nEffective < MIN_HOLDOUT_SAMPLE) {
        return {
            promoted: false, slug, status: meta.status, nEffective, required: MIN_HOLDOUT_SAMPLE,
            reason: `Refused: nEffective ${nEffective} < ${MIN_HOLDOUT_SAMPLE} (O-150). The skill stays ${meta.status} until the ledger proves it.`,
        };
    }
    meta.status = 'verified';
    meta.updatedAt = new Date().toISOString();
    const stamp = resolveProvenance(provenance);
    if (stamp) meta.provenance = stamp;
    map[slug] = meta;
    await writeMetaMap(username, map);

    const verdict: SkillPromotionVerdict = {
        promoted: true, slug, status: 'verified', nEffective, required: MIN_HOLDOUT_SAMPLE,
        reason: 'Promoted on empirical holdout evidence.',
    };
    // EFFICIENT SKILL — POST-verification only. Pruning is never a gate on
    // promotion: the skill already wears `verified`. The deterministic pass
    // may only drop duplicate bullets / blank runs; a guard failure is a
    // ZERO-CHANGE refusal with an honest note, and a successful rewrite goes
    // through `writeSkillFile` (the ONE pen) with the version just read.
    const skill = getSkill(slug);
    const parsed = skill ? parseSkillMarkdown(skill.file.content) : null;
    if (skill && parsed) {
        const prune = pruneVerifiedSkill(parsed.body);
        if (prune.ok && prune.removed > 0) {
            const written = await writeSkillFile({
                slug, name: skill.name, description: skill.description,
                body: prune.prunedBody, ifVersion: skill.version,
            }, username);
            if (written.ok) {
                verdict.undoSnapshot = {
                    slug, action: 'patch', created: false,
                    priorFileContent: skill.file.content,
                    // Pre-prune state: already verified (the promotion itself
                    // is not undone) — undoing the prune restores verified +
                    // the original bytes together.
                    priorMeta: JSON.parse(JSON.stringify(map)),
                };
                verdict.pruned = true;
                verdict.prunedCount = prune.removed;
                verdict.notes = [`Pruned ${prune.removed} duplicate line(s) after verification (reversible).`];
            } else {
                verdict.notes = [`Post-verification prune refused by the one pen: ${written.message} — verified bytes unchanged.`];
            }
        } else if (!prune.ok) {
            verdict.notes = [`Post-verification prune skipped: ${prune.reason}`];
        }
    }
    return verdict;
};

// ─── The zero-LLM inactivity Curator ────────────────────────────────────────

export const CURATOR_STALE_DAYS = 14;
export const CURATOR_ARCHIVE_DAYS = 30;

export interface CuratorTransition {
    slug: string;
    from: SkillStatus;
    to: SkillStatus;
    daysIdle: number;
}

export interface CuratorResult {
    transitions: CuratorTransition[];
    /** The whole prior meta map, for `undoSkillMetaSnapshot`. */
    undoSnapshot: Record<string, SkillMeta>;
    protectedSlugs: string[];
}

const daysBetween = (fromIso: string | undefined, nowMs: number): number => {
    const from = fromIso ? Date.parse(fromIso) : NaN;
    if (!Number.isFinite(from)) return 0;
    return Math.max(0, (nowMs - from) / 86_400_000);
};

/**
 * Pure deterministic pass over the lifecycle store. Agent-authored skills
 * idle >= 14 days go `stale`; >= 30 days go `archived`. Skills authored by
 * the trader (`user`), shipped (`bundled`), or explicitly `pinned` are NEVER
 * auto-archived. Reversible: the receipt carries the prior map. Nothing is
 * ever deleted — archived skills stay on disk, out of the prompt index.
 */
export const runSkillCurator = async (
    options: { nowMs?: number; staleDays?: number; archiveDays?: number; username?: string } = {},
): Promise<CuratorResult> => {
    const nowMs = options.nowMs ?? Date.now();
    const staleDays = options.staleDays ?? CURATOR_STALE_DAYS;
    const archiveDays = options.archiveDays ?? CURATOR_ARCHIVE_DAYS;
    const username = options.username || getActiveUsername() || 'default';
    const map = await readMetaMap(username);
    const undoSnapshot: Record<string, SkillMeta> = JSON.parse(JSON.stringify(map));
    const transitions: CuratorTransition[] = [];
    const protectedSlugs: string[] = [];
    for (const [slug, meta] of Object.entries(map)) {
        if (meta.createdBy !== 'agent' && meta.createdBy !== 'review') { protectedSlugs.push(slug); continue; }
        if (meta.pinned === true) { protectedSlugs.push(slug); continue; }
        if (meta.status === 'archived') continue;
        const idle = daysBetween(meta.lastUsedAt ?? meta.updatedAt ?? meta.createdAt, nowMs);
        const next: SkillStatus | null =
            idle >= archiveDays ? 'archived'
                : idle >= staleDays && meta.status !== 'stale' ? 'stale'
                    : null;
        if (!next) continue;
        transitions.push({ slug, from: meta.status, to: next, daysIdle: Math.floor(idle) });
        meta.status = next;
        meta.updatedAt = new Date(nowMs).toISOString();
        map[slug] = meta;
    }
    if (transitions.length > 0) await writeMetaMap(username, map);
    return { transitions, undoSnapshot, protectedSlugs };
};

/** Restore a curator / skill_manage undo snapshot wholesale. */
export const undoSkillMetaSnapshot = async (
    undoSnapshot: Record<string, SkillMeta>,
    username = getActiveUsername() || 'default',
): Promise<boolean> => {
    if (!undoSnapshot || typeof undoSnapshot !== 'object') return false;
    await writeMetaMap(username, JSON.parse(JSON.stringify(undoSnapshot)));
    return true;
};

export interface SkillUndoResult {
    ok: boolean;
    /** A patch/archive undo restored the exact prior SKILL.md bytes. */
    restoredFile: boolean;
    /** A create undo removed the skill (head + support files). */
    removedCreated: boolean;
    /** The sidecar map was restored (also drops a created skill's row). */
    restoredMeta: boolean;
    error?: string;
}

/**
 * The 1-click Undo behind a `skill_manage` receipt. Restores BOTH halves of
 * the mutation: the exact prior SKILL.md bytes (or deletes a newly created
 * skill, head + bundled files) AND the prior `skill_meta_v1_<user>` sidecar.
 * A meta-only undo left a patch's new procedure on disk while claiming the
 * skill was back to its old state — the receipt said "undone", the library
 * disagreed. Both writes go through the same one-pen/serialized paths as the
 * mutation; a file failure leaves the meta untouched and reports honestly.
 */
export const undoSkillManageMutation = async (
    snapshot: SkillManageUndoSnapshot,
    username = getActiveUsername() || 'default',
): Promise<SkillUndoResult> => {
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.slug !== 'string' || !snapshot.slug) {
        return { ok: false, restoredFile: false, removedCreated: false, restoredMeta: false, error: 'No skill undo snapshot.' };
    }
    let restoredFile = false;
    let removedCreated = false;
    try {
        const current = getSkill(snapshot.slug);
        if (snapshot.created) {
            if (current) {
                const removed = await deleteSkillFile(snapshot.slug, username);
                if (removed.error) {
                    return { ok: false, restoredFile, removedCreated, restoredMeta: false, error: removed.error };
                }
                removedCreated = removed.removed.length > 0;
            }
        } else if (snapshot.priorFileContent !== null && current) {
            if (current.file.content !== snapshot.priorFileContent) {
                await updateMemoryFile(current.file.id, { content: snapshot.priorFileContent }, username);
            }
            restoredFile = true;
        }
        const restoredMeta = await undoSkillMetaSnapshot(snapshot.priorMeta, username);
        return { ok: true, restoredFile, removedCreated, restoredMeta };
    } catch (e) {
        return {
            ok: false, restoredFile, removedCreated, restoredMeta: false,
            error: e instanceof Error ? e.message : String(e),
        };
    }
};

/** Test seeding: write exact lifecycle rows (incl. pinned / lastUsedAt states
 *  the public tools derive rather than accept). Same convention as the other
 *  `__*ForTests` seams in this repo. */
export const __seedSkillMetaForTests = async (
    map: Record<string, SkillMeta>,
    username = getActiveUsername() || 'default',
): Promise<void> => {
    await writeMetaMap(username, JSON.parse(JSON.stringify(map)));
};

// ─── Prompt-index support (progressive disclosure) ──────────────────────────

export interface SkillStatusRow {
    slug: string;
    status: SkillStatus;
    createdBy: SkillOrigin;
    pinned: boolean;
}

const statusRowsFromMap = (map: Record<string, SkillMeta>): Record<string, SkillStatusRow> => {
    const out: Record<string, SkillStatusRow> = {};
    for (const skill of listSkillFiles()) {
        const meta = map[skill.slug];
        // A skill the lifecycle store has never touched defaults by ORIGIN:
        // bundled procedure is shipped verified, everything else starts at
        // probation (the safe default — an untracked skill is unproven).
        const bundled = isBundledName(skill.file);
        out[skill.slug] = {
            slug: skill.slug,
            status: meta?.status ?? (bundled ? 'verified' : 'probation'),
            createdBy: meta?.createdBy ?? (bundled ? 'bundled' : 'user'),
            pinned: meta?.pinned === true,
        };
    }
    return out;
};

/** Status of every skill, for the compact index column (async = authoritative). */
export const skillStatusRows = async (
    username = getActiveUsername() || 'default',
): Promise<Record<string, SkillStatusRow>> => statusRowsFromMap(await readMetaMap(username));

/** The sync read for the render-path index builder (see the metaCache note). */
export const cachedSkillStatusRows = (): Record<string, SkillStatusRow> =>
    statusRowsFromMap(getCachedSkillMetaMap());

/** The rows the PROMPT index carries: archived skills drop out entirely (a
 *  note in retirement must not be re-offered as procedure; `stale` stays
 *  visible with its marker so the seat can revive it), and every line opens
 *  with its lifecycle marker so the seat sees probation/stale at a glance.
 *  ONE projection for every prompt consumer — the three-level disclosure is
 *  still slug + one line here, with the full body only via skill_view. */
export const promptSkillRows = (): SkillIndexRow[] => {
    const statuses = cachedSkillStatusRows();
    return filterArchivedSkillRows(skillIndexRows(), statuses).map((r) => {
        const st = statuses[r.slug];
        if (!st) return r;
        const pin = st.pinned ? ' · pinned' : '';
        return { ...r, description: `[${st.status}${pin}] ${(r.description || r.name || '').trim()}` };
    });
};

/** A prompt index must not point at an ARCHIVED skill (a note in retirement);
 *  `stale` stays visible with its marker so the seat can revive it. */
export const filterArchivedSkillRows = <T extends { slug: string }>(rows: T[], statuses: Record<string, SkillStatusRow>): T[] =>
    rows.filter(r => statuses[r.slug]?.status !== 'archived');

/** Format issues for one skill (shared with the editor). Re-exported so the
 *  desk tool and the index read the same gate without a second import path. */
export const skillFormatIssuesOf = (content: string): string[] => skillFormatIssues(content).map(i => i.what);
