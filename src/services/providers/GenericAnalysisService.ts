/**
 * GenericAnalysisService — Consolidated analysis service parameterized by ProviderConfig.
 *
 * Replaces the 9 per-provider main services + 9 accuracy services. All AI calls
 * route through GenericProviderService (no per-provider clients, no process.env keys).
 *
 * `analyzeTradingView` unifies the standard-mode and accuracy-mode prompt paths
 * via composePrompt (contract once + this-turn job + extras).
 */

import { ProviderConfig } from '../../types/provider';
import { Message, GroundingChunk, TradeAnalysis, GlobalMemory, TradeOutcome, LoggedTrade, StrategySearchResult, TradeSummary, MessageRole } from '../../types';
import { extractAndParseJson, extractLastJson } from '../../utils/jsonUtils';
import { sanitizeAIResponse, sanitizeAIResponseLight, sanitizeJSONString } from '../../utils/sanitizers';
import { sanitizeTradeAnalysis, truncateTextToTokens, formatAnalysisForDisplay, parsePrice } from '../../utils/analysisUtils';
import { splitThinkingFromOutput, extractAndStripThinkBlocks, createThinkingStreamGate } from '../../utils/thinkingSplit';
import { CASUAL_CHAT_SYSTEM_PROMPT } from '../../constants/prompts/chatPrompts';
import { buildTradeInsightBrief, compactInsightForPatternMemory } from '../../utils/tradeInsightBrief';
import { parseGlobalMemory, parseStrategySearchResults } from '../../schemas/learning';
import { MASTER_ANALYSIS_PROMPT, COMPACT_ANALYSIS_PROMPT, RISK_MANAGEMENT_RULES, AI_PROVIDER_MEMORY_ENFORCEMENT_PROMPT, HARNESS_CONTRACT_PROMPT } from '../../constants/prompts';
import { constructOptimizedContext } from '../../utils/memoryUtils';
import { parseLiveMarketData } from '../../utils/liveMarketParser';
import {
    sendChatRequest, streamChatRequest, ChatMessage, ContentPart, ChatRequestOptions,
} from './GenericProviderService';
import { TASK_BUDGETS } from './taskBudgets';
import { EFFORT_BY_TASK, effortForTask, resolveComposerEffort, WireAuditEntry, type ReasoningEffort } from './reasoningControls';
import { getPrompt } from '../infrastructure/PromptOverrideService';
import { composePrompt } from '../../utils/composePrompt';
import { clipNote } from '../../utils/harnessMarks';
import { getHarnessSettings } from '../../utils/harnessSettings';
import { DESK_TOOLS_PROMPT, TEXT_TOOL_FALLBACK_PROMPT, resolveDefaultSymbol } from '../analysis/deskToolShared';

import { isVisionModel } from '../../utils/modelUtils';
import type { ToolAction } from '../../types/message';

// ─── Helpers ────────────────────────────────────────────────────────────────

const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
});

/** Small-context models need aggressively truncated prompts. */
function isSmallContextModel(modelId: string): boolean {
    const m = modelId.toLowerCase();
    return m.includes('kimi') || m.includes('gpt-oss-20b') || m.includes('mistral-7b');
}

/**
 * Remove legacy XML tags and standalone label headers from text destined for
 * display, so historical/cached responses never show format scaffolding.
 */
function stripTagArtifacts(text: string): string {
    return text
        .replace(/<THINKING>[\s\S]*?<\/THINKING>/gi, '')
        .replace(/<FINAL_OUTPUT>[\s\S]*?<\/FINAL_OUTPUT>/gi, '')
        .replace(/<\/?(?:THINKING|FINAL_OUTPUT)>/gi, '')
        .replace(/^\s*(?:\*\*)?(?:THINKING|FINAL OUTPUT|FINAL_OUTPUT)(?:\*\*)?\s*:?\s*$/gim, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ─── Analyst structured-plan extraction ─────────────────────────────────────
// Analysts write readable prose (the prompts forbid JSON), but every
// structured consumer downstream — per-analyst Monte Carlo, the consensus
// panel, pre-debate divergence detection, Bayesian calibration, and the
// Gate's confidence-conflict challenge — keys on
// analysis.entryPoints/stopLoss/takeProfit/probability. Before this parser
// existed the pipeline stored a hardcoded Neutral/Low placeholder per
// analyst, silently killing all of those consumers. This mines the fields
// out of the prose: labeled values first (Direction / Entry / Stop Loss /
// Probability), then a TRADE PLAN BLOCK if a model still emits one. Prompts
// no longer mandate that block — a fabricated N/A pad is worse than omitting
// a field.

export interface ParsedTradePlan {
    direction?: 'Long' | 'Short' | 'Neutral';
    entryPoints?: string[];
    stopLoss?: string;
    takeProfit?: string[];
    probability?: number;
    confidence?: 'High' | 'Medium' | 'Low' | 'Avoid';
}

/** Price tokens out of a labeled line: "94,500 – 94,800 (limit)" → ["94,500","94,800"]. */
const priceTokens = (line: string): string[] =>
    (line.match(/\d[\d,]*(?:\.\d+)?/g) || []).filter(t => t !== '');

const firstPriceToken = (line: string): string | undefined => priceTokens(line)[0];

/**
 * Value after a labeled line: the inline capture, or the NEXT line when the
 * label ends with the colon — the lens prompts put the value on the
 * following line ("**Optimal Entry Zone:**\n$93,800 to $94,200").
 */
const labeledValue = (text: string, match: RegExpMatchArray | null, group = 1): string => {
    if (!match) return '';
    const inline = (match[group] ?? '').trim();
    if (inline) return inline;
    const rest = text.slice((match.index ?? 0) + match[0].length);
    return rest.split('\n')[0].trim();
};

export const extractStructuredPlanFromProse = (text: string): ParsedTradePlan => {
    if (!text) return {};
    const plan: ParsedTradePlan = {};

    // --- Direction: labeled forms first ("Direction:", "MACRO BIAS:",
    // "TECHNICAL BIAS:", "VERDICT:", "Bias:"), then explicit ALL-CAPS
    // LONG/SHORT (lens roles write "TECHNICAL BIAS: LONG"). Labels may be
    // markdown-bolded with the COLON INSIDE the markers ("**MACRO
    // VERDICT:** Bullish") — the \*{0,2} bridges on both sides of the colon
    // see through that. Bare lowercase "bullish"/"bearish" in prose is
    // never enough — sentence noise. A label whose line lists competing
    // options ("LONG / SHORT / NO TRADE") means the model echoed the
    // template — no verdict.
    const dirLabel = text.match(/Direction\s*\*{0,2}\s*:\s*\*{0,2}\s*(Long|Short|Neutral|Bullish|Bearish|Buy|Sell)/i)
        || text.match(/(?:MACRO|TECHNICAL|FINAL|TRADE|TOTAL)\s*(?:BIAS|VERDICT|RECOMMENDATION|OUTLOOK)\s*\*{0,2}\s*:\s*\*{0,2}\s*(?:(?:STRONG|WEAK|CONFIRMED)\s+)?(Long|Short|Neutral|Bullish|Bearish|Buy|Sell|NO\s*TRADE)/i)
        || text.match(/(?:Bias|Verdict|Outlook|Thesis|Recommendation)\s*\*{0,2}\s*:\s*\*{0,2}\s*(Long|Short|Neutral|Bullish|Bearish|Buy|Sell|NO\s*TRADE)/i);
    if (dirLabel) {
        const word = dirLabel[1].toLowerCase();
        const mapped = word.includes('long') || word.includes('bull') || word.includes('buy')
            ? 'Long'
            : word.includes('short') || word.includes('bear') || word.includes('sell') ? 'Short' : 'Neutral';
        const labelEnd = (dirLabel.index ?? 0) + dirLabel[0].length;
        const lineEnd = text.indexOf('\n', labelEnd);
        const labelLine = text.slice(labelEnd, lineEnd === -1 ? text.length : lineEnd);
        // Echo detection: the template prints "Long/Short/Neutral" (lowercase,
        // slash-separated) — the old case-sensitive single-word check never
        // caught it, so a literal template echo parsed as a real verdict.
        // A line listing ≥2 distinct options means the model echoed the
        // template, not a decision.
        const optionWords = ['LONG', 'SHORT', 'NEUTRAL', 'NO TRADE'];
        const echoedCount = optionWords.filter(w =>
            new RegExp(w.replace(' ', '\\s+'), 'i').test(labelLine)
        ).length;
        const echoedOptions = echoedCount >= 2;
        if (!echoedOptions) plan.direction = mapped;
    }
    if (!plan.direction) {
        const explicitLong = /\bLONG\b/.test(text);
        const explicitShort = /\bSHORT\b/.test(text);
        if (explicitLong !== explicitShort) plan.direction = explicitLong ? 'Long' : 'Short';
    }

    // --- Entry (single price or zone — both survive parsePrice; the value
    // may sit on the next line, see labeledValue) ---
    const entryLine = text.match(/Entry(?:\s*Zone)?\s*\*{0,2}\s*:\s*\*{0,2}\s*([^\n]*)/i);
    if (entryLine) {
        const entryRaw = labeledValue(text, entryLine);
        if (entryRaw && !/N\/?A/i.test(entryRaw)) {
            const tokens = priceTokens(entryRaw);
            if (tokens.length > 0) {
                plan.entryPoints = [tokens.length > 1 ? `${tokens[0]} - ${tokens[tokens.length - 1]}` : tokens[0]];
            }
        }
    }

    // --- Stop loss ("Stop Loss:", "SL:"; "Stop Loss Percentage:" is
    // deliberately NOT matched — the colon comes after "Percentage"). ---
    const slLine = text.match(/(?:Stop Loss|SL)\s*(?:1)?\s*\*{0,2}\s*:\s*\*{0,2}\s*([^\n]*)/i);
    if (slLine) {
        const slRaw = labeledValue(text, slLine);
        if (slRaw && !/N\/?A/i.test(slRaw)) {
            const sl = firstPriceToken(slRaw);
            if (sl) plan.stopLoss = sl;
        }
    }

    // --- Take profits ("Take Profit 1:", "TP1:") ---
    const tpLines = [...text.matchAll(/(?:Take Profit|TP)\s*(\d)?\s*\*{0,2}\s*:\s*\*{0,2}\s*([^\n]*)/gi)];
    if (tpLines.length > 0) {
        plan.takeProfit = tpLines
            .map(m => {
                const raw = labeledValue(text, m, 2);
                return raw && !/N\/?A/i.test(raw) ? firstPriceToken(raw) : undefined;
            })
            .filter((t): t is string => !!t);
    }

    // --- Probability (the master prompt's "Long Probability %: 65%"; a bare
    // "Probability: 65" too). 1–10 role scales ("MACRO CONFIDENCE: 7") are
    // NOT probabilities and stay unmatched — the schema's confidence path
    // handles those separately. The range-guard rejects a template echo
    // ("<0-100>%") — "100" inside a range must not read as 100%.
    const probMatch = text.match(/Probability\s*\*{0,2}\s*%?\s*:\s*\*{0,2}\s*(?<![-–—])(\d+(?:\.\d+)?)\s*%/i);
    if (probMatch) {
        const p = parseFloat(probMatch[1]);
        if (!isNaN(p) && p > 0 && p <= 100) plan.probability = p;
    }

    // --- Confidence label ("Confidence: High") ---
    const confMatch = text.match(/(?:Confidence|Conviction)\s*\*{0,2}\s*:\s*\*{0,2}\s*(High|Medium|Med|Low|Avoid)/i);
    if (confMatch) {
        // Echo guard: "**Family Confidence:** High / Medium / Low" (a template
        // echo listing multiple options) must not parse as a real label —
        // the old check turned it into confidence='High'.
        const labelEnd = (confMatch.index ?? 0) + confMatch[0].length;
        const lineEnd = text.indexOf('\n', labelEnd);
        const labelLine = text.slice(labelEnd, lineEnd === -1 ? text.length : lineEnd);
        const confOptions = ['HIGH', 'MEDIUM', 'LOW', 'AVOID'];
        const confEchoed = confOptions.filter(w =>
            new RegExp(w, 'i').test(labelLine)
        ).length >= 2;
        if (confEchoed) {
            plan.confidence = undefined;
        } else {
            const c = confMatch[1].toLowerCase();
            plan.confidence = c === 'med' || c === 'medium' ? 'Medium'
                : c === 'high' ? 'High'
                : c === 'low' ? 'Low'
                : c === 'avoid' ? 'Avoid'
                : undefined;
        }
    }

    return plan;
};

// ─── analyzeTradingView ─────────────────────────────────────────────────────

export interface AnalyzeTradingViewParams {
    prompt: string;
    images: File[];
    imageSummaries: string[];
    chatHistory: Message[];
    finalTradeSummary: string | null;       // Pattern Memory (synthesis)
    recentInsights: string | null;          // Recent Insights (individual)
    activeFrameworks: string[];
    deepenAnalysis: boolean;
    globalMemory?: GlobalMemory;
    threadSummary?: string;
    customInstructions?: string;
    /**
     * Summaries of the user's uploaded strategy books (Settings → Strategies),
     * rendered into the system prompt so every analyst persona follows them.
     */
    userStrategies?: string;
    /**
     * User-edited base prompt for Normal mode. Replaces MASTER_ANALYSIS_PROMPT
     * while the appended contract sections (rules, formatting, evidence
     * discipline) stay intact.
     */
    systemPromptOverride?: string;
    /**
     * Per-seat independence directive (ensemble openings, Lenses off).
     * Rendered into the SYSTEM prompt near the front — not appended to the
     * user message — so each seat's payload differs from its first bytes.
     * Free-tier gateways dedupe/cache concurrent near-identical prompts keyed
     * on the payload bulk; a differing tail at the end of a long shared user
     * message does not break those cache keys, a differing system head does.
     */
    seatDirective?: string;
    signal?: AbortSignal;
    /**
     * Sampling temperature. Defaults to 0.35 (pro-trader determinism) when
     * omitted. A caller that runs several seats over one prompt may raise it
     * per seat so they sample differently instead of collapsing to identical
     * output.
     */
    temperature?: number;
    allowedTools?: string[];
    /** Closed-trade journal for the `recall`/`get_setup_history_stats` desk
     *  tools: without it the single-analysis path had desk tools
     *  but no history to recall. */
    trades?: LoggedTrade[];
    onReasoning?: (reasoning: string) => void;
    /** Visible content deltas as they stream — lets the Floor show the
     *  answer (and any untagged thinking) forming live, not just at the end. */
    onPartialOutput?: (chunk: string) => void;
    /** Wire-audit sink (P5) — receives the applied reasoning-route label for
     *  this call so the answer's row can show what the wire received. */
    onWireAudit?: (entry: WireAuditEntry) => void;
    /** model side-effects from this seat's desk-tool loop
     *  (forge_tool / amend_memory / custom_* receipts). */
    onToolAction?: (action: ToolAction) => void;
}

export async function analyzeTradingView(
    config: ProviderConfig,
    params: AnalyzeTradingViewParams
): Promise<{ analysis: TradeAnalysis; thoughtProcess: string; finalOutput: string; sources: GroundingChunk[] }> {
    const {
        prompt, images, imageSummaries, chatHistory, finalTradeSummary, recentInsights,
        activeFrameworks, globalMemory, threadSummary, customInstructions,
        systemPromptOverride, seatDirective, userStrategies, signal, temperature, onReasoning, onPartialOutput, onWireAudit,
    } = params;

    const modelName = config.selectedModel;
    const hasImages = images.length > 0;

    // --- LIVE MARKET DATA PARSING & INJECTION ---
    const parsedMarketData = parseLiveMarketData(prompt);
    let marketDataOverride = "";
    if (parsedMarketData) {
        marketDataOverride = `
    **VERIFIED LIVE MARKET TELEMETRY (HIGHEST PRIORITY):**
    Use this exact data for your analysis. Do NOT output "N/A" for these fields.

    - **Prices:** ${JSON.stringify(parsedMarketData.prices)}
    - **Detected Patterns:** ${JSON.stringify(parsedMarketData.patterns)}
    - **Key Zones:** ${JSON.stringify(parsedMarketData.keyZones)}

    **MANDATORY:** Reference these detected patterns, key zones, and prices in your readable final output.
        `;
    }

    const memoryContext = truncateTextToTokens(constructOptimizedContext(chatHistory, threadSummary, globalMemory), 800);

    const frameworksList = activeFrameworks.map((fw, index) => `${index + 1}. **${fw}**`).join('\n');
    const userStrategiesBlock = userStrategies
        ? `\n**USER STRATEGIES (from uploaded books — follow these when they apply):**\n${userStrategies}`
        : '';
    const imageSummaryContext = imageSummaries.length > 0
        ? `**PRE-PROCESSED VISION ANALYSIS**...\n${imageSummaries.join('\n\n---\n\n')}`
        : "No chart data provided.";

    const userOverride = customInstructions
        ? `\n\n**USER BEHAVIOR OVERRIDE:**\nThe user has provided specific instructions for how you must respond, calculate, and reason. These instructions take precedence over default tone/style settings:\n"${customInstructions}"\n`
        : "";

    const visionDeepDive = hasImages
        ? `**ENHANCED VISION ANALYTICS PROTOCOL:**
           - You have direct access to the high-fidelity chart images.
           - **OCR & TEXT:** Perform a pixel-perfect scan to read all text labels, indicator settings (e.g. RSI 14), timestamps, and price axes.
           - **MICRO-STRUCTURE:** Extract PRECISE price levels, wick behaviors, and hidden liquidity pools from the visual data.
           - **CONTEXT:** If this is a trading terminal screenshot, extract any visible PnL, leverage, or account data.
           - Visually confirm the "Market Classification Family" based on candle structure.`
        : '';

    // --- BUILD SYSTEM PROMPT ---
    // Contract once, then persona/job, then extras. Nested harness copies are stripped.
    // The seat directive sits directly after the contract so seats diverge from
    // the first bytes of the payload (see AnalyzeTradingViewParams.seatDirective).
    const seatBlock = seatDirective
        ? `**INDEPENDENT SEAT DIRECTIVE**\n\n${seatDirective}`
        : '';
    const playbookBlock = frameworksList
        ? `**PLAYBOOK: CORE TRADING FRAMEWORKS**\n${frameworksList}`
        : '';
    const outputContract = `**OUTPUT:** No JSON, XML, restated instructions, section templates, or TRADE PLAN BLOCK. Public reply: the call (direction + key levels), then only the findings that support it. Name prices in the sentences when you have them (Direction, Entry, Stop Loss, Take Profit, Probability: N%). Name an invalidation price. Use retrieved memory only when it matches this setup.`;
    const deskToolsEnabled = getHarnessSettings().deskToolsEnabled && !isSmallContextModel(modelName);
    const deskToolsNative = deskToolsEnabled && config.apiFormat === 'chat_completions';
    const deskToolsBlock = deskToolsEnabled
        ? `${DESK_TOOLS_PROMPT}${deskToolsNative ? '' : TEXT_TOOL_FALLBACK_PROMPT}`
        : '';

    let systemPrompt: string;
    const basePrompt = systemPromptOverride || getPrompt('analysis.master', MASTER_ANALYSIS_PROMPT);
    systemPrompt = composePrompt([
        { id: 'contract', text: HARNESS_CONTRACT_PROMPT },
        { id: 'seat', text: seatBlock },
        { id: 'job', text: basePrompt },
        { id: 'vision', text: visionDeepDive },
        { id: 'memory', text: getPrompt('analysis.memory_enforcement', AI_PROVIDER_MEMORY_ENFORCEMENT_PROMPT) },
        { id: 'override', text: userOverride },
        { id: 'playbook', text: playbookBlock },
        { id: 'strategies', text: userStrategiesBlock },
        { id: 'desk_tools', text: deskToolsBlock },
        { id: 'risk', text: getPrompt('analysis.risk_rules', RISK_MANAGEMENT_RULES) },
        { id: 'output', text: outputContract },
    ]);


    // --- BUILD USER PROMPT ---
    const isLiveMarketData = prompt.includes("**LIVE MARKET DATA**");
    const isHybridIntelligenceData = prompt.includes("HYBRID INTELLIGENCE") || prompt.includes("VERIFIED MARKET DATA");
    const formattedPrompt = (isLiveMarketData || isHybridIntelligenceData)
        ? `User's request:\n${prompt}\n\n`
        : `User's request: "${prompt}"\n\n`;

    let userPromptText: string;
    const patternMemoryContext = finalTradeSummary
        ? truncateTextToTokens(`\n\n**PATTERN MEMORY (SYNTHESIS):**\nUse this only if it matches this coin, direction, or regime:\n${finalTradeSummary}\n`, 600)
        : "\n\n** PATTERN MEMORY:** Use the retrieved harness memory in the user request (skills + similar trades). Do not invent a personal track record.\n";
    const recentInsightsContext = recentInsights
        ? truncateTextToTokens(`\n\n**RECENT INSIGHTS:**\nUse matching closed trades only. Ignore unrelated coins/regimes:\n${recentInsights}\n`, 600)
        : "\n\n** RECENT INSIGHTS:** No recent trade insights available.\n";

    /** One clip for every context block that rides this prompt. The old
     *  form appended a bare "...[truncated]", which let a model read 200
     *  chars of trade history as the whole record — naming what was dropped
     *  and how much is what turns "I have nothing on this setup" into "I
     *  have an excerpt of it". */
    const clipContext = (text: string, kept: number, source: string): string =>
        text.length > kept
            ? `${text.slice(0, kept)} ${clipNote({ source, kept, total: text.length })}`
            : text;

    if (isSmallContextModel(modelName)) {
        const effectiveSystemPrompt = composePrompt([
            { id: 'contract', text: HARNESS_CONTRACT_PROMPT },
            { id: 'job', text: getPrompt('analysis.compact', COMPACT_ANALYSIS_PROMPT) },
        ]);
        const minimalPattern = clipContext(patternMemoryContext, 400, 'pattern memory');
        const minimalInsights = clipContext(recentInsightsContext, 200, 'recent insights');
        const minimalImages = clipContext(imageSummaryContext, 500, 'chart image summaries');
        systemPrompt = effectiveSystemPrompt;
        userPromptText = `${formattedPrompt}\n\n${marketDataOverride}\n\n${minimalImages}\n\n${minimalPattern}\n\n${minimalInsights}\n\nPresent your readable trade proposal.`;
    } else {
        // Capable models get the LARGER budgets — this was inverted (they
        // were cut harder than the small-context branch, defeating the
        // token-level truncation above). Pattern memory & insights are the
        // highest-value context for the trade proposal.
        const truncatedImages = clipContext(imageSummaryContext, 800, 'chart image summaries');
        const truncatedPattern = clipContext(patternMemoryContext, 600, 'pattern memory');
        const truncatedInsights = clipContext(recentInsightsContext, 300, 'recent insights');
        const truncatedMemory = clipContext(memoryContext, 600, 'harness memory');
        userPromptText = `${formattedPrompt}${marketDataOverride}\n\n${truncatedImages}\n\n${truncatedPattern}\n\n${truncatedInsights}\n\n${truncatedMemory}\n\nPresent your readable trade proposal.`;
    }

    // --- BUILD MESSAGES (with optional vision content) ---
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

    const canUseVision = isVisionModel(modelName);
    if (canUseVision && hasImages) {
        const parts: ContentPart[] = [{ type: 'text', text: userPromptText }];
        for (const image of images) {
            const base64 = await fileToBase64(image);
            parts.push({ type: 'image_url', image_url: { url: `data:${image.type};base64,${base64}` } });
        }
        messages.push({ role: 'user', content: parts });
    } else {
        if (hasImages && !canUseVision) {
            console.warn(`Model ${modelName} is not vision-capable, but images were provided. Analyzing based on text summaries only.`);
        }
        messages.push({ role: 'user', content: userPromptText });
    }

    // --- CALL THE GENERIC CLIENT (optional desk-tools loop, then stream) ---
    // Temperature: 0.35 default — pro-trader discipline wants determinism.
    // The analysis is scheduled at high effort. The ensemble that used to
    // pass a per-seat temperature (0.55–0.85) when Lenses were OFF was
    // removed with the debate engine; `temperature` remains the caller's
    // override for this single analysis call, which is why the default is
    // the pro-trader number rather than a sampling spread.
    const options: ChatRequestOptions = { jsonMode: false, maxTokens: TASK_BUDGETS.analysis, temperature: temperature ?? 0.35, signal, onReasoning, reasoningEffort: effortForTask('analysis'), onWireAudit };
    let responseText = '';
    let reasoningAccumulated = '';
    try {
        // LAZY: the desk whale loads on the first tool turn, not at boot
        // (O-146 — the entry chunk carries it no longer).
        const { streamChatWithDeskTools } = await import('../analysis/DeskToolsService');
        for await (const chunk of streamChatWithDeskTools(config, messages, {
            ...options,
            enabled: deskToolsEnabled,
            allowedTools: params.allowedTools,
            trades: params.trades,
            defaultSymbol: resolveDefaultSymbol(prompt, marketDataOverride),
            afterToolsNudge: 'Tool results are above. Write the public Floor reply now from the findings. No JSON, no tool tags.',
            onToolAction: action => params.onToolAction?.(action),
            onReasoning: (reasoning: string) => {
                reasoningAccumulated += reasoning;
                options.onReasoning?.(reasoning);
            },
        })) {
            if (chunk) {
                responseText += chunk;
                onPartialOutput?.(chunk);
            }
        }
    } catch (error) {
        console.error(`${config.name} analysis streaming failed:`, error);
        throw error;
    }
    if (!responseText && !reasoningAccumulated) throw new Error("Received an empty response from the AI.");

    try {
        const split = splitThinkingFromOutput(reasoningAccumulated, responseText);
        let thoughtProcess = sanitizeAIResponseLight(split.thinking);
        let finalOutput = sanitizeAIResponseLight(split.output);

        const tryFormatJsonPlan = (raw: string): boolean => {
            try {
                const json = extractAndParseJson(raw);
                if (!json || typeof json !== 'object') return false;
                const jsonThought = typeof json.thoughtProcess === 'string'
                    ? sanitizeAIResponseLight(json.thoughtProcess)
                    : '';
                const analysisObj = json.analysis && typeof json.analysis === 'object' ? json.analysis : json;
                const isTradePlan = typeof analysisObj.coinName === 'string' || typeof analysisObj.direction === 'string';
                if (!thoughtProcess && jsonThought) thoughtProcess = jsonThought;
                if (isTradePlan) {
                    finalOutput = formatAnalysisForDisplay(analysisObj);
                    return true;
                }
            } catch {
                return false;
            }
            return false;
        };

        if (!finalOutput || /^\s*\{/.test(finalOutput) || (!thoughtProcess && /^\s*\{/.test(responseText))) {
            tryFormatJsonPlan(finalOutput || responseText || reasoningAccumulated);
        }
        if (thoughtProcess && finalOutput && thoughtProcess.trim() !== finalOutput.trim()) {
            const recovered = splitThinkingFromOutput(thoughtProcess, finalOutput);
            thoughtProcess = recovered.thinking || thoughtProcess;
            finalOutput = recovered.output || finalOutput;
        }

        // Analysts deliberately do not produce the structured trade plan as
        // JSON — but their prose is mined for the setup fields so the
        // per-analyst Monte Carlo, consensus panel, divergence detection and
        // Bayesian calibration all receive real data instead of the old
        // hardcoded Neutral/Low placeholder (which silently dead-coded every
        // one of those consumers).
        const parsedPlan = extractStructuredPlanFromProse(finalOutput);
        const analysis: TradeAnalysis = sanitizeTradeAnalysis({
            direction: parsedPlan.direction,
            confidence: parsedPlan.confidence,
            probability: parsedPlan.probability,
            entryPoints: parsedPlan.entryPoints?.map(price => ({ price, description: '' })) ?? [],
            stopLoss: parsedPlan.stopLoss,
            takeProfit: parsedPlan.takeProfit?.map(price => ({ price, percentage: '' })) ?? [],
            strategy: finalOutput,
        });

        analysis.activeStrategies = Array.isArray(analysis.activeStrategies) ? analysis.activeStrategies : [];
        analysis.stopLoss = sanitizeJSONString(analysis.stopLoss);
        analysis.takeProfit = Array.isArray(analysis.takeProfit)
            ? analysis.takeProfit.map(tp => ({ price: sanitizeJSONString(String(tp.price || '')), percentage: sanitizeJSONString(String(tp.percentage || '')) })).filter(tp => tp.price)
            : [];
        analysis.entryPoints = Array.isArray(analysis.entryPoints)
            ? analysis.entryPoints.map(ep => ({ description: sanitizeJSONString(String(ep.description || '')), price: sanitizeJSONString(String(ep.price || '')) })).filter(ep => ep.price)
            : [];
        analysis.createdAt = new Date().toISOString();

        return { analysis, thoughtProcess, finalOutput, sources: [] };
    } catch (error) {
        console.error(`${config.name} analysis JSON parsing failed:`, error, "Response:", responseText);
        throw new Error("Failed to parse the trading analysis from the AI response.", { cause: error });
    }
}

// ─── getQuickResponse ───────────────────────────────────────────────────────

/**
 * The empty-visible fallback. A reasoning model can burn the whole chat
 * token budget inside its chain of thought and stream ZERO visible text —
 * the stream completes cleanly, so no provider error fires, but "could not
 * generate a response" is a lie: it generated a lot, we just starved the
 * answer. When reasoning arrived, say so — it names the real fix.
 */
const emptyVisibleFallback = (reasoningSeen: boolean): string =>
    reasoningSeen
        ? '(The model spent its entire reply budget on hidden reasoning and never produced an answer — pick a lighter-thinking model or raise the chat budget.)'
        : 'I am sorry, I could not generate a response.';

export async function getQuickResponse(
    config: ProviderConfig,
    prompt: string,
    history: Message[],
    systemInstruction?: string,
    signal?: AbortSignal,
    onReasoning?: (reasoning: string) => void
): Promise<string> {
    const messages: ChatMessage[] = (history || []).map(m => ({
        role: m.role === MessageRole.AI ? 'assistant' : m.role === MessageRole.SYSTEM ? 'system' : 'user',
        content: m.text,
    }));
    messages.unshift({ role: 'system', content: systemInstruction || CASUAL_CHAT_SYSTEM_PROMPT });
    // Callers pass the current user message as part of `history`; avoid sending the same prompt twice.
    if (messages[messages.length - 1]?.content !== prompt) {
        messages.push({ role: 'user', content: prompt });
    }

    let reasoningSeen = false;
    const noteReasoning = (reasoning: string): void => {
        if (reasoning.trim()) reasoningSeen = true;
        onReasoning?.(reasoning);
    };
    const result = await sendChatRequest(config, messages, { maxTokens: TASK_BUDGETS.chat, signal, onReasoning: noteReasoning, reasoningEffort: effortForTask('chat') });
    // Defensive: some apiFormats leave  bodies in the final content.
    // Strip them here (idempotent — chat_completions already peeled them via
    // splitChatContent) and route any leftover to the reasoning side channel
    // so the bubble's Thinking row owns it instead of the visible reply.
    const stripped = extractAndStripThinkBlocks(result || '');
    if (stripped.leaked.trim()) noteReasoning(stripped.leaked);
    // Chat replies render via MarkdownRenderer — the light sanitizer keeps the
    // model's markdown (bold/lists/code) instead of flattening it to plain text.
    return sanitizeAIResponseLight(stripped.visible || emptyVisibleFallback(reasoningSeen));
}

/**
 * Streaming casual-chat reply (perceived speed). Same contract
 * as getQuickResponse, but visible deltas are pushed to `onChunk` as they
 * arrive so the bubble renders incrementally instead of appearing all at once
 * after completion. Reasoning deltas still flow through `onReasoning`. The
 * transport already routes think-tag bodies to the reasoning side channel, so
 * the accumulated visible text is clean; a final strip is a safety net.
 *
 * `effort` is LAST and optional: every existing caller passes positionals only
 * and a chat turn that never names a tier must keep sending the task default
 * (`effortForTask('chat')`), not a new one. It exists because the composer's
 * dial was previously honored by the dock's seat turn and ignored here, so the
 * same chip on the Agents surface changed nothing on the wire — and a control
 * that changes nothing is worse than no control.
 */
export async function streamQuickResponse(
    config: ProviderConfig,
    prompt: string,
    history: Message[],
    systemInstruction?: string,
    signal?: AbortSignal,
    onReasoning?: (reasoning: string) => void,
    onChunk?: (visibleDelta: string) => void,
    effort?: ReasoningEffort
): Promise<string> {
    const messages: ChatMessage[] = (history || []).map(m => ({
        role: m.role === MessageRole.AI ? 'assistant' : m.role === MessageRole.SYSTEM ? 'system' : 'user',
        content: m.text,
    }));
    messages.unshift({ role: 'system', content: systemInstruction || CASUAL_CHAT_SYSTEM_PROMPT });
    if (messages[messages.length - 1]?.content !== prompt) {
        messages.push({ role: 'user', content: prompt });
    }

    let visible = '';
    let reasoningSeen = false;
    const noteReasoning = (reasoning: string): void => {
        if (reasoning.trim()) reasoningSeen = true;
        onReasoning?.(reasoning);
    };
    // One streaming pass into `visible` with a given output budget.
    // Double safety net: chat_completions already gates think-tag bodies into
    // the reasoning channel at the transport, but other apiFormats (and the
    // Electron non-streaming path) can still leak them into content. Gating
    // here guarantees the live bubble never shows scratchpad markup.
    const pump = async (maxTokens: number): Promise<void> => {
        const gate = createThinkingStreamGate();
        for await (const chunk of streamChatRequest(config, messages, {
            maxTokens,
            signal,
            onReasoning: noteReasoning,
            reasoningEffort: resolveComposerEffort(effort),
            // A history this app shortened to fit the model's window is said in
            // the thinking channel, which this surface already shows. NOT routed
            // through `noteReasoning`: that flag decides whether the empty-reply
            // retry runs, and a compaction line is not the model having thought.
            onContextCompact: line => onReasoning?.(`\n${line}\n`),
        })) {
            if (!chunk) continue;
            const gated = gate.push(chunk);
            if (gated.thinking) noteReasoning(gated.thinking);
            if (gated.visible) {
                visible += gated.visible;
                onChunk?.(gated.visible);
            }
        }
        const flushed = gate.flush();
        if (flushed.thinking) noteReasoning(flushed.thinking);
        if (flushed.visible) {
            visible += flushed.visible;
            onChunk?.(flushed.visible);
        }
    };
    await pump(TASK_BUDGETS.chat);
    // A reasoning model can burn the ENTIRE chat budget inside its chain of
    // thought and finish cleanly with zero visible text — the stream worked,
    // the answer didn't exist. One retry with a doubled budget so the reply
    // actually lands (only on this exact empty-visible-after-reasoning case,
    // never on aborts, so cost stays bounded).
    if (!visible.trim() && reasoningSeen && !signal?.aborted) {
        console.warn('[streamQuickResponse] reasoning consumed the chat budget — retrying once with doubled maxTokens');
        await pump(TASK_BUDGETS.chat * 2);
    }
    const stripped = extractAndStripThinkBlocks(visible || '');
    if (stripped.leaked.trim()) noteReasoning(stripped.leaked);
    return sanitizeAIResponseLight(stripped.visible || emptyVisibleFallback(reasoningSeen));
}

// ─── summarizeChartImage (vision/OCR) ───────────────────────────────────────

export async function summarizeChartImage(
    config: ProviderConfig,
    image: File,
    chartNumber: number,
    signal?: AbortSignal
): Promise<{ uiSummary: string; fullSummary: string }> {
    try {
        const base64Image = await fileToBase64(image);

        const prompt = `You are a state-of-the-art Computer Vision & OCR engine for financial markets.
        **MODE: ENHANCED VISION STRUCTURING ENABLED**
        Your task is to analyze Chart ${chartNumber}, discard irrelevant OCR noise, and produce a highly structured data report.

        **STRICT OUTPUT FORMAT:**

        1. Chart Metadata
        Timeframe: [Value]
        Asset: [Value]
        Exchange: [Value]
        Chart Type: [Value]

        2. Price & Trend
        Current Price: [Value]
        24h High: [Value]
        24h Low: [Value]
        Trend Summary: [Value]

        3. Indicators
        Moving Averages
        MA5: [Value]
        MA10: [Value]
        MA20: [Value]
        MA30: [Value]
        MA60: [Value]
        MA200: [Value]

        EMA
        EMA5: [Value]
        EMA13: [Value]
        EMA20: [Value]
        EMA200: [Value]

        Bollinger Bands
        BOLL Middle: [Value]
        BOLL Upper: [Value]
        BOLL Lower: [Value]

        Volume
        Volume: [Value]
        Volume Trend: [Value]

        RSI
        RSI1: [Value]
        RSI2: [Value]
        RSI3: [Value]

        MACD
        MACD DIF: [Value]
        MACD DEA: [Value]
        MACD Histogram: [Value]

        Stochastic
        Stoch K: [Value]
        Stoch D: [Value]
        Stoch J: [Value]

        4. Market Structure
        Immediate Resistance: [Value]
        Immediate Support: [Value]
        Strong Support Zones: [Value]
        Trend Context: [Value]

        5. Candle Pattern Recognition
        Latest Candle: [Value] (e.g., Doji, Hammer, Marubozu)
        Pattern Detected: [Value] (e.g., Bullish Engulfing, Morning Star, None)
        Candle Position: [Value] (e.g., At Support, In Consolidation)
        Remaining Time: [Value]

        6. Chart Narrative
        Narrative: [A 2-3 sentence description of what is happening in the chart. Describe the current price action, trend behavior, and any notable patterns or formations visible. Example: "Price is consolidating near resistance after a strong bullish move. The last 3 candles show indecision with small bodies and long wicks, suggesting a potential reversal or breakout."]

        **INSTRUCTIONS:**
        - Extract exact numbers where visible.
        - Look specifically for the specific candlestick shape of the last 1-3 candles.
        - If a field is not visible or applicable, write "N/A".
        - Do not mix sections.
        - Keep descriptions concise.
        `;

        const messages: ChatMessage[] = [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${image.type};base64,${base64Image}` } },
            ],
        }];

        const fullSummary = await sendChatRequest(config, messages, { maxTokens: TASK_BUDGETS.ocr, signal, reasoningEffort: effortForTask('ocr') });

        const timeframeMatch = fullSummary.match(/Timeframe:\s*(.*?)(?:\n|$)/i);
        const priceMatch = fullSummary.match(/(?:Current )?Price:\s*(.*?)(?:\n|$)/i);
        const patternMatch = fullSummary.match(/Pattern Detected:\s*(.*?)(?:\n|$)/i);

        const timeframe = timeframeMatch ? timeframeMatch[1].trim().replace(/['"]/g, '') : 'N/A';
        let price = priceMatch ? priceMatch[1].trim().replace(/['"]/g, '') : 'N/A';
        let pattern = patternMatch ? patternMatch[1].trim().replace(/['"]/g, '') : '';

        if (price !== 'N/A') {
            const numericPrice = parsePrice(price);
            if (!isNaN(numericPrice)) {
                price = `₮${numericPrice}`;
            } else {
                price = 'N/A';
            }
        }

        if (pattern === 'N/A' || pattern === 'None') pattern = '';

        let uiSummary = `Chart ${chartNumber} | ${timeframe} | ${price}`;
        if (pattern) {
            uiSummary += ` | ${pattern}`;
        }

        return { uiSummary, fullSummary };
    } catch (error) {
        console.error(`Error in ${config.name} summarizeChartImage:`, error);
        return {
            uiSummary: `Chart ${chartNumber} | Error | N/A`,
            fullSummary: `Chart ${chartNumber} Vision Analysis Failed: ${(error as Error).message}`
        };
    }
}

// ─── Strategy helpers ───────────────────────────────────────────────────────

export async function searchStrategies(
    config: ProviderConfig,
    query: string,
    activeFrameworks: string[],
    signal?: AbortSignal
): Promise<StrategySearchResult[]> {
    const frameworksList = activeFrameworks.join(', ');
    const prompt = `You are a search engine for a predefined list of trading strategies. Your entire knowledge base is limited to ONLY the following frameworks: [${frameworksList}].

    The user is searching for: "${query}".

    Your task is to:
    1. Find the frameworks from your knowledge base that are the most relevant to the user's query.
    2. For each relevant framework, provide a concise description and rationale.
    3. If no frameworks are relevant, return an empty array.
    4. You are strictly forbidden from suggesting or describing any strategy that is not in the provided list.
    5. Your output must be a single, valid JSON array of objects with keys "name", "description", and "rationale".`;

    const result = await sendChatRequest(config, [{ role: 'user', content: prompt }], { jsonMode: true, signal });
    if (!result) return [];
    try {
        const parsed = extractAndParseJson(result);
        return parseStrategySearchResults(parsed).filter((r) =>
            activeFrameworks.some(fw => fw.toLowerCase() === r.name.toLowerCase())
        );
    } catch (e) {
        console.error(`Failed to parse ${config.name} strategy search results:`, e);
        return [];
    }
}

export async function discoverStrategies(
    config: ProviderConfig,
    chatHistory: Message[],
    activeFrameworks: string[],
    signal?: AbortSignal
): Promise<StrategySearchResult[]> {
    const frameworksList = activeFrameworks.join(', ');
    const historyText = chatHistory.length > 0
        ? chatHistory.slice(-5).map(m => `${m.role}: ${m.text} ${m.imageSummaries?.join('\n') || ''}`).join('\n\n')
        : '';

    const prompt = `You are an AI assistant that suggests relevant trading strategies. Your entire knowledge base is limited to ONLY the following frameworks: [${frameworksList}].

    ${historyText ? `Based on the recent conversation:\n${historyText}\n` : ''}

    Your task is to pick 3 interesting or relevant strategies from the list and provide a concise description and rationale.

    You are strictly forbidden from suggesting any strategy that is not in the provided list. Your output must be a valid JSON array of objects with keys "name", "description", and "rationale".`;

    const result = await sendChatRequest(config, [{ role: 'user', content: prompt }], { jsonMode: true, signal });
    if (!result) return [];
    try {
        const parsed = extractAndParseJson(result) || {};
        const results = Array.isArray(parsed) ? parsed : (parsed.results || parsed.strategies || []);
        return results.filter((r: any) =>
            r.name && typeof r.name === 'string' &&
            activeFrameworks.some(fw => fw.toLowerCase() === r.name.toLowerCase())
        );
    } catch (e) {
        console.error(`Failed to parse ${config.name} strategy discovery results:`, e);
        return [];
    }
}

export async function getStrategyDescription(
    config: ProviderConfig,
    strategyName: string,
    signal?: AbortSignal
): Promise<string> {
    const prompt = `Provide a concise, one-paragraph explanation of the "${strategyName}" trading strategy.`;
    const result = await sendChatRequest(config, [{ role: 'user', content: prompt }], { signal, temperature: 0.25 });
    return sanitizeAIResponse(result || "Failed to retrieve strategy description.");
}

// ─── Memory helpers ─────────────────────────────────────────────────────────

export async function summarizeTrade(
    config: ProviderConfig,
    trade: LoggedTrade,
    signal?: AbortSignal
): Promise<string> {
    const brief = buildTradeInsightBrief(trade);
    const outcome = String(trade.outcome || 'UNKNOWN');

    const prompt = `You are a Master Trading Strategist writing a short post-trade insight — the same forensic standard as a post-mortem debate, in one dense paragraph (not a transcript).

**Outcome to explain: ${outcome}**

Diagnose *why* this trade won, lost, or missed entry. Use only the facts below. Do not invent prices or chart events that are not stated. Prefer crypto % / $ language (never "pips").

**Required contents (max ~180 words, complete sentences):**
1. Header facts: outcome, direction, confidence, family/strategy, entry / SL / TP
2. Causal diagnosis: the technical or execution reason for the outcome (not luck-speak)
3. One IF [condition] THEN [action] rule the desk should apply next time
4. Flags when present: [MISSED WIN - TIGHT SL], [150% ZONE BREACH]

**Trade facts:**
${brief}
`;

    const result = await sendChatRequest(
        config,
        [{ role: 'user', content: prompt }],
        { signal, temperature: 0.25, maxTokens: 700 }
    );
    return sanitizeAIResponse(result || "Summary generation failed.");
}

export async function generateFinalSummary(
    config: ProviderConfig,
    summaries: TradeSummary[],
    charLimit: number = 4000,
    signal?: AbortSignal
): Promise<string> {
    const summariesText = summaries.map(s => `- ${compactInsightForPatternMemory(s.summaryText)}`).join('\n');
    const tradeCount = summaries.length;

    const prompt = `
You are a Pattern Recognition Engine.

You MUST output a summary using EXACTLY the following headings and order:

Executive Summary
Missed Win Analysis
Extended SL Zone Breach Analysis
Pattern Family Performance
Confidence Calibration
Winning Patterns
Failure Patterns
Behavioral Biases
Statistical Tendencies
Actionable Rules
Conclusion

**SPECIAL ATTENTION REQUIRED:**
- **Missed Win Analysis**: Count "[MISSED WIN - TIGHT SL]" trades. Calculate what % of losses were avoidable. Recommend SL adjustments.
- **Extended SL Zone Breach Analysis**: Count "[150% ZONE BREACH]" trades. Were these bad entries or failed thesis?
- **Pattern Family Performance**: Compare Family A/B/C/Omega win rates. Identify best/worst performing families.
- **Confidence Calibration**: Compare High/Medium/Low confidence win rates. Are confidence ratings accurate?

RULES:
- All headings MUST appear exactly as written.
- If a section has no evidence, write exactly "None." (the notebook will drop empty product sections).
- Do not copy or restate skills/*.md or rules/recurring-mistakes.md — point at them in Actionable Rules instead.
- No new headings, no removed headings, no reordering.
- Output must be ~${charLimit} characters.
- Output must be ONE continuous text block.

Analyze the ${tradeCount} historical trades below and generate the summary:

${summariesText}

Return ONLY the structured summary.
`;

    // Reasoning-capable models (DeepSeek-R1, etc.) often prefix the answer
    // with their chain of thought — either inline or because the gateway
    // omits the final content field and the client salvages reasoning as the
    // response text. The answer is the block starting at the LAST
    // "Executive Summary" heading that still contains the other mandated
    // headings. Never store the thinking as pattern memory.
    // maxTokens is raised well above the ~4000-char summary: with the default
    // 4096 tokens, a long reasoning trace can truncate the response BEFORE
    // the answer is emitted, leaving only chain of thought behind.
    const request = (content: string) => sendChatRequest(config, [{ role: 'user', content }], { signal, maxTokens: 8192, temperature: 0.25 });

    let raw = sanitizeAIResponse(await request(prompt) || '');
    let structured = extractStructuredSummary(raw);
    if (!structured) {
        console.warn('[FinalSummary] First attempt returned no structured summary (snippet):', raw.slice(0, 400));
        // One hardened retry: forbid any thinking and demand the first
        // heading up front. Costs one extra call only when the first
        // response was unusable.
        raw = sanitizeAIResponse(await request(`${prompt}\n\nCRITICAL: Do NOT output any reasoning, thinking, or planning. Start your reply directly with the heading "Executive Summary" and output ONLY the structured summary.`) || '');
        structured = extractStructuredSummary(raw);
    }
    if (!structured) {
        console.warn('[FinalSummary] Retry also returned no structured summary (snippet):', raw.slice(0, 400));
        return 'The AI returned its reasoning instead of a structured pattern-memory summary. Regenerate the review to try again.';
    }
    return structured;
}

/**
 * The pattern-memory prompt mandates the exact heading list (see
 * generateFinalSummary). When a reasoning model leaks its chain of thought
 * into the response — inline, or via the reasoning-only fallback in the
 * provider layer — the real answer is the block that starts at the LAST
 * line beginning with the first required heading AND still contains a
 * quorum of the remaining headings (the CoT only *mentions* headings
 * inside prose; the draft emits them as standalone lines).
 *
 * Returns the extracted answer, or null when the response contains no
 * structured answer (pure reasoning / unusable output).
 */
export function extractStructuredSummary(
    response: string,
    headings: string[] = [
        'Executive Summary',
        'Missed Win Analysis',
        'Extended SL Zone Breach Analysis',
        'Pattern Family Performance',
        'Confidence Calibration',
        'Winning Patterns',
        'Failure Patterns',
        'Behavioral Biases',
        'Statistical Tendencies',
        'Actionable Rules',
        'Conclusion',
    ]
): string | null {
    if (!response || typeof response !== 'string') return null;
    const lines = response.split('\n');
    const [firstHeading, ...otherHeadings] = headings;
    if (!firstHeading) return null;

    // Normalize a line for heading comparison: strip leading/trailing
    // markdown decoration and list numbering ("1. ", "1) "). A line is in
    // heading form when it is EXACTLY the heading, or the heading followed
    // by a colon and content on the same line ("Executive Summary: The
    // dataset…"). Prose that merely mentions the heading ("Need 'Executive
    // Summary' include…") never normalizes to it.
    const normalizeHeadingLine = (line: string): string =>
        line
            .replace(/^[\s#>*_\-~`"'«»]+/, '')
            .replace(/^\d+[.)]?\s*/, '')
            .replace(/[\s#>*_\-~`"'«»]+$/, '')
            .trim();

    const isHeadingForm = (normalized: string, heading: string): boolean =>
        normalized === heading.toLowerCase()
        || normalized.startsWith(heading.toLowerCase() + ':');

    // Iterate from the END: the final output of a reasoning model always
    // follows its thinking, so the last candidate is the answer itself.
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!isHeadingForm(normalizeHeadingLine(lines[i]).toLowerCase(), firstHeading)) continue;
        const tail = lines.slice(i);
        const tailNorms = tail.map(l => normalizeHeadingLine(l).toLowerCase());

        // Quorum: a real answer carries most mandated headings as heading
        // lines. A thinking fragment fails unless it literally emitted
        // several heading-form lines.
        const matched = otherHeadings.filter(h =>
            tailNorms.some(n => isHeadingForm(n, h))
        ).length;
        if (matched < 3) continue;

        // The answer always ends with the Conclusion section — require
        // actual content AFTER its heading line. This stops a reasoning-only
        // checklist that trails off at "Conclusion: …" from being stored.
        let lastConclusionIdx = -1;
        for (let j = tail.length - 1; j >= 0; j--) {
            if (isHeadingForm(tailNorms[j], 'Conclusion')) { lastConclusionIdx = j; break; }
        }
        if (lastConclusionIdx === -1) continue;
        if (!tail.slice(lastConclusionIdx + 1).some(l => l.trim().length > 0)) continue;

        return tail.join('\n').trim();
    }
    return null;
}

export async function compressChatHistory(
    config: ProviderConfig,
    messages: Message[],
    currentSummary: string = "",
    signal?: AbortSignal
): Promise<string> {
    const messagesText = messages.map(m => `${m.role}: ${m.text}`).join('\n\n');

    const prompt = `
You are a memory compressor for a trading chat.

**PREVIOUS SUMMARY (LAYER 2):**
${currentSummary || "None"}

**NEW CONTENT TO COMPRESS:**
${messagesText}

**INSTRUCTIONS:**
Merge the new content into the previous summary.
Keep it chronological.
Discard redundant details.
Return ONLY the new compressed summary text.
    `;

    const result = await sendChatRequest(config, [{ role: 'user', content: prompt }], { maxTokens: 2048, signal, temperature: 0.25 });
    return sanitizeAIResponse(result || "Memory compression failed.");
}

