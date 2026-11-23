/**
 * rejectedFingerprints — the DURABLE "do not propose this again" list.
 *
 * A trader who undoes a memory/skill write, or rejects an O-150 proposal, has
 * made a decision. Re-deriving the same rule on the next background review or
 * Dream is not persistence — it is the harness ignoring a refusal. This store
 * keeps a compact, normalized fingerprint of what was refused, per user, so
 * every future writer can skip the exact same suggestion across sessions.
 *
 * The fingerprint is a hash of the SEMANTIC payload (kind + target + text),
 * not of timestamps or receipt ids: a reworded wrapper around the same rule
 * must still be recognized, while a genuinely different rule is not.
 */

import { getPreferenceObject, setPreferenceObject } from '../infrastructure/PreferencesService';
import { getActiveUsername } from '../../utils/activeUser';

const KEY_PREFIX = 'rejected_fingerprints_v1_';
export { KEY_PREFIX as REJECTED_FINGERPRINT_KEY_PREFIX };
const MAX_FINGERPRINTS = 200;
/** Provenance text is a receipt line, not a transcript. A single rejection
 *  must never be able to write an unbounded blob into a durable preference. */
const PROVENANCE_TEXT_MAX = 500;
const MAX_OBSERVED_OUTCOMES = 8;

const capText = (value: string | undefined): string =>
    typeof value === 'string' ? value.slice(0, PROVENANCE_TEXT_MAX) : '';

export type RejectedSource = 'user_undo' | 'proposal_reject' | 'background_skip';

/**
 * Compact OPTIONAL provenance for a refusal or mutation: WHY it happened and
 * WHICH model proposed it. Deliberately a wrapper AROUND the semantic payload:
 *
 *   - it is NEVER part of `rejectionFingerprint`'s hash inputs (kind + target +
 *     normalized content only). If a rationale or model id entered the hash, a
 *     reworded wrapper would mint a fresh fingerprint and evade the durable
 *     refusal this store exists to enforce;
 *   - every field is optional on write EXCEPT `recordedAt`, which the writer
 *     defaults to now. Old rows have no provenance at all — no migration.
 *
 * `modelId` is always an INJECTED value. No module invents one.
 */
export interface Provenance {
    rationale?: string;
    observedOutcome?: string;
    /** Every outcome observed across re-records, oldest first. A re-record
     *  APPENDS here; it never rewrites where the refusal came from. */
    observedOutcomes?: string[];
    modelId?: string;
    recordedAt: string;
}

/** Caller-supplied provenance: all fields optional, `recordedAt` defaulted. */
export type ProvenanceInput = Partial<Omit<Provenance, 'recordedAt'>> & { recordedAt?: string };

export interface RejectedFingerprintRow {
    fingerprint: string;
    source: RejectedSource;
    /** Human-readable label for Settings/Undo receipts — never used for matching. */
    label: string;
    at: string;
    /** Optional WHY / WHICH MODEL. Never hashed — see `Provenance`. */
    provenance?: Provenance;
}

/** Resolve caller provenance into a storable row, stamping a clock when the
 *  caller did not supply one, and bounding every free-text field. Pure apart
 *  from the default clock. */
export const resolveProvenance = (prov?: ProvenanceInput): Provenance | undefined => {
    if (!prov || typeof prov !== 'object') return undefined;
    return {
        rationale: capText(prov.rationale) || undefined,
        observedOutcome: capText(prov.observedOutcome) || undefined,
        modelId: prov.modelId,
        recordedAt: prov.recordedAt ?? new Date().toISOString(),
    };
};

/**
 * Merge re-recorded provenance into the row's ORIGIN.
 *
 * The origin — `modelId`, `recordedAt` — survives a re-record unless the new
 * write explicitly names a replacement model; the durable refusal's age and
 * authorship are facts about the FIRST decision, not about the latest scan.
 * `observedOutcome` accumulates: each distinct observation is appended (once),
 * bounded per entry and in count. `rationale` may be refreshed. The 500-char
 * cap is applied HERE as well as on first write so legacy long text cannot
 * survive a merge.
 */
const mergeProvenance = (previous: Provenance | undefined, next: Provenance | undefined): Provenance | undefined => {
    if (!previous && !next) return undefined;
    const outcomes = [...(previous?.observedOutcomes ?? [])];
    if (previous?.observedOutcome) outcomes.push(previous.observedOutcome);
    if (next?.observedOutcome && next.observedOutcome !== previous?.observedOutcome) outcomes.push(next.observedOutcome);
    const observedOutcomes = [...new Set(outcomes.map(capText).filter(Boolean))].slice(-MAX_OBSERVED_OUTCOMES);
    const rationale = capText(next?.rationale || previous?.rationale);
    const observedOutcome = capText(next?.observedOutcome || previous?.observedOutcome);
    const modelId = next?.modelId || previous?.modelId;
    return {
        recordedAt: previous?.recordedAt ?? next?.recordedAt ?? new Date().toISOString(),
        ...(modelId ? { modelId } : {}),
        ...(rationale ? { rationale } : {}),
        ...(observedOutcome ? { observedOutcome } : {}),
        ...(observedOutcomes.length ? { observedOutcomes } : {}),
    };
};

interface RejectedBlob {
    version: 1;
    rows: RejectedFingerprintRow[];
}

/** FNV-1a over a normalized string: deterministic, dependency-free, stable
 *  across builds. Collisions are possible in theory; the stored `label` makes
 *  them visible to the trader, and a false positive only SUPPRESSES a
 *  suggestion — it never writes anything. */
export const hashRejectionText = (text: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
};

/** Collapse whitespace and case so a reformat is not a new rule. */
export const normalizeRejectionText = (text: string): string =>
    String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** One canonical fingerprinter for every writer — memory ops, skill bodies
 *  and O-150 proposals all go through this shape. */
export const rejectionFingerprint = (parts: {
    kind: string;
    target?: string;
    content: string;
}): string => {
    const kind = normalizeRejectionText(parts.kind);
    const target = normalizeRejectionText(parts.target ?? '');
    const content = normalizeRejectionText(parts.content);
    return `${kind}:${target}:${hashRejectionText(content)}`;
};

/**
 * Read the durable blob. A missing key is an empty store; a PRESENT but
 * unusable blob, or a backend failure, is a DEGRADED store and MUST throw.
 * Returning an empty list here is how a corruption silently disabled every
 * future refusal — the seat re-proposed exactly what the trader rejected.
 */
const readBlob = async (username: string): Promise<RejectedBlob> => {
    const raw = await getPreferenceObject<Partial<RejectedBlob>>(`${KEY_PREFIX}${username}`);
    if (!raw) return { version: 1, rows: [] };
    if (!Array.isArray(raw.rows)) {
        throw new Error(`rejected fingerprint store for "${username}" is degraded: rows is not an array`);
    }
    return {
        version: 1,
        rows: raw.rows.filter(r => r && typeof r.fingerprint === 'string' && typeof r.at === 'string'),
    };
};

const writeBlob = async (username: string, blob: RejectedBlob): Promise<void> => {
    await setPreferenceObject(`${KEY_PREFIX}${username}`, blob);
};

/** Record a refusal. Re-recording the same rule refreshes its timestamp and
 *  source but never duplicates it; the list is capped by evicting the oldest
 *  entry so a long-running profile cannot grow without bound. */
export const recordRejectedFingerprint = async (
    parts: { kind: string; target?: string; content: string },
    source: RejectedSource,
    label: string,
    username = getActiveUsername() || 'default',
    options?: { provenance?: ProvenanceInput },
): Promise<string> => {
    const fingerprint = rejectionFingerprint(parts);
    const blob = await readBlob(username);
    const existingIndex = blob.rows.findIndex(r => r.fingerprint === fingerprint);
    const provenance = mergeProvenance(blob.rows[existingIndex]?.provenance, resolveProvenance(options?.provenance));
    const row: RejectedFingerprintRow = {
        fingerprint,
        source,
        label: String(label ?? '').slice(0, 200),
        at: new Date().toISOString(),
        ...(provenance ? { provenance } : {}),
    };
    if (existingIndex >= 0) blob.rows[existingIndex] = row;
    else blob.rows.push(row);
    while (blob.rows.length > MAX_FINGERPRINTS) blob.rows.shift();
    await writeBlob(username, blob);
    return fingerprint;
};

export interface RejectionReadState {
    rejected: boolean;
    /** True when the durable store could not be read. Callers that enforce a
     *  refusal must NOT treat this as "not rejected". */
    degraded: boolean;
    error?: string;
}

/** Read with an explicit degraded flag instead of a bare boolean. A backend
 *  failure or a corrupt blob returns `degraded: true`; it never masquerades as
 *  an honest "not rejected". */
export const readRejectionState = async (
    parts: { kind: string; target?: string; content: string },
    username = getActiveUsername() || 'default',
): Promise<RejectionReadState> => {
    const fingerprint = rejectionFingerprint(parts);
    try {
        const blob = await readBlob(username);
        return { rejected: blob.rows.some(r => r.fingerprint === fingerprint), degraded: false };
    } catch (e) {
        return { rejected: false, degraded: true, error: e instanceof Error ? e.message : String(e) };
    }
};

/** True when this exact suggestion was refused before. A degraded store is a
 *  LOUD error, not a false: a false would disable refusal enforcement for the
 *  rest of the session and let the seat re-propose the trader's rejection. */
export const isRejectedFingerprint = async (
    parts: { kind: string; target?: string; content: string },
    username = getActiveUsername() || 'default',
): Promise<boolean> => {
    const state = await readRejectionState(parts, username);
    if (state.degraded) {
        throw new Error(`rejected fingerprint store is degraded: ${state.error ?? 'unreadable'}`);
    }
    return state.rejected;
};

export const listRejectedFingerprints = async (
    username = getActiveUsername() || 'default',
): Promise<RejectedFingerprintRow[]> => (await readBlob(username)).rows;
