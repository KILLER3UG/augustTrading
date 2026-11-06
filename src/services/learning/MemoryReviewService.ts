/**
 * One-shot notebook review: after Memory files change, the Memory model
 * reads the index and writes profile/suggestions.md for the user.
 * It does not rewrite other files.
 *
 * WHY `profile/suggestions.md` is force-disabled and stays out of retrieval —
 * it is advice addressed to the HUMAN, not a belief about the market. Nothing
 * in this module (or anywhere else) judges its claims, so re-enabling it would
 * feed one model's unsolicited opinion back into the next debate as if it were
 * evidence, and the loop would compound its own advice. Its reader is a
 * person: `components/learn/MemoryFilesManager.tsx` renders it in the
 * notebook UI, and it is excluded from the prompt index dump
 * (`SKIP_INDEX_DUMP`) and from note search (`NOTE_SEARCH_SKIP_FOLDERS`) by the
 * same reasoning. Write-only with
 * respect to the model is therefore the design, not an oversight — the file is
 * a one-way message out of the loop.
 */

import { ProviderConfig } from '../../types/provider';
import { getQuickResponse } from '../providers/GenericAnalysisService';
import { sanitizeAIResponse } from '../../utils/sanitizers';
import { getPreferenceObject, setPreferenceObject } from '../infrastructure/PreferencesService';
import { NOTEBOOK_REVIEW_COOLDOWN_MS, notebookReviewDue, type NotebookReviewState } from '../../utils/notebookReviewGate';
import {
    createMemoryFileUnlocked,
    getMemoryFiles,
    getMemoryFilesIndex,
    SUGGESTIONS_FILE_NAME,
    updateMemoryFileUnlocked,
    withSilentMemoryPersist,
} from './MemoryFilesService';

const REVIEW_SYSTEM = `You are the trader's notebook reviewer. Read the CURRENT NOTEBOOK index (folders, files, excerpts). Suggest what the trader should do next. Do not rewrite files yourself.

Cover:
- Contradictions or duplicates to merge
- Stale or empty files to edit or drop
- Missing playbooks given what is already logged
- Skills/rules that look weak or unused
- One short priority list (max 7 bullets)

Write markdown the trader will open as suggestions.md. No JSON. No chain-of-thought. Start with "# Suggestions". Keep it under 800 words.`;

let inFlight: Promise<boolean> | null = null;

/** A notebook write burst is not a reason to buy another review. The gate is
 *  "material change": a different index signature AND the cooldown elapsed.
 *  Startup seeding writes several files; without this the app paid for a
 *  review per batch (two in the live capture). */
const REVIEW_STATE_KEY = (user: string): string => `memory_review_v1:${user}`;
const REVIEW_COOLDOWN_MS = NOTEBOOK_REVIEW_COOLDOWN_MS;

/** FNV-1a over the rendered index — cheap, stable, and only compared to its
 *  previous value (it is not a security hash). */
const indexSignature = (text: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
};

export const runNotebookReview = async (
    username: string,
    config: ProviderConfig | null | undefined,
): Promise<boolean> => {
    if (!config?.apiKey) return false;
    if (inFlight) return inFlight;

    const work = (async (): Promise<boolean> => {
        const index = getMemoryFilesIndex();
        if (!index || index.includes('empty notebook')) return false;
        const signature = indexSignature(index);
        const stateKey = REVIEW_STATE_KEY(username);
        const prior = await getPreferenceObject<NotebookReviewState>(stateKey);
        const now = Date.now();
        if (!notebookReviewDue(prior, signature, now, REVIEW_COOLDOWN_MS)) return false;
        // Stamp BEFORE the call: a burst of writes in the same minute must not
        // each buy a review, and a failed call is retried by a later material
        // change after the cooldown rather than immediately.
        await setPreferenceObject(stateKey, { at: now, signature });
        const raw = await getQuickResponse(
            config,
            `CURRENT NOTEBOOK:\n${index}\n\nWrite suggestions.md for this trader.`,
            [],
            REVIEW_SYSTEM,
        );
        const body = sanitizeAIResponse(raw || '').trim();
        if (!body || body.length < 40) return false;
        const dateStr = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const content = body.startsWith('#')
            ? body
            : `# Suggestions\n> Memory model review · ${dateStr}\n\n${body}`;
        const folder = getMemoryFiles().folders.find(f => f.name === 'profile');
        if (!folder) return false;
        const existing = getMemoryFiles().files.find(
            f => f.folderId === folder.id && f.name === SUGGESTIONS_FILE_NAME,
        );
        await withSilentMemoryPersist(async () => {
            // `enabled: false` on BOTH branches — including the create, which
            // would otherwise default to enabled and start injecting. Why: see
            // the module header (human-facing advice, never a model-facing
            // belief). The silent persist is the paired half of that: writing
            // this file must not re-trigger the notebook-change debounce that
            // schedules another review.
            if (existing) {
                await updateMemoryFileUnlocked(existing.id, { content, enabled: false }, username);
            } else {
                const created = await createMemoryFileUnlocked(folder.id, SUGGESTIONS_FILE_NAME, content, username, true);
                await updateMemoryFileUnlocked(created.id, { enabled: false }, username);
            }
        });
        return true;
    })();

    inFlight = work.finally(() => { inFlight = null; });
    return inFlight;
};
