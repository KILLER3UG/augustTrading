/**
 * Prompt registry — every user-editable prompt in the app.
 *
 * The Settings → Prompts tab renders this list; edits are stored by
 * PromptOverrideService and applied at call time via getPrompt(id, fallback).
 * `fallback` is the built-in default (shown in the editor and used by
 * "Reset to default"). `usage` is a human-readable list of where the prompt
 * reaches a model.
 *
 * THE FALLBACK IS IMPORTED, NEVER RESTATED. An entry used to carry its own
 * copy of the prompt text, and three of those copies had drifted from the
 * constant they shadowed: `strategy.summarize_pdf` was 366 characters short
 * and dropped the mandatory `Family` line, so "Reset to default" installed a
 * prompt that made every uploaded strategy parse with no `strategyFamily`
 * (the field the skill attribution and the family grouping both read);
 * the notebook prompts were each 107 characters short and
 * missing the line that forbids writing into `skills/`. A restated copy is a
 * drift waiting to happen, so every fallback below is the SAME STRING the
 * call site passes to `getPrompt` — imported, so the two cannot diverge.
 * The registry↔ids equality is pinned by `scripts/check-contracts.cjs`; the
 * vitest suite that used to pin the fallback identity was deleted with the
 * whole suite on 2026-10-23.
 */

import {
    MASTER_ANALYSIS_PROMPT,
    COMPACT_ANALYSIS_PROMPT,
    RISK_MANAGEMENT_RULES,
} from './prompts/analysisPrompts';
import { AI_PROVIDER_MEMORY_ENFORCEMENT_PROMPT } from './prompts/memoryPrompts';
import { DEFAULT_SUMMARIZE_PROMPT } from '../services/learning/strategySummarizer';
import { CHAT_NOTE_FALLBACK } from '../services/learning/NotebookWriterService';
import { DEFAULT_OCR_PAGE_PROMPT } from '../services/learning/pdfOcrService';
import { SETTLEMENT_REFLECTION_FALLBACK } from '../services/learning/settlementReflection';
import { POST_MORTEM_DIAGNOSIS_FALLBACK } from '../services/tracking/postMortemDiagnosis';

export interface PromptRegistryEntry {
    /** Stable id — the key user overrides are stored under. */
    id: string;
    /** Display name in the Prompts tab. */
    name: string;
    /** One-line description of what this prompt does. */
    description: string;
    /** Where this prompt reaches a model (shown as chips). */
    usage: string[];
    /** The built-in default text (editor content + reset target). */
    fallback: string;
}

export const PROMPT_REGISTRY: PromptRegistryEntry[] = [
    {
        id: 'analysis.master',
        name: 'Master Analysis Prompt',
        description: 'Standard-mode system prompt: desk-trader scan (structure, liquidity, volume, session, playbooks if they fit). Prose output follows the findings — no section template.',
        usage: ['Standard-mode analysis (analyzeTradingView)'],
        fallback: MASTER_ANALYSIS_PROMPT,
    },
    {
        id: 'analysis.compact',
        name: 'Compact Analysis Prompt',
        description: 'Trimmed desk-trader brief for small-context models (low context window).',
        usage: ['Small-context-model analysis'],
        fallback: COMPACT_ANALYSIS_PROMPT,
    },
    {
        id: 'analysis.risk_rules',
        name: 'Risk Management Rules',
        description: 'Mandatory risk rules appended to every analysis mode (leverage, R:R floor, position sizing).',
        usage: ['All analysis modes'],
        fallback: RISK_MANAGEMENT_RULES,
    },
    {
        id: 'analysis.memory_enforcement',
        name: 'Pattern Memory Enforcement',
        description: 'Instructs the model to use retrieved memory only when it matches this setup — never invent citations.',
        usage: ['Standard-mode analysis system prompt'],
        fallback: AI_PROVIDER_MEMORY_ENFORCEMENT_PROMPT,
    },
    {
        id: 'strategy.summarize_pdf',
        name: 'PDF Strategy Summarizer',
        description: 'Turns uploaded PDF book text into concise, actionable trading strategies (used when summarizing an upload in Settings → Strategies).',
        usage: ['PDF upload summarization (Settings → Strategies)'],
        // IMPORTED, not restated: the restated copy was 366 characters short and
        // dropped the mandatory `Family` line, so a reset installed a prompt
        // that made every uploaded strategy parse with no strategyFamily.
        fallback: DEFAULT_SUMMARIZE_PROMPT,
    },
    {
        id: 'notebook.chat_note',
        name: 'Trader Notebook Quick-Save (chat)',
        description: 'Runs when the user asks mid-conversation to save something to the notebook ("save this to the notebook"). The model reads the current notebook index, then decides skip / append to an existing file / create a new file or folder.',
        usage: ['Chat quick-save requests (short-circuits the analysis pipeline)'],
        // IMPORTED, not restated — same drift, same fix.
        fallback: CHAT_NOTE_FALLBACK,
    },
    {
        id: 'strategy.ocr_page',
        name: 'PDF Page OCR',
        description: 'Transcribes a scanned (image-only) PDF page into text using the vision model, so scanned books can be summarized too.',
        usage: ['Scanned PDF pages (Settings → Strategies)'],
        // IMPORTED, not restated — the last restated copy in this registry.
        fallback: DEFAULT_OCR_PAGE_PROMPT,
    },
    {
        id: 'learning.settlement_reflection',
        name: 'Closed-trade reflection (post-mortem at settlement)',
        description: 'When a trade closes, the memory model writes the row\'s post-mortem from the facts the settlement path already measured — the R it earned, the cost, the excursion, the benchmark, the regime and what the pre-trade gate said. Its `When …, do …` line feeds the journal-rules store; it no longer drafts a skill.',
        usage: ['Every closed WIN/LOSS trade (E-57 §1; the leg `craftSkillFromPostMortem` and the diary/lesson readers have been waiting on)'],
        // IMPORTED, not restated: the note-shape contract (a plain `Lesson:`
        // line and one When/do sentence) is read back by
        // `extractLessonFromPostMortem` and `parseLessonClauses`, so an override
        // that drops it costs the notebook its lesson — and the Settings diff
        // has to show the truth about what runs.
        fallback: SETTLEMENT_REFLECTION_FALLBACK,
    },
    {
        id: 'learning.post_mortem_diagnosis',
        name: 'Tracked-trade post-mortem diagnosis',
        description: 'When a tracked signal or journal trade closes, the memory model diagnoses it from the measured record: outcome, what happened, root cause, what should have been done, the lesson, a mechanical When/do clause and confidence. The tape outcome is authoritative; a disagreement is recorded, not accepted.',
        usage: ['The tracker diagnosis queue (signals + tracked journal trades; one call per closed position, max 3 per pass)'],
        fallback: POST_MORTEM_DIAGNOSIS_FALLBACK,
    },
];
