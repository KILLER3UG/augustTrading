/**
 * The registered prompt ids, as BARE STRINGS.
 *
 * `constants/promptRegistry.ts` is the registry, but it IMPORTS the built-in
 * text of every registered prompt (that is the point of it — the fallback is
 * imported, never restated, so an override and a reset can never disagree with
 * the call site). Pulling it into a run path dragged 1,245 lines of prompt text
 * into the entry chunk: measured at +18.7 kB, which broke the bundle ratchet.
 * `PromptOverrideService.promptCorpusVersion` needs only the NAMES, to decide
 * which stored overrides are still attached to something that reaches a model.
 *
 * So this file is the narrow list, and `scripts/check-contracts.cjs` (the
 * prompt-registry section) refuses to let the two drift: an id in the
 * registry but not here is an override that silently stops counting in the
 * corpus fingerprint, and an id here but not in the registry is the orphan
 * this filter exists to drop. (The vitest suite that used to pin this was
 * deleted with the whole suite on 2026-10-23; the guard lives in the
 * contracts check now.)
 */
export const PROMPT_REGISTRY_IDS: readonly string[] = [
    'analysis.master',
    'analysis.compact',
    'analysis.risk_rules',
    'analysis.memory_enforcement',
    'strategy.summarize_pdf',
    'notebook.chat_note',
    'strategy.ocr_page',
    'learning.settlement_reflection',
    'learning.post_mortem_diagnosis',
];

/** Whether `id` names a prompt the Settings tab can edit and a call site resolves. */
export const isRegisteredPromptId = (id: string): boolean => PROMPT_REGISTRY_IDS.includes(id);
