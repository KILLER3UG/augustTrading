/**
 * LevelCitations — the reader for `TradeAnalysis.levelCitations`.
 *
 * The field has been written by the model and checked at the schema boundary
 * since `schemas/tradeAnalysis.ts` gained it, and NOTHING in `src/` ever read
 * it. The model could name the source of its entry, stop and target and the
 * answer still rendered three bare prices — indistinguishable from a level the
 * model invented. A citation nobody reads is a promise nobody keeps, so an
 * uncited level now says so on the card instead of looking sourced.
 *
 * This is a MEASUREMENT, never a rule:
 *   - it does not remove a level, rewrite a price or refuse an output;
 *   - a level with no citation renders `uncited`, which is a fact about the
 *     evidence, not a warning colour (the charter reserves colour for
 *     direction and interaction);
 *   - a level the model never mentioned still renders. The refusal path here is
 *     the *label* `uncited`, not a missing row.
 *
 * Matching is by LABEL and never by price. `levelCitations[].label` is the
 * model's own name for a level; the price beside it is a restatement of that
 * same level, so matching on it would let a citation claim the source of a
 * *different* level sitting at the same number. A citation whose label names
 * nothing in this plan simply never matches — the evidence list can explain it,
 * and this module will not credit it to the nearest price.
 */

import type { LevelCitation } from '../../types/analysis';

export type LevelKind = 'entry' | 'stop' | 'target';

/** 'cited' = the model named a source for this level. 'uncited' = it did not. */
export type LevelCitationState = 'cited' | 'uncited';

/**
 * The vocabulary the model actually uses for each level. Kept here, beside the
 * matcher, so the two cannot drift: an alias nobody matches is dead weight, and
 * an alias the matcher cannot reach is a silent miss.
 */
export const LEVEL_KIND_ALIASES: Record<LevelKind, readonly string[]> = {
    entry: ['entry', 'entryprice', 'entrylevel', 'limitentry', 'longentry', 'shortentry', 'fill'],
    stop: ['stop', 'sl', 'stoploss', 'stoplosslevel', 'invalidation', 'invalid', 'stopprice'],
    target: ['target', 'tp', 'takeprofit', 'takeprofitlevel', 'profit', 'reward'],
};

/** The mark a level carries once it has been graded against the citations. */
export interface LevelCitationMark {
    kind: LevelKind;
    /** The level's own label as it is drawn on the card. */
    label: string;
    state: LevelCitationState;
    /** The credited source id, or null when nothing was credited. */
    sourceId: string | null;
    /** The citation's own wording, so the tooltip can quote it verbatim. */
    citedBy: string | null;
}

/** Normalizes a label for comparison: case and punctuation are not identity. */
const norm = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * `sl` / `tp` are the one abbreviation the model shortens further ("TP2"), so
 * they are matched as a prefix of a trailing digit rather than by containment:
 * a containment rule would let "stop" claim "stopped out of the target".
 */
const SHORT_WITH_INDEX = /^(sl|tp)\d{1,2}$/;

const matches = (label: string, alias: string): boolean => {
    if (!label || !alias) return false;
    if (label === alias) return true;
    if (SHORT_WITH_INDEX.test(label) && label.startsWith(alias)) return true;
    // Below three characters, containment is noise: "sl" is not inside "close",
    // and an exact match has already been tried.
    if (Math.min(label.length, alias.length) < 3) return false;
    return label.startsWith(alias) || label.endsWith(alias) || alias.startsWith(label);
};

/**
 * Grade ONE level against the model's citations. The first citation whose label
 * names this level wins, in the order the model listed them — a plan that cites
 * the same level twice is a wording problem for the evidence list, not a tie
 * this function invents a winner for.
 */
export const citationForLevel = (
    kind: LevelKind,
    label: string,
    citations: readonly LevelCitation[] | undefined,
): LevelCitationMark => {
    const target = norm(label);
    const hit = (citations ?? []).find((c) => {
        if (!c || typeof c.label !== 'string') return false;
        return LEVEL_KIND_ALIASES[kind].some((alias) => matches(target, alias) || matches(norm(c.label), alias));
    });
    return hit
        ? { kind, label, state: 'cited', sourceId: hit.sourceId ?? null, citedBy: hit.label ?? null }
        : { kind, label, state: 'uncited', sourceId: null, citedBy: null };
};

export interface LevelCitationSummary {
    marks: LevelCitationMark[];
    /** Marks keyed by kind, so a card can address one level without searching. */
    byKind: Partial<Record<LevelKind, LevelCitationMark>>;
    cited: number;
    uncited: number;
    total: number;
    /** How many citations the model actually declared, read or not. */
    declared: number;
}

/** Grade a whole plan. One call per card, so the marks can never disagree. */
export const summarizeLevelCitations = (
    levels: readonly { kind: LevelKind; label: string }[],
    citations: readonly LevelCitation[] | undefined,
): LevelCitationSummary => {
    const marks = levels.map((l) => citationForLevel(l.kind, l.label, citations));
    const byKind: Partial<Record<LevelKind, LevelCitationMark>> = {};
    for (const mark of marks) byKind[mark.kind] = mark;
    return {
        marks,
        byKind,
        cited: marks.filter((m) => m.state === 'cited').length,
        uncited: marks.filter((m) => m.state === 'uncited').length,
        total: marks.length,
        declared: citations?.length ?? 0,
    };
};

/**
 * The word the card draws. Two constants, so the UI and the contract check pin
 * the same two strings — a silent rename here would otherwise leave the check
 * green while the trader reads a new word.
 */
export const CITATION_TAG_CITED = (sourceId: string): string => `src:${sourceId}`;
export const CITATION_TAG_UNCITED = 'uncited';

/** The tooltip for a mark: what was credited, or that nothing was. */
export const citationTagText = (mark: LevelCitationMark): string =>
    mark.state === 'cited'
        ? `sourced: ${mark.citedBy ?? mark.label}${mark.sourceId ? ` · ${mark.sourceId}` : ''}`
        : 'no source recorded for this level';