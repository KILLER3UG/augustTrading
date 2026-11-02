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
 * (the field the strategy×regime matrix and the skill attribution both read);
 * `notebook.note` and `notebook.chat_note` were each 107 characters short and
 * missing the line that forbids writing into `skills/`. A restated copy is a
 * drift waiting to happen, so every fallback below is the SAME STRING the
 * call site passes to `getPrompt` — imported, so the two cannot diverge.
 * `tests/planE08PromptRegistry.test.ts` pins that identity.
 */

import {
    MASTER_ANALYSIS_PROMPT,
    COMPACT_ANALYSIS_PROMPT,
    RISK_MANAGEMENT_RULES,
} from './prompts/analysisPrompts';
import { AI_PROVIDER_MEMORY_ENFORCEMENT_PROMPT } from './prompts/memoryPrompts';
// The call-site constants, imported rather than copied. Each of these modules
// already owns the text the model actually receives — including the two skill
// prompts, whose predicate grammar is interpolated from its evaluator
// (services/analysis/skillPredicate) inside the constant itself, so an
// override can never ask for a clause the parser would reject.
import { DEFAULT_SUMMARIZE_PROMPT } from '../services/learning/strategySummarizer';
import { NOTEBOOK_NOTE_FALLBACK, CHAT_NOTE_FALLBACK } from '../services/learning/NotebookWriterService';
import { SKILL_CRAFT_FALLBACK, SKILL_REFINE_FALLBACK } from '../services/learning/SkillCraftService';
import { SKILL_WORTH_FALLBACK } from '../services/learning/skillWorthGate';
import { CHART_SCAN_FALLBACK_PROMPT } from '../services/learning/chartScanSkills';
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
        id: 'notebook.note',
        name: 'Trader Notebook Note Writer',
        description: 'After each closed trade, decides what the Trader Notebook (Settings → Personal edge) needs: SKIP when the lesson is already covered, APPEND a new section to an existing file, or CREATE a new file/folder. The current notebook index (folders + files + excerpts) is appended by the service so the model always reads the real notebook before writing.',
        usage: ['After every logged WIN/LOSS post-mortem (AI memory writer)'],
        // IMPORTED, not restated: the restated copy was 107 characters short and
        // missing the line that forbids writing into skills/.
        fallback: NOTEBOOK_NOTE_FALLBACK,
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
        // KEEP IN SYNC with SKILL_CRAFT_FALLBACK (services/learning/SkillCraftService.ts):
        // this text is only the Settings diff base, while the call-site constant
        // is what actually runs — a stale copy here makes every override diff lie.
        id: 'learning.skill_craft',
        name: 'Skill craft (trigger → procedure)',
        description: 'After a post-mortem, the memory model turns the lesson into a skill: description, when, inputs, steps, pitfalls, verification, validate, return, approval.',
        usage: ['Post-mortem skill draft (inbox Approve to save)'],
        // IMPORTED, not restated. The predicate grammar is part of this prompt
        // and comes from its evaluator (already interpolated into the
        // constant), so an override can never ask for a clause the parser
        // would reject.
        fallback: SKILL_CRAFT_FALLBACK,
    },
    {
        id: 'learning.skill_refine',
        name: 'Skill refinement (losses → tighter trigger)',
        description: 'When a confirmed skill has lost repeatedly, the model rewrites it: tighten the trigger, add the missing guard, or narrow the regime. The refined skill goes to the inbox for approval like any other proposal.',
        usage: ['Confirmed-skill loss refinement (inbox Approve to save)'],
        // This id was read by a call site (SkillCraftService.refineSkillFromLosses)
        // but was NOT a registry entry, so the Settings editor could neither
        // show nor reset an override for it. Registered: the prompt is real and
        // the machinery is already there.
        fallback: SKILL_REFINE_FALLBACK,
    },
    {
        id: 'learning.skill_worth',
        name: 'Skill worth gate',
        description: 'Judges whether a newly drafted skill is worth keeping: is it mechanical, non-duplicate, and worth the injection budget it would take from better rules?',
        usage: ['Skill worth gate (keeps the library under its cap)'],
        // Also read by a call site (skillWorthGate) without being a registry
        // entry — registered for the same reason as learning.skill_refine.
        fallback: SKILL_WORTH_FALLBACK,
    },
    {
        id: 'learning.chart_scan',
        name: 'Chart-history skill scan',
        description: 'The model reads a study of EVERY candle in a chart (hour-by-hour movement in PHT, the ≥10% up/down swing legs and what preceded them, candle anatomy, regimes, gaps, every setup detector with historical win-rates) and creates 1–3 pattern-first candidate skills.',
        usage: ['scan_chart_skills desk tool + "Scan → skills" in the Chart AI composer (candidates are created directly; evidence sets their status)'],
        // IMPORTED, not restated. The predicate grammar is part of this prompt
        // and comes from its evaluator (already interpolated into the
        // constant).
        fallback: CHART_SCAN_FALLBACK_PROMPT,
    },
    {
        id: 'learning.settlement_reflection',
        name: 'Closed-trade reflection (post-mortem at settlement)',
        description: 'When a trade closes, the memory model writes the row\'s post-mortem from the facts the settlement path already measured — the R it earned, the cost, the excursion, the benchmark, the regime and what the pre-trade gate said. Its `When …, do …` line is what turns into a skill DRAFT for the trader to approve.',
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
