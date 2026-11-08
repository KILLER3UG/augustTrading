// TAB: Analysis — hybrid mode, stillness and the advanced capture
// switches (SettingsMenu "TAB 2").
//
// Moved verbatim from the inline body. `deskToolsEnabled`, `idleMotionEnabled`
// and `isAdvancedOpen` are the parent's state, passed under their local names —
// they must stay in SettingsMenu so a choice survives leaving and re-entering
// the tab. The service setter `setIdleMotionEnabled` is imported here because
// only this body writes through it.
import React from 'react';
import { Activity, ChevronDown, Wrench } from '../../shared/Icons';
import { ToggleSwitch } from '../../shared/ToggleSwitch';
import { HarnessControls } from '../SessionUsagePanel';
import { SettingsGroup, SettingsPageHeader, SettingsRow } from './shared';
import Disclosure from '../../shared/Disclosure';
import DeskToolCatalogue from './DeskToolCatalogue';
import { setIdleMotionEnabled } from '../../../services/desk/idleMotion';
import { saveHarnessSettings } from '../../../utils/harnessSettings';
import type { SettingsTabProps } from './types';

export interface GeneralTabProps extends SettingsTabProps {
    // Hybrid & Capturing
    isHybridIntelligenceEnabled: boolean;
    onToggleHybridIntelligence?: () => void;
    setIsHybridIntelligenceEnabled?: (enabled: boolean) => void;
    isAutoCapturing?: boolean;
    onToggleAutoCapturing?: () => void;
    isEntryNotHitCapturing?: boolean;
    onToggleEntryNotHitCapturing?: () => void;
    // Parent-local state, passed down (see header comment).
    deskToolsEnabled: boolean;
    setDeskToolsEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    idleMotionEnabled: boolean;
    isAdvancedOpen: boolean;
    setIsAdvancedOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

const GeneralTab: React.FC<{ tab: GeneralTabProps }> = ({ tab: props }) => {
    const {
        isHybridIntelligenceEnabled,
        onToggleHybridIntelligence,
        deskToolsEnabled,
        setDeskToolsEnabled,
        idleMotionEnabled,
        isAdvancedOpen,
        setIsAdvancedOpen,
        isAutoCapturing,
        onToggleAutoCapturing,
        isEntryNotHitCapturing,
        onToggleEntryNotHitCapturing,
    } = props;

    return (
        <div className="space-y-5 animate-fade-in">
            <SettingsPageHeader
                title="Analysis"
                description="How the harness thinks, what it is allowed to call, and how still the indicators sit."
            />

            <SettingsGroup title="Analysis modes">
                <SettingsRow
                    icon={<Activity className="h-4 w-4" aria-hidden="true" />}
                    title="Hybrid Intelligence"
                    description="Adds real-time market data (price, RSI, MACD, EMAs) so the models reason over live context."
                    control={
                        <ToggleSwitch checked={isHybridIntelligenceEnabled} onChange={() => {
                            if (onToggleHybridIntelligence) onToggleHybridIntelligence();
                            else if (props.setIsHybridIntelligenceEnabled) props.setIsHybridIntelligenceEnabled(!isHybridIntelligenceEnabled);
                        }} label="Toggle Hybrid Intelligence" />
                    }
                />
            </SettingsGroup>

            <SettingsGroup title="Analyst desk">
                <SettingsRow
                    icon={<Wrench className="h-4 w-4" aria-hidden="true" />}
                    title="Desk Tools"
                    description="Lets the desk call live tools anytime — web search, funding/OI, order book, liquidations, BTC context, session timing."
                    control={
                        <ToggleSwitch
                            checked={deskToolsEnabled}
                            onChange={() => {
                                const next = !deskToolsEnabled;
                                setDeskToolsEnabled(next);
                                saveHarnessSettings({ deskToolsEnabled: next });
                            }}
                            label="Toggle Desk Tools"
                        />
                    }
                />
                <SettingsRow
                    icon={<Activity className="h-4 w-4" aria-hidden="true" />}
                    title="Reduce motion"
                    description="Stills the indicators that never stop — the running-turn edge, the live-feed ring, the working dot. On means the screen stays steady."
                    control={
                        <ToggleSwitch
                            checked={!idleMotionEnabled}
                            onChange={() => setIdleMotionEnabled(!idleMotionEnabled)}
                            label="Toggle reduced motion"
                        />
                    }
                />
            </SettingsGroup>

            {/* What the switch above turns ON. Six of the forty tools were
                named; the rest were not, and the ones nobody names are
                exactly the ones that write. */}
            <DeskToolCatalogue />

            {/* ADVANCED — fine-tuning; most users never touch these. */}
            {/* The shared disclosure, like every other expander in the app: one
                mechanism, one keyboard behaviour, one look. */}
            <Disclosure
                testId="settings-advanced"
                label="Advanced"
                open={isAdvancedOpen}
                onToggle={setIsAdvancedOpen}
                summary={(
                    <span className="flex items-center justify-between gap-4">
                        <span className="min-w-0">
                            <span className="block text-ui-caption font-semibold text-zinc-200">Advanced</span>
                            <span className="mt-0.5 block text-ui-dense text-zinc-500">Context injection and capture prompts — most users can leave these as-is.</span>
                        </span>
                        <ChevronDown className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-150 ease-[var(--ease-snappy)] ${isAdvancedOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </span>
                )}
                summaryClassName="flex w-full items-center justify-between gap-4 rounded-bubble border border-hairline bg-zinc-900/50 px-4 py-3 text-left transition-colors hover:bg-zinc-800/40"
                bodyClassName="mt-3 space-y-3 animate-fade-in"
            >

                        {/* The harness's model-behavior dials — effort, the session
                            guard, the edge floor, default leverage, settlement —
                            moved here from the Data tab (stage 3): they are analysis
                            behavior. The cost cap that used to be in this list went
                            with the debate engine. */}
                        <SettingsGroup title="Harness dials" description="Model effort, the session guard, the edge floor and the default leverage.">
                            <HarnessControls />
                        </SettingsGroup>

                        {onToggleAutoCapturing && (
                            <SettingsGroup title="Automated capture prompts" description="When to ask for trade results automatically. All default: off.">
                                <SettingsRow
                                    title="Post-trade result capture"
                                    description={isAutoCapturing
                                        ? 'On — when the autopilot confirms a WIN/LOSS, the full capture modal opens so dollars and discipline tags reach the journal.'
                                        : 'Off — an autopilot-confirmed outcome logs immediately (percent-only PnL).'}
                                    control={<ToggleSwitch checked={!!isAutoCapturing} onChange={onToggleAutoCapturing} label="Toggle post-trade result capture" />}
                                />
                                {onToggleEntryNotHitCapturing && (
                                    <SettingsRow
                                        title="Entry not hit"
                                        description="Ask what happened when price never reached the entry."
                                        control={<ToggleSwitch checked={!!isEntryNotHitCapturing} onChange={onToggleEntryNotHitCapturing} label="Toggle entry not hit capture" />}
                                    />
                                )}
                            </SettingsGroup>
                        )}
            </Disclosure>
        </div>
    );
};

export default GeneralTab;
