/**
 * providerRequestPolicy — the SINGLE source of truth for provider wire-request
 * policy, shared by all three transports:
 *
 *   · renderer   services/providers/GenericProviderService.ts (bundled by Vite;
 *                served ESM via the interop plugin in vite.config.ts)
 *   · dev proxy  vite.config.ts middleware (Node — direct import)
 *   · desktop    electron/main.cjs (CommonJS — plain require)
 *
 * Why a dependency-free .cjs: main.cjs cannot import TypeScript, the Vite
 * config runs under Node, and the renderer is bundled. Before this module the
 * wire policy was hand-built three times and HAD DRIFTED (Claude thinking-gate
 * regex, budget formula, messages temperature, LAN-HTTP host rules — see
 * .review/deep-dive-2026-09-15.md §"Providers / transport"). The semantics
 * below are the RENDERER's verified-correct behavior; every transport must
 * call these functions instead of re-deriving rules inline.
 *
 * Rules encoded here:
 *  - Extended-thinking gate + effort-scaled budget for Anthropic messages.
 *  - Messages-format temperature: explicit value or 0.7 default, OMITTED when
 *    thinking is active (Anthropic rejects temperature alongside thinking).
 *  - Gemini thinking params (includeThoughts + 8192 budget, unchanged).
 *  - Provider URL host policy: HTTPS only for remote hosts; plain HTTP is
 *    allowed for loopback and RFC1918 private LAN addresses so keyless local
 *    servers (Ollama / LM Studio / llama.cpp) work identically on web, dev
 *    proxy, and the packaged desktop app. The link-local range
 *    (169.254.0.0/16, fe80::/10) is REFUSED OUTRIGHT — it is the cloud
 *    metadata range, not a LAN.
 *  - isLocalBaseUrl — the "keyless = ready" exemption predicate.
 *  - normalizeProviderUrl — validate + strip the endpoint path suffix off a
 *    configured baseUrl (six suffixes; the dev proxy used to strip four, so a
 *    pasted "/v1/messages" base URL normalized differently per transport).
 *  - fetchFollowingSafeRedirects — the ONE redirect-hop policy: follow
 *    redirects manually and re-validate every hop against the URL policy, so
 *    neither the dev proxy nor the main process can be 302'd at an internal
 *    target. Takes the fetch implementation as a parameter (net.fetch on
 *    desktop, global fetch in the vite config) because the POLICY is shared
 *    while the transport is not.
 */

'use strict';
/* global URL, module */
// The project's eslint flat config grants Node globals only to
// electron/**/*.cjs; this file runs under Node (main.cjs require), the config
// loader (vite.config.ts), and the browser (via the vite-plugin interop), so
// the two ambient globals it touches are declared inline.

// ─── Extended thinking (Anthropic messages format) ──────────────────────────

/**
 * Thinking-capable Claude model ids. The `thinking` request block is only
 * valid on these — older Claude models 400 on it — so the gate is model-id
 * based (with a manual per-provider override, `thinkingCapable`). Covers the
 * 3.7 / 4 / 4.5 series AND the 5-series ids; the old proxy-side copies of
 * this regex lacked sonnet-5/opus-5, which silently disabled thinking on
 * desktop/dev for the same model that thinks in the browser. Single copy now.
 */
const EXTENDED_THINKING_MODEL_RE = /claude-(?:3-7|3\.7|sonnet-4|opus-4|haiku-4-5|sonnet-5|opus-5|4-5)/i;

/** Chain-of-thought budget as a fraction of max_tokens (kept below it). */
const THINKING_BUDGET_DEFAULT_FRACTION = 0.35;

/** Budget fraction per requested reasoning-effort tier — the messages
 *  transport has no native effort param, so Low/Medium/High/Max must actually
 *  change the thinking budget or the composer knob does nothing on Claude.
 *  'auto' and unknown tiers keep the historical default fraction. */
const THINKING_BUDGET_FRACTIONS = {
    low: 0.15,
    medium: 0.35,
    high: 0.55,
    max: 0.85,
};

/** Anthropic's own minimum is 1024; below that the block is rejected, and a
 *  request whose whole budget is that small is a connection test, not a
 *  reasoning call. */
const MIN_EFFECTIVE_THINKING_TOKENS = 1024;

/** Messages-format default temperature — matches chat_completions/responses
 *  (Anthropic's own API default is 1.0; leaving it unset made the same task
 *  sample at different values per format and polluted calibration data). */
const ANTHROPIC_DEFAULT_TEMPERATURE = 0.7;

/**
 * Whether a model id (or, secondarily, a provider/display name — helps proxy
 * routes whose model id is generic) is Claude-extended-thinking-capable.
 * `capabilityOverride` is the provider's manual `thinkingCapable` flag:
 * true = force thinking on, false = force off, undefined = decide by regex.
 *
 * @param {string} [modelId]
 * @param {string} [displayName]
 * @param {boolean} [capabilityOverride]
 * @returns {boolean}
 */
function isExtendedThinkingModel(modelId, displayName, capabilityOverride) {
    if (capabilityOverride === true) return true;
    if (capabilityOverride === false) return false;
    if (typeof modelId === 'string' && modelId && EXTENDED_THINKING_MODEL_RE.test(modelId)) return true;
    if (typeof displayName === 'string' && displayName && EXTENDED_THINKING_MODEL_RE.test(displayName)) return true;
    return false;
}

/**
 * Anthropic budget_tokens for a call: effort-scaled, clamped so that
 * MIN_EFFECTIVE_THINKING_TOKENS <= budget <= maxTokens - 1 (Anthropic
 * requires budget_tokens < max_tokens). Callers must only invoke this when
 * maxTokens exceeds the floor (see anthropicShouldSendThinking).
 *
 * @param {number} maxTokens
 * @param {string} [effort] 'low' | 'medium' | 'high' | 'max' | other = default
 * @returns {number}
 */
function claudeThinkingBudgetTokens(maxTokens, effort) {
    const fraction = Object.prototype.hasOwnProperty.call(THINKING_BUDGET_FRACTIONS, effort ?? '')
        ? THINKING_BUDGET_FRACTIONS[effort]
        : THINKING_BUDGET_DEFAULT_FRACTION;
    return Math.min(
        maxTokens - 1,
        Math.max(MIN_EFFECTIVE_THINKING_TOKENS, Math.floor(maxTokens * fraction)),
    );
}

/**
 * Whether to request extended thinking on an Anthropic messages call.
 * Gated on: not JSON mode (structured output and extended thinking are
 * mutually exclusive), the composer's explicit 'off' tier, enough headroom
 * for the 1024 <= budget < max_tokens constraint, and model eligibility
 * (regex list or the manual override).
 *
 * @param {{
 *   modelId?: string,
 *   displayName?: string,
 *   capabilityOverride?: boolean,
 *   maxTokens?: number,
 *   jsonMode?: boolean,
 *   reasoningEffort?: string,
 * }} input
 * @returns {boolean}
 */
function anthropicShouldSendThinking(input) {
    const opts = input || {};
    if (opts.jsonMode) return false;
    // The composer's explicit no-think toggle wins over the model gate.
    if (opts.reasoningEffort === 'off') return false;
    const maxTokens = opts.maxTokens === undefined ? 4096 : opts.maxTokens;
    // Connection tests still pass tiny maxTokens; below the floor thinking
    // is pointless (and budget_tokens could not stay under max_tokens).
    if (!(maxTokens > MIN_EFFECTIVE_THINKING_TOKENS)) return false;
    return isExtendedThinkingModel(opts.modelId, opts.displayName, opts.capabilityOverride);
}

/**
 * The two coupled messages-format body fields: temperature and thinking.
 * Returns the fields the transport must apply:
 *   - thinking active  → `{ temperature: undefined, thinking: {...} }`
 *     (Anthropic 400s on temperature while thinking is enabled),
 *   - otherwise        → `{ temperature: explicit ?? 0.7, thinking: undefined }`.
 *
 * @param {{
 *   modelId?: string,
 *   displayName?: string,
 *   capabilityOverride?: boolean,
 *   maxTokens?: number,
 *   temperature?: number,
 *   jsonMode?: boolean,
 *   reasoningEffort?: string,
 * }} input
 * @returns {{ temperature: number | undefined, thinking: { type: 'enabled', budget_tokens: number } | undefined }}
 */
function anthropicThinkingFields(input) {
    const opts = input || {};
    const maxTokens = opts.maxTokens === undefined ? 4096 : opts.maxTokens;
    const temperature = typeof opts.temperature === 'number' ? opts.temperature : ANTHROPIC_DEFAULT_TEMPERATURE;
    if (!anthropicShouldSendThinking({
        modelId: opts.modelId,
        displayName: opts.displayName,
        capabilityOverride: opts.capabilityOverride,
        maxTokens,
        jsonMode: opts.jsonMode,
        reasoningEffort: opts.reasoningEffort,
    })) {
        return { temperature, thinking: undefined };
    }
    return {
        temperature: undefined,
        thinking: { type: 'enabled', budget_tokens: claudeThinkingBudgetTokens(maxTokens, opts.reasoningEffort) },
    };
}

// ─── Prompt caching (Anthropic messages format) ─────────────────────────────

/**
 * The one cache breakpoint the app places: the system prompt.
 *
 * Anthropic matches caches on an exact prefix and `cache_control` is only
 * valid on a content block — a string `system` cannot carry it. The system
 * prompt is the largest stable part of a desk turn (harness contract + desk
 * mandate + skill index), so it is the breakpoint that pays on rounds 2..N;
 * the conversation after it changes every round and is deliberately unmarked.
 *
 * The system block must stay BYTE-IDENTICAL between the rounds of a turn.
 * Anything that varies per request (a timestamp, a per-turn notice) belongs in
 * the messages array, not here — one changed byte invalidates the prefix.
 * Below the provider's minimum cacheable size this is a no-op, not an error.
 *
 * @param {string} text
 * @returns {Array<{ type: 'text', text: string, cache_control: { type: 'ephemeral' } }> | undefined}
 */
function anthropicCachedSystem(text) {
    if (typeof text !== 'string' || text.length === 0) return undefined;
    return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

/**
 * The EFFECTIVE temperature per (API format × thinking state). This is the
 * one table the app promises, and the transport tests assert it:
 *
 *   format            | thinking active | temperature sent
 *   ------------------|-----------------|-----------------
 *   chat_completions  | n/a             | explicit, else 0.7
 *   responses         | n/a             | explicit, else 0.7
 *   google            | n/a             | explicit, else 0.7
 *   messages          | no              | explicit, else 0.7
 *   messages          | yes             | OMITTED (Anthropic 400s on both)
 *
 * Before this existed the trader could see "0.4" beside a call that sent
 * nothing at all, because the messages transport drops temperature when
 * thinking is on. The caller gets the requested value AND what actually
 * went on the wire, so the distinction is never silent.
 *
 * @param {{
 *   apiFormat?: string,
 *   temperature?: number,
 *   modelId?: string,
 *   displayName?: string,
 *   capabilityOverride?: boolean,
 *   maxTokens?: number,
 *   jsonMode?: boolean,
 *   reasoningEffort?: string,
 * }} input
 * @returns {{ temperature: number | undefined, requested: number, omittedBecause: 'thinking' | null }}
 */
function effectiveTemperature(input) {
    const opts = input || {};
    const requested = typeof opts.temperature === 'number' ? opts.temperature : ANTHROPIC_DEFAULT_TEMPERATURE;
    if (opts.apiFormat !== 'messages') {
        return { temperature: requested, requested, omittedBecause: null };
    }
    const fields = anthropicThinkingFields({
        modelId: opts.modelId,
        displayName: opts.displayName,
        capabilityOverride: opts.capabilityOverride,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        jsonMode: opts.jsonMode,
        reasoningEffort: opts.reasoningEffort,
    });
    return fields.temperature === undefined
        ? { temperature: undefined, requested, omittedBecause: 'thinking' }
        : { temperature: fields.temperature, requested, omittedBecause: null };
}

// ─── Gemini thinking ────────────────────────────────────────────────────────

const GEMINI_THINKING_BUDGETS = {
    low: 2048,
    medium: 4096,
    high: 8192,
    max: 16384,
};

/**
 * generationConfig.thinkingConfig for Google generateContent: chain of
 * thought is requested for gemini-ish models unless JSON mode is on.
 * Scales thinkingBudget based on the requested effort tier:
 *   - 'off'            → undefined (disabled)
 *   - 'low'            → 2048
 *   - 'medium'         → 4096
 *   - 'high' / default → 8192
 *   - 'max'            → 16384
 *
 * The budget is clamped to the call's own output limit — see
 * geminiThinkingBudget — so a max-effort request on a short answer cannot ask
 * for more thinking tokens than the response is allowed to spend in total.
 *
 * @param {boolean} [jsonMode]
 * @param {string} [model]
 * @param {string} [effort]
 * @param {number} [maxOutputTokens]
 * @returns {{ includeThoughts: boolean, thinkingBudget: number } | undefined}
 */
function geminiThinkingParams(jsonMode, model, effort, maxOutputTokens) {
    if (jsonMode) return undefined;
    if (effort === 'off') return undefined;
    const id = String(model || '').toLowerCase();
    if (!/gemini|thinking/i.test(id || 'gemini')) return undefined;
    const budget = geminiThinkingBudget(effort, maxOutputTokens);
    return budget === undefined ? undefined : { includeThoughts: true, thinkingBudget: budget };
}

/**
 * thinkingBudget for an effort tier, clamped to the output budget the call
 * actually has. Gemini bills thinking tokens INSIDE maxOutputTokens, so a
 * budget at or above the cap is a 400 — and the flat 8192 this replaced
 * already outran the 4096 a plain chat call asks for. Mirrors the Anthropic
 * path: under MIN_EFFECTIVE_THINKING_TOKENS there is nothing worth thinking
 * with, so no thinkingConfig is requested at all.
 *
 * @param {string} [effort]
 * @param {number} [maxOutputTokens]
 * @returns {number | undefined} undefined ⇒ send no thinkingConfig
 */
function geminiThinkingBudget(effort, maxOutputTokens) {
    const requested = (effort && GEMINI_THINKING_BUDGETS[effort]) || 8192;
    if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) return requested;
    if (maxOutputTokens <= MIN_EFFECTIVE_THINKING_TOKENS) return undefined;
    return Math.min(requested, maxOutputTokens - 1);
}

// ─── Address canonicalization ───────────────────────────────────────────────
//
// ONE rule, asked by every host filter in the app: what ADDRESS is this
// hostname? The filters used to answer it by matching the hostname STRING
// with IPv4 dotted-decimal regexes, and the WHATWG URL parser defeats that —
// it rewrites an IPv4-embedded IPv6 literal into pure hex BEFORE the filter
// ever sees it:
//
//     new URL('https://[::ffff:127.0.0.1]/').hostname  ===  '[::ffff:7f00:1]'
//
// `::ffff:127.0.0.1` and `::ffff:7f00:1` are the SAME address (127.0.0.1),
// but only the first one matches a dotted-quad regex — so every filter built
// on those regexes classified loopback, RFC1918 and cloud-metadata hosts as
// ordinary public ones. The decimal form (`https://2130706433/`) is parsed
// back to dotted form and was caught; the IPv6 form was not, which is how a
// single spelling of a blocked address walked straight through the gate.
//
// So the address is parsed NUMERICALLY, once, here, and the filters ask this
// module for the answer instead of re-deriving it from text.

/** A dotted-quad IPv4 literal. */
const IPV4_LITERAL_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Expand an IPv6 literal to its eight hextets, or null when it is not one.
 * Handles the `::` gap, an embedded IPv4 tail and a zone index.
 *
 * @param {string} host
 * @returns {number[]|null} eight hextets, most significant first
 */
function expandIpv6(host) {
    let h = String(host == null ? '' : host).trim().toLowerCase();
    if (h.startsWith('[')) h = h.slice(1);
    if (h.endsWith(']')) h = h.slice(0, -1);
    if (!h.includes(':')) return null;
    const zone = h.indexOf('%');
    if (zone >= 0) h = h.slice(0, zone);

    // An embedded IPv4 tail (`::ffff:127.0.0.1`) contributes the last two
    // hextets. The tail is cut BEFORE the gap is read, so the `::` that
    // precedes it is still visible.
    const tail = [];
    const v4 = h.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (v4) {
        const octets = v4[1].split('.').map(Number);
        if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        tail.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        h = h.slice(0, v4.index);
        // The separator before the tail is not part of the gap: `::ffff:` is
        // `::` + `ffff`, not `::` + `ffff:`.
        if (h.endsWith(':') && h.slice(0, -1).includes('::')) h = h.slice(0, -1);
    }

    const gap = h.indexOf('::');
    const headText = gap >= 0 ? h.slice(0, gap) : h;
    const rearText = gap >= 0 ? h.slice(gap + 2) : '';
    const wordsOf = (text) => {
        const out = [];
        for (const part of text.split(':')) {
            if (part === '') continue;
            if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
            out.push(parseInt(part, 16));
        }
        return out;
    };
    const head = wordsOf(headText);
    const rear = wordsOf(rearText);
    if (!head || !rear) return null;

    if (gap < 0) {
        // No gap: the literal must be exactly eight hextets.
        if (head.length + tail.length !== 8) return null;
        return [...head, ...tail];
    }
    const fill = 8 - head.length - rear.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...new Array(fill).fill(0), ...rear, ...tail];
}

/**
 * The IPv4 address an IPv6 literal carries, or null when it carries none.
 *
 * `::ffff:a.b.c.d` (IPv4-mapped, RFC 4291) and `::a.b.c.d` (IPv4-compatible)
 * are the same IPv4 address wearing an IPv6 hat — and the hat is what the URL
 * parser leaves behind.
 *
 * @param {number[]} words eight hextets
 * @returns {string|null} dotted-quad
 */
function ipv4FromIpv6(words) {
    if (!words || words.length !== 8) return null;
    const mapped = words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff;
    const compatible = words.slice(0, 6).every((w) => w === 0);
    if (!mapped && !compatible) return null;
    return `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
}

/**
 * The canonical numeric forms of a URL hostname.
 *
 * `ipv4` is set for a dotted-quad host AND for an IPv6 literal that carries
 * one (so `::ffff:127.0.0.1` answers `127.0.0.1`). `ipv6` is set for an IPv6
 * literal. A NAME answers neither — a hostname is resolved by the transport,
 * not by this module, and a name that resolves inward is a separate question
 * (see `docs/plan/open-items.md`).
 *
 * @param {string} hostname
 * @returns {{ipv4: string|null, ipv6: number[]|null}}
 */
function hostAddresses(hostname) {
    const bare = String(hostname == null ? '' : hostname).trim().toLowerCase()
        .replace(/^\[/, '').replace(/\]$/, '');
    if (!bare) return { ipv4: null, ipv6: null };
    const v4 = bare.match(IPV4_LITERAL_RE);
    if (v4) {
        const octets = v4.slice(1).map(Number);
        if (octets.some((n) => n > 255)) return { ipv4: null, ipv6: null };
        return { ipv4: octets.join('.'), ipv6: null };
    }
    const words = expandIpv6(bare);
    if (!words) return { ipv4: null, ipv6: null };
    return { ipv4: ipv4FromIpv6(words), ipv6: words };
}

// ─── Provider URL host policy ───────────────────────────────────────────────

/** Named loopback hosts accepted for plain-HTTP local model servers. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

const isLoopbackIp = (hostname) => /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
const isPrivateIp = (hostname) =>
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname);
const isLinkLocalIp = (hostname) => /^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname);
/** IPv6 link-local — fe80::/10. The WHATWG URL parser hands the hostname over
 *  in brackets, so both forms are matched. */
const isIpv6LinkLocalWords = (words) => Boolean(words) && (words[0] & 0xffc0) === 0xfe80;
/** IPv6 loopback - ::1. */
const isIpv6LoopbackWords = (words) =>
    Boolean(words) && words.slice(0, 7).every((w) => w === 0) && words[7] === 1;

/**
 * The CLOUD-METADATA range, refused outright.
 *
 * 169.254.169.254 is where the AWS / GCP / Azure instance metadata service
 * answers, and it hands CREDENTIALS to anything that can reach it. The range
 * is also the address an OS auto-assigns when DHCP fails — so it is NOT the
 * "private LAN" a model server would be configured on (loopback and the
 * RFC1918 ranges are). A user whose local model server sits on such a host
 * has `localhost` and the LAN address available instead, so nothing real is
 * lost by refusing it.
 *
 * It has to be refused over HTTPS TOO, not just over plain HTTP: HTTPS is
 * allowed for every host, so a "no plain HTTP off-LAN" rule alone leaves
 * 169.254.169.254 reachable. `services/tools/toolForge.ts` has always refused
 * this range for forged tools, and PRIVACY.md:84-87 says cloud-metadata hosts
 * are refused — that claim is now true of the provider policy as well.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isLinkLocalHost(hostname) {
    const { ipv4, ipv6 } = hostAddresses(hostname);
    if (ipv4) return isLinkLocalIp(ipv4);
    if (ipv6) return isIpv6LinkLocalWords(ipv6);
    return false;
}

/**
 * Loopback / RFC1918 host test. Local model servers (Ollama, LM Studio,
 * llama.cpp…) are commonly served over plain HTTP on the loopback OR another
 * machine on the LAN — blocking the private ranges made those setups
 * unreachable, and the packaged app used to carry a stricter localhost-only
 * variant of this rule than the web app (the drift this module removes).
 *
 * Link-local is deliberately NOT in this set — see isLinkLocalHost.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isPrivateOrLoopbackHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return false;
    if (LOCAL_HOSTS.has(host)) return true;
    const { ipv4, ipv6 } = hostAddresses(host);
    // The IPv4 answer comes first because an IPv4-mapped literal IS that IPv4
    // address; the IPv6 test still runs for the loopback spelling, whose
    // embedded IPv4 (0.0.0.1) is not a loopback address in IPv4 terms.
    if (ipv4 && (isLoopbackIp(ipv4) || isPrivateIp(ipv4))) return true;
    if (ipv6 && isIpv6LoopbackWords(ipv6)) return true;
    return false;
}

/**
 * Plain HTTP is allowed ONLY for hosts passing isPrivateOrLoopbackHost;
 * everything remote must be HTTPS.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function httpAllowedForHost(hostname) {
    return isPrivateOrLoopbackHost(hostname);
}

/**
 * The security core of the provider-URL policy: absolute http(s) URL, HTTPS
 * by default, HTTP only for private/loopback hosts, no embedded credentials,
 * and never the cloud-metadata range. Used for initial request URLs AND —
 * critically — re-validated on every manual redirect hop in the Electron main
 * process (net.fetch defaults to following redirects, which let a configured
 * endpoint 302 the MAIN process to internal/HTTP targets: SSRF). Query
 * strings are NOT checked here: legitimate redirect targets may carry them
 * (initial URLs get the stricter no-query treatment in the transports' own
 * normalization).
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
function isSafeProviderTargetUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl || '').trim());
    } catch {
        return false;
    }
    // The cloud-metadata range is refused over HTTPS as well as HTTP.
    if (isLinkLocalHost(parsed.hostname)) return false;
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isPrivateOrLoopbackHost(parsed.hostname))) {
        return false;
    }
    if (parsed.username || parsed.password) return false;
    return true;
}

/**
 * Whether a provider baseUrl points at a local/LAN model server that needs
 * no API key (Ollama / LM Studio / llama.cpp). Empty keys are accepted for
 * these hosts by the readiness predicates and by desktop discovery.
 * Returns false for unparseable URLs.
 *
 * @param {string} baseUrl
 * @returns {boolean}
 */
function isLocalBaseUrl(baseUrl) {
    try {
        const parsed = new URL(String(baseUrl || '').trim());
        return isPrivateOrLoopbackHost(parsed.hostname);
    } catch {
        return false;
    }
}

// ─── Base-URL normalization ─────────────────────────────────────────────────

/**
 * Endpoint path suffixes stripped from a configured baseUrl. A user routinely
 * pastes the full endpoint they were given ("…/v1/chat/completions"), and the
 * transports append their own path to the base — so an unstripped suffix
 * produced "…/chat/completions/chat/completions".
 *
 * SIX suffixes, not four: the dev proxy used to strip only the four it
 * happened to know about, so a baseUrl pasted from an Anthropic-style endpoint
 * ("/v1/messages"), a bare "/v1/chat" gateway or "/v1/completions" legacy
 * OpenAI route was normalized DIFFERENTLY per transport — the same saved
 * provider worked on web and failed on desktop (and vice versa). The list now
 * lives here, so the two cannot drift again.
 */
const PROVIDER_URL_PATH_SUFFIXES = [
    '/chat/completions',
    '/messages',
    '/responses',
    '/models',
    '/chat',
    '/completions',
];

/**
 * Validate + normalize a configured provider baseUrl: the host policy above,
 * no embedded credentials / query / fragment, and the endpoint-path suffix
 * stripped. Throws with the same user-facing message on every transport
 * (this text is shown verbatim in Settings → Providers).
 *
 * The renderer reaches the same rules through
 * `utils/providerUrlValidation.ts`, which is the UX layer over this function.
 *
 * @param {string} rawUrl
 * @returns {string} the normalized base URL (no trailing slash)
 */
function normalizeProviderUrl(rawUrl) {
    const parsed = new URL(String(rawUrl || '').trim());
    // The cloud-metadata range first, and on its own message: "must use HTTPS"
    // would be a confusing answer for a host that may not be reached at all.
    if (isLinkLocalHost(parsed.hostname)) {
        throw new Error('Provider URLs cannot point at a link-local address (169.254.x.x). That range includes the cloud metadata service.');
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isPrivateOrLoopbackHost(parsed.hostname))) {
        throw new Error('Provider URLs must use HTTPS. HTTP is allowed only for localhost and private LAN addresses.');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('Provider URLs cannot include credentials, query parameters, or fragments.');
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    for (const suffix of PROVIDER_URL_PATH_SUFFIXES) {
        if (parsed.pathname.endsWith(suffix)) {
            parsed.pathname = parsed.pathname.slice(0, -suffix.length).replace(/\/+$/, '');
            break;
        }
    }
    return parsed.toString().replace(/\/$/, '');
}

// ─── Redirect-hop policy ────────────────────────────────────────────────────

/** Cap on manual redirect hops, matching the pre-existing desktop limit. */
const MAX_REDIRECT_HOPS = 3;

/**
 * Fetch with redirects followed MANUALLY, re-validating every hop.
 *
 * WHY THIS EXISTS. `fetch` follows redirects by default, so the host gate on
 * the configured endpoint only ever checked the INITIAL url: a configured (or
 * compromised, or hostile) provider could 302 the caller — on desktop the
 * MAIN process, which has no CORS confinement — at an internal or plain-HTTP
 * target and the body still came back. Every hop is therefore re-checked
 * with isSafeProviderTargetUrl, and the chain is capped.
 *
 * WHY IT LIVES HERE and is not duplicated. It was desktop-only: the vite dev
 * proxy forwarded redirects invisibly, so the dev server and the packaged app
 * enforced different hop policies for the same request. The hop rule is part
 * of the provider wire policy, and this module is already imported by all
 * three transports (renderer via the ESM interop, the dev proxy as a plain
 * Node import, electron/main.cjs by require). The fetch IMPLEMENTATION is a
 * parameter because it differs per host — `net.fetch` in the Electron main
 * process, the global `fetch` in the vite config — while the policy cannot.
 *
 * @param {(url: string, init: object) => Promise<any>} fetcher
 * @param {string} url
 * @param {object} [init] standard fetch init (method/headers/body/signal)
 * @returns {Promise<any>} the final, non-redirect response
 */
async function fetchFollowingSafeRedirects(fetcher, url, init) {
    let current = String(url);
    let method = (init && init.method) || 'GET';
    let fetchInit = init;
    for (let hop = 0; ; hop++) {
        if (!isSafeProviderTargetUrl(current)) {
            throw new Error('Provider request blocked: the target URL failed the provider URL policy.');
        }
        const response = await fetcher(current, { ...fetchInit, redirect: 'manual' });
        const status = response.status;
        if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
            const location = response.headers.get('location');
            try { if (response.body && response.body.cancel) await response.body.cancel(); } catch { /* already consumed */ }
            if (!location) return response; // redirect without Location: surface the status as-is
            if (hop >= MAX_REDIRECT_HOPS) throw new Error('Provider request exceeded the redirect limit.');
            try {
                current = new URL(location, current).toString();
            } catch {
                throw new Error('Provider request blocked: redirect target is not a valid URL.');
            }
            if ((status === 301 || status === 302 || status === 303) && method !== 'GET' && method !== 'HEAD') {
                // fetch spec: 301/302/303 ALL rewrite a POST into a bodyless
                // GET (303 unconditionally; 301/302 in every real client and
                // in both the web fetch and Node's proxy transports). Re-POSTing
                // the body after a 301/302 is a double-submit class bug.
                // 307/308 by contrast MUST repeat the method + body.
                method = 'GET';
                fetchInit = { ...fetchInit, method: 'GET' };
                delete fetchInit.body;
            }
            continue;
        }
        return response;
    }
}

/**
 * Ask a host that can return a separate reasoning channel to do so.
 *
 * This lived in the renderer only, so the PACKAGED DESKTOP app never sent it:
 * the Chat AI dock asks main.cjs to build the provider request, and main.cjs
 * had no idea the flag existed. The same seat therefore returned its thinking
 * on the web and not on the desktop — a model behaving differently per runtime,
 * with the Thinking row silently empty where it should not be.
 *
 * It belongs HERE because this is the one module the renderer, the vite dev
 * proxy and electron/main.cjs all import; that is the whole point of it.
 */
function requestReasoningSideChannel(config, params) {
    const host = `${(config && config.baseUrl) || ''} ${(config && config.selectedModel) || ''}`;
    if (/openrouter.ai|deepseek|groq.com|together.xyz|fireworks.ai|siliconflow/i.test(host)) {
        params.include_reasoning = true;
    }
}

const PROVIDER_REQUEST_POLICY = {
    isExtendedThinkingModel,
    claudeThinkingBudgetTokens,
    anthropicShouldSendThinking,
    anthropicThinkingFields,
    anthropicCachedSystem,
    effectiveTemperature,
    geminiThinkingParams,
    geminiThinkingBudget,
    isPrivateOrLoopbackHost,
    isLinkLocalHost,
    hostAddresses,
    httpAllowedForHost,
    isSafeProviderTargetUrl,
    isLocalBaseUrl,
    normalizeProviderUrl,
    PROVIDER_URL_PATH_SUFFIXES,
    fetchFollowingSafeRedirects,
    MAX_REDIRECT_HOPS,
    EXTENDED_THINKING_MODEL_RE,
    MIN_EFFECTIVE_THINKING_TOKENS,
    ANTHROPIC_DEFAULT_TEMPERATURE,
    THINKING_BUDGET_FRACTIONS,
    GEMINI_THINKING_BUDGETS,
    requestReasoningSideChannel,
};

// CommonJS export guarded so the SAME file also loads in the browser once
// vite.config.ts's interop plugin appends the ESM re-export (the guard keeps
// `module.exports = …` from throwing in an ES-module context where `module`
// is undeclared). electron/main.cjs and vitest consume it as plain CJS.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PROVIDER_REQUEST_POLICY;
}
