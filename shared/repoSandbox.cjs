/**
 * The ONE path rule for the repo bridge (Electron main + contracts).
 *
 * The model may read and edit August's own source in DEV ONLY, and only
 * inside the checkout named by AUGUSTTRADING_REPO. This module answers one
 * question — may this relative path be touched? — so the main process never
 * hand-rolls a containment check that a `..` or a drive letter slips past.
 *
 * Denied on purpose: dependency and build trees (writing them is not editing
 * the app), the git database, checkpoint storage, environment files and
 * binary assets (the bridge carries UTF-8 text, so a "successful" write to a
 * PNG would corrupt it).
 */
const path = require('path');
const fs = require('fs');

const DENY_SEGMENTS = new Set(['node_modules', '.git', 'dist', 'dist_electron', '.august-checkpoints']);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|otf|eot|pdf|zip|gz|exe|dll|node|wasm|mp4|mov|mp3|wav)$/i;
/**
 * Files that decide what the BUILD runs, and what the install pulls down.
 *
 * `package.json` carries npm's lifecycle hooks (`prebuild`, `postinstall`,
 * `pretypecheck`): npm runs them around the script the build calls, in the
 * build process, on the machine. A hook is a shell command, so an editable
 * manifest turns "the model may edit the source" into "the model may run a
 * command" - a different privilege level, and one the product never
 * promised. `package-lock.json` decides what `npm install` fetches.
 *
 * The build itself runs with `--ignore-scripts` (electron/main.cjs), so a
 * hook is inert even in a checkout that already carried one.
 */
const DENIED_BUILD_FILES = new Set(['package.json', 'package-lock.json']);

const normalizeRel = (rel) => String(rel == null ? '' : rel).replace(/\\/g, '/');

/**
 * The real path of `abs`, with its SYMBOLIC LINKS resolved, for the deepest
 * part of it that exists yet.
 *
 * WHY THIS EXISTS. `path.resolve` and `path.relative` are LEXICAL: they never
 * touch the filesystem, so they cannot see a symlink (or a Windows junction)
 * that sits INSIDE the repo and points outside it. The containment check
 * passed such a path and the write landed outside the checkout - the deny
 * list has the same blind spot, because it is matched on the lexical
 * segments and a symlinked `node_modules` is not one of them.
 *
 * So the target is resolved before the check, and the resolved segments are
 * matched against the deny list as well.
 *
 * @param {string} abs
 * @returns {string} the resolved path; the input itself when nothing resolves
 */
const realpathWithTail = (abs) => {
    let current = abs;
    const tail = [];
    for (;;) {
        try {
            const real = fs.realpathSync(current);
            return tail.length ? path.join(real, ...tail.reverse()) : real;
        } catch (err) {
            // ENOENT / ENOTDIR: this path (or a parent of it) is not there
            // yet. Walk up to the deepest ancestor that IS there and keep the
            // rest as the tail - a file about to be written is normal.
            if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) throw err;
            const parent = path.dirname(current);
            if (parent === current) return abs;
            tail.push(path.basename(current));
            current = parent;
        }
    }
};

/** The real path of `abs`, or null when it does not exist. */
const realpathOrNull = (abs) => {
    try {
        return fs.realpathSync(abs);
    } catch {
        return null;
    }
};

/**
 * @returns {{ok:true, abs:string, rel:string} | {ok:false, error:string}}
 */
const resolveRepoPath = (root, rel) => {
    if (!root) return { ok: false, error: 'no repo is configured' };
    const cleaned = normalizeRel(rel);
    if (!cleaned) return { ok: false, error: 'path is required' };
    if (cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) {
        return { ok: false, error: 'path must be relative to the repo' };
    }
    const rootAbs = path.resolve(root);
    const abs = path.resolve(rootAbs, cleaned);
    const lexicalBack = path.relative(rootAbs, abs);
    if (!lexicalBack || lexicalBack.startsWith('..') || path.isAbsolute(lexicalBack)) {
        return { ok: false, error: 'path must stay inside the repo' };
    }
    // The RESOLVED path is checked too: a link inside the repo that points
    // out of it is a way out of the sandbox, and the check above is lexical
    // so it cannot see one. The root is resolved the same way, or a repo
    // that lives behind a link would refuse every path inside it.
    const realRoot = realpathOrNull(rootAbs);
    let realParts = [];
    if (realRoot) {
        const realBack = path.relative(realRoot, realpathWithTail(abs));
        if (!realBack || realBack.startsWith('..') || path.isAbsolute(realBack)) {
            return { ok: false, error: 'path must stay inside the repo' };
        }
        realParts = realBack.split(path.sep);
    }
    const parts = lexicalBack.split(path.sep);
    // The deny-list is matched on BOTH the path as written and the path as
    // it resolves: a symlinked `node_modules` is invisible in the first.
    const denied = [...parts, ...realParts].find(p => DENY_SEGMENTS.has(p));
    if (denied) return { ok: false, error: `"${denied}" is not editable` };
    const base = parts[parts.length - 1];
    if (/^\.env/i.test(base)) return { ok: false, error: 'environment files are not editable' };
    if (DENIED_BUILD_FILES.has(base.toLowerCase())) {
        return { ok: false, error: 'the build manifest is not editable' };
    }
    if (BINARY_EXT.test(base)) return { ok: false, error: 'binary files are not editable' };
    return { ok: true, abs, rel: parts.join('/') };
};

module.exports = { resolveRepoPath, DENY_SEGMENTS };
