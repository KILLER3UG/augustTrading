/**
 * storeFs — the desktop's file backend for the stores that outgrew a browser.
 *
 * WHY THIS EXISTS. On desktop every big store was renderer `localStorage`
 * (`PreferencesService` only takes the native branch on Capacitor; Electron is
 * not that), so chats, the notebook, payloads, drafts and amendments shared one
 * ~5 MiB origin budget — and the owner's ruling is "store everything, no cap".
 * Those two cannot both be true. This module is the destination: plain JSON
 * files under the app's userData directory, one file per store key.
 *
 * THE RULES IT KEEPS.
 *  - A key is a PATH, and a path is refused unless every segment is a plain
 *    name: no `.`/`..`, no separators inside a segment, bounded depth. A store
 *    that can escape its root is a store that can overwrite the app.
 *  - Writes are ATOMIC: bytes land in `<file>.tmp`, the previous version is
 *    copied to `<file>.bak`, then the temp file is renamed over the target. A
 *    crash mid-write leaves the old bytes intact, never a half file.
 *  - A value has a size ceiling. A store that can grow without one is how a
 *    runaway turn fills the disk instead of a quota.
 *  - Reads never throw for a missing file — that is a first run, not an error.
 *
 * Deliberately dependency-free and free of Electron imports so it can be
 * exercised by plain Node, which is how it is verified.
 */

const fs = require('fs');
const path = require('path');

/** One value's ceiling. Well past any real store (chats are ~3.5 MB today) and
 *  far below "the disk is full because a model looped". */
const MAX_VALUE_BYTES = 32 * 1024 * 1024;
/** Segments per key: `profiles/<user>/notebook/shards/skills` is 5. */
const MAX_DEPTH = 6;

/** `a/b-c/d` → ['a','b-c','d'], or null when any segment is not a plain name. */
const keySegments = (key) => {
    if (typeof key !== 'string') return null;
    const trimmed = key.trim();
    if (!trimmed || trimmed.length > 400) return null;
    const parts = trimmed.split('/');
    if (parts.length === 0 || parts.length > MAX_DEPTH) return null;
    const out = [];
    for (const part of parts) {
        if (!/^[A-Za-z0-9._-]{1,120}$/.test(part)) return null;
        if (part === '.' || part === '..') return null;
        out.push(part);
    }
    return out;
};

/** Absolute path for a key, or null when the key is unacceptable OR the result
 *  would fall outside the root (belt and braces after the segment check). */
const pathForKey = (root, key) => {
    const parts = keySegments(key);
    if (!parts) return null;
    const rootResolved = path.resolve(root);
    const abs = path.resolve(rootResolved, ...parts) + '.json';
    if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return null;
    return abs;
};

const createStore = (root) => {
    const ensureDir = (file) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    };

    /** The stored bytes, or null when this key has never been written. Throws
     *  only for a file that exists and cannot be read — the caller must be able
     *  to tell "first run" from "your data is unreadable". */
    const read = (key) => {
        const file = pathForKey(root, key);
        if (!file) return { ok: false, error: 'invalid store key' };
        try {
            return { ok: true, value: fs.readFileSync(file, 'utf8') };
        } catch (err) {
            if (err && err.code === 'ENOENT') return { ok: true, value: null };
            return { ok: false, error: `read failed: ${err && err.code ? err.code : 'unknown'}` };
        }
    };

    const write = (key, value) => {
        const file = pathForKey(root, key);
        if (!file) return { ok: false, error: 'invalid store key' };
        if (typeof value !== 'string') return { ok: false, error: 'value must be a string' };
        const bytes = Buffer.byteLength(value, 'utf8');
        if (bytes > MAX_VALUE_BYTES) {
            return { ok: false, error: `value is ${bytes} bytes, over the ${MAX_VALUE_BYTES}-byte ceiling` };
        }
        const tmp = `${file}.tmp`;
        try {
            ensureDir(file);
            fs.writeFileSync(tmp, value, 'utf8');
            // Keep the previous version before replacing it. A store that
            // overwrites without a copy is one bad serialize away from losing the
            // only copy of what the trader wrote.
            try {
                fs.copyFileSync(file, `${file}.bak`);
            } catch (err) {
                if (!err || err.code !== 'ENOENT') {
                    // A failed backup is not a reason to drop the new write, but it
                    // is a reason to say so in the log rather than pretend.
                    console.warn(`[storeFs] could not keep a backup for ${file}:`, err && err.code);
                }
            }
            renameReplace(tmp, file);
            return { ok: true, bytes };
        } catch (err) {
            try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
            return { ok: false, error: `write failed: ${err && err.code ? err.code : 'unknown'}` };
        }
    };

    const remove = (key) => {
        const file = pathForKey(root, key);
        if (!file) return { ok: false, error: 'invalid store key' };
        try {
            fs.unlinkSync(file);
        } catch (err) {
            if (err && err.code !== 'ENOENT') return { ok: false, error: `remove failed: ${err.code || 'unknown'}` };
        }
        return { ok: true };
    };

    /** Where this store lives, for the Settings card and for support. */
    const location = () => path.resolve(root);

    /** Every key currently in the store whose name starts with `prefix`,
     *  decoded back from the files on disk. A store the renderer can write to
     *  but never enumerate cannot answer "which profiles exist" — so the
     *  profile store gets a real listing instead of a second index file that
     *  could drift from the bytes it claims to describe. */
    const list = (prefix) => {
        const rootResolved = path.resolve(root);
        const out = [];
        const want = typeof prefix === 'string' ? prefix : '';
        const walk = (dir, parts) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return; // a directory that is not there yet is an empty store
            }
            for (const entry of entries) {
                const nextParts = [...parts, entry.name];
                if (entry.isDirectory()) {
                    walk(path.join(dir, entry.name), nextParts);
                    continue;
                }
                if (!entry.name.endsWith('.json')) continue;
                const key = nextParts.slice(0, -1).concat(entry.name.slice(0, -'.json'.length)).join('/');
                if (want && !key.startsWith(want)) continue;
                out.push(key);
            }
        };
        walk(rootResolved, []);
        return { ok: true, keys: out };
    };

    return { read, write, remove, location, list, keySegments };
};

/**
 * Node's rename replaces an existing file on both platforms (MoveFileExW with
 * REPLACE_EXISTING on Windows), but a locked target (an antivirus scan, a
 * backup agent) can still refuse. Retrying once is what turns a transient lock
 * into a saved turn instead of a lost one.
 */
const renameReplace = (from, to) => {
    try {
        fs.renameSync(from, to);
    } catch (err) {
        if (!err || (err.code !== 'EPERM' && err.code !== 'EACCES' && err.code !== 'EBUSY')) throw err;
        fs.rmSync(to, { force: true });
        fs.renameSync(from, to);
    }
};

module.exports = { createStore, pathForKey, keySegments, MAX_VALUE_BYTES, MAX_DEPTH };
