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
const MAX_FINGERPRINTS = 200;

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
 *  caller did not supply one. Pure apart from the default clock. */
export const resolveProvenance = (prov?: ProvenanceInput): Provenance | undefined => {
    if (!prov || typeof prov !== 'object') return undefined;
    return {
        rationale: prov.rationale,
        observedOutcome: prov.observedOutcome,
        modelId: prov.modelId,
        recordedAt: prov.recordedAt ?? new Date().toISOString(),
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

const readBlob = async (username: string): Promise<RejectedBlob> => {
    try {
        const raw = await getPreferenceObject<Partial<RejectedBlob>>(`${KEY_PREFIX}${username}`);
        if (!raw || !Array.isArray(raw.rows)) return { version: 1, rows: [] };
        return {
            version: 1,
            rows: raw.rows.filter(r => r && typeof r.fingerprint === 'string' && typeof r.at === 'string'),
        };
    } catch {
        return { version: 1, rows: [] };
    }
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
    const provenance = resolveProvenance(options?.provenance);
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

/** True when this exact suggestion was refused before. An empty/corrupt store
 *  is an honest "not rejected" — the read never throws to a writer. */
export const isRejectedFingerprint = async (
    parts: { kind: string; target?: string; content: string },
    username = getActiveUsername() || 'default',
): Promise<boolean> => {
    const fingerprint = rejectionFingerprint(parts);
    try {
        const blob = await readBlob(username);
        return blob.rows.some(r => r.fingerprint === fingerprint);
    } catch {
        return false;
    }
};

export const listRejectedFingerprints = async (
    username = getActiveUsername() || 'default',
): Promise<RejectedFingerprintRow[]> => (await readBlob(username)).rows;
