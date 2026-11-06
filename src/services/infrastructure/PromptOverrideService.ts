/**
 * PromptOverrideService — user-editable prompt overrides.
 *
 * Every prompt the app sends to models is registered in
 * constants/promptRegistry.ts; the call sites resolve the live text through
 * `getPrompt(id, fallback)`, which returns the user's override when one
 * exists and the built-in default otherwise.
 *
 * Overrides are stored per-user in Preferences (`prompt_overrides_v1_<user>`)
 * and mirrored in a synchronous module cache so prompt assembly (which runs
 * at call time, not render time) can read them without awaiting storage.
 */

import { getPreferenceObject, setPreferenceObject, removePreference } from './PreferencesService';
import { getHarnessSettings } from '../../utils/harnessSettings';
import { isRegisteredPromptId } from '../../constants/promptIds';

const OVERRIDES_KEY_PREFIX = 'prompt_overrides_v1_';

/** Synchronous override cache — populated by initOverrides/save/reset. */
let overridesCache: Record<string, string> = {};

/**
 * Which A/B lane THIS run resolved. There is deliberately no module state: the
 * lane used to be `let controlLane`, flipped on by `beginPromptLane()` and back
 * by an `endPromptLane()` in a `finally`, so a detached job and a human
 * send deciding at the same moment overwrote each other and a run resolved
 * whichever lane the OTHER one happened to pick. The decision is returned as a
 * value now, and the caller hands it to `getPrompt` / `promptCorpusVersion` at
 * every resolve — nothing to un-set, so nothing can leak into the next run.
 */
export type PromptLane = 'live' | 'control';

export const beginPromptLane = (): PromptLane => {
    const settings = getHarnessSettings();
    const hasOverride = Object.keys(overridesCache).length > 0;
    const rate = settings.promptAbRate;
    return hasOverride && rate > 0 && Math.random() < rate ? 'control' : 'live';
};

/**
 * Load the active user's overrides into the sync cache.
 * Call on app boot and on every user switch.
 */
export const initPromptOverrides = async (username: string): Promise<void> => {
    try {
        const stored = await getPreferenceObject<Record<string, string>>(`${OVERRIDES_KEY_PREFIX}${username}`);
        overridesCache = stored && typeof stored === 'object' ? stored : {};
    } catch (e) {
        console.warn('[PromptOverride] Failed to load overrides:', e);
        overridesCache = {};
    }
};

/**
 * Resolve the live prompt text for a registered prompt id.
 * Synchronous by design — prompt assembly happens inside provider calls.
 *
 * `lane` is the CALLER's run lane, defaulting to 'live'. A call site that does
 * not thread a lane is not silently getting the global one (there is none left
 * to get): it is always resolving the trader's edits. That is the honest reading
 * for the background learners — `notebook.chat_note`,
 * `strategy.ocr_page` and friends are separate runs with no A/B decision to
 * carry. The dock's tool turn resolves NO overrides at all today, and that gap
 * is registered (E-57 §3) rather than papered over by a default.
 */
export const getPrompt = (id: string, fallback: string, lane: PromptLane = 'live'): string => {
    if (lane === 'control') return fallback;
    const override = overridesCache[id];
    return typeof override === 'string' && override.trim() ? override : fallback;
};

/**
 * A fingerprint of the prompt corpus THIS call resolves, for the journal row.
 *
 * `promptVersion` and `promptLane` are stamped here so the profile card's A/B
 * rows and `summarizePromptVersions` have a writer at all. Whether the two
 * lanes actually send different bytes is a separate open question: the call
 * sites resolve `getPrompt` without a lane, so today they differ only in what
 * is RECORDED. Registered, not papered over.
 *
 * `defaults` means the run resolved the built-in text on every id — which is
 * what the control lane does by definition, and also what a live run with no
 * overrides does. `edited-<hash>` covers the exact override set the live lane
 * resolved, so two different edits are two versions. Nothing finer is available
 * here: a change to a BUILT-IN prompt ships with the app build and is recorded
 * by the app version, not by this string.
 *
 * Deliberately hashed over the in-memory override map rather than over
 * `PROMPT_REGISTRY`: importing the registry into a run path pulls all 1,245
 * lines of prompt text into the entry chunk — measured at +18.7 kB, which put
 * the bundle over its 1,400 kB ratchet. The fingerprint cannot cost more than
 * the thing it names.
 */
export const promptCorpusVersion = (lane: PromptLane = 'live'): string => {
    if (lane === 'control') return 'defaults';
    // Only ids the registry still knows. An override left behind by a prompt that
    // has since been deleted used to hash into every live run's fingerprint, so
    // the A/B halves differed by a number that described nothing the model was
    // ever sent — and "Reset all (N)" counted the same ghosts.
    const ids = Object.keys(overridesCache)
        .filter(id => (overridesCache[id] || '').trim() && isRegisteredPromptId(id))
        .sort();
    if (ids.length === 0) return 'defaults';
    let h = 0x811c9dc5;
    for (const id of ids) {
        const text = `${id}\u0000${overridesCache[id]}`;
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
    }
    return `edited-${(h >>> 0).toString(36)}`;
};

/** Current override map (for the Settings UI). */
export const getPromptOverrides = (): Record<string, string> => ({ ...overridesCache });

/**
 * Persist a user's override and update the sync cache immediately so the
 * next provider call sees it. An empty/whitespace-only text clears the
 * override (falls back to the built-in default).
 */
export const savePromptOverride = async (id: string, text: string, username: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) {
        delete overridesCache[id];
    } else {
        overridesCache[id] = text;
    }
    try {
        const key = `${OVERRIDES_KEY_PREFIX}${username}`;
        if (Object.keys(overridesCache).length === 0) {
            await removePreference(key);
        } else {
            await setPreferenceObject(key, overridesCache);
        }
    } catch (e) {
        console.warn('[PromptOverride] Failed to persist overrides:', e);
    }
};

const ALLOWED_PLACEHOLDERS = new Set([
    'NAME', 'ROUND', 'COIN', 'COINNAME', 'DIRECTION', 'TIMEFRAME',
    'ANALYSTS', 'DIALOGUE_INSTRUCTIONS', 'CONTEXT', 'QUESTION', 'OTHERS',
]);

/** Advisory checks for user-edited prompts. Does not block save. */
export const validatePromptOverride = (text: string): string[] => {
    const warnings: string[] = [];
    if (/JSON_PLAN/i.test(text)) {
        warnings.push('Contains leftover JSON_PLAN tags — the harness now uses a labeled markdown plan.');
    }
    if (/\bI am an AI\b/i.test(text)) {
        warnings.push('Contains “I am an AI” hedging — that fights the analyst persona.');
    }
    const leftovers = [...text.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)]
        .map(m => m[1])
        .filter(name => !ALLOWED_PLACEHOLDERS.has(name));
    if (leftovers.length > 0) {
        warnings.push(`Unknown placeholders: ${[...new Set(leftovers)].map(n => `{{${n}}}`).join(', ')}`);
    }
    return warnings;
};

/** Remove a single override (back to the built-in default). */
export const resetPromptOverride = async (id: string, username: string): Promise<void> => {
    delete overridesCache[id];
    try {
        await setPreferenceObject(`${OVERRIDES_KEY_PREFIX}${username}`, overridesCache);
    } catch (e) {
        console.warn('[PromptOverride] Failed to persist overrides:', e);
    }
};

/** Remove every override for the user. */
export const resetAllPromptOverrides = async (username: string): Promise<void> => {
    overridesCache = {};
    try {
        await removePreference(`${OVERRIDES_KEY_PREFIX}${username}`);
    } catch (e) {
        console.warn('[PromptOverride] Failed to clear overrides:', e);
    }
};
