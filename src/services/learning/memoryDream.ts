/**
 * memoryDream — the periodic "Dream" consolidator for the two bounded memory
 * files. Claude-style: on a slow cadence, re-read what the harness has been
 * told, resolve the relative dates, merge the duplicates, and check the
 * qualitative beliefs against the settled ledger — so MEMORY.md stays a
 * curated summary instead of an append-only landfill.
 *
 * Four phases, in order:
 *   1. LOAD — capture USER.md + MEMORY.md and a reversible before-snapshot.
 *   2. GATHER — recent user corrections (correction-cue turns from the chat
 *      sessions since the last run) + the settled signal-ledger summary.
 *   3. RESOLVE — relative dates → absolute ISO days; merge duplicate entries;
 *      remove entries numerically contradicted by the ledger; flag
 *      qualitative edge claims the ledger cannot support.
 *   4. ENFORCE — the 1,500 / 2,500 char caps, by dropping the OLDEST dated
 *      entries (never by silent truncation of a survivor's text).
 *
 * Zero LLM. The consolidation is deterministic text work; the eligibility
 * gate, the concurrency lock and the manual trigger are here too. The whole
 * core is pure over its inputs, so the phases are unit-testable offline.
 */

import { getPreference, setPreference } from '../infrastructure/PreferencesService';
import { getActiveUsername } from '../../utils/activeUser';
import {
    captureCuratedMemorySnapshot,
    maxCharsForTarget,
    setCuratedMemoryTexts,
    type CuratedMemoryTarget,
} from './curatedMemory';
import { CORRECTION_CUE_RE } from './backgroundReview';
import {
    buildExecutionAutopsy,
    formatAutopsyForPrompt,
    type ExecutionAutopsyReport,
} from './executionAutopsyCore';
import type { SignalRow } from '../../types/signal';
import type { PaperSettledTrade } from '../paper/paperCore';
import { isRejectedFingerprint, recordRejectedFingerprint } from './rejectedFingerprints';
import { demoteSkillToStale, undoSkillMetaSnapshot, type SkillMeta, type SkillStatus } from './skillManage';

export const skillDemotionFingerprintParts = (slug: string): { kind: string; target: string; content: string } => {
    const clean = slug.trim().toLowerCase();
    return {
        kind: 'skill_demotion',
        target: clean,
        content: `demote_stale:${clean}`,
    };
};

export const DREAM_MIN_HOURS = 24;
export const DREAM_MIN_NEW_SESSIONS = 5;

export interface LedgerSummaryRow {
    label: string;
    wins: number;
    losses: number;
    /** wins / (wins + losses), 0–1; undefined with no settled rows. */
    winRate?: number;
    sample: number;
}

export interface DreamResolvedDate {
    expression: string;
    isoDay: string;
}

export interface DreamCoreResult {
    userMd: string;
    memoryMd: string;
    resolvedDates: DreamResolvedDate[];
    duplicatesRemoved: number;
    entriesRemoved: Array<{ target: CuratedMemoryTarget; reason: string; excerpt: string }>;
    contradictionFlags: string[];
    /** Entries dropped tail-first to satisfy the caps, with the file they came from. */
    capDropped: Array<{ target: CuratedMemoryTarget; day: string; excerpt: string }>;
    /** Deterministic MFE/MAE execution autopsy attached when settled signal rows exist. */
    autopsy?: ExecutionAutopsyReport;
    notes: string[];
}

// ─── Phase 3a: relative → absolute dates ────────────────────────────────────

const DAY_MS = 86_400_000;

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Resolve the relative date expressions a memory entry tends to carry into
 * absolute ISO days. "yesterday", "today", "last week", "last month",
 * "N days ago", "N weeks ago". Pure: `nowMs` in, deterministic text out.
 */
export const resolveRelativeDates = (
    text: string,
    nowMs: number,
): { text: string; resolved: DreamResolvedDate[] } => {
    const resolved: DreamResolvedDate[] = [];
    const replace = (source: string, re: RegExp, toMs: (m: RegExpExecArray) => number, label: (m: RegExpExecArray) => string): string =>
        source.replace(re, (match: string, ...rest: unknown[]) => {
            // `String.replace` passes (match, p1…pn, offset, whole, groups?) —
            // NOT an exec array. Taking the last argument used to hand the
            // capture-bearing patterns a STRING: `m[1]` was undefined,
            // `Number(undefined)` was NaN and isoDay threw. Rebuild the
            // exec-like shape the injected mappers expect. Every pattern here
            // has at most one capture group and no named groups.
            const capture = typeof rest[0] === 'string' ? rest[0] : '';
            const m = [match, capture] as unknown as RegExpExecArray;
            const day = isoDay(toMs(m));
            resolved.push({ expression: label(m), isoDay: day });
            return day;
        });
    let out = text;
    out = replace(out, /\byesterday\b/gi, () => nowMs - DAY_MS, () => 'yesterday');
    out = replace(out, /\btoday\b/gi, () => nowMs, () => 'today');
    out = replace(out, /\blast\s+week\b/gi, () => nowMs - 7 * DAY_MS, () => 'last week');
    out = replace(out, /\blast\s+month\b/gi, () => nowMs - 30 * DAY_MS, () => 'last month');
    out = replace(out, /\b(\d{1,3})\s+days?\s+ago\b/gi, (m) => nowMs - Number(m[1]) * DAY_MS, m => `${m[1]} days ago`);
    out = replace(out, /\b(\d{1,2})\s+weeks?\s+ago\b/gi, (m) => nowMs - Number(m[1]) * 7 * DAY_MS, m => `${m[1]} weeks ago`);
    return { text: out, resolved };
};

// ─── Phase 3b: duplicate merge ──────────────────────────────────────────────

const ENTRY_SPLIT = /^##\s+\[(\d{4}-\d{2}-\d{2})\]\s*$/;

interface DreamEntry {
    day: string;
    body: string;
}

/** Parse a curated file into its `## [YYYY-MM-DD]` entries (preamble kept as
 *  a dayless leading entry). Inverse of the writer's `formatCuratedEntry`. */
export const parseCuratedEntries = (text: string): DreamEntry[] => {
    const entries: DreamEntry[] = [];
    let current: DreamEntry | null = null;
    for (const line of (text || '').split('\n')) {
        const m = ENTRY_SPLIT.exec(line.trim());
        if (m) {
            current = { day: m[1], body: '' };
            entries.push(current);
            continue;
        }
        if (!current) {
            if (!line.trim()) continue;
            current = { day: '', body: '' };
            entries.push(current);
        }
        current.body += (current.body ? '\n' : '') + line;
    }
    for (const e of entries) e.body = e.body.trim();
    return entries.filter(e => e.body.length > 0);
};

const serializeEntries = (entries: DreamEntry[]): string =>
    entries.map(e => (e.day ? `## [${e.day}]\n${e.body}` : e.body)).join('\n\n').trim();

/**
 * Merge duplicate entries: same normalized body (case/whitespace-collapsed,
 * date-stamp-insensitive) keeps the NEWEST day. Returns the merged list and
 * how many copies went away.
 */
export const mergeDuplicateEntries = (entries: DreamEntry[]): { entries: DreamEntry[]; removed: number } => {
    const byKey = new Map<string, DreamEntry>();
    let removed = 0;
    for (const entry of entries) {
        const key = entry.body.toLowerCase().replace(/\s+/g, ' ').trim();
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, entry);
            continue;
        }
        removed += 1;
        // Keep the newer stamp; keep the longer body on a tie so a merged
        // entry never loses text to an older stub.
        if ((entry.day || '') >= (existing.day || '')) {
            byKey.set(key, { day: entry.day || existing.day, body: entry.body.length >= existing.body.length ? entry.body : existing.body });
        }
    }
    return { entries: [...byKey.values()], removed };
};

// ─── Phase 3c: ledger contradiction pass ────────────────────────────────────

/** Minimum settled sample before the dream trusts a ledger rate over prose. */
export const DREAM_MIN_LEDGER_SAMPLE = 5;
/** A stated rate further than this from the measured one is contradicted. */
export const DREAM_RATE_CONTRADICTION_PP = 0.2;

const RATE_CLAIM_RE = /(\d{1,3})\s*%\s*(?:win|hit)\s*rate/i;
const EDGE_WORDS = /\b(always|usually|often|tends?\s+to|reliably|works|profitable|edge)\b/i;

/**
 * Check every entry against the ledger summary:
 *  - a NUMERIC win-rate claim contradicted by the measured rate (sample ≥ 5,
 *    |stated − measured| > 20pp) is REMOVED — a memory that states a false
 *    number is worse than no memory;
 *  - a QUALITATIVE edge claim about a measured-losing setup is FLAGGED
 *    inline (the belief may still be right; the flag says what the ledger
 *    actually says), never silently deleted.
 */
export const applyLedgerContradictions = (
    entries: DreamEntry[],
    ledger: LedgerSummaryRow[],
    nowMs: number,
): { entries: DreamEntry[]; removed: Array<{ reason: string; excerpt: string }>; flags: string[] } => {
    const removed: Array<{ reason: string; excerpt: string }> = [];
    const flags: string[] = [];
    const measured = ledger.filter(r => r.sample >= DREAM_MIN_LEDGER_SAMPLE && typeof r.winRate === 'number');
    const kept: DreamEntry[] = [];
    for (const entry of entries) {
        const rateClaim = RATE_CLAIM_RE.exec(entry.body);
        if (rateClaim && measured.length > 0) {
            const stated = Number(rateClaim[1]) / 100;
            const match = measured.find(r => entry.body.toLowerCase().includes(r.label.toLowerCase()));
            // Only a MATCHED setup may be deleted on a numeric contradiction.
            // Falling back to measured[0] deleted an entry about coin A because
            // an unrelated coin B happened to be the first ledger row.
            if (match && Math.abs(stated - (match.winRate ?? 0)) > DREAM_RATE_CONTRADICTION_PP) {
                removed.push({
                    reason: `stated ${(stated * 100).toFixed(0)}% win rate vs measured ${((match.winRate ?? 0) * 100).toFixed(0)}% over ${match.sample} (${match.label})`,
                    excerpt: entry.body.slice(0, 120),
                });
                continue;
            }
        }
        const qualitative = EDGE_WORDS.test(entry.body);
        if (qualitative && measured.length > 0) {
            const against = measured.find(r => entry.body.toLowerCase().includes(r.label.toLowerCase()) && (r.winRate ?? 1) < 0.5);
            if (against) {
                const day = isoDay(nowMs);
                const flag = `[LEDGER CHECK ${day}: ${against.label} measured ${(against.winRate! * 100).toFixed(0)}% over ${against.sample} settled — treat the claim above as a hypothesis, not a fact.]`;
                entry.body = `${entry.body}\n${flag}`;
                flags.push(`${against.label}: ${flag}`);
            }
        }
        kept.push(entry);
    }
    return { entries: kept, removed, flags };
};

// ─── Phase 4: cap enforcement ───────────────────────────────────────────────

/**
 * Drop the OLDEST dated entries until the serialized file fits its cap. The
 * preamble (dayless leading entry) is never dropped — it is the file's
 * header. This is the ONLY place truncation-like behavior exists, it is
 * entry-granular, oldest-first, and every drop is reported.
 */
export const enforceCuratedCap = (
    entries: DreamEntry[],
    target: CuratedMemoryTarget,
): { entries: DreamEntry[]; dropped: Array<{ day: string; excerpt: string }> } => {
    const max = maxCharsForTarget(target);
    const dropped: Array<{ day: string; excerpt: string }> = [];
    const kept = [...entries];
    while (serializeEntries(kept).length > max) {
        const oldestIdx = kept.reduce((oldest, e, i) =>
            (e.day && (kept[oldest].day === '' || e.day < kept[oldest].day) ? i : oldest), 0);
        const victim = kept[oldestIdx];
        if (!victim || (!victim.day && kept.length === 1)) break;
        dropped.push({ day: victim.day || '(preamble)', excerpt: victim.body.slice(0, 100) });
        kept.splice(oldestIdx, 1);
    }
    return { entries: kept, dropped };
};

// ─── The pure core (phases 3–4 over two strings) ────────────────────────────

export const consolidateMemoryCore = (
    input: {
        userMd: string;
        memoryMd: string;
        nowMs: number;
        ledger: LedgerSummaryRow[];
        autopsy?: ExecutionAutopsyReport;
        extraMemoryEntry?: string;
    },
): DreamCoreResult => {
    const notes: string[] = [];
    const resolvedDates: DreamResolvedDate[] = [];
    const capDropped: DreamCoreResult['capDropped'] = [];
    const entriesRemoved: DreamCoreResult['entriesRemoved'] = [];
    const contradictionFlags: string[] = [];
    let duplicatesRemoved = 0;

    const process = (text: string, target: CuratedMemoryTarget): string => {
        const dated = resolveRelativeDates(text, input.nowMs);
        resolvedDates.push(...dated.resolved);
        let entries = parseCuratedEntries(dated.text);
        const merged = mergeDuplicateEntries(entries);
        entries = merged.entries;
        duplicatesRemoved += merged.removed;
        const checked = applyLedgerContradictions(entries, input.ledger, input.nowMs);
        entries = checked.entries;
        entriesRemoved.push(...checked.removed.map(r => ({ target, reason: r.reason, excerpt: r.excerpt })));
        contradictionFlags.push(...checked.flags);
        const capped = enforceCuratedCap(entries, target);
        entries = capped.entries;
        capDropped.push(...capped.dropped.map(d => ({ target, day: d.day, excerpt: d.excerpt })));
        return serializeEntries(entries);
    };

    const userMd = process(input.userMd, 'user');
    const extra = input.extraMemoryEntry?.trim();
    const rawMemoryWithAutopsy = extra
        ? [input.memoryMd.trim(), `## [${isoDay(input.nowMs)}]\n${extra}`].filter(Boolean).join('\n\n')
        : input.memoryMd;
    const memoryMd = process(rawMemoryWithAutopsy, 'memory');
    if (resolvedDates.length > 0) notes.push(`Resolved ${resolvedDates.length} relative date(s) to ISO days.`);
    if (duplicatesRemoved > 0) notes.push(`Merged ${duplicatesRemoved} duplicate entr(y/ies).`);
    if (entriesRemoved.length > 0) notes.push(`Removed ${entriesRemoved.length} ledger-contradicted entr(y/ies).`);
    if (contradictionFlags.length > 0) notes.push(`Flagged ${contradictionFlags.length} qualitative claim(s) the ledger cannot support.`);
    if (capDropped.length > 0) notes.push(`Dropped ${capDropped.length} oldest entr(y/ies) to satisfy the caps.`);
    if (input.autopsy?.sufficientSample && input.autopsy.findings.length > 0) {
        notes.push(...input.autopsy.findings);
    }
    return {
        userMd,
        memoryMd,
        resolvedDates,
        duplicatesRemoved,
        entriesRemoved,
        contradictionFlags,
        capDropped,
        ...(input.autopsy ? { autopsy: input.autopsy } : {}),
        notes,
    };
};

// ─── Eligibility + state ────────────────────────────────────────────────────

const STATE_KEY_PREFIX = 'memory_dream_state_v1_';

export interface DreamState {
    lastRunAt?: string;
    sessionsAtRun?: number;
}

export const readDreamState = async (username = getActiveUsername() || 'default'): Promise<DreamState> => {
    try {
        const raw = await getPreference(`${STATE_KEY_PREFIX}${username}`);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as DreamState | null;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
};

export interface DreamEligibility {
    eligible: boolean;
    hoursSince: number | null;
    newSessions: number;
    /** Blocking conditions — non-empty means ineligible. */
    reasons: string[];
    /** Non-blocking context (e.g. "first run") for the receipt. */
    notes?: string[];
}

/** The gate: >= 24h since the last consolidation AND >= 5 new sessions. */
export const dreamEligibility = (
    state: DreamState,
    newSessions: number,
    nowMs = Date.now(),
): DreamEligibility => {
    const reasons: string[] = [];
    let hoursSince: number | null = null;
    if (state.lastRunAt) {
        const last = Date.parse(state.lastRunAt);
        hoursSince = Number.isFinite(last) ? (nowMs - last) / 3_600_000 : null;
        if (hoursSince === null || hoursSince < DREAM_MIN_HOURS) {
            reasons.push(`last consolidation ${state.lastRunAt} is under ${DREAM_MIN_HOURS}h ago`);
        }
    }
    // A first consolidation has no 24h clock to satisfy: the time gate starts
    // at the FIRST run, so an empty state with enough new sessions is eligible.
    // Pushing a reason here used to make reasons.length > 0 and permanently
    // block the first run (the comment said otherwise — the logic did not).
    const notes: string[] = [];
    if (!state.lastRunAt) notes.push('no consolidation has run yet (eligible on the session-count gate alone)');
    if (newSessions < DREAM_MIN_NEW_SESSIONS) {
        reasons.push(`only ${newSessions} new session(s) since the last run (needs >= ${DREAM_MIN_NEW_SESSIONS})`);
    }
    return { eligible: reasons.length === 0, hoursSince, newSessions, reasons, notes };
};

// ─── The runner (phases 1–2 + persistence), with a concurrency lock ─────────

export interface DreamDemotedSkill {
    slug: string;
    priorStatus: SkillStatus;
    sample: number;
    expectancyR: number;
}

export interface DreamRunResult {
    ran: boolean;
    manual: boolean;
    eligibility?: DreamEligibility;
    core?: DreamCoreResult;
    beforeSnapshot?: { userMd: string; memoryMd: string };
    undoSnapshot?: { userMd: string; memoryMd: string };
    demotedSkills?: DreamDemotedSkill[];
    skillMetaUndoSnapshot?: Record<string, SkillMeta>;
    error?: string;
}

export interface DreamRunOptions {
    /** Manual trigger (/dream, button): skip the eligibility gate. */
    manual?: boolean;
    username?: string;
    nowMs?: number;
    /** Injected gatherers — the real ones read chatSessions + signalLedger + paperTrades;
     *  tests pass fixtures. */
    gather?: () => { newSessions: number; corrections: string[]; ledger: LedgerSummaryRow[]; signalRows?: SignalRow[]; paperTrades?: PaperSettledTrade[] };
}

let dreamInFlight: Promise<DreamRunResult> | null = null;

/** The default gatherer: chat-dock sessions + canonical Chat conversations +
 *  the settled signal ledger + closed paper broker trades. A Chat-surface turn is as much experience as a
 *  dock turn; counting only the dock meant five Chat sessions never unlocked
 *  a Dream (the >= 5 gate) while every gate stayed green. */
const defaultGather = async (username: string, sinceMs: number): Promise<{ newSessions: number; corrections: string[]; ledger: LedgerSummaryRow[]; signalRows: SignalRow[]; paperTrades: PaperSettledTrade[] }> => {
    let newSessions = 0;
    const corrections: string[] = [];
    try {
        // Lazy: the chat store belongs to the trade surface, not to memory.
        const { loadSessions } = await import('../trade/chatSessions');
        const sessions = loadSessions();
        newSessions = sessions.filter(s => s.createdAt > sinceMs).length;
        const boundIds = new Set(sessions.map(s => s.conversationId).filter(Boolean));
        for (const s of sessions) {
            for (const e of s.entries ?? []) {
                if (e.role === 'user' && CORRECTION_CUE_RE.test(e.text)) corrections.push(e.text.slice(0, 200));
            }
        }
        // The Chat surface stores its turns on the profile, not in chatSessions.
        // Count those conversations too, excluding ones already represented by
        // a bound dock session so one dialogue is never counted twice.
        const { getUserProfile } = await import('../infrastructure/dbService');
        const profile = await getUserProfile(username);
        newSessions += (profile?.conversations ?? [])
            .filter(c => c.timestamp > sinceMs && !boundIds.has(c.id)).length;
    } catch { /* a gather miss just weakens the pass */ }
    const ledger: LedgerSummaryRow[] = [];
    let signalRows: SignalRow[] = [];
    let paperTrades: PaperSettledTrade[] = [];
    try {
        const { readSignals } = await import('../signals/signalLedger');
        signalRows = readSignals(username).filter(r => r.resolution && r.resolution.status !== 'never_triggered');
        const rows = signalRows.filter(r => r.resolution && (r.resolution.status === 'won' || r.resolution.status === 'lost'));
        const byKey = new Map<string, LedgerSummaryRow>();
        for (const r of rows) {
            const label = `${r.signal.coin} ${r.signal.direction}`.trim();
            const row = byKey.get(label) ?? { label, wins: 0, losses: 0, sample: 0 };
            if (r.resolution!.status === 'won') row.wins += 1; else row.losses += 1;
            row.sample += 1;
            row.winRate = row.wins / row.sample;
            byKey.set(label, row);
        }
        ledger.push(...byKey.values());
    } catch { /* ledger unavailable — the dream still consolidates */ }
    try {
        const { getPaperAccount } = await import('../paper/PaperBrokerService');
        const paper = await getPaperAccount(username);
        paperTrades = Array.isArray(paper?.closedTrades) ? paper.closedTrades : [];
    } catch { /* paper store unavailable — the dream still consolidates */ }
    return { newSessions, corrections, ledger, signalRows, paperTrades };
};

/**
 * Run one consolidation. Serialized by a module lock: two overlapping calls
 * (a scheduled pass and a manual /dream) resolve to ONE run — the second
 * caller awaits the first's result instead of racing it.
 */
export const runMemoryDream = async (options: DreamRunOptions = {}): Promise<DreamRunResult> => {
    if (dreamInFlight) return dreamInFlight;
    dreamInFlight = runMemoryDreamUnlocked(options).finally(() => { dreamInFlight = null; });
    return dreamInFlight;
};

const runMemoryDreamUnlocked = async (options: DreamRunOptions): Promise<DreamRunResult> => {
    const username = options.username || getActiveUsername() || 'default';
    const nowMs = options.nowMs ?? Date.now();
    const state = await readDreamState(username);
    const sinceMs = state.lastRunAt ? Date.parse(state.lastRunAt) || 0 : 0;
    const gather = options.gather ?? (() => defaultGather(username, sinceMs));
    const { newSessions, corrections, ledger, signalRows, paperTrades } = await gather();
    const eligibility = dreamEligibility(state, newSessions, nowMs);
    if (!options.manual && !eligibility.eligible) {
        return { ran: false, manual: false, eligibility, error: eligibility.reasons.join('; ') };
    }
    // Phase 1: load + reversible before-snapshot.
    const snap = await captureCuratedMemorySnapshot(username);
    const beforeSnapshot = { userMd: snap.userMd, memoryMd: snap.memoryMd };
    // Deterministic execution autopsy (N >= 5 settled rows only). Fail-closed
    // against `rejectedFingerprints`: if rejected previously or store unreadable, withhold entry.
    const hasAutopsyInputs = (signalRows?.length ?? 0) + (paperTrades?.length ?? 0) > 0;
    const autopsy = hasAutopsyInputs
        ? buildExecutionAutopsy({ signals: signalRows ?? [], paperTrades: paperTrades ?? [] })
        : undefined;
    let extraMemoryEntry: string | undefined;
    let rejectedNote: string | undefined;
    if (autopsy?.sufficientSample && autopsy.findings.length > 0) {
        const candidate = formatAutopsyForPrompt(autopsy);
        try {
            const rejected = await isRejectedFingerprint({ kind: 'memory', target: 'memory', content: candidate }, username);
            if (!rejected) {
                extraMemoryEntry = candidate;
            } else {
                rejectedNote = 'Autopsy finding withheld: previously rejected by trader (rejectedFingerprints).';
            }
        } catch {
            rejectedNote = 'Autopsy finding withheld: durable rejection store unreadable (fail-closed).';
        }
    }
    // Phase 2 is `gather` (already run). Corrections ride the notes so the
    // receipt says what the pass was looking at.
    // Phase 3 + 4: the pure core.
    const core = consolidateMemoryCore({ userMd: snap.userMd, memoryMd: snap.memoryMd, nowMs, ledger, autopsy, extraMemoryEntry });
    if (rejectedNote) core.notes.push(rejectedNote);
    if (corrections.length > 0) core.notes.push(`Reviewed ${corrections.length} correction-cue turn(s) since the last run.`);
    // Persist through the SAME capped, receipted write path the desk tool
    // uses — but as ONE atomic pair. Both files are fields of one JSON blob,
    // so a cap refusal on either side leaves BOTH prior bytes intact: there
    // is no "USER.md consolidated, MEMORY.md refused" partial state.
    const receipts = await setCuratedMemoryTexts([
        { target: 'user', text: core.userMd },
        { target: 'memory', text: core.memoryMd },
    ], username);
    const failed = receipts.find(r => !r.ok);
    if (failed) {
        return {
            ran: false, manual: !!options.manual, eligibility, beforeSnapshot,
            undoSnapshot: beforeSnapshot,
            error: `consolidation pair refused (${failed.target}: ${failed.error ?? 'write failed'}) — no bytes were changed`,
        };
    }
    await setPreference(`${STATE_KEY_PREFIX}${username}`, JSON.stringify({ lastRunAt: new Date(nowMs).toISOString(), sessionsAtRun: newSessions } satisfies DreamState));

    // Autopsy-to-skill feedback loop: demote playbooks with N >= 5 and negative expectancy
    // to `stale`, fail-closed against `rejectedFingerprints` if user previously undid/rejected.
    const demotedSkills: DreamDemotedSkill[] = [];
    let skillMetaUndoSnapshot: Record<string, SkillMeta> | undefined;
    if (autopsy?.sufficientSample) {
        const leakyPlaybooks = autopsy.byPlaybook.filter(b => b.flaggedLeak && b.expectancyR < 0);
        for (const bucket of leakyPlaybooks) {
            const fp = skillDemotionFingerprintParts(bucket.key);
            let rejected = true;
            try {
                rejected = await isRejectedFingerprint(fp, username);
            } catch {
                core.notes.push(`Skipped demoting playbook "${bucket.key}": durable rejection store unreadable (fail-closed).`);
                continue;
            }
            if (rejected) {
                core.notes.push(`Skipped demoting playbook "${bucket.key}": previously rejected/undone by trader (rejectedFingerprints).`);
                continue;
            }
            const demotion = await demoteSkillToStale(bucket.key, {
                username,
                nowMs,
                provenance: {
                    rationale: `Playbook leak (N=${bucket.sample}, expectancy ${bucket.expectancyR}R)`,
                    recordedAt: new Date(nowMs).toISOString(),
                },
            });
            if (demotion.ok && demotion.changed && demotion.priorStatus) {
                if (!skillMetaUndoSnapshot && demotion.undoSnapshot) {
                    skillMetaUndoSnapshot = demotion.undoSnapshot;
                }
                demotedSkills.push({
                    slug: demotion.slug,
                    priorStatus: demotion.priorStatus,
                    sample: bucket.sample,
                    expectancyR: bucket.expectancyR,
                });
                core.notes.push(`Demoted leaky playbook "${demotion.slug}" to stale (N=${bucket.sample}, expectancy ${bucket.expectancyR}R; reversible).`);
            }
        }
    }

    return {
        ran: true,
        manual: !!options.manual,
        eligibility,
        core,
        beforeSnapshot,
        // The reversible before-snapshot: undo = write both files back.
        undoSnapshot: beforeSnapshot,
        ...(demotedSkills.length > 0 ? { demotedSkills } : {}),
        ...(skillMetaUndoSnapshot ? { skillMetaUndoSnapshot } : {}),
    };
};

export const formatDreamResultSummary = (result: DreamRunResult): string => {
    if (!result.ran) {
        return result.error ? `Memory consolidation skipped (${result.error}).` : 'Memory consolidation skipped.';
    }
    const core = result.core;
    if (!core) return 'Memory consolidated.';
    const parts: string[] = [];
    if (core.resolvedDates.length > 0) parts.push(`${core.resolvedDates.length} date(s) resolved`);
    if (core.duplicatesRemoved > 0) parts.push(`${core.duplicatesRemoved} duplicate(s) removed`);
    if (core.entriesRemoved.length > 0) parts.push(`${core.entriesRemoved.length} contradicted entry removed`);
    if (core.capDropped.length > 0) parts.push(`${core.capDropped.length} tail entry trimmed to cap`);
    if (result.demotedSkills && result.demotedSkills.length > 0) {
        parts.push(`${result.demotedSkills.length} leaky playbook(s) marked stale (${result.demotedSkills.map(d => d.slug).join(', ')})`);
    }
    return parts.length > 0
        ? `Memory consolidated — ${parts.join(', ')}.`
        : 'Memory consolidated — clean (no duplicates or contradictions).';
};

/** Undo a dream: restore both files from the run's before-snapshot and revert any demoted skills. */
export const undoMemoryDream = async (
    beforeSnapshot: { userMd: string; memoryMd: string },
    username = getActiveUsername() || 'default',
    opts?: { skillMetaUndoSnapshot?: Record<string, SkillMeta>; demotedSlugs?: readonly string[] },
): Promise<boolean> => {
    const { undoMemorySnapshot } = await import('./curatedMemory');
    const a = await undoMemorySnapshot('user', beforeSnapshot.userMd, username);
    const b = await undoMemorySnapshot('memory', beforeSnapshot.memoryMd, username);
    let metaOk = true;
    if (opts?.skillMetaUndoSnapshot) {
        metaOk = await undoSkillMetaSnapshot(opts.skillMetaUndoSnapshot, username);
    }
    for (const slug of opts?.demotedSlugs ?? []) {
        await recordRejectedFingerprint(
            skillDemotionFingerprintParts(slug),
            'user_undo',
            `Undid /dream stale demotion for ${slug}`,
            username,
        ).catch(() => { /* best-effort */ });
    }
    return a.ok && b.ok && metaOk;
};
