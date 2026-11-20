/**
 * traderLearner — the "keeps learning your preferences, habits, and ways of
 * working, making every collaboration the start of the next one" loop, for
 * trading. Every couple of Chart AI sessions it makes ONE independent LLM
 * call over the recent conversations and distills DURABLE facts about the
 * TRADER (not the market) into profileMemory:
 *
 *   • preferred symbols / timeframes / session times
 *   • risk habits (sizing, stop discipline, leverage comfort)
 *   • recurring mistakes the user themselves keeps making
 *   • strategy preferences and how they like answers delivered
 *
 * profileMemory's slug-upsert means a refined habit UPDATES its entry rather
 * than duplicating, and the always-loaded index means the very next session
 * starts with everything learned so far. Entries are tagged source:'auto',
 * visible (AUTO badge) and forgettable in Settings → Assistant memory —
 * automatic, never invisible. Market lessons do NOT belong here; they have
 * the whole skill/notebook pipeline.
 */

import type { ProviderConfig } from '../../types/provider';
import { sendChatRequest, type ChatMessage } from '../providers/GenericProviderService';
import { TASK_BUDGETS } from '../providers/taskBudgets';
import { effortForTask } from '../providers/reasoningControls';
import { extractAndParseJson } from '../../utils/jsonUtils';
import { z } from 'zod';
import { getActiveUsername } from '../../utils/activeUser';
import {
    listProfileMemories, normalizeKind, slugify,
    buildProfileMemoryIndex, type ProfileMemoryKind,
} from './profileMemory';
import { rememberWithConsolidation } from './profileMemoryConsolidation';
import { memoryEntryLabel } from './memoryTopics';
import { getUserProfile } from '../infrastructure/dbService';
import { checkProfileBiasPromotionEligibility } from './candidateRuleLoop';

const COUNTER_KEY = 'trader_learner_counter_v1';
const TOGGLE_KEY = 'trader_learning_v1';
const EVERY_SESSIONS = 2;
const MIN_TRANSCRIPT_CHARS = 200;

export const isTraderLearningEnabled = (username = getActiveUsername()): boolean => {
    try { return localStorage.getItem(`${TOGGLE_KEY}:${username}`) !== '0'; } catch { return true; }
};

export const setTraderLearningEnabled = (on: boolean, username = getActiveUsername()): void => {
    try { localStorage.setItem(`${TOGGLE_KEY}:${username}`, on ? '1' : '0'); } catch { /* noop */ }
};

/** Bump the per-user session counter; true when a learn pass is due. */
export const recordSessionForLearning = (username: string, every = EVERY_SESSIONS): boolean => {
    try {
        const key = `${COUNTER_KEY}:${username}`;
        const n = Number(localStorage.getItem(key) || '0') + 1;
        if (n >= every) {
            localStorage.setItem(key, '0');
            return true;
        }
        localStorage.setItem(key, String(n));
        return false;
    } catch {
        return false;
    }
};

const LearnedFactSchema = z.object({
    name: z.string().min(3).max(60),
    description: z.string().min(10).max(160),
    kind: z.string(),
    body: z.string().min(10).max(1_000),
    /** The display category. Free-form so the learner can create trading
     *  categories the fixed subject set does not name. */
    section: z.string().min(2).max(40).optional(),
    /** For a BEHAVIORAL RULE ("when X, avoid Y") only: the facts that were
     *  knowable BEFORE the entry, so the promotion gate can refuse a rule
     *  whose support is a post-entry price path. */
    knowableAtEntry: z.array(z.string()).max(6).optional(),
});

export type LearnedFact = z.infer<typeof LearnedFactSchema>;

const LEARNER_PROMPT = (transcript: string, existingIndex: string): string => [
    'From this trading-app conversation, extract DURABLE facts about the TRADER — the kind of thing that should shape every future collaboration.',
    'Look for: preferred symbols/timeframes/session times; risk habits (sizing, stop discipline, leverage comfort); recurring mistakes THEY make; strategy preferences; how they like answers delivered (concise vs deep, numbers-first, warnings wanted…).',
    'Rules:',
    '- Only durable facts: explicitly stated, or clearly repeated. One-off price talk is NOT a fact.',
    '- For a BEHAVIORAL RULE about the trader ("when X, do/skip/avoid Y"), also return `knowableAtEntry`: the observations that were knowable BEFORE the entry (regime, session, plan state) — never anything read off the post-entry price path. A rule whose support is hindsight will be refused.',
    '- Facts about the TRADER, never market lessons (those live in the skill system) and never any keys/codes.',
    '- Update-not-duplicate: skip a fact whose slug+description already exists below unless it genuinely changed.',
    '- Every fact carries a `section`: reuse one from the SECTIONS line in ALREADY KNOWN when it fits, or create a concise trading category (e.g. Trading, Risk, Instruments, Psychology, Process, Session). Reuse the same spelling for the same kind of fact.',
    '- 0 to 3 facts per pass. Fewer, better.',
    'Return ONLY a JSON array of {"name":"short kebab-name","description":"one line ≤140 chars","kind":"user|feedback|project|reference","section":"Trading|Risk|Instruments|Psychology|Process|Session|<a new concise category>","body":"the fact (markdown)"} — [] when nothing durable surfaced.',
    '',
    existingIndex ? `ALREADY KNOWN:\n${existingIndex}` : 'ALREADY KNOWN: (nothing yet)',
    '',
    'RECENT CONVERSATIONS:',
    transcript.slice(-12_000),
].join('\n');

/** One learner pass: distill durable trader facts from recent sessions into
 *  profileMemory. Returns how many entries were written. Never throws. */
export const runTraderLearner = async (
    username: string,
    config: ProviderConfig,
    transcripts: string[],
): Promise<number> => {
    if (!isTraderLearningEnabled(username)) return 0;
    // The learner is a memory writer, so the memory switch is its gate too.
    // It ran behind its own toggle only, which meant a trader who turned
    // memory OFF still had facts distilled and stored (the 2026-10-27 audit M-2's
    // sibling). A profile that cannot be read falls through to the old
    // default-on behaviour rather than silently disabling learning.
    try {
        const profile = await getUserProfile(username);
        if (profile?.settings?.isGlobalMemoryEnabled === false) return 0;
    } catch { /* no readable profile: keep the learner's own toggle */ }
    const flat = transcripts.join('\n\n').trim();
    // Length + toggle checks come BEFORE the counter bump, so a tiny or
    // disabled session never consumes the every-2 cadence.
    if (flat.length < MIN_TRANSCRIPT_CHARS) return 0;
    if (!recordSessionForLearning(username)) return 0;
    const existing = buildProfileMemoryIndex(username);
    try {
        const raw = await sendChatRequest(
            config,
            [{ role: 'user', content: LEARNER_PROMPT(flat, existing) } as ChatMessage],
            { maxTokens: TASK_BUDGETS.chat, temperature: 0.2, reasoningEffort: effortForTask('postMortem') },
        );
        const parsed = extractAndParseJson(raw);
        const arr = Array.isArray(parsed) ? parsed : (parsed?.facts ?? []);
        if (!Array.isArray(arr)) return 0;
        const known = new Set(listProfileMemories(username).map(e => `${e.slug}|${e.description.toLowerCase()}`));
        let written = 0;
        for (const item of arr.slice(0, 3)) {
            const fact = LearnedFactSchema.safeParse(item);
            if (!fact.success) continue;
            const slug = slugify(fact.data.name);
            if (!slug) continue;
            if (known.has(`${slug}|${fact.data.description.toLowerCase()}`)) continue; // no churn
            const kind: ProfileMemoryKind = normalizeKind(fact.data.kind) ?? 'user';
            // The SAME gate the `remember` tool runs, on the path nobody presses.
            // The learner used to store whatever the model distilled with no
            // classification and no setting check, so a health/finances/identity
            // fact could be written unflagged and then advertised in the index
            // every seat reads (the 2026-10-27 audit M-2). A refused fact is dropped; a
            // sensitive one is stored FLAGGED, and only when the trader allows
            // sensitive memory at all.
            const { filterMemoryWrite } = await import('../../utils/memoryWriteFilters');
            const { getHarnessSettings } = await import('../../utils/harnessSettings');
            const verdict = filterMemoryWrite(`${fact.data.description}
${fact.data.body}`);
            if (verdict.refused) continue;
            if (verdict.sensitive && getHarnessSettings().sensitiveMemoryEnabled !== true) continue;
            // A behavioral rule distilled from OBSERVED sessions is a
            // persistent trader-profile BIAS promotion, and it goes through
            // the same gate a rule proposal does: >=3 evidence items across
            // >=3 distinct sessions, hindsight-free (knowable at entry), and
            // trader confirmation when it touches risk rules. The transcripts
            // this pass ran on ARE the evidence — each one a distinct
            // session's review. A refused promotion is a dropped fact, not an
            // error: the trader states a risk rule themselves (tag 'stated')
            // or confirms it on a rule card.
            const biasText = `${fact.data.description}
${fact.data.body}`;
            const biasShaped = /\b(?:when|whenever|always|never|avoid|until|instead of|cap|risk|stop|size|leverage)\b/i.test(biasText);
            if (biasShaped) {
                const affectsRiskRules = /\b(?:risk|stop|size|sizing|leverage|guardrail)\b/i.test(biasText);
                const promotion = checkProfileBiasPromotionEligibility({
                    evidenceIds: transcripts.map((_, i) => `session-${i}`),
                    sessionIds: transcripts.map((_, i) => `session-${i}`),
                    biasStatement: biasText,
                    knowableAtEntry: fact.data.knowableAtEntry ?? [],
                    ...(affectsRiskRules ? { affectsRiskRules: true, traderConfirmed: false } : {}),
                });
                if (!promotion.ok) continue;
            }
            const saved = await rememberWithConsolidation({
                slug, name: fact.data.name,
                // The learner's name is a kebab id; the row label is what a
                // reader sees, so it is humanized once, here.
                title: memoryEntryLabel(fact.data.name),
                description: fact.data.description,
                kind,
                body: fact.data.body,
                source: 'auto',
                tag: 'observed',
                ...(fact.data.section ? { section: fact.data.section } : {}),
                ...(verdict.sensitive ? { sensitive: true } : {}),
            }, { username });
            if (saved.ok && !('conflict' in saved.result) && saved.result.persisted !== false) written += 1;
        }
        return written;
    } catch (e) {
        console.warn('[TraderLearner] pass failed:', e);
        return 0;
    }
};
