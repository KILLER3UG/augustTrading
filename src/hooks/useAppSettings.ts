/**
 * useAppSettings — manages AI analysis settings state.
 * Extracted from App.tsx to reduce component complexity.
 */

import { useState } from 'react';
import { CustomInstructionsMap, GlobalMemory, AIProvider } from '../types';
import { ProviderConfig } from '../types/provider';
import { DEFAULT_FRAMEWORKS } from '../constants/models';

export function useAppSettings() {
    // Layer 3: Global Long-Term Memory
    const [globalMemory, setGlobalMemory] = useState<GlobalMemory | undefined>(undefined);

    // Memory Provider Selection
    const [memoryConfig, setMemoryConfig] = useState<ProviderConfig | null>(null);
    const [memoryModel, setMemoryModel] = useState<string>('');
    // The shipped default, so a turn that runs before the profile loader hydrates
    // this is not a turn without memory. `useUserProfileLoader` overwrites it with
    // the stored value (or the same default) the moment the profile arrives.
    const [isGlobalMemoryEnabled, setIsGlobalMemoryEnabled] = useState<boolean>(true);

    // User-uploaded strategy summaries (Settings → Strategies): master switch
    // that gates whether enabled docs are injected into prompts. Default ON —
    // the switch now gates the seat prompt for real (`activeStrategiesBlock`),
    // and a book the trader marked Enabled is meant to be used, not held behind
    // a control they never touched.
    const [isStrategiesEnabled, setIsStrategiesEnabled] = useState<boolean>(true);

    // Custom AI Behavior
    const [customInstructions, setCustomInstructions] = useState<CustomInstructionsMap>({
        general: [],
    });
    const [isHybridIntelligenceEnabled, setIsHybridIntelligenceEnabled] = useState<boolean>(false);

    // Confidence Calibration

    // Summarization settings
    const [activeFrameworks, setActiveFrameworks] = useState<string[]>(DEFAULT_FRAMEWORKS);
    const [summaryCharLimit, setSummaryCharLimit] = useState<number>(4000);
    // Defaults are empty — App resolves them to the first ready provider once configs load.
    const [summarizationProvider, setSummarizationProvider] = useState<AIProvider>('');
    const [summarizationModel, setSummarizationModel] = useState<string>('');
    // Global vision model (Settings → AI setup → Vision Model): one model for
    // EVERY vision feature — chart OCR, post-trade uploads, PDF book OCR.
    // Empty = fall back to the conversation's OCR model, then first ready provider.
    const [visionModel, setVisionModel] = useState<string>('');
    // Journal generation defaults to AI (false = use AI); algorithmic mode
    // (true, token-free) is an explicit opt-in. Persisted via UserSettings.
    const [useAlgorithmicSummary, setUseAlgorithmicSummary] = useState<boolean>(false);
    const [useAlgorithmicInsights, setUseAlgorithmicInsights] = useState<boolean>(false);

    return {
        globalMemory, setGlobalMemory,
        memoryConfig, setMemoryConfig,
        memoryModel, setMemoryModel,
        isGlobalMemoryEnabled, setIsGlobalMemoryEnabled,
        isStrategiesEnabled, setIsStrategiesEnabled,
        customInstructions, setCustomInstructions,
        isHybridIntelligenceEnabled, setIsHybridIntelligenceEnabled,
        activeFrameworks, setActiveFrameworks,
        summaryCharLimit, setSummaryCharLimit,
        summarizationProvider, setSummarizationProvider,
        summarizationModel, setSummarizationModel,
        visionModel, setVisionModel,
        useAlgorithmicSummary, setUseAlgorithmicSummary,
        useAlgorithmicInsights, setUseAlgorithmicInsights,
    };
}
