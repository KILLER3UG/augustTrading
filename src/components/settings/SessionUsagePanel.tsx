import React, { useEffect, useMemo, useState } from 'react';
import { clearSessionUsage, loadSessionUsage, SessionUsageEntry, summarizeModelUsage, summarizeUsagePeriod } from '../../utils/sessionUsage';
import { getHarnessSettings, saveHarnessSettings } from '../../utils/harnessSettings';
import type { SelfModMode } from '../../schemas/selfChange';
import { loadChecklistConfig, saveChecklistConfig } from '../../utils/checklist';
import { formatChars } from '../../utils/runUsage';
import { formatModelDisplayName } from '../../utils/providerUtils';
import { SelectMenu } from '../shared/SelectMenu';

const SLICE_COLORS = ['#42a1ff', '#c9c9c9', '#4d9fff', '#858585', '#e6e6e6', '#2069c0', '#9a9a9a'];

const startOfToday = (): number => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
};

const polar = (cx: number, cy: number, r: number, angle: number): { x: number; y: number } => {
    const rad = (angle - 90) * (Math.PI / 180);
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
};

const arcPath = (start: number, sweep: number): string => {
    const s = polar(40, 40, 28, start);
    const e = polar(40, 40, 28, start + sweep);
    return `M ${s.x} ${s.y} A 28 28 0 ${sweep > 180 ? 1 : 0} 1 ${e.x} ${e.y}`;
};

const SessionUsagePanel: React.FC = () => {
    const [entries, setEntries] = useState<SessionUsageEntry[]>([]);

    useEffect(() => {
        void loadSessionUsage().then(setEntries);
    }, []);

    const today = useMemo(() => summarizeUsagePeriod(entries, startOfToday()), [entries]);
    const week = useMemo(() => summarizeUsagePeriod(entries, Date.now() - 7 * 24 * 60 * 60 * 1000), [entries]);
    const models = useMemo(() => summarizeModelUsage(entries, startOfToday()), [entries]);
    const topModel = models[0];
    const todayTokens = today.promptTokens + today.completionTokens || today.tokensEst;

    const renderSummary = (label: string, s: ReturnType<typeof summarizeUsagePeriod>): React.ReactNode => {
        const tokens = s.promptTokens + s.completionTokens || s.tokensEst;
        return (
            <div className="rounded-bubble border border-zinc-800 bg-zinc-900 p-4">
                <p className="text-ui-dense text-zinc-500">{label}</p>
                <p className="mt-1 text-ui-base text-zinc-100">{s.runs} runs · {Math.round(s.durationMs / 1000)}s</p>
                <p className="mt-1 text-ui-dense text-zinc-500">
                    {s.tokensExact ? '' : '~'}{formatChars(tokens)} tok
                    {s.costUsd > 0 ? ` · $${s.costUsd.toFixed(3)}` : ''}
                </p>
                {s.cachedPromptTokens > 0 && (
                    <p className="mt-1 text-ui-dense text-zinc-500">
                        {formatChars(s.cachedPromptTokens)} cached input · billed below fresh input
                    </p>
                )}
            </div>
        );
    };

    return (
        <div className="space-y-3">
            <div>
                <h4 className="text-ui-base font-bold text-white">Usage</h4>
                <p className="text-ui-sm text-zinc-500 mt-0.5">Tokens from provider responses when available; otherwise estimated from output size. Cached input is the provider-reported subset served from its prompt cache.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
                {renderSummary('Today', today)}
                {renderSummary('Last 7 days', week)}
            </div>
            {models.length > 0 && (
                <div className="rounded-bubble border border-zinc-800 bg-zinc-900 p-4">
                    <p className="text-ui-dense font-semibold uppercase tracking-widest text-zinc-500">Today by model</p>
                    <div className="mt-3 flex items-center gap-4">
                        <svg viewBox="0 0 80 80" className="h-20 w-20 shrink-0" aria-hidden="true">
                            {models.reduce<{ offset: number; nodes: React.ReactNode[] }>((acc, slice, index) => {
                                const sweep = Math.max(2, slice.share * 360);
                                acc.nodes.push(
                                    <path
                                        key={slice.modelId}
                                        d={arcPath(acc.offset, Math.min(359.9, sweep))}
                                        fill="none"
                                        stroke={SLICE_COLORS[index % SLICE_COLORS.length]}
                                        strokeWidth="10"
                                    />,
                                );
                                acc.offset += sweep;
                                return acc;
                            }, { offset: 0, nodes: [] }).nodes}
                            <circle cx="40" cy="40" r="18" fill="#141414" />
                        </svg>
                        <div className="min-w-0 flex-1">
                            <p className="text-ui-base text-zinc-100">{today.tokensExact ? '' : '~'}{formatChars(todayTokens)} tok today</p>
                            {topModel && (
                                <p className="mt-1 text-ui-dense text-zinc-400">
                                    Top model · {formatModelDisplayName(topModel.modelId)} · {Math.round(topModel.share * 100)}%
                                </p>
                            )}
                            <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-zinc-800" role="img" aria-label="Token share by model">
                                {models.map((slice, index) => (
                                    <div
                                        key={slice.modelId}
                                        className="h-full"
                                        style={{ width: `${Math.max(2, slice.share * 100)}%`, background: SLICE_COLORS[index % SLICE_COLORS.length] }}
                                    />
                                ))}
                            </div>
                        </div>
                    </div>
                    <ul className="mt-3 space-y-1">
                        {models.map((slice, index) => (
                            <li key={slice.modelId} className="flex items-center justify-between gap-2 text-ui-dense text-zinc-400">
                                <span className="flex min-w-0 items-center gap-2">
                                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SLICE_COLORS[index % SLICE_COLORS.length] }} />
                                    <span className="truncate" title={slice.modelId}>{formatModelDisplayName(slice.modelId)}</span>
                                </span>
                                <span className="shrink-0 tabular-nums">{formatChars(slice.tokens)}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {entries.length > 0 && (
                <button
                    type="button"
                    className="text-ui-dense text-zinc-500 hover:text-zinc-300"
                    onClick={() => { void clearSessionUsage().then(() => setEntries([])); }}
                >
                    Clear usage history
                </button>
            )}
        </div>
    );
};

/**
 * The harness's model-behavior dials (effort, the session guard, the edge
 * floor, the default leverage, settlement, checklist). "Cost caps" named a
 * dial that was deleted with the debate engine — a comment listing a control
 * that is not on the panel is how the next reader re-adds one.
 * Stage 3 moved them out of the Data tab — they are analysis behavior, not
 * storage — and they now render in Settings → Analysis.
 */
export const HarnessControls: React.FC = () => {
    const [settings, setSettings] = useState(getHarnessSettings);
    const [checklist, setChecklist] = useState(loadChecklistConfig);
    const persist = (next: Partial<ReturnType<typeof getHarnessSettings>>): void => {
        setSettings(saveHarnessSettings(next));
    };
    // The one writer of this switch goes through the service, because turning
    // self-modification OFF also undoes what the agent did with it — a value
    // written straight to storage would leave those changes riding every run.
    const persistSelfMod = (mode: SelfModMode): void => {
        void import('../../services/selfMod/SelfModificationService')
            .then(m => m.setSelfModMode(mode))
            .then(() => setSettings(getHarnessSettings()))
            .catch(err => console.warn('[SelfMod] the switch did not take effect:', err));
    };
    return (
        <div className="space-y-3 rounded-bubble border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-ui-dense font-semibold uppercase tracking-widest text-zinc-500">Harness</p>
            <label className="block text-ui-dense text-zinc-400">
                Account equity (USD)
                <input
                    type="number"
                    min={100}
                    value={settings.equityUsd || ''}
                    placeholder="Not set"
                    onChange={e => persist({ equityUsd: Math.max(0, Number(e.target.value) || 0) })}
                    className="mt-1 w-full rounded-control border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100"
                />
            </label>
            <label className="block text-ui-dense text-zinc-400">
                Risk per ticket (%)
                <input
                    type="number"
                    min={0.1}
                    max={10}
                    step={0.1}
                    value={settings.riskPercent}
                    onChange={e => persist({ riskPercent: Math.min(10, Math.max(0.1, Number(e.target.value) || 1)) })}
                    className="mt-1 w-full rounded-control border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100"
                />
            </label>
            <label className="block text-ui-dense text-zinc-400">
                Minimum net edge (R)
                <span className="mt-0.5 block text-ui-2xs leading-4 text-zinc-500">
                    Refuse a plan whose net expectancy at its own probability is at or
                    below this, after the round-trip fee. 0 refuses only negative edge;
                    the card quotes the number it refused on. Slippage is not modelled.
                </span>
                <input
                    type="number"
                    min={-5}
                    max={5}
                    step={0.05}
                    value={settings.minEdgeR}
                    onChange={e => persist({ minEdgeR: Math.min(5, Math.max(-5, Number(e.target.value) || 0)) })}
                    data-testid="harness-min-edge"
                    className="mt-1 w-full rounded-control border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100"
                />
            </label>
            <label className="block text-ui-dense text-zinc-400">
                Default leverage (×)
                <span className="mt-0.5 block text-ui-2xs leading-4 text-zinc-500">
                    New sessions and tickets start here. Historical rows keep the
                    leverage they were logged with. The proposal card always shows the
                    isolated-liquidation buffer beside the stop.
                </span>
                <input
                    type="number"
                    min={1}
                    max={125}
                    step={1}
                    value={settings.defaultLeverage}
                    onChange={e => {
                        const n = Number(e.target.value);
                        persist({ defaultLeverage: Math.min(125, Math.max(1, Math.round(Number.isFinite(n) ? n : 10))) });
                    }}
                    data-testid="harness-default-leverage"
                    className="mt-1 w-full rounded-control border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100"
                />
            </label>
            <label className="block text-ui-dense text-zinc-400">
                Starter playbook library
                <span className="mt-0.5 block text-ui-2xs leading-4 text-zinc-500">
                    The curated vetted-literature shelf. Turning this off withdraws
                    approval from every starter skill at once, so none is injected.
                </span>
                <span className="mt-1 flex items-center gap-2">
                    <input
                        type="checkbox"
                        checked={settings.starterLibraryEnabled !== false}
                        onChange={e => persist({ starterLibraryEnabled: e.target.checked })}
                        data-testid="harness-starter-library"
                        className="h-3.5 w-3.5 accent-cyan-400"
                    />
                    <span className="text-ui-dense text-zinc-300">
                        {settings.starterLibraryEnabled !== false ? 'Approved — injected' : 'Withdrawn'}
                    </span>
                </span>
            </label>
            <label className="block text-ui-dense text-zinc-400">
                Tentative skills
                <span className="mt-0.5 block text-ui-2xs leading-4 text-zinc-500">
                    Skills the post-mortem loop earned from independent outcomes but
                    nothing has confirmed yet. On: injected as labelled context only —
                    they never veto or cap confidence. Off: hidden from prompts and the
                    skills index. Any one can still be edited or retired in Learning.
                </span>
                <span className="mt-1 flex items-center gap-2">
                    <input
                        type="checkbox"
                        checked={settings.tentativeSkillInjectionEnabled !== false}
                        onChange={e => persist({ tentativeSkillInjectionEnabled: e.target.checked })}
                        data-testid="harness-tentative-skills"
                        className="h-3.5 w-3.5 accent-cyan-400"
                    />
                    <span className="text-ui-dense text-zinc-300">
                        {settings.tentativeSkillInjectionEnabled !== false ? 'Injected as context' : 'Withdrawn'}
                    </span>
                </span>
            </label>
            <label className="block text-ui-dense text-zinc-400">
                Sensitive memories
                <span className="mt-0.5 block text-ui-2xs leading-4 text-zinc-500">
                    Whether facts about health, finances or identity may be stored at all.
                    Off (the default) means the write is refused with the reason; on, the fact is
                    stored flagged and never surfaces in pre-reads or unattended runs.
                </span>
                <span className="mt-1 flex items-center gap-2">
                    <input
                        type="checkbox"
                        checked={settings.sensitiveMemoryEnabled === true}
                        onChange={e => persist({ sensitiveMemoryEnabled: e.target.checked })}
                        data-testid="harness-sensitive-memory"
                        className="h-3.5 w-3.5 accent-cyan-400"
                    />
                    <span className="text-ui-dense text-zinc-300">
                        {settings.sensitiveMemoryEnabled === true ? 'Allowed — stored flagged' : 'Refused'}
                    </span>
                </span>
            </label>
            <label className="block text-ui-dense text-zinc-400">
                Draft playbooks on its own
                <span className="mt-0.5 block text-ui-2xs leading-4 text-zinc-500">
                    Studies finished conversations, bot closed trades, and the whole
                    chart, then writes drafts into the Approvals inbox. These paths can
                    cost provider calls, so they are off until you turn them on. Skills
                    you save yourself, drafts you request by hand, and imports are
                    unaffected — this switch only stops drafts the app was not asked for.
                </span>
                <span className="mt-1 flex items-center gap-2">
                    <input
                        type="checkbox"
                        checked={settings.autoDraftingEnabled === true}
                        onChange={e => persist({ autoDraftingEnabled: e.target.checked })}
                        data-testid="harness-auto-drafting"
                        className="h-3.5 w-3.5 accent-cyan-400"
                    />
                    <span className="text-ui-dense text-zinc-300">
                        {settings.autoDraftingEnabled === true ? 'On — the loop drafts unasked' : 'Off — only what you ask for'}
                    </span>
                </span>
            </label>
            <label className="block text-ui-dense text-zinc-400">
                Self-modification
                <span className="mt-0.5 block text-ui-2xs leading-4 text-zinc-500">
                    How far the agent may change the harness it is running in. Off (the
                    default) refuses every self-change. Config lets it move a behavior
                    knob you can see below — thinking effort, the skill library cap — and
                    each change reverts itself within 24 hours. Shadow additionally lets it
                    rewrite one prompt, which then has to win on the trades that ran under
                    it; that needs the Prompt A/B rate above 0% with no lane pin, or the
                    edit cannot be judged. Risk limits, privacy, memory and this switch
                    itself are blocked. Every change is written to the notebook
                    self-changes folder, with the value it replaced.
                </span>
                <span className="mt-1 block">
                    <SelectMenu
                        value={settings.selfModificationMode}
                        onChange={v => persistSelfMod(v as SelfModMode)}
                        options={[
                            { value: 'off', label: 'Off — it changes nothing about itself' },
                            { value: 'config', label: 'Config — reversible behavior knobs, 24h window' },
                            { value: 'shadow', label: 'Shadow — plus prompt text, judged by outcomes' },
                        ]}
                        aria-label="Self-modification"
                        className="w-full"
                        triggerClassName="w-full rounded-control border border-zinc-700 bg-zinc-950 px-2 py-1 text-ui-sm hover:bg-zinc-800"
                    />
                </span>
            </label>
            <label className="block text-ui-dense text-zinc-400">
                Skill enforcement
                <span className="mt-0.5 block text-ui-2xs leading-4 text-zinc-500">
                    The off-switch over code-side enforcement: the confidence caps and
                    the confirmed-avoid veto that can halt a verdict. Injection itself is
                    governed by the approval gate, not by this.
                </span>
                <span className="mt-1 flex items-center gap-2">
                    <input
                        type="checkbox"
                        checked={settings.skillEnforcementEnabled !== false}
                        onChange={e => persist({ skillEnforcementEnabled: e.target.checked })}
                        data-testid="harness-skill-enforcement"
                        className="h-3.5 w-3.5 accent-cyan-400"
                    />
                    <span className="text-ui-dense text-zinc-300">
                        {settings.skillEnforcementEnabled !== false ? 'Enforced' : 'Not enforced'}
                    </span>
                </span>
            </label>
            <label className="block text-ui-dense text-zinc-400">
                Outcome settlement
                <span className="mt-0.5 block text-ui-2xs leading-4 text-zinc-500">
                    What the autopilot does when it detects a win, loss or missed entry.
                    Shadow (the default) shows the result and records nothing — run it
                    for a month and compare with your own calls. Automatic records
                    after a 15-second Undo window; confirm waits for your click. A
                    per-coin approval rule always wins over this.
                </span>
                <span className="mt-1 block">
                    <SelectMenu
                        value={settings.outcomeSettlement}
                        onChange={v => persist({ outcomeSettlement: v as 'automatic' | 'confirm' | 'shadow' })}
                        options={[
                            { value: 'automatic', label: 'Automatic — record after 15s, Undo' },
                            { value: 'shadow', label: 'Shadow — show, never record' },
                            { value: 'confirm', label: 'Confirm — wait for my click' },
                        ]}
                    />
                </span>
            </label>
            <label className="block text-ui-dense text-zinc-400">
                Prompt A/B (control lane)
                <SelectMenu
                    value={String(settings.promptAbRate)}
                    onChange={v => persist({ promptAbRate: Number(v) as 0 | 0.1 | 0.5 })}
                    options={[
                        { value: '0', label: 'Off' },
                        { value: '0.1', label: '10%' },
                        { value: '0.5', label: '50%' },
                    ]}
                    aria-label="Prompt A/B (control lane)"
                    className="mt-1 w-full"
                    triggerClassName="w-full rounded-control border border-zinc-700 bg-zinc-950 px-2 py-1 text-ui-sm hover:bg-zinc-800"
                />
            </label>
            <label className="block text-ui-dense text-zinc-400">
                Default thinking effort
                <SelectMenu
                    value={settings.responseEffort}
                    onChange={v => persist({ responseEffort: v === 'fast' ? 'fast' : 'quality' })}
                    options={[
                        { value: 'quality', label: 'Quality — built-in reasoning budget' },
                        { value: 'fast', label: 'Fast — one step lighter on every call' },
                    ]}
                    aria-label="Default thinking effort"
                    className="mt-1 w-full"
                    triggerClassName="w-full rounded-control border border-zinc-700 bg-zinc-950 px-2 py-1 text-ui-sm hover:bg-zinc-800"
                />
            </label>
            <label className="block text-ui-dense text-zinc-400">
                Skill library cap
                <input
                    type="number"
                    min={5}
                    max={200}
                    step={1}
                    value={settings.skillLibraryCap ?? 40}
                    onChange={e => persist({ skillLibraryCap: Math.min(200, Math.max(5, Math.round(Number(e.target.value) || 40))) })}
                    className="mt-1 w-full rounded-control border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100"
                />
                <span className="mt-1 block text-ui-xs text-zinc-600">How many confirmed skills the worth gate holds before it turns comparative (displacement/revival). Default 40.</span>
            </label>
            {/* Session-guard limits: preset + overrides.
                Takes effect immediately here; the in-the-moment cap change
                rule (typed confirm) applies to the banner, not this panel. */}
            <label className="block text-ui-dense text-zinc-400">
                Session guard preset
                <SelectMenu
                    value={settings.guardPreset ?? 'default'}
                    onChange={v => persist({ guardPreset: v as 'default' | 'ftmo' })}
                    options={[
                        { value: 'default', label: 'Tight — 2% day / 2 trades / 4h cooldown' },
                        { value: 'ftmo', label: 'FTMO — 3% day / 3 trades / 4h cooldown' },
                    ]}
                    aria-label="Session guard preset"
                    className="mt-1 w-full"
                    triggerClassName="w-full rounded-control border border-zinc-700 bg-zinc-950 px-2 py-1 text-ui-sm hover:bg-zinc-800"
                />
            </label>
            <div className="grid grid-cols-2 gap-2">
                <label className="block text-ui-dense text-zinc-400">
                    Daily loss limit (%)
                    <input
                        type="number"
                        min={0.5}
                        max={25}
                        step={0.5}
                        placeholder="preset"
                        value={settings.guardDailyLossPct ?? ''}
                        onChange={e => persist({ guardDailyLossPct: e.target.value === '' ? undefined : Math.min(25, Math.max(0.5, Number(e.target.value))) })}
                        className="mt-1 w-full rounded-control border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100"
                    />
                </label>
                <label className="block text-ui-dense text-zinc-400">
                    Max trades / day
                    <input
                        type="number"
                        min={1}
                        max={20}
                        placeholder="preset"
                        value={settings.guardMaxTradesPerDay ?? ''}
                        onChange={e => persist({ guardMaxTradesPerDay: e.target.value === '' ? undefined : Math.min(20, Math.max(1, Math.floor(Number(e.target.value)))) })}
                        className="mt-1 w-full rounded-control border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100"
                    />
                </label>
            </div>
            {/* Pre-trade checklist: OFF by default; when on, the
                capture modal shows the items and completion rides onto the
                trade (checklistCompleted) feeding adherence stats. */}
            <label className="flex items-center gap-2 text-ui-dense text-zinc-400 cursor-pointer select-none">
                <input
                    type="checkbox"
                    checked={checklist.enabled}
                    onChange={e => setChecklist(saveChecklistConfig({ ...checklist, enabled: e.target.checked }))}
                    className="rounded-control border-zinc-700 bg-zinc-950"
                />
                Pre-trade checklist at capture (off by default)
            </label>
        </div>
    );
};

export default React.memo(SessionUsagePanel);
