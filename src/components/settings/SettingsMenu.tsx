import React, { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { useConfirmDialog } from '../shared/ConfirmDialog';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { APP_NAME, APP_VERSION } from '../../constants/version';
import { AIProvider, LoggedTrade } from '../../types';
import { CustomInstructionsMap } from '../../types/user';
import { ProviderConfig, ApiFormat } from '../../types/provider';
import type { JournalUIState } from '../../hooks/useJournalUI';
import { EmptyState } from '../ui/EmptyState';
import {AISettingsIcon, HistoryIcon, SettingsIcon, CodeIcon, SearchIcon, CloseIcon, User, FileText, Brain, BookOpen, Database, Search, ChevronRight} from '../shared/Icons';
import { getIdleMotionEnabled, subscribeIdleMotion } from '../../services/desk/idleMotion';
import { loadForgedTools } from '../../services/tools/toolForge';
import { getHarnessSettings } from '../../utils/harnessSettings';
import { isProviderReady } from '../../utils/providerUtils';
import type { LearnTab } from '../learn/LearnView';
import type { InstructionTab } from './CustomInstructionsEditor';


// The tab bodies are code-split. Each used to be an inline IIFE in this file
// (with ~70 props threaded through the one component); they now live under
// ./tabs as lazily-loaded components receiving a single `tab` props object —
// the same lazy-section pattern LearnView uses. Tabs render exclusively, so
// lazy sections are free.
const JournalTab = lazy(() => import('./tabs/JournalTab'));
const ModelsTab = lazy(() => import('./tabs/ModelsTab'));
const ProfileTab = lazy(() => import('./tabs/ProfileTab'));
const GeneralTab = lazy(() => import('./tabs/GeneralTab'));
const PromptsTab = lazy(() => import('./tabs/PromptsTab'));
const MemoryTab = lazy(() => import('./tabs/MemoryTab'));
const StrategiesTab = lazy(() => import('./tabs/StrategiesTab'));
const ActionsTab = lazy(() => import('./tabs/ActionsTab'));

/** Chunk-load placeholder for a tab body — mirrors LearnView's Fallback. */
const TabFallback: React.FC = () => (
    <div className="p-6 text-ui-dense text-zinc-600">Loading…</div>
);

export type SettingsTab = 'profile' | 'general' | 'models' | 'journal' | 'instructions' | 'memory' | 'actions' | 'prompts' | 'strategies';

/** Tabs whose embedded manager owns the whole scroll container (their own
 *  padding, their own sticky headers) — the workspace adds none. */
const FULL_BLEED_TABS: SettingsTab[] = ['prompts', 'instructions', 'strategies'];

interface SettingsMenuProps {
    isVisible: boolean;
    onClose: () => void;
    // Hybrid & Capturing
    isHybridIntelligenceEnabled: boolean;
    onToggleHybridIntelligence?: () => void;
    setIsHybridIntelligenceEnabled?: (enabled: boolean) => void;
    isAutoCapturing?: boolean;
    onToggleAutoCapturing?: () => void;
    isEntryNotHitCapturing?: boolean;
    onToggleEntryNotHitCapturing?: () => void;
    // Memory
    // Uploaded strategy books (Settings → Strategies)
    isStrategiesEnabled?: boolean;
    setIsStrategiesEnabled?: (enabled: boolean) => void;
    memoryConfig?: ProviderConfig | null;
    onMemoryConfigChange?: (config: ProviderConfig | null) => void;
    // Pure AI options
    // Instructions
    customInstructions: CustomInstructionsMap;
    setCustomInstructions: (instructions: CustomInstructionsMap) => void;
    // Modals & Navigation triggers from main view
    /** Opens the Learning surface — the one home for the queues, the notebook and
     *  memory health. Settings keeps the provider/model switches and links here.
     *  Pass a tab to land somewhere specific. */
    onOpenLearn?: (tab?: LearnTab) => void;
    onSwitchUser?: () => void;
    onExportData?: () => Promise<void> | void;
    /** Active profile — enables the backup management section. */
    username?: string;
    /** Called after a backup restore replaces the profile (App reloads it). */
    onProfileRestored?: (username: string) => void;
    /** Routes to the JOURNAL SURFACE (stage 3) — Settings holds no journal of
     *  its own; these were the launcher cards' only path to it. */
    onOpenJournal?: (tab?: JournalUIState['tab']) => void;
    summaryCharLimit?: number;
    onUpdateSummaryCharLimit?: (limit: number) => void;
    useAlgorithmicSummary?: boolean;
    onToggleAlgorithmicSummary?: (enabled: boolean) => void;
    useAlgorithmicInsights?: boolean;
    onToggleAlgorithmicInsights?: (enabled: boolean) => void;
    /** Trade count for the "Journal" nav badge. The journal
     *  itself is the SHARED overlay (single instance, always in sync with
     *  the sidebar one — the old embedded duplicate drifted). */
    loggedTrades?: LoggedTrade[];
    // Models
    selectedOcrModel?: string;
    onSetOcrModel?: (modelId: string) => void;
    /** Global vision model (Settings → AI setup → Vision Model): one model
     *  for EVERY vision feature (chart OCR, post-trade uploads, PDF OCR). */
    visionModel?: string;
    onSetVisionModel?: (modelId: string) => void;
    /** Resolved vision ProviderConfig (global → conversation → first ready). */
    visionConfig?: ProviderConfig | null;
    // Dynamic Providers
    providerConfigs?: ProviderConfig[];
    /** False while provider configs are still loading — avoids the
     *  "No providers configured" empty-state flash. */
    providerConfigsLoaded?: boolean;
    onUpdateProvider?: (id: string, updates: Partial<Omit<ProviderConfig, 'id' | 'isBuiltIn'>>) => Promise<void>;
    onAddCustomProvider?: (provider: { name: string; baseUrl: string; apiKey: string; apiFormat: ApiFormat; models?: string[]; selectedModel?: string }) => Promise<void>;
    onRemoveProvider?: (id: string) => Promise<void>;
    onToggleProviderConfig?: (id: string) => Promise<void>;
    onAddModel?: (providerId: string, modelId: string) => Promise<void>;
    onRemoveModel?: (providerId: string, modelId: string) => Promise<void>;
    // A 16-prop "Journal embedded props" block used to sit here, left behind
    // when the Journal stopped being an overlay inside Settings and became a
    // surface: every prop declared, none read, all still computed and passed by
    // App. It was removed by the 2026-09-22 audit together with its last three
    // stragglers (familyWinRates, enabledProviders, selectedModels), which went
    // with the tab split. The block's own names are deliberately not listed —
    // tests/deadControlsGuard.test.ts forbids them in this file, comment
    // included.
    onUpdateModel?: (providerId: string, oldModelId: string, newModelId: string) => Promise<void>;
}

// ─── Shared UI Helpers ────────────────────────────────────────────────────────
// The reference settings layout is: grouped sidebar → page header → cards of
// hairline rows, each row an icon tile, a title + description, and the control
// pushed to the right edge. The row/page-card helpers live in ./tabs/shared.tsx
// (only the lazily-loaded tab bodies compose them); the nav composes
// NavTabButton here.

const NavTabButton: React.FC<{
    active: boolean;
    onClick: () => void;
    icon: React.ReactNode;
    label: string;
    badge?: string;
}> = ({ active, onClick, icon, label, badge }) => (
    <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        className={`flex w-full items-center justify-between gap-2 rounded-control px-2.5 py-2 text-left text-ui-sm font-medium transition-colors ${
            active
                ? 'bg-zinc-800 text-zinc-100 shadow-sm ring-1 ring-white/[0.09]'
                : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-100'
        }`}
    >
        <span className="flex min-w-0 items-center gap-2.5">
            <span className={`shrink-0 ${active ? 'text-zinc-100' : 'text-zinc-500'}`}>{icon}</span>
            <span className="truncate" title={label}>{label}</span>
        </span>
        {badge && (
            <span className="shrink-0 rounded-full bg-zinc-700 px-1.5 py-0.5 font-mono text-ui-2xs font-bold leading-none text-zinc-200">
                {badge}
            </span>
        )}
    </button>
);

const NAV_ICON = 'h-4 w-4 shrink-0';

interface NavEntry {
    id: SettingsTab;
    label: string;
    icon: React.ReactNode;
    /** Content words the search box matches beyond the label itself — the
     *  sidebar says "Playbooks" but a user types "strategy", and both must
     *  find it. */
    keywords: string;
}

interface NavGroup { title: string; entries: NavEntry[] }

/** The sidebar is this list, filtered — not a hand-written button per tab.
 *  Adding a tab used to mean remembering to also add its group header and its
 *  own navMatch() clause, which is how 'profile' ended up reachable from the
 *  account menu but absent from the nav (and never rendered). */
const NAV_GROUPS: NavGroup[] = [
    {
        title: 'Setup',
        entries: [
            // `moderator` went with the debate engine; leaving it in the keyword
            // list made the search box surface AI setup for a word that names no
            // control in it.
            { id: 'models', label: 'AI setup', icon: <AISettingsIcon className={NAV_ICON} />, keywords: 'provider api key model vision memory ocr connect' },
        ],
    },
    {
        title: 'Analysis',
        entries: [
            { id: 'general', label: 'Analysis', icon: <SettingsIcon className={NAV_ICON} />, keywords: 'hybrid desk tools reduce motion idle motion capture advanced' },
            { id: 'prompts', label: 'Prompts', icon: <CodeIcon className={NAV_ICON} />, keywords: 'template library editing' },
            { id: 'instructions', label: 'Instructions', icon: <FileText className={NAV_ICON} />, keywords: 'custom system instruction rules' },
        ],
    },
    {
        title: 'Learning',
        entries: [
            // Skills left this dialog for the Learning surface's own tab, so the
            // library and the notebook sit together instead of one being a
            // settings pane. The rail's Skills row and Alt+3 land there.
            { id: 'memory', label: 'Memory', icon: <Brain className={NAV_ICON} />, keywords: 'notebook amendment profile memory files global' },
            { id: 'strategies', label: 'Playbooks', icon: <BookOpen className={NAV_ICON} />, keywords: 'strategy book pdf upload studio families import' },
        ],
    },
    {
        title: 'Account',
        entries: [
            { id: 'profile', label: 'Profile', icon: <User className={NAV_ICON} />, keywords: 'account trader switch export data version about' },
            { id: 'journal', label: 'Journal', icon: <HistoryIcon className={NAV_ICON} />, keywords: 'trades log summary insights statistics win rate' },
            { id: 'actions', label: 'Data', icon: <Database className={NAV_ICON} />, keywords: 'usage backup restore session tokens' },
        ],
    },
];

const SettingsMenu: React.FC<SettingsMenuProps> = (props) => {
    const { confirm, ConfirmDialogComponent } = useConfirmDialog();
    const {
        isVisible,
        onClose,
        onOpenLearn,
        providerConfigs,
        providerConfigsLoaded,
    } = props;

    // Land on the friendliest tab: General when a provider is already
    // configured, otherwise the Get Started provider setup (the onboarding
    // card points beginners there anyway). The old default was the most
    // technical tab (provider CRUD).
    const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
        const hasReadyProvider = (providerConfigs ?? []).some(isProviderReady);
        return hasReadyProvider ? 'general' : 'models';
    });
    const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
    const [deskToolsEnabled, setDeskToolsEnabled] = useState(() => getHarnessSettings().deskToolsEnabled);
    // Whether the infinite indicators stay still. Default is motion ON.
    // The toggle is per-user, persisted via services/desk/idleMotion.
    const [idleMotionEnabled, setIdleMotionState] = useState(() => getIdleMotionEnabled());
    useEffect(() => subscribeIdleMotion(setIdleMotionState), []);
    const [activeInstructionTab, setActiveInstructionTab] = useState<InstructionTab>('general');
    const [isDirty, setIsDirty] = useState(false);
    const [navQuery, setNavQuery] = useState('');
    // No pending-amendment count: `amend_memory` applies directly (owner
    // ruling 2026-11-03), so a number here would have nothing to open — the
    // exact "count chasing nothing" this menu deleted once already.
    const navQ = navQuery.trim().toLowerCase();
    const navMatches = (entry: NavEntry): boolean =>
        !navQ
        || entry.label.toLowerCase().includes(navQ)
        || entry.keywords.includes(navQ);
    const navBadge = (id: SettingsTab): string | undefined => {
        if (id === 'journal') return props.loggedTrades && props.loggedTrades.length > 0 ? String(props.loggedTrades.length) : undefined;
        return undefined;
    };
    const initialTabResolvedRef = useRef(false);
    /** A tab the parent explicitly ASKED FOR outranks the heuristic landing.
     *  Recorded here because the requested prop is consumed immediately, so by
     *  the time the landing effect runs — declared later, same commit — there
     *  is nothing left for it to see, and it used to overwrite the choice. */
    const explicitTabChosenRef = useRef(false);

    const navClick = useCallback((id: SettingsTab): void => {
        // A click IS the explicit choice: without this the landing effect
        // below can still overwrite it when providerConfigsLoaded arrives late.
        explicitTabChosenRef.current = true;
        setActiveTab(id);
    }, []);

    // Closing with a staged (unsaved) provider draft would silently discard
    // the user's edits — confirm first (Escape, backdrop, and the X all route
    // through here).
    const requestClose = useCallback(() => {
        if (!isDirty) {
            onClose();
            return;
        }
        void confirm({
            title: 'Discard unsaved changes?',
            message: 'You have unsaved provider edits. Closing Settings will discard them.',
            confirmLabel: 'Discard',
            destructive: true,
        }).then(ok => { if (ok) onClose(); });
    }, [isDirty, onClose, confirm]);

    // The open-effect below must re-run ONLY when the dialog opens/closes.
    // Depending on `requestClose` directly (inline-identity `onClose` from the
    // parent) re-added the keydown listener and re-queued the autofocus on
    // every parent render — stealing focus mid-typing in provider forms.
    // Route the latest callback through a ref and focus once per open.
    const requestCloseRef = useRef(requestClose);
    useEffect(() => {
        requestCloseRef.current = requestClose;
    }, [requestClose]);

    // Shared trap + Esc: cycles focus, focuses the first control, and returns
    // focus to the rail/header control that opened Settings.
    const dialogRef = useFocusTrap<HTMLDivElement>(isVisible);
    useEscapeClose(isVisible, () => requestCloseRef.current());

    // Enabled providers list for lens settings —
    // derived from dynamic provider configs (ready = enabled + API key).
    const readyConfigProviders = useMemo(
        () => (providerConfigs ?? []).filter(isProviderReady),
        [providerConfigs],
    );

    // Provider configs load asynchronously. Resolve the landing tab once after
    // that load so existing users do not get stranded on provider CRUD while
    // preserving deliberate tab choices after the first render.
    useEffect(() => {
        if (!isVisible || !providerConfigsLoaded || initialTabResolvedRef.current) return;
        initialTabResolvedRef.current = true;
        // Do not step on a deliberate first landing: the very first Profile
        // click opened Analysis, because this effect ran after it.
        if (explicitTabChosenRef.current) return;
        setActiveTab(readyConfigProviders.length > 0 ? 'general' : 'models');
    }, [isVisible, providerConfigsLoaded, readyConfigProviders.length]);

    if (!isVisible) return null;

    return (
        <>
            {/* z-modal, not a literal: the expanded nav rail rides z-drawer
                (50), and at the same rung DOM order let the rail paint OVER
                this modal — its panel covered the settings nav entirely. */}
            <div className="fixed inset-0 z-modal flex items-center justify-center p-3 sm:p-6">
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={requestClose} aria-hidden="true" />
                <div
                    ref={dialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="settings-title"
                    className="relative flex h-[min(860px,94vh)] w-[min(1180px,97vw)] overflow-hidden rounded-bubble border border-white/10 bg-zinc-900 shadow-2xl ring-1 ring-white/[0.04] animate-fade-in"
                >
                    <button
                        type="button"
                        onClick={requestClose}
                        aria-label="Close settings"
                        className="absolute right-4 top-4 z-10 rounded-control p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                    >
                        <CloseIcon className="h-5 w-5" aria-hidden="true" />
                    </button>
                    <div className="flex-1 flex min-h-0 flex-col md:flex-row">

                        <div className="w-full md:w-64 max-h-[32vh] overflow-y-auto md:max-h-none md:overflow-y-auto border-b md:border-b-0 md:border-r border-white/[0.06] bg-zinc-950/45 px-3 py-4 space-y-1 shrink-0 flex flex-col justify-between custom-scrollbar">
                            <div className="space-y-1">
                                <div className="px-1 pb-4">
                                    <div className="mb-4 px-1.5">
                                        <h2 id="settings-title" className="august-wordmark text-ui-xl font-semibold tracking-[-0.03em]">August</h2>
                                        <p className="mt-1 text-ui-2xs font-medium uppercase tracking-[0.14em] text-zinc-600">Settings &amp; controls</p>
                                    </div>
                                    <div className="flex items-center gap-2 rounded-control border border-white/[0.07] bg-zinc-800/80 px-2.5 py-2 transition-colors focus-within:border-white/20">
                                        <SearchIcon className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                                        <input
                                            value={navQuery}
                                            onChange={e => setNavQuery(e.target.value)}
                                            placeholder="Search settings"
                                            aria-label="Search settings"
                                            className="w-full bg-transparent text-ui-sm text-zinc-200 placeholder-zinc-500 outline-none"
                                        />
                                    </div>
                                </div>
                                {NAV_GROUPS.map(group => {
                                    const entries = group.entries.filter(navMatches);
                                    if (entries.length === 0) return null;
                                    return (
                                        <div key={group.title} className="space-y-0.5 pt-5 first:pt-0">
                                            <p className="ui-kicker px-2.5 pb-1">{group.title}</p>
                                            {entries.map(entry => (
                                                <NavTabButton
                                                    key={entry.id}
                                                    active={activeTab === entry.id}
                                                    onClick={() => navClick(entry.id)}
                                                    icon={entry.icon}
                                                    label={entry.label}
                                                    badge={navBadge(entry.id)}
                                                />
                                            ))}
                                        </div>
                                    );
                                })}
                                {navQ && !NAV_GROUPS.some(g => g.entries.some(navMatches)) && (
                                    <EmptyState
                                        compact
                                        iconVariant="subtle"
                                        align="start"
                                        icon={<Search className="h-5 w-5" aria-hidden="true" />}
                                        title={`Nothing matches "${navQuery.trim()}"`}
                                    />
                                )}
                            </div>

                            {/* Diagnostics & Version at bottom of nav — developer
                                tooling tucked behind a collapsible so it doesn't
                                sit on a user-facing screen. */}
                            <div className="pt-4 border-t border-zinc-800/80 space-y-2">
                                <details className="group">
                                    <summary className="flex cursor-pointer select-none list-none items-center justify-between font-mono text-ui-xs text-zinc-600 hover:text-zinc-400">
                                        <span>Developer</span>
                                        <ChevronRight className="h-3 w-3 shrink-0 text-zinc-500 transition-transform duration-150 ease-[var(--ease-snappy)] group-open:rotate-90" aria-hidden="true" />
                                    </summary>
                                    <div className="mt-2 px-2 pb-1 text-ui-dense leading-5 text-zinc-500">
                                        Runtime errors and the thinking-leak bin moved
                                        to <span className="text-zinc-300">Learning → Health</span>.
                                    </div>
                                </details>
                                <p className="text-ui-xs text-zinc-600 text-center font-mono">
                                    {APP_NAME} v{APP_VERSION}
                                </p>
                            </div>
                        </div>

                        {/* Right Content Workspace. Three layout modes: tabs
                            that own their whole scroll container (the embedded
                            managers), a wide measure for data-dense pages, and
                            a reading measure for preference pages. */}
                        <div className={`flex-1 min-h-0 overflow-y-auto bg-zinc-900 custom-scrollbar ${
                            // One frame for every preference page: a full-width
                            // column inset from the pane edge, the reference's
                            // measure. Full-bleed editors own their own padding.
                            FULL_BLEED_TABS.includes(activeTab)
                                ? ''
                                : 'px-8 py-8 lg:px-10 [&>*]:w-full'
                        }`}>

                            {/* TAB 0: Trading Journal — Hub & Quick Launcher */}
                            {activeTab === 'journal' && (
                                <Suspense fallback={<TabFallback />}>
                                    <JournalTab tab={{
                                        loggedTrades: props.loggedTrades,
                                        username: props.username,
                                        onClose,
                                        onOpenJournal: props.onOpenJournal,
                                        onOpenLearn,
                                        useAlgorithmicSummary: props.useAlgorithmicSummary,
                                        onToggleAlgorithmicSummary: props.onToggleAlgorithmicSummary,
                                        useAlgorithmicInsights: props.useAlgorithmicInsights,
                                        onToggleAlgorithmicInsights: props.onToggleAlgorithmicInsights,
                                        summaryCharLimit: props.summaryCharLimit,
                                        onUpdateSummaryCharLimit: props.onUpdateSummaryCharLimit,
                                    }} />
                                </Suspense>
                            )}

                            {/* TAB 1: AI Models & Providers */}
                            {activeTab === 'models' && (
                                <Suspense fallback={<TabFallback />}>
                                    <ModelsTab tab={{
                                        providerConfigs,
                                        providerConfigsLoaded,
                                        readyConfigProviders,
                                        memoryConfig: props.memoryConfig,
                                        onMemoryConfigChange: props.onMemoryConfigChange,
                                        visionModel: props.visionModel,
                                        selectedOcrModel: props.selectedOcrModel,
                                        onSetVisionModel: props.onSetVisionModel,
                                        onUpdateProvider: props.onUpdateProvider,
                                        onAddCustomProvider: props.onAddCustomProvider,
                                        onRemoveProvider: props.onRemoveProvider,
                                        onToggleProviderConfig: props.onToggleProviderConfig,
                                        onAddModel: props.onAddModel,
                                        onRemoveModel: props.onRemoveModel,
                                        onUpdateModel: props.onUpdateModel,
                                        setIsDirty,
                                    }} />
                                </Suspense>
                            )}

                            {/* TAB 1: Profile — who is signed in and what their
                                desk holds. The account menu has linked here all
                                along; the tab itself was never rendered, so
                                Profile opened an empty pane. */}
                            {activeTab === 'profile' && (
                                <Suspense fallback={<TabFallback />}>
                                    <ProfileTab tab={{
                                        loggedTrades: props.loggedTrades,
                                        username: props.username,
                                        providerConfigs,
                                        providerConfigsLoaded,
                                        onSwitchUser: props.onSwitchUser,
                                        onExportData: props.onExportData,
                                        setActiveTab,
                                    }} />
                                </Suspense>
                            )}

                            {/* TAB 2: General & Analysis */}
                            {activeTab === 'general' && (
                                <Suspense fallback={<TabFallback />}>
                                    <GeneralTab tab={{
                                        isHybridIntelligenceEnabled: props.isHybridIntelligenceEnabled,
                                        onToggleHybridIntelligence: props.onToggleHybridIntelligence,
                                        setIsHybridIntelligenceEnabled: props.setIsHybridIntelligenceEnabled,
                                        deskToolsEnabled,
                                        setDeskToolsEnabled,
                                        idleMotionEnabled,
                                        isAdvancedOpen,
                                        setIsAdvancedOpen,
                                        isAutoCapturing: props.isAutoCapturing,
                                        onToggleAutoCapturing: props.onToggleAutoCapturing,
                                        isEntryNotHitCapturing: props.isEntryNotHitCapturing,
                                        onToggleEntryNotHitCapturing: props.onToggleEntryNotHitCapturing,
                                    }} />
                                </Suspense>
                            )}

                            {/* TAB: Prompts & Instructions — one body with a conditional
                                inside (the editor when the Instructions entry is active,
                                PromptManager otherwise), so it stays ONE component. */}
                            {(activeTab === 'prompts' || activeTab === 'instructions') && (
                                <Suspense fallback={<TabFallback />}>
                                    <PromptsTab tab={{
                                        activeTab,
                                        username: props.username,
                                        customInstructions: props.customInstructions,
                                        setCustomInstructions: props.setCustomInstructions,
                                        activeInstructionTab,
                                        setActiveInstructionTab,
                                    }} />
                                </Suspense>
                            )}

                            {activeTab === 'memory' && (
                                <Suspense fallback={<TabFallback />}>
                                    <MemoryTab tab={{
                                        memoryConfig: props.memoryConfig,
                                        onOpenLearn,
                                    }} />
                                </Suspense>
                            )}

                            {activeTab === 'strategies' && (
                                <Suspense fallback={<TabFallback />}>
                                    <StrategiesTab tab={{
                                        username: props.username,
                                        providerConfigs,
                                        visionConfig: props.visionConfig,
                                        isStrategiesEnabled: props.isStrategiesEnabled,
                                        setIsStrategiesEnabled: props.setIsStrategiesEnabled,
                                        // The library left this dialog for the
                                        // Learning surface's Skills tab, so the
                                        // jump crosses surfaces now — and Settings
                                        // closes itself on the way, the same way
                                        // "open the notebook" already does.
                                        onOpenStrategyStudio: () => props.onOpenLearn?.('skills'),
                                    }} />
                                </Suspense>
                            )}

                            {/* TAB 6: Data — Backups & Alerts */}
                            {activeTab === 'actions' && (
                                <Suspense fallback={<TabFallback />}>
                                    <ActionsTab tab={{
                                        username: props.username,
                                        // The Data tab's training export counts these rows to decide
                                        // whether the button is live, so a mount that omits them
                                        // renders "No trades logged yet" over a full journal
                                        // (the 2026-10-27 audit §8, item F-9).
                                        loggedTrades: props.loggedTrades,
                                        onProfileRestored: props.onProfileRestored,
                                    }} />
                                </Suspense>
                            )}

                        </div>
                    </div>
                </div>
                </div>
            {ConfirmDialogComponent}
        </>
    );
};

export default React.memo(SettingsMenu);
