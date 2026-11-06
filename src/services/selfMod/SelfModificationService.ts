/**
 * SelfModificationService — the rails on an agent that edits its own harness.
 *
 * The capability is real, and so is the ceiling. Two surfaces actually change
 * how this app behaves, and both are already wired into every run:
 *
 *  - `config` tier — the behavior knobs the harness reads per call
 *    (`responseEffort`). Applied immediately, ledgered, and
 *    AUTO-REVERTED when the window closes. This is what makes the agent faster
 *    or less forgetful for the work in front of it, without letting a
 *    mid-task guess become tomorrow's default.
 *  - `shadow` tier — prompt overrides (`services/infrastructure/
 *    PromptOverrideService`). The app already A/Bs an edited corpus against the
 *    built-in text and already stamps `promptVersion` on every closed trade,
 *    so a self-edited instruction is judged by the trades it produced, not by
 *    the model's opinion of its own edit. It is refused unless that
 *    measurement is actually armed.
 *
 * What is NOT here, on purpose:
 *  - Risk. Sizing, leverage, the edge floor, the session guard and outcome
 *    settlement are the trader's, and the deny list says so by name.
 *  - The measuring instrument. `promptAbRate` is blocked because an agent
 *    that can disarm the A/B can make its own shadow edit unfalsifiable.
 *  - Privacy and the off-switch. `sensitiveMemoryEnabled` and the memory
 *    switch stay owner-only.
 *  - `selfModificationMode` itself. Nothing in this file may widen its own
 *    authority, and the desk tool that reaches this file cannot turn it on.
 *  - Skills. They are documents written through `writeSkillFile`; no
 *    self-change target may write one.
 */

import {
    getHarnessSettings, saveHarnessSettings, type HarnessSettings,
} from '../../utils/harnessSettings';
import { getActiveUsername } from '../../utils/activeUser';
import { isRegisteredPromptId } from '../../constants/promptIds';
import { scanSkillText } from '../../utils/skillFrontmatter';
import {
    getPromptOverrides, promptCorpusVersion, resetPromptOverride, savePromptOverride, validatePromptOverride,
} from '../infrastructure/PromptOverrideService';
import {
    getSelfChange, listSelfChanges, liveSelfChanges, patchSelfChange, writeSelfChange,
} from './SelfChangeLedger';
import { SelfChangeSchema, type SelfChange, type SelfChangeActor, type SelfModMode } from '../../schemas/selfChange';
import { TradeOutcome, type LoggedTrade } from '../../types';

/** How long a config-tier change stays in force before it reverts itself. */
export const SELF_CHANGE_WINDOW_MS = 24 * 3600_000;
/** A target may not be re-changed inside this window, so the agent cannot
 *  oscillate a knob to chase a result. Measured from the newest row naming it. */
export const SELF_CHANGE_COOLDOWN_MS = 6 * 3600_000;
/** Simultaneous in-force config changes, all tiers included. */
export const MAX_LIVE_SELF_CHANGES = 8;
/** The shadow settles on the same evidence bar the prompt A/B already uses —
 *  5 closed trades per side and an 8-point win-rate gap, the numbers
 *  `summarizePromptLanes` is read against. Restating a looser bar here would
 *  make a self-edit easier to promote than the app's own experiment. */
export const SHADOW_MIN_TRADES_PER_SIDE = 5;
export const SHADOW_MIN_WINRATE_GAP_PP = 8;
export const PROMPT_OVERRIDE_MAX_CHARS = 6_000;

/** Prompts the agent may never rewrite, whatever the mode: the text that
 *  carries the risk rules is the one override that would turn a shadow edit
 *  into a policy change. */
export const BLOCKED_PROMPT_IDS: readonly string[] = ['analysis.risk_rules'];

export type SelfModResult<T = SelfChange> =
    | { ok: true; change: T; note?: string }
    | { ok: false; error: string };

const nowIso = (): string => new Date().toISOString();

const newId = (tier: SelfChange['tier'], target: string): string => {
    const clean = target.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28);
    for (let i = 0; i < 20; i += 1) {
        const candidate = `${tier}-${clean || 'target'}-${Date.now().toString(36)}${i ? `-${i}` : ''}`.slice(0, 60);
        if (!getSelfChange(candidate)) return candidate;
    }
    return `${tier}-${clean}-${Date.now().toString(36)}-x`.slice(0, 60);
};

/** ── The knob whitelist ─────────────────────────────────────────────────── */

type KnobDecode =
    | { ok: true; stored: string; apply: (username: string) => void }
    | { ok: false; refusal: string };

interface KnobDef {
    label: string;
    read: () => string;
    /** Decode + clamp a proposed JSON value. `ok:false` means refused, with the
     *  reason attached — a knob never silently accepts what it cannot use. */
    decode: (raw: string) => KnobDecode;
    hint: string;
}

const KNOBS: Record<string, KnobDef> = {
    responseEffort: {
        label: 'thinking effort',
        read: () => JSON.stringify(getHarnessSettings().responseEffort),
        decode: raw => {
            let value: unknown;
            try { value = JSON.parse(raw); } catch { return { ok: false, refusal: 'responseEffort must be the JSON string "fast" or "quality"' }; }
            if (value !== 'fast' && value !== 'quality') return { ok: false, refusal: 'responseEffort accepts only "fast" or "quality"' };
            return {
                stored: JSON.stringify(value),
                apply: () => { saveHarnessSettings({ responseEffort: value }); },
                ok: true,
            };
        },
        hint: '"quality" runs the built-in role→effort schedule; "fast" drops every reasoning task one tier. Speed, not capability.',
    },
};

/** ── The deny list (defense in depth + an honest refusal message) ───────── */

const BLOCKED_KNOB_REASONS: Record<string, string> = {
    equityUsd: 'account equity is the trader\'s',
    riskPercent: 'position risk is the trader\'s',
    defaultLeverage: 'leverage is the trader\'s',
    minEdgeR: 'the edge floor is a risk gate',
    guardPreset: 'the session guard is a risk gate',
    guardDailyLossPct: 'the daily loss limit is a risk gate',
    guardMaxTradesPerDay: 'the trade cap is a risk gate',
    guardPostLossCooldownMin: 'the post-loss cooldown is a risk gate',
    outcomeSettlement: 'how outcomes are recorded is the trader\'s',
    sensitiveMemoryEnabled: 'the sensitive-memory privacy switch is the trader\'s',
    promptAbRate: 'the measurement itself cannot be moved by the thing being measured',
    deskToolsEnabled: 'whether the desk may call live tools at all is the trader\'s',
    selfModificationMode: 'self-modification cannot be enabled by self-modification',
};

const modeRank: Record<SelfModMode, number> = { off: 0, config: 1, shadow: 2 };

export const getSelfModMode = (): SelfModMode => getHarnessSettings().selfModificationMode;

/** Owner-only. The Settings surface calls this; no desk tool may, and the
 *  knob whitelist above has no entry that reaches it. Turning the mode OFF
 *  also undoes what the agent did with it: a trader who pulls the switch is
 *  not asking for its effects to ride every run until the windows happen to
 *  close. */
export const setSelfModMode = async (mode: SelfModMode, username = getActiveUsername()): Promise<SelfModMode> => {
    saveHarnessSettings({ selfModificationMode: mode });
    if (mode === 'off') {
        // Active, shadow AND promoted: a promoted override is still the
        // agent's text steering the next run, and a trader who pulls the
        // switch is not asking for that to keep riding.
        const live = liveSelfChanges().filter(r => r.actor === 'agent');
        for (const row of live) {
            const res = await revertSelfChange(row.id, 'owner', {
                username,
                note: 'reverted: the trader turned self-modification off',
            });
            if (!res.ok) console.warn(`[SelfMod] "${row.id}" survived the switch-off: ${res.error}`);
        }
    }
    return getSelfModMode();
};

export interface SelfModActorOptions {
    actor?: SelfChangeActor;
    username?: string;
    /** Set by the unattended/detached seats: they may read the ledger and
     *  never write it. */
    readOnly?: boolean;
}

const requireMode = (need: SelfModMode, opts: SelfModActorOptions): string | null => {
    const mode = getSelfModMode();
    if (modeRank[mode] >= modeRank[need]) return null;
    if (opts.readOnly) {
        return 'self-modification is read-only on this seat: a detached or restricted run may audit changes, never make one.';
    }
    return need === 'shadow'
        ? `self-modification is "${mode}"; a prompt override needs "shadow". The trader turns it on in Settings → Analysis.`
        : `self-modification is "${mode}"; the trader turns it on in Settings → Analysis.`;
};

const newestRowAt = (target: string): SelfChange | null =>
    listSelfChanges().find(r => r.target === target) ?? null;

/** Who is allowed to ask at all. Checked first, so a seat that cannot write
 *  never learns anything about the value it wanted. */
const permissionCheck = (tier: SelfChange['tier'], opts: SelfModActorOptions): string | null => {
    const modeError = requireMode(tier, opts);
    if (modeError) return modeError;
    if (opts.readOnly) {
        return 'self-modification is read-only on this seat: a detached or restricted run may audit changes, never make one.';
    }
    return null;
};

/** The churn rails. Checked AFTER the payload is known to be valid, so a call
 *  that could never have applied does not get a cooldown lecture instead of
 *  the reason it is wrong. */
const churnCheck = (target: string): string | null => {
    // The ceiling counts PENDING changes (active or still measuring), not
    // promoted ones: an edit the evidence already accepted is settled
    // knowledge, not churn, and it must not occupy a slot forever.
    const pending = listSelfChanges().filter(r => r.status === 'active' || r.status === 'shadow');
    if (pending.length >= MAX_LIVE_SELF_CHANGES) {
        return `refused: ${pending.length} self-changes are already in force or in shadow (the ceiling is ${MAX_LIVE_SELF_CHANGES}). Revert one with revert_self_change before proposing another.`;
    }
    const last = newestRowAt(target);
    if (last && last.actor !== 'owner') {
        const since = Date.now() - Date.parse(last.updatedAt);
        if (since < SELF_CHANGE_COOLDOWN_MS) {
            return `refused: "${target}" was changed ${(since / 3600_000).toFixed(1)}h ago. A target rests for ${SELF_CHANGE_COOLDOWN_MS / 3600_000}h before it changes again — flipping a knob to chase a result is the drift these rails exist to stop.`;
        }
    }
    return null;
};

const record = async (
    partial: Omit<SelfChange, 'schemaVersion' | 'id' | 'version' | 'createdAt' | 'updatedAt'>,
    opts: SelfModActorOptions,
): Promise<SelfChange> => {
    const now = nowIso();
    const row = SelfChangeSchema.parse({
        schemaVersion: 1,
        ...partial,
        id: newId(partial.tier, partial.target),
        version: 1,
        createdAt: now,
        updatedAt: now,
    });
    await writeSelfChange(row, opts.username || getActiveUsername());
    return row;
};

/**
 * Change a behavior knob. Applies now, reverts itself at
 * `SELF_CHANGE_WINDOW_MS`.
 */
export const proposeKnobChange = async (
    key: string,
    valueJson: string,
    reason: string,
    opts: SelfModActorOptions = {},
): Promise<SelfModResult> => {
    if (!reason || !reason.trim()) return { ok: false, error: 'a self-change must say why' };
    if (BLOCKED_KNOB_REASONS[key]) return { ok: false, error: `"${key}" is blocked: ${BLOCKED_KNOB_REASONS[key]}.` };
    const knob = KNOBS[key];
    if (!knob) {
        const names = Object.keys(KNOBS).join(', ');
        return { ok: false, error: `knob "${key}" is not open to self-modification. Open knobs: ${names}. A prompt override is a different call (kind:"prompt").` };
    }
    const target = `knob:${key}`;
    const permission = permissionCheck('config', opts);
    if (permission) return { ok: false, error: permission };
    const decoded = knob.decode(valueJson);
    if (!decoded.ok) return { ok: false, error: `${target} rejected: ${decoded.refusal}` };
    const before = knob.read();
    if (before === decoded.stored) return { ok: false, error: `${target} is already ${decoded.stored} — nothing changed, so nothing was ledgered.` };
    const churn = churnCheck(target);
    if (churn) return { ok: false, error: churn };
    try {
        decoded.apply(opts.username || getActiveUsername());
    } catch (err) {
        return { ok: false, error: `${target} could not be applied: ${err instanceof Error ? err.message : String(err)}` };
    }
    const row = await record({
        tier: 'config',
        target,
        before,
        after: decoded.stored,
        reason: reason.trim().slice(0, 600),
        status: 'active',
        actor: opts.actor || 'agent',
        expiresAt: new Date(Date.now() + SELF_CHANGE_WINDOW_MS).toISOString(),
    }, opts);
    return { ok: true, change: row, note: `reverts automatically in ${SELF_CHANGE_WINDOW_MS / 3600_000}h unless the trader keeps it` };
};

/**
 * Rewrite what the model is told. Only with the mode at 'shadow', only for a
 * registered prompt, and only while the app's own A/B is armed — an override
 * that no control lane is compared against is an unmeasured change to the
 * harness, which is exactly what this tier is not allowed to be.
 */
export const proposePromptOverride = async (
    promptId: string,
    text: string,
    reason: string,
    opts: SelfModActorOptions = {},
): Promise<SelfModResult> => {
    if (!reason || !reason.trim()) return { ok: false, error: 'a self-change must say why' };
    if (!isRegisteredPromptId(promptId)) {
        return { ok: false, error: `prompt "${promptId}" is not a registered prompt id, so no call site would resolve it.` };
    }
    if (BLOCKED_PROMPT_IDS.includes(promptId)) {
        return { ok: false, error: `prompt "${promptId}" is blocked from self-modification: it carries the risk rules, which are the trader's.` };
    }
    const target = `prompt:${promptId}`;
    const permission = permissionCheck('shadow', opts);
    if (permission) return { ok: false, error: permission };
    const body = text.trim();
    if (!body) return { ok: false, error: `${target} rejected: an empty override would silently restore the built-in text — revert the row instead.` };
    if (body.length > PROMPT_OVERRIDE_MAX_CHARS) {
        return { ok: false, error: `${target} rejected: ${body.length} chars over the ${PROMPT_OVERRIDE_MAX_CHARS} ceiling. A prompt that long is a document; put the material where the model can read it on demand.` };
    }
    const scan = scanSkillText(body);
    if (scan.length > 0) {
        return { ok: false, error: `${target} rejected by the content scan: ${scan.map(h => `${h.severity}: ${h.what}`).join('; ')}` };
    }
    const warnings = validatePromptOverride(body);
    if (warnings.some(w => w.startsWith('Unknown placeholders'))) {
        return { ok: false, error: `${target} rejected: ${warnings.find(w => w.startsWith('Unknown placeholders'))}. A placeholder the harness does not substitute reaches the model as literal braces.` };
    }

    const settings = getHarnessSettings();
    if (settings.promptAbRate <= 0) {
        return {
            ok: false,
            error: `${target} refused: this override cannot be judged while the prompt A/B is disarmed (rate ${settings.promptAbRate}). `
                + 'The trader sets a sampling rate above 0% in Settings → Usage; until then a shadow edit would go to every run with nothing to compare it against.',
        };
    }

    const before = getPromptOverrides()[promptId] ?? '';
    if (before === body) {
        return { ok: false, error: `${target} already holds exactly this text — nothing changed, so nothing was ledgered.` };
    }
    const churn = churnCheck(target);
    if (churn) return { ok: false, error: churn };
    const username = opts.username || getActiveUsername();
    try {
        await savePromptOverride(promptId, body, username);
    } catch (err) {
        return { ok: false, error: `${target} could not be saved: ${err instanceof Error ? err.message : String(err)}` };
    }
    // The fingerprint of the corpus this text now produces, so the settle pass
    // can attribute the trades that were actually decided under it.
    const corpusVersion = promptCorpusVersion('live');
    const row = await record({
        tier: 'shadow',
        target,
        before,
        after: body,
        reason: reason.trim().slice(0, 600),
        status: 'shadow',
        actor: opts.actor || 'agent',
        corpusVersion,
        evidence: warnings.length > 0 ? `advisory: ${warnings.join(' | ')}`.slice(0, 1000) : undefined,
    }, opts);
    return {
        ok: true,
        change: row,
        note: `the built-in text keeps the control lane; this override settles on ${SHADOW_MIN_TRADES_PER_SIDE}+ closed trades per side`,
    };
};

/** The one undo path. Owner rows are not the agent's to revert. */
export const revertSelfChange = async (
    id: string,
    by: SelfChangeActor = 'owner',
    opts: { username?: string; note?: string } = {},
): Promise<SelfModResult> => {
    const row = getSelfChange(id);
    if (!row) return { ok: false, error: `no self-change "${id}". list_self_changes prints every row.` };
    // A promoted row is only the trader's to pull back: the party that won the
    // evidence argument does not get the last word over the outcome it produced.
    const revertible = row.status === 'active' || row.status === 'shadow'
        || (row.status === 'promoted' && by !== 'agent');
    if (!revertible) {
        return { ok: false, error: `"${id}" is ${row.status}; there is nothing to revert.` };
    }
    if (by === 'agent' && row.actor === 'owner') {
        return { ok: false, error: `"${id}" was made by the trader, not the agent — only the trader can revert it.` };
    }
    const username = opts.username || getActiveUsername();
    if (row.target.startsWith('knob:')) {
        const key = row.target.slice('knob:'.length);
        const knob = KNOBS[key];
        if (!knob) return { ok: false, error: `"${id}" names knob "${key}", which is no longer a known knob — it cannot be restored automatically.` };
        const restored = knob.decode(row.before);
        if (!restored.ok) return { ok: false, error: `"${id}" could not be reverted: the stored previous value is invalid (${restored.refusal}).` };
        restored.apply(username);
    } else if (row.target.startsWith('prompt:')) {
        await resetPromptOverride(row.target.slice('prompt:'.length), username);
    } else {
        return { ok: false, error: `"${id}" targets "${row.target}", which this service does not own.` };
    }
    const updated = await patchSelfChange(row.id, {
        status: 'reverted',
        evidence: opts.note ?? (by === 'owner'
            ? 'reverted by the trader'
            : by === 'agent' ? "reverted at the agent's request" : 'reverted by the harness rail'),
    }, username);
    if (!updated) return { ok: false, error: `"${id}" was undone in effect but its ledger row vanished — the audit trail is broken and needs a look.` };
    return { ok: true, change: updated };
};

/** Config-tier expiry: a window that closed reverts the knob it moved. */
export const expireSelfChanges = async (
    now = Date.now(),
    opts: { username?: string } = {},
): Promise<SelfChange[]> => {
    const due = listSelfChanges().filter(r =>
        r.status === 'active' && r.tier === 'config' && typeof r.expiresAt === 'string' && Date.parse(r.expiresAt) <= now);
    const done: SelfChange[] = [];
    for (const row of due) {
        const res = await revertSelfChange(row.id, 'system', {
            username: opts.username,
            note: `auto-reverted: the ${SELF_CHANGE_WINDOW_MS / 3600_000}h self-change window closed`,
        });
        if (res.ok) done.push(res.change);
        else console.warn(`[SelfMod] window closed on "${row.id}" but it did not revert: ${res.error}`);
    }
    return done;
};

const closedWinLoss = (trades: LoggedTrade[], version: string): { trades: number; winRate: number | null } => {
    const rows = trades.filter(t =>
        t.promptVersion === version
        && (t.outcome === TradeOutcome.WIN || t.outcome === TradeOutcome.LOSS));
    const wins = rows.filter(t => t.outcome === TradeOutcome.WIN).length;
    return { trades: rows.length, winRate: rows.length > 0 ? Math.round((wins / rows.length) * 100) : null };
};

/**
 * Settle the shadow tier against closed trades. The comparison is the one the
 * app already runs — an edited corpus vs `defaults` — because that is what the
 * control lane resolves by construction. An override that loses to the
 * built-in text is reverted by this pass; one that wins is marked promoted and
 * stops being compared.
 */
export const settleSelfChanges = async (
    trades: LoggedTrade[],
    opts: { username?: string } = {},
): Promise<SelfChange[]> => {
    const shadow = listSelfChanges().filter(r => r.status === 'shadow' && r.tier === 'shadow' && r.corpusVersion);
    if (shadow.length === 0) return [];
    const baseline = closedWinLoss(trades, 'defaults');
    if (baseline.trades < SHADOW_MIN_TRADES_PER_SIDE || baseline.winRate === null) return [];
    const settled: SelfChange[] = [];
    for (const row of shadow) {
        const mine = closedWinLoss(trades, row.corpusVersion!);
        if (mine.trades < SHADOW_MIN_TRADES_PER_SIDE || mine.winRate === null) continue;
        const gap = mine.winRate - baseline.winRate;
        const label = `${mine.trades} trades at ${mine.winRate}% vs the built-in text at ${baseline.winRate}% on ${baseline.trades}`;
        if (gap >= SHADOW_MIN_WINRATE_GAP_PP) {
            const updated = await patchSelfChange(row.id, { status: 'promoted', evidence: `kept: ${label}` }, opts.username);
            if (updated) settled.push(updated);
            continue;
        }
        if (gap <= -SHADOW_MIN_WINRATE_GAP_PP) {
            const reverted = await revertSelfChange(row.id, 'system', {
                username: opts.username,
                note: `auto-reverted: the edit lost to the built-in text — ${label}`,
            });
            if (!reverted.ok) {
                console.warn(`[SelfMod] shadow lost but did not revert ("${row.id}"): ${reverted.error}`);
                continue;
            }
            settled.push(reverted.change);
        }
        // Inside the band: still measuring. No verdict is the honest state.
    }
    return settled;
};

/** Names the open knobs for the tool description and the refusal message. */
export const openKnobNames = (): string[] => Object.keys(KNOBS);

export const knobHint = (key: string): string | undefined => KNOBS[key]?.hint;

/** Belt for callers that patch settings directly: the blocked keys, so a write
 *  path outside this service can check the same list rather than invent one. */
export const isBlockedKnob = (key: keyof HarnessSettings | string): boolean =>
    Object.prototype.hasOwnProperty.call(BLOCKED_KNOB_REASONS, key);
