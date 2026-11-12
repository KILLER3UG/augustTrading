
import { Message, GlobalMemory } from '../types';

/**
 * Index-layer memory injection (Batch 5, — the ZCode memory
 * pattern): a tiny always-loaded INDEX instead of the whole GlobalMemory
 * JSON dump. One line per entry with status; full content is fetched
 * on demand through the desk `recall` tool (handleRecallTool). Tokens
 * saved scale with library size; salience goes UP because each seat
 * sees a menu, not a wall.
 *
 * Migration constraint: `familyPerformance` is genuinely read by
 * the model — it stays injected verbatim as computed stats, never demoted
 * to "call recall".
 */
const INDEX_LINE_CAP = 5;      // newest N lines per list section
const INDEX_TOTAL_CAP = 900;   // chars — snapshot-cap discipline 

export const buildGlobalMemoryIndex = (globalMemory: GlobalMemory): string => {
    const lines: string[] = [];

    // familyPerformance: verbatim stats block — MUST stay injected.
    const fams = Object.entries(globalMemory.familyPerformance || {});
    if (fams.length > 0) {
        lines.push('FAMILY PERFORMANCE (win rates by setup family):');
        for (const [family, stat] of fams.slice(0, 8)) lines.push(`- ${family}: ${stat}`);
    }

    if (Array.isArray(globalMemory.globalCorrections) && globalMemory.globalCorrections.length > 0) {
        const total = globalMemory.globalCorrections.length;
        lines.push(`CORRECTIONS (newest ${Math.min(total, INDEX_LINE_CAP)} of ${total}):`);
        for (const c of globalMemory.globalCorrections.slice(0, INDEX_LINE_CAP)) lines.push(`- ${c}`);
    }

    const prefs = globalMemory.userPreferences;
    if (prefs && (prefs.leverageDefault > 0 || (prefs.favoriteAssets || []).length > 0 || prefs.preferredSetup)) {
        const favs = (prefs.favoriteAssets || []).slice(0, 5).join(', ');
        lines.push(`PREFERENCES: leverage default ${prefs.leverageDefault}x${favs ? ` · favorites: ${favs}` : ''}${prefs.preferredSetup ? ` · preferred setup: ${prefs.preferredSetup}` : ''}`);
    }

    // (The frozen GlobalMemory.insightKnowledgeBase is gone: its entries
    // migrated into the notebook's distilled/ folder, which the prompt
    // includes through its own index.)

    if (lines.length === 0) return 'INDEX: empty (no journal history distilled yet).';
    const body = lines.join('\n');
    return body.length > INDEX_TOTAL_CAP ? `${body.slice(0, INDEX_TOTAL_CAP).trimEnd()}\n…` : body;
};

export const constructOptimizedContext = (
    recentMessages: Message[],
    threadSummary: string | undefined,
    globalMemory: GlobalMemory | undefined
): string => {
    let context = "";

    // Layer 3: Global Long-Term Memory — INDEX only. The old
    // JSON.stringify dump scaled with library size and buried the signal;
    // seats pull detail via the recall desk tool when a setup matches.
    if (globalMemory) {
        context += `\n\n**🧠 LAYER 3: GLOBAL MEMORY INDEX (LONG-TERM — detail via the recall tool):**\nMacro-context only; one line per entry. Need the full text of any line? Call recall with its topic.\n${buildGlobalMemoryIndex(globalMemory)}\n`;
    } else {
        context += `\n\n**🧠 LAYER 3: GLOBAL MEMORY:** No global memory initialized yet.\n`;
    }

    // Layer 2: Compressed Conversation Summary - DISABLED to save tokens
    // if (threadSummary) {
    //     context += `\n\n**LAYER 2: CURRENT CONVERSATION SUMMARY**\n${threadSummary}\n`;
    // }

    // Layer 1 is implicitly handled by the message history passed to the API, 
    // but we ensure the prompt knows this is the immediate context.
    context += `\n\n**LAYER 1: IMMEDIATE CONTEXT (Recent Messages)**\nThe messages below are the most recent interactions.\n`;

    return context;
};

