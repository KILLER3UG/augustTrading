/**
 * relativeTime — the ONE arithmetic of "how long ago", and the minute bucket
 * that lets a row cache its label.
 *
 * The contract exists because of a real defect: a rail row printed `20731d`
 * for an 8-day-old message. One helper computed `Date.now() - Date.parse(iso)`
 * and handed that DURATION to a formatter that subtracted `Date.now()` again,
 * so the epoch leaked through. Here the subtraction happens once, in
 * `ageMinutes`, and every label takes MINUTES and never sees a clock — a
 * second subtraction is not expressible.
 *
 * `ageMinutes` is deliberately FRACTIONAL. Rounding belongs to the label: a
 * formatter that rounds the age first and then claims to floor (a 30-second
 * old row reading `1m ago`) is the same class of bug in a quieter form. Each
 * preset below names its rounding, and they all share `label`.
 *
 * `utils/timezone.ts` owns absolute PHT stamps and day keys; this owns elapsed
 * time. Different questions, and neither formats the other's.
 */

export const MINUTE_MS = 60_000;

/** The wall-clock minute — a cheap "did time move" key for a row cache. Read
 *  it ONCE per render rather than once per row, so every row in a single pass
 *  agrees on the minute it is printing. */
export const minuteBucket = (now: number = Date.now()): number => Math.floor(now / MINUTE_MS);

/** Minutes between a stamp and now. ONE subtraction, FRACTIONAL. Negative
 *  means the stamp is in the future (clock skew); each preset decides whether
 *  that reads `now` or nothing. */
export const ageMinutes = (at: number, now: number = Date.now()): number =>
    (now - at) / MINUTE_MS;

type Rounding = 'round' | 'floor';

interface Ladder {
    /** Whole minutes, then hours, then days — the same rounding at each step. */
    rounding: Rounding;
    /** Terse rows (`45m`, `6h`, `8d`) rather than prose (`45m ago`). */
    terse?: boolean;
    /** Extend past days to weeks. */
    weeks?: boolean;
    /** The health widget's `just now` instead of `now`. */
    justNow?: boolean;
    /** Stop the ladder at hours instead of days (the provider widget's old
     *  `48h ago`, the prov line's `6h ago`). */
    maxUnit?: 'hours' | 'days';
    /** What a future stamp prints. `''` means the surface prints nothing
     *  rather than a wrong word; `'now'` is the honest answer at this
     *  resolution. */
    future: 'now' | '';
}

/** The one ladder. Every exported preset is this function with a named set of
 *  choices, so a rounding change is made once. */
const label = (mins: number, opts: Ladder): string => {
    if (!Number.isFinite(mins)) return '';
    if (mins < 0) return opts.future;
    const round = opts.rounding === 'floor' ? Math.floor : Math.round;
    const m = round(mins);
    if (m < 1) return opts.justNow ? 'just now' : 'now';
    if (m < 60) return opts.terse ? `${m}m` : `${m}m ago`;
    const hours = round(m / 60);
    if (opts.maxUnit === 'hours' || hours < 24) {
        return opts.terse ? `${hours}h` : `${hours}h ago`;
    }
    const days = round(hours / 24);
    if (opts.weeks && days >= 7) return `${Math.round(days / 7)} wk ago`;
    if (opts.terse) return `${days}d`;
    if (opts.weeks) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
    return `${days}d ago`;
};

/** `now` · `45m ago` · `6h ago` · `3 days ago` · `2 wk ago`. Rounded minutes,
 *  weeks past a week. The palette's recency column and the dock's "answered"
 *  meta. */
export const agoLabel = (mins: number): string =>
    label(mins, { rounding: 'round', weeks: true, future: 'now' });

/** The same ladder, terse and unsuffixed: `now` · `45m` · `6h` · `8d`, for
 *  dense list rows. '' for a future or unparseable age: this presentation
 *  prints nothing rather than a wrong word. */
export const shortAgeLabel = (mins: number): string =>
    label(mins, { rounding: 'round', terse: true, future: '' });

/** `just now` · `45m ago` · `6h ago` · `48h ago` — the provider-health
 *  widget's vocabulary. `just now` rather than `now`, hours rather than days,
 *  and `—` for a missing stamp is the caller's decision, not this module's. */
export const healthLabel = (mins: number): string =>
    label(mins, { rounding: 'round', justNow: true, maxUnit: 'hours', future: 'now' });

/** `now` · `45m ago` · `6h ago` · `8d ago` — FLOOR minutes, the ladder the
 *  signal rows print. A 30-second-old signal is `now`, a 90-second-old signal
 *  is `1m ago`: the floor is applied to the exact age, never to a pre-rounded
 *  one. */
export const floorAgoLabel = (mins: number): string =>
    label(mins, { rounding: 'floor', future: '' });

/** `now` · `45m ago` · `6h ago` · `8d ago` — ROUNDED minutes, stopped at
 *  days. The memory list prints this: a day-capped "ago" is what fits a dense
 *  topic row. */
export const roundAgoDaysLabel = (mins: number): string =>
    label(mins, { rounding: 'round', future: '' });

/** `now` · `45m ago` · `6h ago` · `48h ago` — ROUNDED minutes, stopped at
 *  hours. The transcript's prov line printed this before the ladder moved
 *  here. */
export const roundAgoHoursLabel = (mins: number): string =>
    label(mins, { rounding: 'round', maxUnit: 'hours', future: '' });
