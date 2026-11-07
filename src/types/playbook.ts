/**
 * The `scan_playbooks` detector vocabulary — the ids one module emits and
 * three surfaces spell: the scan result, the `present_trade` attribution tag,
 * and the journal's per-detector stats.
 *
 * It lives in `types/` because the prompt-schema module (`deskToolShared`)
 * and the trade path both need it, and neither may pull the detector math
 * into its eager graph. NO IMPORTS: this file is pure vocabulary.
 */

export const PLAYBOOK_IDS = [
    'value_area_rotation',
    'failed_ib_extension',
    'wyckoff_spring',
    'wyckoff_utad',
    'sweep_structure_shift',
    'absorption_reversal',
    'trend_pullback',
    'turtle_soup',
    'vwap_reclaim',
] as const;

export type PlaybookId = typeof PLAYBOOK_IDS[number];

/** Normalise a caller-supplied id and prove it names a detector. */
export const asPlaybookId = (value: unknown): PlaybookId | null => {
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    return (PLAYBOOK_IDS as readonly string[]).includes(v) ? v as PlaybookId : null;
};
