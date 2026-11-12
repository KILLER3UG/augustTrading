// User profile, settings, and custom instruction types

import { Conversation, LoggedTrade, TradeSummary } from './trade';
import { GlobalMemory, LearningRule } from './learning';

export interface CustomInstruction {
  id: string;
  title: string;
  content: string;
  isActive: boolean;
}

export interface CustomInstructionsMap {
  general: CustomInstruction[];
}

export interface UserSettings {
  activeFrameworks: string[];
  summaryCharLimit?: number;
  summarizationProvider?: string;  // ProviderConfig id
  summarizationModel?: string;
  /** Global vision model (bare model id) — one model for every vision feature. */
  visionModel?: string;
  isGlobalMemoryEnabled?: boolean; // Layer 3 Toggle
  customInstructions?: CustomInstructionsMap; // User-defined behavior overrides per mode
  isHybridIntelligenceEnabled?: boolean; // Hybrid Intelligence: Real-time data + programmatic TA
  isStrategiesEnabled?: boolean; // Master switch: inject uploaded strategy books into analysis prompts
  isAutoCapturing?: boolean; // Prompt for post-trade result capture
  isEntryNotHitCapturing?: boolean; // Prompt when entry price is not hit
  useAlgorithmicSummary?: boolean; // Journal AI Review: false = AI (default), true = algorithmic (free)
  useAlgorithmicInsights?: boolean; // Trade insight generation: false = AI (default), true = algorithmic
  memoryProvider?: string; // Memory core AI provider (e.g., 'gemini', 'groq')
  memoryModel?: string; // Model for memory operations
}

export interface UserProfile {
  username: string;
  conversations: Conversation[];
  tradeLog: LoggedTrade[];
  tradeSummaries: TradeSummary[];
  finalTradeSummary: string | null;
  globalMemory?: GlobalMemory; // Layer 3: Global Long-Term Memory
  settings: UserSettings;
  lastActiveConversationId?: string;
  createdAt?: string;
  updatedAt?: string;
  // AI Learning Features
  learningRules?: { rules: LearningRule[]; lastUpdated: string }; // journal rules (when → action) from post-mortems
}
