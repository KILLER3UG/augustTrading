import { getPreferenceArray, setPreferenceObject } from '../infrastructure/PreferencesService';
import { withSerializedPref } from '../infrastructure/serializedPrefs';

export interface InjectedSource {
    path: string;
    kind: string;
    /** Actual chars of this block that made it into the prompt —
     *  the per-source cost half of budget economics. Absent on legacy
     *  records (cost falls back to the block-class average). */
    chars?: number;
    /** Identity of the exact rendered block, for blocks whose TEXT varies while
     *  their `path` stays fixed (the recent-form brief differs by audience and
     *  by window). Lets a stored decision be traced to the context it saw. */
    fingerprint?: string;
}

export interface MemoryInjectionRecord {
    ts: string;
    stage: string;
    audience: string;
    coin?: string;
    sources: InjectedSource[];
    runId?: string;
}

const KEY_PREFIX = 'memory_injections_v1_';
export const MAX_INJECTION_RECORDS = 400;

const keyFor = (username: string): string =>
    `${KEY_PREFIX}${(username || 'default').trim() || 'default'}`;

/** Runtime shape check for a stored record — junk blobs must not flow into the
 *  readers that walk `r.sources` (the provenance strip, the monthly card). */
const isInjectionRecord = (item: unknown): item is MemoryInjectionRecord => {
    const r = item as MemoryInjectionRecord | null;
    return !!r && typeof r === 'object'
        && typeof r.ts === 'string'
        && typeof r.stage === 'string'
        && Array.isArray(r.sources);
};

export const recordMemoryInjection = async (
    username: string,
    record: Omit<MemoryInjectionRecord, 'ts'>,
): Promise<void> => {
    const key = keyFor(username);
    try {
        await withSerializedPref(key, async () => {
            const prev = await getRecentMemoryInjections(username);
            const next = [
                { ...record, ts: new Date().toISOString() },
                ...prev,
            ].slice(0, MAX_INJECTION_RECORDS);
            await setPreferenceObject(key, next);
        });
    } catch {
        // Telemetry must never break prompt assembly.
    }
};

export const getRecentMemoryInjections = async (
    username: string,
): Promise<MemoryInjectionRecord[]> => {
    try {
        return await getPreferenceArray<MemoryInjectionRecord>(keyFor(username), isInjectionRecord);
    } catch {
        return [];
    }
};
