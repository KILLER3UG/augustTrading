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
import {AISettingsIcon, HistoryIcon, SettingsIcon, CodeIcon, SearchIcon, CloseIcon, ChevronLeftIcon, User, FileText, Brain, BookOpen, Database, Search, ChevronRight, ArrowLeft, ArrowRight, PanelLeft, Info, X} from '../shared/Icons';
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
    /** A lifecycle flag on the row. Only set on labels no gate matches exactly,
     *  because it becomes part of the button's text content. */
    flag?: 'Beta' | 'New';
}> = ({ active, onClick, icon, label, badge, flag }) => (
    <button
        type="button"
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        className={`motion-press flex w-full items-center justify-between gap-2 rounded-control px-2.5 py-2 text-left text-ui-sm font-medium transition-colors ${
            active
                ? 'bg-zinc-800 text-zinc-100 shadow-sm ring-1 ring-white/[0.09]'
                : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-100'
        }`}
    >
        <span className="flex min-w-0 items-center gap-2.5">
            <span className={`shrink-0 ${active ? 'text-zinc-100' : 'text-zinc-500'}`}>{icon}</span>
            <span className="truncate" title={label}>{label}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
            {flag && (
                <span className={`rounded-full px-1.5 py-0.5 text-ui-2xs font-semibold leading-none ${
                    flag === 'New' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-cyan-500/15 text-cyan-300'
                }`}>{flag}</span>
            )}
            {badge && (
                <span className="rounded-full bg-zinc-700 px-1.5 py-0.5 font-mono text-ui-2xs font-bold leading-none text-zinc-200">
                    {badge}
                </span>
            )}
        </span>
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
    flag?: 'Beta' | 'New';
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
            { id: 'prompts', label: 'Prompts', icon: <CodeIcon className={NAV_ICON} />, keywords: 'template library editing', flag: 'Beta' },
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
            { id: 'strategies', label: 'Playbooks', icon: <BookOpen className={NAV_ICON} />, keywords: 'strategy book pdf upload studio families import', flag: 'New' },
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

/** The search box's ROW index. The sidebar's keyword list finds a PAGE; these
 *  entries find the control inside it. A hit jumps to the page and then to the
 *  row whose title matches, so "vision" lands on the Vision Model card rather
 *  than merely opening AI setup. Every label here names a control that exists. */
interface SettingsSearchHit {
    id: string;
    label: string;
    tab: SettingsTab;
    keywords: string;
}
const SETTINGS_SEARCH_ROWS: SettingsSearchHit[] = [
    { id: 'hybrid', label: 'Hybrid intelligence', tab: 'general', keywords: 'real time market data rsi macd ema price context' },
    { id: 'desk-tools', label: 'Desk Tools', tab: 'general', keywords: 'web search funding open interest order book liquidations tools' },
    { id: 'reduce-motion', label: 'Reduce motion', tab: 'general', keywords: 'animation indicators still idle motion accessibility' },
    { id: 'capture', label: 'Auto-capture', tab: 'general', keywords: 'capture prompts context injection advanced' },
    { id: 'vision', label: 'Vision Model', tab: 'models', keywords: 'ocr chart screenshot pdf image provider' },
    { id: 'memory-model', label: 'Memory Model', tab: 'models', keywords: 'librarian notebook skills background passes' },
    { id: 'providers', label: 'Model settings', tab: 'models', keywords: 'provider api key base url endpoint add custom' },
    { id: 'prompts', label: 'Prompt library', tab: 'prompts', keywords: 'prompts template edit override' },
    { id: 'instructions', label: 'Custom instructions', tab: 'instructions', keywords: 'system rules persona behaviour' },
    { id: 'memory', label: 'Memory behavior', tab: 'memory', keywords: 'global notebook switches learning sensitive' },
    { id: 'notebook', label: 'Notebook', tab: 'memory', keywords: 'memory files entries export learning surface' },
    { id: 'playbooks', label: 'Playbooks', tab: 'strategies', keywords: 'strategy book pdf upload studio' },
    { id: 'profile', label: 'Profile', tab: 'profile', keywords: 'trader account switch version update' },
    { id: 'journal', label: 'Trading journal', tab: 'journal', keywords: 'trades log summary insights statistics' },
    { id: 'storage', label: 'Storage location', tab: 'actions', keywords: 'sqlite indexeddb journal disk path' },
    { id: 'backup', label: 'Backups', tab: 'actions', keywords: 'backup restore export import json' },
    { id: 'usage', label: 'Session usage', tab: 'actions', keywords: 'tokens usage cost training export' },
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

    // ── Standalone window chrome ───────────────────────────────────────────
    // Settings is a WINDOW, not a card floating over the app: its top bar owns
    // the sidebar toggle and the page history, its sidebar scrolls on its own,
    // and the content pane is a separate scroll container. The dialog contract
    // (focus trap, Escape, aria-modal, mounting outside <main>) is unchanged.
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [helpOpen, setHelpOpen] = useState(false);
    const [history, setHistory] = useState<{ stack: SettingsTab[]; index: number }>(() => ({
        stack: [activeTab], index: 0,
    }));
    const [pendingJump, setPendingJump] = useState<string | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const historyNavigationRef = useRef(false);

    // Every tab change is a page visit. Back/forward set the flag first so a
    // history move does not also append itself as a new visit.
    useEffect(() => {
        if (historyNavigationRef.current) {
            historyNavigationRef.current = false;
            return;
        }
        setHistory(prev => {
            const base = prev.stack.slice(0, prev.index + 1);
            if (base[base.length - 1] === activeTab) return prev;
            return { stack: [...base, activeTab], index: base.length };
        });
    }, [activeTab]);

    // Toasts + the help button share the bottom-right corner only while this
    // window is open (see body[data-settings-open] in index.css).
    useEffect(() => {
        if (!isVisible) return;
        document.body.setAttribute('data-settings-open', 'true');
        return () => { document.body.removeAttribute('data-settings-open'); };
    }, [isVisible]);

    const searchHits = useMemo<SettingsSearchHit[]>(() => {
        if (!navQ) return [];
        return SETTINGS_SEARCH_ROWS.filter(hit =>
            hit.label.toLowerCase().includes(navQ) || hit.keywords.includes(navQ),
        ).slice(0, 7);
    }, [navQ]);

    const jumpTo = useCallback((hit: SettingsSearchHit): void => {
        explicitTabChosenRef.current = true;
        setActiveTab(hit.tab);
        setNavQuery('');
        setPendingJump(hit.label);
        setHelpOpen(false);
    }, []);

    // The tab body is lazy-loaded, so poll briefly for its row before giving
    // up. The scroll + highlight are transform/opacity only (motion-highlight).
    useEffect(() => {
        if (!pendingJump || !isVisible) return;
        let attempts = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const find = (): void => {
            const pane = contentRef.current;
            const rows = pane
                ? Array.from(pane.querySelectorAll<HTMLElement>('[data-settings-row]'))
                : [];
            const needle = pendingJump.toLowerCase();
            const row = rows.find(r => (r.textContent || '').toLowerCase().includes(needle));
            if (row) {
                row.scrollIntoView({ block: 'center', behavior: 'smooth' });
                row.classList.add('motion-highlight');
                setTimeout(() => row.classList.remove('motion-highlight'), 600);
                setPendingJump(null);
                return;
            }
            attempts += 1;
            if (attempts < 12) timer = setTimeout(find, 80);
            else setPendingJump(null);
        };
        timer = setTimeout(find, 60);
        return () => { if (timer) clearTimeout(timer); };
    }, [pendingJump, activeTab, isVisible]);

    const goBack = useCallback((): void => {
        if (history.index <= 0) return;
        const next = history.index - 1;
        historyNavigationRef.current = true;
        setHistory({ ...history, index: next });
        setActiveTab(history.stack[next]);
    }, [history]);

    const goForward = useCallback((): void => {
        if (history.index >= history.stack.length - 1) return;
        const next = history.index + 1;
        historyNavigationRef.current = true;
        setHistory({ ...history, index: next });
        setActiveTab(history.stack[next]);
    }, [history]);

    if (!isVisible) return null;

    const activeEntry = NAV_GROUPS.flatMap(g => g.entries).find(e => e.id === activeTab);
    const activeGroup = NAV_GROUPS.find(g => g.entries.some(e => e.id === activeTab));
    const canGoBack = history.index > 0;
    const canGoForward = history.index < history.stack.length - 1;
    const noNavMatches = navQ && !NAV_GROUPS.some(g => g.entries.some(navMatches)) && searchHits.length === 0;

    return (
        <>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="settings-title"
                data-testid="settings-window"
                className="fixed inset-0 z-modal flex flex-col bg-zinc-950 motion-fade"
            >
                {/* Top bar — sidebar toggle, back/forward, breadcrumb, close. */}
                <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-hairline bg-zinc-900/40 px-3">
                    <button
                        type="button"
                        onClick={() => setSidebarCollapsed(v => !v)}
                        aria-label={sidebarCollapsed ? 'Show settings sidebar' : 'Hide settings sidebar'}
                        aria-expanded={!sidebarCollapsed}
                        data-testid="settings-sidebar-toggle"
                        className="motion-press rounded-control p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                    >
                        <PanelLeft className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <span aria-hidden="true" className="mx-1 h-4 w-px bg-white/[0.08]" />
                    <button type="button" onClick={goBack} disabled={!canGoBack} aria-label="Back"
                        data-testid="settings-back"
                        className="motion-press rounded-control p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-30">
                        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button type="button" onClick={goForward} disabled={!canGoForward} aria-label="Forward"
                        data-testid="settings-forward"
                        className="motion-press rounded-control p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-30">
                        <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <h2 id="settings-title" className="ml-2 min-w-0 flex-1 truncate text-ui-sm font-medium text-zinc-300">
                        <span className="text-zinc-600">{activeGroup?.title ?? 'Settings'}</span>
                        <span className="px-1.5 text-zinc-700">/</span>
                        {activeEntry?.label ?? 'Settings'}
                    </h2>
                    <button
                        type="button"
                        onClick={requestClose}
                        aria-label="Close settings"
                        className="motion-press rounded-control p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                    >
                        <CloseIcon className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>

                <div className="relative flex min-h-0 flex-1">
                    {/* Sidebar — its own scroll container, independent of the page. */}
                    <aside
                        data-testid="settings-sidebar"
                        aria-label="Settings sections"
                        className={`shrink-0 overflow-hidden bg-zinc-950/60 ${sidebarCollapsed ? 'w-0' : 'w-64 border-r border-hairline'}`}
                    >
                        <div className={`flex h-full w-64 flex-col transition-[opacity,transform] duration-[var(--motion-base)] ease-[var(--motion-ease)] ${
                            sidebarCollapsed ? 'pointer-events-none -translate-x-3 opacity-0' : 'translate-x-0 opacity-100'
                        }`}>
                            <div className="px-3 pt-4">
                                <button type="button" onClick={requestClose} data-testid="settings-back-to-app"
                                    className="motion-press flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-left text-ui-sm text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-100">
                                    <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
                                    Back to app
                                </button>
                            </div>
                            <div className="px-3 pb-2 pt-3">
                                <div className="flex items-center gap-2 rounded-control border border-hairline bg-zinc-800/80 px-2.5 py-2 transition-colors focus-within:border-line">
                                    <SearchIcon className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                                    <input
                                        value={navQuery}
                                        onChange={e => setNavQuery(e.target.value)}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter' && searchHits.length > 0) jumpTo(searchHits[0]);
                                            if (e.key === 'Escape') setNavQuery('');
                                        }}
                                        placeholder="Search settings..."
                                        aria-label="Search settings"
                                        className="w-full min-w-0 bg-transparent text-ui-sm text-zinc-200 placeholder-zinc-500 outline-none"
                                    />
                                    {navQ && (
                                        <button type="button" onClick={() => setNavQuery('')} aria-label="Clear search"
                                            className="shrink-0 rounded-control p-0.5 text-zinc-500 transition-colors hover:text-zinc-200">
                                            <X className="h-3 w-3" aria-hidden="true" />
                                        </button>
                                    )}
                                </div>
                            </div>
                            <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 custom-scrollbar">
                                {navQ && searchHits.length > 0 && (
                                    <div className="pb-3">
                                        <p className="ui-kicker px-2.5 pb-1">Results</p>
                                        <div className="space-y-0.5 motion-list">
                                            {searchHits.map(hit => (
                                                <button key={hit.id} type="button" onClick={() => jumpTo(hit)}
                                                    data-testid={`settings-search-${hit.id}`}
                                                    className="motion-press flex w-full flex-col items-start gap-0.5 rounded-control px-2.5 py-2 text-left transition-colors hover:bg-white/[0.05]">
                                                    <span className="text-ui-sm text-zinc-200">{hit.label}</span>
                                                    <span className="max-w-full truncate text-ui-2xs text-zinc-500">
                                                        {NAV_GROUPS.find(g => g.entries.some(e => e.id === hit.tab))?.title}
                                                        {' · '}{NAV_GROUPS.flatMap(g => g.entries).find(e => e.id === hit.tab)?.label}
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {NAV_GROUPS.map(group => {
                                    const entries = group.entries.filter(navMatches);
                                    if (entries.length === 0) return null;
                                    return (
                                        <div key={group.title} className="space-y-0.5 pt-4 first:pt-0">
                                            <p className="ui-kicker px-2.5 pb-1">{group.title}</p>
                                            {entries.map(entry => (
                                                <NavTabButton
                                                    key={entry.id}
                                                    active={activeTab === entry.id}
                                                    onClick={() => navClick(entry.id)}
                                                    icon={entry.icon}
                                                    label={entry.label}
                                                    badge={navBadge(entry.id)}
                                                    flag={entry.flag}
                                                />
                                            ))}
                                        </div>
                                    );
                                })}
                                {noNavMatches && (
                                    <EmptyState
                                        compact
                                        iconVariant="subtle"
                                        align="start"
                                        icon={<Search className="h-5 w-5" aria-hidden="true" />}
                                        title={`Nothing matches "${navQuery.trim()}"`}
                                    />
                                )}
                            </nav>
                            <div className="border-t border-zinc-800/80 px-3 py-3">
                                <details className="group">
                                    <summary className="flex cursor-pointer select-none list-none items-center justify-between font-mono text-ui-xs text-zinc-600 hover:text-zinc-400">
                                        <span>Developer</span>
                                        <ChevronRight className="h-3 w-3 shrink-0 text-zinc-500 transition-transform duration-[var(--motion-fast)] ease-[var(--motion-ease)] group-open:rotate-90" aria-hidden="true" />
                                    </summary>
                                    <div className="mt-2 px-2 pb-1 text-ui-dense leading-5 text-zinc-500">
                                        Runtime errors and the thinking-leak bin moved
                                        to <span className="text-zinc-300">Learning → Health</span>.
                                    </div>
                                </details>
                                <p className="mt-2 text-center font-mono text-ui-xs text-zinc-600">
                                    {APP_NAME} v{APP_VERSION}
                                </p>
                            </div>
                        </div>
                    </aside>

                    {/* Content — an inset panel on its own scroll container. */}
                    <div
                        ref={contentRef}
                        role="region"
                        aria-label="Settings content"
                        className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-zinc-950 p-4 custom-scrollbar md:p-6"
                    >
                        <div
                            key={activeTab}
                            className={`mx-auto w-full max-w-[940px] motion-page rounded-bubble border border-hairline bg-zinc-900/50 ${
                                FULL_BLEED_TABS.includes(activeTab) ? 'overflow-hidden' : 'p-6 md:p-8'
                            }`}
                        >
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

                            {/* TAB: Profile */}
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

                            {/* TAB: General & Analysis */}
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
                                inside, so it stays ONE component. */}
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
                                        onOpenStrategyStudio: () => props.onOpenLearn?.('skills'),
                                    }} />
                                </Suspense>
                            )}

                            {/* TAB: Data — Backups & Alerts */}
                            {activeTab === 'actions' && (
                                <Suspense fallback={<TabFallback />}>
                                    <ActionsTab tab={{
                                        username: props.username,
                                        loggedTrades: props.loggedTrades,
                                        onProfileRestored: props.onProfileRestored,
                                    }} />
                                </Suspense>
                            )}
                        </div>
                    </div>
                </div>

                {/* Bottom-right help — the reference's floating "?" button. */}
                <div className="pointer-events-none absolute bottom-4 right-4 z-10 flex flex-col items-end gap-2">
                    {helpOpen && (
                        <div role="dialog" aria-label="Settings help" data-testid="settings-help-panel"
                            className="motion-pop pointer-events-auto w-72 rounded-bubble border border-hairline bg-zinc-900 p-4 shadow-2xl">
                            <p className="text-ui-sm font-semibold text-zinc-100">Settings help</p>
                            <p className="mt-1.5 text-ui-dense leading-relaxed text-zinc-500">
                                Search finds a control by name and jumps to it. Back and forward walk the pages
                                you visited in this window.
                            </p>
                            <dl className="mt-3 space-y-1.5 text-ui-dense">
                                {[
                                    ['Ctrl/⌘ + ,', 'Open settings'],
                                    ['Esc', 'Close settings'],
                                    ['Ctrl/⌘ + K', 'New chat'],
                                    ['Ctrl/⌘ + B', 'Hide conversation'],
                                ].map(([key, action]) => (
                                    <div key={key} className="flex items-center justify-between gap-2">
                                        <dt className="font-mono text-ui-2xs text-zinc-400">{key}</dt>
                                        <dd className="text-zinc-500">{action}</dd>
                                    </div>
                                ))}
                            </dl>
                            <p className="mt-3 flex items-start gap-1.5 text-ui-2xs leading-relaxed text-zinc-600">
                                <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                                August is local-first. No account, subscription or order placement lives here.
                            </p>
                        </div>
                    )}
                    <button type="button" onClick={() => setHelpOpen(v => !v)}
                        aria-label="Settings help" aria-expanded={helpOpen} data-testid="settings-help"
                        className="motion-press pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-zinc-800 text-ui-base font-semibold text-zinc-200 transition-colors hover:bg-zinc-700">
                        ?
                    </button>
                </div>
            </div>
            {ConfirmDialogComponent}
        </>
    );
};

export default React.memo(SettingsMenu);
