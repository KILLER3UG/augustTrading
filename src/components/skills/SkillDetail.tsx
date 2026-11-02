import React, { useState } from 'react';
import { setSkillStatus, skillExpectancyR, skillEnabledFlag, isApprovedSkill, isInjectableSkill, EXPECTANCY_MIN_R_SAMPLE } from '../../services/learning/SkillMemoryService';
import { getMemoryFiles, withNotebookWriteLock, deleteMemoryFileUnlocked } from '../../services/learning/MemoryFilesService';
import type { SkillMeta } from '../../services/learning/SkillMemoryService';
import type { SkillProofResult } from '../../services/learning/skillProof';
import { parsePredicate } from '../../services/analysis/skillPredicate';
import { evaluateSkill, SkillEvalResult, recordEvalVerdict } from '../../services/learning/SkillEvalService';
import type { LoggedTrade } from '../../types';
import type { ProviderConfig } from '../../types/provider';
import { getActiveUsername } from '../../utils/activeUser';
import { requestSkillTry } from '../chat/skillDeepLink';
import MarkdownContent from '../shared/MarkdownContent';
import { ToggleSwitch } from '../shared/ToggleSwitch';
import { FlaskConical, History } from '../shared/Icons';

/**
 * Shared building blocks for the Strategy Studio (the single skill-library
 * surface, formerly split between Settings → Skills and the Studio). The
 * card, the badges, the "try in chat" dispatch, and the detail pane all live
 * here so the dashboard surface never imports from `components/settings`.
 */

export interface SkillCardData {
    fileId: string;
    name: string;
    meta: SkillMeta | null;
    body: string;
}

/** Two-letter monogram for the card tile ("Avoid BTC…" → "AB"). */
export const monogramOf = (name: string): string => {
    const cleaned = name.replace(/^(avoid|repeat)[-_ ]?/i, '');
    const words = cleaned.split(/[-_\s]+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return cleaned.slice(0, 2).toUpperCase() || 'SK';
};

export const STATUS_BADGE: Record<string, { label: string; className: string }> = {
    candidate: { label: 'CANDIDATE', className: 'bg-zinc-800 text-zinc-400' },
    confirmed: { label: 'CONFIRMED', className: 'bg-emerald-950/60 text-emerald-400' },
    retired: { label: 'RETIRED', className: 'bg-zinc-900 text-zinc-600 line-through' },
};

export const KIND_BADGE: Record<string, { label: string; className: string }> = {
    avoid: { label: 'AVOID', className: 'bg-rose-950/50 text-rose-400/90' },
    repeat: { label: 'REPEAT', className: 'bg-zinc-800 text-zinc-300' },
};

/** localStorage key for the user's pinned-skill order (kept the historical
 *  name so existing pins survive the move from the Settings grid to Studio). */
export const PIN_STORAGE_KEY = 'skills_grid_pins_v1';

/** First prose line of the skill body, used as the card/detail description. */
export const descriptionOf = (body: string): string =>
    body
        .split('\n')
        .map(l => l.trim())
        .find(l => l.length > 0 && !l.startsWith('#')) ?? '';

/**
 * "Try in chat" — drops the skill's /slug into the Chart AI composer. The dock
 * owns the composer and its listener (see TradeChatPanel), and it is not
 * mounted while this card is on screen, so the hand-off is parked as well as
 * broadcast — see components/chat/skillDeepLink.
 */
export const trySkillInChat = (slug: string): void => {
    requestSkillTry(slug);
};

/** Toggle a skill's retired/active status and let the caller refresh. */
export const toggleSkillRetire = async (s: SkillCardData): Promise<void> => {
    const next = s.meta?.status === 'retired' ? 'candidate' : 'retired';
    await setSkillStatus(s.fileId, next);
};

/** Remove the skill file outright. Retiring is the soft move; WS-2.3's point is
 *  that the human keeps the hard one even though the supervisor now does the
 *  approving, so it has to be reachable where the skill is actually read.
 *
 *  A skill that arrived as a FOLDER — by picker or by URL — owns bundled files
 *  named `<slug>__<role>__<leaf>` beside it. Deleting only the head would leave
 *  those bytes in the library addressed by nothing: the L1 list is drawn from
 *  the parent, so the trader sees one row vanish and four files stay. They go
 *  with it, inside ONE write lock, so a delete is one notebook write rather
 *  than a torn sequence. Returns how many files went, which is what lets the
 *  UI say so instead of guessing. */
export const deleteSkillFile = async (s: SkillCardData): Promise<number> => {
    const username = getActiveUsername();
    const notebook = getMemoryFiles();
    const head = notebook.files.find(f => f.id === s.fileId);
    const slug = head ? head.name.replace(/\.md$/i, '') : '';
    const bundles = head && slug
        ? notebook.files.filter(f => f.folderId === head.folderId && f.name.startsWith(`${slug}__`))
        : [];
    await withNotebookWriteLock(async () => {
        for (const f of [...bundles, ...(head ? [head] : [])]) {
            await deleteMemoryFileUnlocked(f.id, username);
        }
    });
    return bundles.length + (head ? 1 : 0);
};

const MetaField: React.FC<{ label: string; value: string; wide?: boolean }> = ({ label, value, wide }) => (
    <div className={wide ? 'col-span-2' : ''}>
        <p className="text-ui-xs uppercase tracking-widest text-zinc-600">{label}</p>
        <p className="mt-0.5 text-ui-sm font-medium text-zinc-300">{value}</p>
    </div>
);

/** Detail pane for one skill — meta panel + full instructions, like the
 *  reference gallery's skill page. Includes the manual A/B eval runner (the
 *  same evaluateSkill the auto-scheduler uses, fired on demand) and the
 *  free history proof. */
const SkillDetail: React.FC<{
    skill: SkillCardData;
    onBack: () => void;
    onToggleRetire: () => void;
    /** Deletes the skill file for good (the caller refreshes + backs out).
     *  Absent ⇒ no delete affordance. */
    onDelete?: () => void;
    memoryConfig?: ProviderConfig | null;
    loggedTrades?: LoggedTrade[];
    /** Label for the back affordance (the surface it was opened from). */
    backLabel?: string;
}> = ({ skill, onBack, onToggleRetire, onDelete, memoryConfig, loggedTrades, backLabel = 'Library' }) => {
    const meta = skill.meta;
    // Two-step confirm rather than a dialog: this pane is rendered by three
    // surfaces and none of them owns a confirm context.
    const [armed, setArmed] = useState(false);
    const [undoArmed, setUndoArmed] = useState(false);
    const retired = meta?.status === 'retired';
    /** WHY this skill is or is not reaching a model right now.
     *
     *  The label above used to read `retired ? 'Retired' : 'Active'` — a STATUS
     *  test — while the injectors gate on `skillEnabledFlag(meta)`. Three states
     *  fall in that gap and all three were labelled "Active" while contributing
     *  nothing: suspended by the idle sweep (`suspendedAt`, at 90 days of
     *  silence), switched off by the trader (`disabledByUser`), and superseded by
     *  a generalized skill. So the pane said a skill was live for a rule the
     *  desk had quietly stopped using.
     *
     *  Derived from the canonical flag rather than re-testing the fields, because
     *  `skillEnabledFlag` is the ONE place `enabled` may be derived — a second
     *  implementation here is exactly how the label and the injectors drift
     *  apart again. */
    const live = meta ? skillEnabledFlag(meta) : false;
    /** Reaching the desk right now. `skillEnabledFlag` deliberately does NOT
     *  test `supersededBy` — it owns the `enabled` FILE field, and a superseded
     *  skill keeps its file enabled so its evidence stays queryable as the
     *  control group. But a superseded skill is retired from MATCHING
     *  (`SkillMeta.supersededBy`), so it is not live either. Layered on top of
     *  the canonical flag rather than folded into it, because changing that flag
     *  would start writing `enabled:false` on a file whose bytes are still read.
     *  Approval is layered the same way, and read from `isApprovedSkill` — the ONE
     *  place that fact is decided — rather than re-tested: the injection and the
     *  skills index both refuse an unapproved rule, so a card calling it "Active"
     *  would be a check on a skill that reaches no seat. Guarded on `meta`
     *  being present, because a pane with no file open has no approval to read. */
    const tentative = meta?.approvedBy === 'tentative';
    const reaching = live && !!meta && !meta.supersededBy && isInjectableSkill(meta);
    const liveReason = retired
        ? undefined
        : tentative
            ? meta?.demotion
                ?? (reaching
                    ? 'Tentative — learned from tracked outcomes, injected as CONTEXT ONLY. It never vetoes or caps confidence; switch it off here to stop it.'
                    : 'Tentative skills are switched off in Settings, or this one is suspended/disabled — no seat is given it.')
            : reaching
                ? undefined
                : meta?.demotion
                    ? meta.demotion
                    : meta?.suspendedAt
                        ? 'Suspended — no evidence for 90 days. Still matched, so it can revive on its own.'
                        : meta?.disabledByUser
                            ? 'You switched this off in the notebook.'
                            : meta?.supersededBy
                                ? `Absorbed into ${meta.supersededBy}. Its evidence is kept as the control group.`
                                : meta && !isApprovedSkill(meta)
                                    ? meta.approvedBy === 'supervisor'
                                        ? 'Accepted by the LLM supervisor, not by you — and nothing model-approved reaches a seat.'
                                        : 'Nothing has approved this rule, so no seat is given it. A skill reaches a seat only on a human approval; the starter library has its own switch in Settings.'
                                    : 'Not reaching the desk.';
    const wins = Math.round(meta?.wins ?? 0);
    const losses = Math.round(meta?.losses ?? 0);
    const refined = Boolean(meta?.previousVersion && meta?.refinedAt);
    // Average R per measured outcome. Undefined is the honest "not yet
    // measured" state, not 0R — only trades whose R came from actual price
    // levels feed it, so a young skill shows a sample count instead of a
    // number it has not earned.
    const expectancy = meta ? skillExpectancyR(meta) : undefined;
    // A skill can carry a trigger that stopped parsing (hand edit, schema
    // drift). Resolve it once so the card can distinguish "no trigger" from
    // "trigger present but inert", which are very different states to a reader.
    const predicateParse = meta?.predicate ? parsePredicate(meta.predicate) : null;
    const parsedPredicate = predicateParse?.ok ?? false;
    const parsedError = predicateParse && !predicateParse.ok ? predicateParse.error : '';
    // Manual A/B eval state — user-invoked, cost-capped by SKILL_EVAL_MAX_TRADES.
    const [evalState, setEvalState] = useState<'idle' | 'running' | 'done'>('idle');
    const [evalResult, setEvalResult] = useState<SkillEvalResult | null>(null);
    // On-demand history proof — pure code + klines, no provider call.
    const [proofState, setProofState] = useState<'idle' | 'running' | 'done'>('idle');
    const [proofResult, setProofResult] = useState<SkillProofResult | null>(null);

    const runProof = async (): Promise<void> => {
        if (!meta || proofState === 'running') return;
        if (!meta.coin) {
            setProofResult({ status: 'no-data', message: 'This skill is not scoped to a coin, so there is no chart to prove it on.' });
            setProofState('done');
            return;
        }
        setProofState('running');
        setProofResult(null);
        try {
            const { proofSkillOnHistory, skillProofText } = await import('../../services/learning/skillProof');
            const res = await proofSkillOnHistory({
                coin: meta.coin,
                timeframe: meta.timeframe || '1h',
                text: skillProofText({
                    title: skill.name, description: meta.description,
                    family: meta.family, when: meta.when,
                }),
            });
            setProofResult(res);
            setProofState('done');
        } catch (err) {
            setProofResult({ status: 'no-data', message: err instanceof Error ? err.message : String(err) });
            setProofState('done');
        }
    };

    const runManualEval = async (): Promise<void> => {
        if (!memoryConfig || evalState === 'running') return;
        setEvalState('running');
        setEvalResult(null);
        try {
            const username = getActiveUsername();
            const { buildDefaultRunner } = await import('../../services/learning/SkillEvalScheduler');
            const result = await evaluateSkill(
                skill.fileId,
                username,
                loggedTrades ?? [],
                memoryConfig,
                buildDefaultRunner(memoryConfig, username),
            );
            setEvalResult(result);
            setEvalState('done');
            // Same ledger the auto-scheduler writes: verdict feeds
            // deriveStatus (helps/hurts streaks), so a manual run can
            // rehabilitate or demote exactly like an automated one.
            await recordEvalVerdict(skill.fileId, result, username);
        } catch (err) {
            setEvalResult({
                fileId: skill.fileId,
                name: skill.name,
                verdict: 'inconclusive',
                flips: 0, alignedFlips: 0, misalignedFlips: 0, cases: [],
                error: err instanceof Error ? err.message : String(err),
            });
            setEvalState('done');
        }
    };

    const evalBadge = (verdict: SkillEvalResult['verdict']): string => {
        switch (verdict) {
            case 'helps': return 'bg-emerald-950/60 text-emerald-400';
            case 'hurts': return 'bg-rose-950/50 text-rose-400/90';
            case 'mixed': return 'bg-amber-950/60 text-amber-400';
            default: return 'bg-zinc-800 text-zinc-400';
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-col animate-fade-in">
            <button
                type="button"
                onClick={onBack}
                className="flex items-center gap-1.5 self-start pb-5 text-ui-base text-zinc-400 transition-colors hover:text-zinc-100"
            >
                ← {backLabel}
            </button>

            <div className="flex items-start justify-between gap-4 pb-5">
                <div className="min-w-0">
                    <h3 className="truncate text-ui-xl font-bold tracking-tight text-zinc-100" title={skill.name}>{skill.name}</h3>
                    <p className="mt-1 text-ui-base leading-relaxed text-zinc-500">
                        {meta?.description || descriptionOf(skill.body) || 'No description.'}
                    </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 pt-1">
                    <span className="text-ui-xs font-medium uppercase tracking-widest text-zinc-500"
                        title={liveReason ?? undefined}>
                        {retired
                            ? 'Retired'
                            : tentative && reaching
                                ? 'Tentative'
                                : reaching
                                    ? 'Active'
                                    : meta?.demotion
                                        ? 'Auto-demoted'
                                        : meta?.suspendedAt ? 'Suspended' : 'Inactive'}
                    </span>
                    <ToggleSwitch checked={!retired} onChange={onToggleRetire} label={`Toggle ${skill.name} active`} />
                    {tentative && !retired && (
                        <span
                            data-testid="skill-tentative"
                            title={liveReason ?? 'Tentative — context only, not enforced.'}
                            className="shrink-0 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-ui-2xs font-bold uppercase tracking-widest text-cyan-400">
                            tentative · context only
                        </span>
                    )}
                    {/* WS-5.2's "auto-approved by the supervisor — undo", on the
                        skill itself rather than only in a session log that does
                        not survive a reload. Retiring is the durable undo:
                        setSkillStatus stamps the transition as user-veto. */}
                    {meta?.approvedBy === 'supervisor' && !retired && (
                        <>
                            <span data-testid="skill-auto-approved"
                                title={meta.whyAccepted
                                    ? `The supervisor accepted this: ${meta.whyAccepted}`
                                    : 'Accepted by the LLM supervisor, not by you.'}
                                className="shrink-0 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-ui-2xs font-bold uppercase tracking-widest text-cyan-400">
                                auto-approved
                            </span>
                            <button type="button" data-testid="skill-undo" aria-pressed={undoArmed}
                                onClick={() => { if (undoArmed) { setUndoArmed(false); onToggleRetire(); return; } setUndoArmed(true); }}
                                onBlur={() => setUndoArmed(false)}
                                className="rounded-control border border-rose-500/40 px-2 py-1 text-ui-dense font-semibold text-rose-300 transition-colors hover:bg-rose-500/10">
                                {undoArmed ? 'Confirm undo' : 'Undo approval'}
                            </button>
                        </>
                    )}
                    {onDelete && (
                        <button type="button" data-testid="skill-delete" aria-pressed={armed}
                            onClick={() => { if (armed) { onDelete(); return; } setArmed(true); }}
                            onBlur={() => setArmed(false)}
                            className={`rounded-control border px-2 py-1 text-ui-dense font-semibold transition-colors ${
                                armed
                                    ? 'border-rose-500/50 bg-rose-500/10 text-rose-300'
                                    : 'border-zinc-700 text-zinc-400 hover:border-rose-500/40 hover:text-rose-300'
                            }`}>
                            {armed ? 'Confirm delete' : 'Delete'}
                        </button>
                    )}
                </div>
            </div>

            <div className="grid shrink-0 grid-cols-2 gap-4 rounded-bubble border border-zinc-800 bg-zinc-900 p-4">
                <MetaField label="Status" value={meta?.status ?? 'candidate'} />
                <MetaField label="Kind" value={meta?.kind ?? '—'} />
                <MetaField label="Setup" value={[meta?.coin, meta?.direction].filter(Boolean).join(' ') || '—'} />
                <MetaField label="Evidence" value={`${wins}W / ${losses}L`} />
                {meta?.whyAccepted && (
                    // WS-2.3: the supervisor's reason rides the file, so "why is
                    // this approved?" survives a reload instead of living only in
                    // the session's event stream.
                    <MetaField wide label="Why it was accepted" value={meta.whyAccepted} />
                )}
                <MetaField
                    label="Expectancy"
                    value={expectancy === undefined
                        ? `unmeasured (${meta?.rSampled ?? 0}/${EXPECTANCY_MIN_R_SAMPLE} R)`
                        : `${expectancy > 0 ? '+' : ''}${expectancy}R`}
                />
                {/* A stored predicate that no longer parses is inert, and inert
                    must not look like "checked and clear" — so it says so. */}
                {meta?.predicate && (
                    <MetaField
                        label="Code trigger"
                        value={parsedPredicate
                            ? meta.predicate
                            : `not evaluated — ${parsedError || 'unparsable clause'}`}
                        wide
                    />
                )}
                <MetaField label="Trigger" value={meta?.when || '—'} wide />
            </div>

            {/* Provenance: where this belief came from. */}
            {(meta?.originMessageId || meta?.regime) && (
                <p className="shrink-0 text-ui-dense text-zinc-600">
                    {meta?.originMessageId
                        ? <>Learned from trade <span className="font-mono text-zinc-500">{meta.originMessageId.slice(0, 20)}</span></>
                        : null}
                    {meta?.originMessageId && meta?.regime ? ' · ' : ''}
                    {meta?.regime ? <>scoped to <span className="text-zinc-500">{meta.regime}</span> markets</> : null}
                </p>
            )}

            {refined && meta?.previousVersion && (
                <div className="mt-4 shrink-0 space-y-1 rounded-bubble border border-zinc-800 bg-zinc-900 p-4 font-mono text-ui-dense leading-5">
                    <p className="text-zinc-500">
                        Refined {new Date(meta.refinedAt!).toLocaleString()} after {meta.consecutiveLosses === 0 ? 'consecutive losses' : `${meta.consecutiveLosses} consecutive losses`}
                    </p>
                    {meta.previousVersion.when !== meta.when && (
                        <div>
                            <p className="text-zinc-600 line-through">When {meta.previousVersion.when || '—'}</p>
                            <p className="text-zinc-200">When {meta.when || '—'}</p>
                        </div>
                    )}
                </div>
            )}

            {/* History proof — replays the coin's full tape and reports what
                this skill's matching detector WOULD have done. Pure code, no
                provider cost, safe to run any time. */}
            <div className="mt-4 shrink-0 rounded-bubble border border-zinc-800 bg-zinc-900 p-4">
                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        onClick={() => { void runProof(); }}
                        disabled={proofState === 'running'}
                        data-testid="prove-skill-history"
                        title="Replay the coin's candle history and report this behavior's first-touch win-rate"
                        className="flex items-center gap-1.5 rounded-control border border-white/10 px-2.5 py-1.5 text-ui-sm font-semibold text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        <History className="h-3.5 w-3.5" aria-hidden="true" />
                        {proofState === 'running' ? 'Checking history…' : 'Prove on history'}
                    </button>
                    {proofState === 'done' && proofResult?.status === 'ok' && (
                        <span className={`rounded-control px-2 py-0.5 text-ui-xs font-bold tracking-wide ${
                            proofResult.proof.winRate !== null && proofResult.proof.winRate >= 0.55 ? 'bg-emerald-950/60 text-emerald-400'
                                : proofResult.proof.winRate !== null && proofResult.proof.winRate < 0.45 ? 'bg-rose-950/50 text-rose-400/90'
                                    : 'bg-amber-950/60 text-amber-400'
                        }`} data-testid="skill-proof-verdict">
                            {proofResult.proof.winRate === null ? 'NO OUTCOMES' : `${Math.round(proofResult.proof.winRate * 100)}%`}
                        </span>
                    )}
                    <span className="ml-auto text-ui-xs text-zinc-600">
                        {proofState === 'done' && proofResult?.status === 'ok'
                            ? `${proofResult.proof.title} · ${proofResult.proof.wins}W/${proofResult.proof.losses}L over ${proofResult.proof.hits} hits · ${proofResult.proof.symbol} ${proofResult.proof.timeframe}`
                            : 'Free · replays real candles, no AI call'}
                    </span>
                </div>
                {proofState === 'done' && proofResult && proofResult.status !== 'ok' && (
                    <p className="mt-2 text-ui-dense text-zinc-500">{proofResult.message}</p>
                )}
                {proofState === 'done' && proofResult?.status === 'ok' && (
                    <p className="mt-2 text-ui-dense text-zinc-500">
                        Average move when it worked: +{(proofResult.proof.avgMfe * 100).toFixed(1)}% · against you: {(proofResult.proof.avgMae * 100).toFixed(1)}%. Historical readout — the skill's live W/L ladder still governs promotion.
                    </p>
                )}
            </div>

            {/* Manual A/B eval — with-skill vs without-skill on matched trades.
                Verdict feeds the same promotion/demotion ledger as the
                automated scheduler. Needs a memory model configured. */}
            <div className="mt-4 shrink-0 rounded-bubble border border-zinc-800 bg-zinc-900 p-4">
                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        onClick={() => { void runManualEval(); }}
                        disabled={evalState === 'running' || !memoryConfig}
                        data-testid="run-skill-eval"
                        title={!memoryConfig ? 'Configure a memory model first (Settings → Memory model)' : 'Run a with-skill vs without-skill A/B over matched trades'}
                        className="flex items-center gap-1.5 rounded-control border border-white/10 px-2.5 py-1.5 text-ui-sm font-semibold text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
                        {evalState === 'running' ? 'Evaluating…' : 'Run A/B eval'}
                    </button>
                    {evalState === 'done' && evalResult && (
                        <span className={`rounded-control px-2 py-0.5 text-ui-xs font-bold tracking-wide ${evalBadge(evalResult.verdict)}`} data-testid="skill-eval-verdict">
                            {evalResult.verdict.toUpperCase()}
                        </span>
                    )}
                    <span className="ml-auto text-ui-xs text-zinc-600">
                        {evalState === 'done' && evalResult
                            ? `${evalResult.alignedFlips}/${evalResult.flips} aligned flips · ${evalResult.cases.length} trades`
                            : !memoryConfig ? 'Needs a memory model' : 'Costs up to 12 provider calls'}
                    </span>
                </div>
                {evalState === 'done' && evalResult?.error && (
                    <p className="mt-2 text-ui-dense text-rose-400/80">{evalResult.error}</p>
                )}
            </div>

            <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-bubble border border-zinc-800 bg-zinc-900">
                <div className="shrink-0 border-b border-zinc-800 px-4 py-3 text-ui-sm font-bold text-zinc-300">
                    Instructions
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-5">
                    <MarkdownContent content={skill.body || '(empty skill)'} className="text-ui-caption leading-6" />
                </div>
            </div>
        </div>
    );
};

export default SkillDetail;
