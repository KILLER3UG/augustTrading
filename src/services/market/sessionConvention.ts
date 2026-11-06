/**
 * sessionConvention — THE one definition of "a trading day" for a 24/7 market.
 *
 * Crypto has no session close, but day types, initial balance and "previous
 * day" levels are meaningless without one. The convention, fixed here and
 * reused identically by every market tool (and by any future training
 * extraction — the parity rule):
 *
 *  - The trading day is the UTC calendar day (00:00–24:00 UTC).
 *  - The named sessions are the DST-shifted windows already defined by
 *    `SessionService.getEffectiveSessions` (asian 00:00–09:00 UTC, London and
 *    New York shifted +1h in their respective winter). This module does not
 *    keep a second hour table — it delegates, so the tools and the session
 *    card can never disagree about where London opens.
 *  - Initial balance is the first 60 minutes of the UTC day (00:00–01:00).
 *  - The trading week starts Monday 00:00 UTC; the month is the UTC calendar
 *    month.
 *
 * Pure module: no fetch, no storage, no clock read that is not an argument.
 */

import { getEffectiveSessions } from '../infrastructure/SessionService';

export const UTC_DAY_MS = 86_400_000;
export const UTC_HOUR_MS = 3_600_000;
/** Initial balance = the first N minutes of the UTC day. */
export const INITIAL_BALANCE_MINUTES = 60;

export type SessionName = 'asian' | 'london' | 'new_york';

export interface SessionWindow {
    session: SessionName;
    startMs: number;
    endMs: number;
}

export interface PeriodRange {
    startMs: number;
    endMs: number;
    /** Human label used in tool output (`prev_day`, `prev_week`, …). */
    label: string;
}

/** The 00:00 UTC millisecond of the day containing `ms`. */
export const utcDayStart = (ms: number): number => Math.floor(ms / UTC_DAY_MS) * UTC_DAY_MS;

/** The Monday 00:00 UTC that opens the week containing `ms` (crypto week). */
export const utcWeekStart = (ms: number): number => {
    const day = utcDayStart(ms);
    // Date.getDay(): 0 = Sunday … 6 = Saturday. Monday-open: shift Sunday back 6.
    const dow = (new Date(day).getUTCDay() + 6) % 7;
    return day - dow * UTC_DAY_MS;
};

/** The 1st 00:00 UTC of the month containing `ms`. */
export const utcMonthStart = (ms: number): number => {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

/**
 * The DST-shifted named-session windows for the UTC day CONTAINING `ms`.
 * Each day carries its own boundaries (a day either side of a DST switch uses
 * its own shift), so a window computed for a past day stays honest.
 */
export const sessionWindowsForDay = (ms: number): SessionWindow[] => {
    const effective = getEffectiveSessions(new Date(utcDayStart(ms)));
    const day = utcDayStart(ms);
    const at = (hour: number): number => day + hour * UTC_HOUR_MS;
    return [
        { session: 'asian', startMs: at(effective.asian.start), endMs: at(effective.asian.end) },
        { session: 'london', startMs: at(effective.london.start), endMs: at(effective.london.end) },
        { session: 'new_york', startMs: at(effective.new_york.start), endMs: at(effective.new_york.end) },
    ];
};

/**
 * The named session a timestamp belongs to, for LABELING a bar. Windows
 * overlap (the London/NY overlap is part of both sessions), so the priority
 * is the one `SessionService` uses: NY over London over Asia. `off_hours`
 * means none of the named windows covers it.
 */
export const sessionOfMs = (ms: number): SessionName | 'off_hours' => {
    const windows = sessionWindowsForDay(ms);
    if (ms >= windows[2].startMs && ms < windows[2].endMs) return 'new_york';
    if (ms >= windows[1].startMs && ms < windows[1].endMs) return 'london';
    if (ms >= windows[0].startMs && ms < windows[0].endMs) return 'asian';
    return 'off_hours';
};

/** The initial-balance window (first `INITIAL_BALANCE_MINUTES` of the UTC day). */
export const initialBalanceWindow = (ms: number): PeriodRange => {
    const start = utcDayStart(ms);
    return {
        startMs: start,
        endMs: start + INITIAL_BALANCE_MINUTES * 60_000,
        label: 'initial_balance',
    };
};

/** The UTC day/week/month period that contains `ms`, each with its range. */
export const currentPeriods = (ms: number): Record<'day' | 'week' | 'month', PeriodRange> => {
    const day = utcDayStart(ms);
    const week = utcWeekStart(ms);
    const month = utcMonthStart(ms);
    return {
        day: { startMs: day, endMs: day + UTC_DAY_MS, label: 'current_day' },
        week: { startMs: week, endMs: week + 7 * UTC_DAY_MS, label: 'current_week' },
        month: { startMs: month, endMs: nextMonthStart(month), label: 'current_month' },
    };
};

const nextMonthStart = (monthStartMs: number): number => {
    const d = new Date(monthStartMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};

/** The UTC day/week/month period BEFORE the one containing `ms`. */
export const previousPeriods = (ms: number): Record<'prev_day' | 'prev_week' | 'prev_month', PeriodRange> => {
    const day = utcDayStart(ms);
    const week = utcWeekStart(ms);
    const month = utcMonthStart(ms);
    return {
        prev_day: { startMs: day - UTC_DAY_MS, endMs: day, label: 'prev_day' },
        prev_week: { startMs: week - 7 * UTC_DAY_MS, endMs: week, label: 'prev_week' },
        prev_month: { startMs: addMonths(month, -1), endMs: month, label: 'prev_month' },
    };
};

const addMonths = (monthStartMs: number, delta: number): number => {
    const d = new Date(monthStartMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1);
};
