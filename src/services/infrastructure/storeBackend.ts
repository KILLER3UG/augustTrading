/**
 * storeBackend — where the app's persistent bytes actually live.
 *
 * ON DESKTOP THEY ARE FILES. Every big store used renderer `localStorage`
 * (`PreferencesService` only takes its native branch on Capacitor; Electron is
 * not that), so chats, the notebook and the small raw stores shared one ~5 MiB
 * origin budget — while the product ruling is "store everything, no cap". This
 * module is the one place that knows the difference:
 *
 *   desktop  → `window.electronAPI.store` → electron/storeFs.cjs → JSON files
 *              under `<userData>/store`.
 *   web      → `localStorage`, exactly as before.
 *
 * THREE RULES.
 *  1. A WRITE NEVER VANISHES. If the desktop write fails, the value is also
 *     written to `localStorage` (which still exists) and the failure is
 *     RECORDED, so the session is not lost and the trader can be told.
 *  2. A FAILURE IS A VALUE, not a rejection — the bridge already resolves to
 *     `{ok,...}` and this keeps that shape, so no caller has to catch an IPC
 *     error it cannot name.
 *  3. LEGACY BYTES ARE COPIED, NOT MOVED. The first read of a key that exists
 *     only in `localStorage` writes it to the file, reads it BACK, and only then
 *     treats the file as authoritative. The old key stays until that read-back
 *     agrees, so a bad cutover costs nothing.
 */

export type StoreBackendKind = 'desktop-files' | 'browser-storage';

interface StoreBridge {
    read: (key: string) => Promise<{ ok: boolean; value?: string | null; error?: string }>;
    write: (key: string, value: string) => Promise<{ ok: boolean; error?: string }>;
    remove: (key: string) => Promise<{ ok: boolean; error?: string }>;
    location?: () => Promise<string | null>;
    /** Enumerate keys by prefix. Present only on the desktop bridge. */
    list?: (prefix: string) => Promise<{ ok: boolean; keys?: string[] }>;
}

export interface StoreFailure {
    key: string;
    error: string;
    at: number;
    /** True when the value was still written to localStorage — the session is
     *  not lost, the durability promise is. */
    fellBack: boolean;
}

const bridge = (): StoreBridge | undefined => {
    if (typeof window === 'undefined') return undefined;
    const api = (window as unknown as { electronAPI?: { store?: StoreBridge } }).electronAPI;
    return api?.store;
};

export const storeBackendKind = (): StoreBackendKind => (bridge() ? 'desktop-files' : 'browser-storage');

/** Keys this build has already copied out of localStorage, so the copy is tried
 *  once per boot rather than on every read. */
const migrated = new Set<string>();
let lastFailure: StoreFailure | null = null;
/** Set when a READ failed outright, per key. While a key is in this set its
 *  FILE is never written: a store whose contents we could not read must not be
 *  overwritten by whatever an empty-looking load would seed into it. The value
 *  still lands in the localStorage fallback (see writeStore), because that copy
 *  is what readStore already serves while the file is unreadable — a later
 *  successful read of that key clears the flag, and the next save rewrites the
 *  file from the in-memory state. A different key's success says nothing about
 *  this one. */
const failedKeys = new Set<string>();

export const getStoreFailure = (): StoreFailure | null => lastFailure;

const recordFailure = (failure: StoreFailure): void => { lastFailure = failure; };

/**
 * The file name for a preference key. Preference keys are `snake_case_user` but
 * a username can carry spaces and a few stores use `:` — neither is legal in a
 * store path, so every disallowed character is encoded as `-<hex>`. That is
 * reversible and unique for the keys this app actually uses (letters, digits,
 * `.`, `_`, `-`, space and `:`).
 */
export const fileKeyFor = (key: string): string =>
    `prefs/${key.replace(/[^A-Za-z0-9._-]/g, ch => `-${ch.codePointAt(0)!.toString(16)}`)}`;

/** Read one key. `{ok:true, value:null}` means "never written" — a first run. */
export const readStore = async (key: string): Promise<{ ok: true; value: string | null } | { ok: false; error: string }> => {
    const api = bridge();
    if (!api) {
        try {
            return { ok: true, value: localStorage.getItem(key) };
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    const fileKey = fileKeyFor(key);
    const res = await api.read(fileKey);
    if (!res.ok) {
        failedKeys.add(key);
        // An unusable file store must not hide data that is still in the browser
        // store; read the legacy copy and say the read went through it.
        try {
            const legacy = localStorage.getItem(key);
            if (legacy !== null) return { ok: true, value: legacy };
        } catch { /* private mode */ }
        return { ok: false, error: res.error ?? 'read failed' };
    }
    failedKeys.delete(key);
    if (res.value != null) return { ok: true, value: res.value };

    // First run for this key: copy the legacy bytes ONCE, verify, then serve.
    if (migrated.has(key)) return { ok: true, value: null };
    let legacy: string | null;
    try { legacy = localStorage.getItem(key); } catch { legacy = null; }
    if (legacy === null) { migrated.add(key); return { ok: true, value: null }; }
    const wrote = await api.write(fileKey, legacy);
    if (!wrote.ok) {
        recordFailure({ key, error: wrote.error ?? 'migration write failed', at: Date.now(), fellBack: true });
        return { ok: true, value: legacy }; // still serve the bytes we have; retry next read
    }
    const back = await api.read(fileKey);
    if (!back.ok || back.value !== legacy) {
        // The copy did not survive a read-back. Serve the legacy bytes and let the
        // next write try again; nothing has been deleted.
        recordFailure({ key, error: back.ok ? 'migration read-back mismatch' : (back.error ?? 'migration read failed'), at: Date.now(), fellBack: true });
        return { ok: true, value: legacy };
    }
    migrated.add(key);
    return { ok: true, value: back.value };
};

/** Write one key. On desktop a failed file write falls back to localStorage so
 *  the value is not lost, and records the failure either way. */
export const writeStore = async (key: string, value: string): Promise<{ ok: boolean; error?: string; backend: StoreBackendKind }> => {
    const api = bridge();
    if (!api) {
        try {
            localStorage.setItem(key, value);
            return { ok: true, backend: 'browser-storage' };
        } catch (err) {
            const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
            recordFailure({ key, error, at: Date.now(), fellBack: false });
            return { ok: false, error, backend: 'browser-storage' };
        }
    }
    if (failedKeys.has(key)) {
        // Refuse the FILE (see `failedKeys`) but keep the bytes recoverable: the
        // same localStorage copy readStore falls back to is the live copy while
        // the file is unreadable, and letting it go stale would lose every write
        // for the length of the outage. The flag clears on the next successful
        // read, and the next save then rewrites the file from memory.
        const error = `store key "${key}" is unavailable after a failed read — refusing to overwrite the file`;
        let fellBack = false;
        try {
            localStorage.setItem(key, value);
            fellBack = true;
        } catch { /* nothing left to fall back to */ }
        recordFailure({ key, error, at: Date.now(), fellBack });
        return { ok: false, error, backend: 'desktop-files' };
    }
    const res = await api.write(fileKeyFor(key), value);
    if (res.ok) return { ok: true, backend: 'desktop-files' };
    const error = res.error ?? 'desktop store write failed';
    let fellBack = false;
    try {
        localStorage.setItem(key, value);
        fellBack = true;
    } catch { /* nothing left to fall back to */ }
    recordFailure({ key, error, at: Date.now(), fellBack });
    return { ok: false, error, backend: 'desktop-files' };
};

export const removeStore = async (key: string): Promise<void> => {
    const api = bridge();
    if (api) {
        const res = await api.remove(fileKeyFor(key));
        if (res.ok) failedKeys.delete(key);
        else recordFailure({ key, error: res.error ?? 'remove failed', at: Date.now(), fellBack: false });
    }
    try { localStorage.removeItem(key); } catch { /* private mode */ }
};

/** Where the bytes live, for Settings → Data. Null on web. */
export const storeLocation = async (): Promise<string | null> => {
    const api = bridge();
    if (!api?.location) return null;
    try { return await api.location(); } catch { return null; }
};

/**
 * Every store key on this machine that starts with `prefix`, or null when the
 * backend cannot enumerate (web/localStorage keeps its own namespace; use
 * PreferencesService.getAllKeys there). Desktop reads the file store directly,
 * so a caller never maintains a second index that can drift from the bytes.
 *
 * The keys are STORAGE ADDRESSES (the file path under the store root, without
 * `.json`) — not the caller-facing key, because a key holding a character
 * outside `[A-Za-z0-9._-]` is escaped on its way to a filename and a filename
 * cannot be un-escaped unambiguously. Read them back with `readStoreByFileKey`.
 */
export const listStoreKeys = async (prefix: string): Promise<string[] | null> => {
    const api = bridge();
    if (!api?.list) return null;
    try {
        const res = await api.list(prefix);
        return Array.isArray(res?.keys) ? res.keys : null;
    } catch {
        return null;
    }
};

/** Read one storage address exactly as `listStoreKeys` returned it — no second
 *  escaping pass. This is how a caller enumerates-then-reads a store whose
 *  keys are not file-safe. */
export const readStoreByFileKey = async (fileKey: string): Promise<{ ok: boolean; value?: string | null; error?: string }> => {
    const api = bridge();
    if (!api) return { ok: false, error: 'no file store on this platform' };
    return api.read(fileKey);
};
