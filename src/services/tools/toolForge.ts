/**
 * ToolForge — model-authored desk tools, run through the same lifecycle
 * as skills: models PROPOSE, the harness HARDENS, evidence DECIDES,
 * and the user approves the one thing that needs a human — outbound
 * network access.
 *
 * A forged tool is a DECLARATIVE HTTP RECIPE, never executable code:
 *   { urlTemplate, method, headers, paramMapping, extractPath, ttlMs }
 * The model picks an endpoint + shape; the harness owns fetch, size caps,
 * timeouts, and the cache. No eval, no sandbox, no code from a model.
 */

import type { DeskToolDefinition, DeskToolCall, DeskToolResult } from '../analysis/DeskToolsService';
import { neutralizeHarnessNotes } from '../../utils/harnessMarks';
import { hostAddresses } from '../../../shared/providerRequestPolicy.cjs';

/** ToolForge request — what a model submits. */
export interface ToolForgeProposal {
    name: string;
    description: string;
    /** JSON-schema properties the model may pass (string/number/boolean). */
    parameters: Record<string, 'string' | 'number' | 'boolean'>;
    /** URL template with {param} slots, e.g. https://api.x.com/v1/{symbol}/depth */
    urlTemplate: string;
    method?: 'GET' | 'POST';
    /** Static headers (values must not embed {param} slots — keep secrets out of models). */
    headers?: Record<string, string>;
    /** How proposal parameters map onto URL template slots / query string. */
    paramMapping?: Record<string, string>;
    /** JSONPath-ish dot path to extract before returning (e.g. 'data.result'). */
    extractPath?: string;
    /** Cache TTL override (ms). Clamped to [5s, 10min]. */
    ttlMs?: number;
}

/** A forged tool as stored (keyed `custom_<slug>`). */
export interface ForgedTool {
    id: string;
    proposal: ToolForgeProposal;
    /** candidate → confirmed → retired. Only CONFIRMED tools are offered. */
    status: 'candidate' | 'confirmed' | 'retired';
    uses: number;
    /** Calls that returned usable content (ok + non-empty). */
    successes: number;
    createdAt: string;
    updatedAt: string;
    /** Provenance: which provider/model proposed it. */
    proposedBy?: string;
}

const KEY = 'desk_tools_forged_v1';
const FORGE_ALLOWED_METHODS = ['GET', 'POST'] as const;
/** URL length + response budget guards. */
const MAX_URL_LENGTH = 600;
const MAX_RESPONSE_CHARS = 2400;
const MIN_TTL_MS = 5_000;
const MAX_TTL_MS = 600_000;
const DEFAULT_TTL_MS = 30_000;

const slugify = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

const nowIso = (): string => new Date().toISOString();

// ── Validation / hardening (deterministic, no model output trusted) ──

export interface ForgeValidation { ok: boolean; errors: string[] }

// ── SSRF hardening (shared by save-time validation AND exec time) ──
//
// Save-time validation of the TEMPLATE is not enough: `{param}` slots live
// wherever the proposal put them — including the host position — so the
// EXPANDED url must be re-validated on every execution. The blacklist covers
// the full private ranges (10/8, 172.16-31, 192.168/16, 169.254/16,
// loopback incl. IPv6 + IPv4-mapped IPv6, and 0.0.0.0/8).

const isBlockedHost = (hostname: string): boolean => {
    const h = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    // The address is read NUMERICALLY, through the shared policy's
    // `hostAddresses`, and NOT by matching the hostname string: the WHATWG
    // URL parser rewrites an IPv4-embedded IPv6 literal into hex before this
    // code ever sees it (`https://[::ffff:127.0.0.1]/` arrives as
    // `[::ffff:7f00:1]`), so a string-matching blacklist classified loopback
    // and cloud-metadata hosts as ordinary public ones.
    const { ipv4, ipv6 } = hostAddresses(h);
    if (ipv4) {
        const a = Number(ipv4.split('.')[0]);
        const b = Number(ipv4.split('.')[1]);
        if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, loopback
        if (a === 169 && b === 254) return true;           // link-local
        if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
        if (a === 192 && b === 168) return true;           // 192.168/16
        if (a >= 224) return true;                         // multicast/reserved
        return false;
    }
    if (ipv6) {
        if ((ipv6[0] & 0xffc0) === 0xfe80) return true;    // fe80::/10 link-local
        if ((ipv6[0] & 0xfe00) === 0xfc00) return true;    // fc00::/7 unique-local
        if (ipv6[0] === 0xff) return true;                 // ff00::/8 multicast
        return false;
    }
    return false;
};

/** Throws when a URL (template or EXPANDED) is not safe to fetch. */
const assertSafeForgedUrl = (raw: string, context: string): URL => {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new Error(`${context} is not a valid absolute URL`);
    }
    if (u.protocol !== 'https:') throw new Error(`${context} must use https://`);
    if (u.username || u.password) throw new Error(`${context} must not embed credentials`);
    if (u.port === '22') throw new Error(`${context} must not use port 22`);
    if (isBlockedHost(u.hostname)) throw new Error(`${context} points at a private/loopback host`);
    return u;
};

/** Host-position `{param}` slots are rejected at save time: they turn model
 *  arguments into the request destination (SSRF by construction). */
const hasHostSlot = (urlTemplate: string): boolean => {
    try {
        const u = new URL(urlTemplate);
        return /\{[a-zA-Z_][a-zA-Z0-9_]*\}/.test(u.host);
    } catch {
        return false;
    }
};

/** Validate a proposal against the forge's hard rules. */
export const validateProposal = (p: ToolForgeProposal): ForgeValidation => {
    const errors: string[] = [];
    const nameOk = slugify(p.name || '');
    if (!nameOk) errors.push('name is required');
    if (!(p.description ?? '').trim()) errors.push('description is required');
    if (!p.urlTemplate || !/^https:\/\//i.test(p.urlTemplate.trim())) {
        errors.push('urlTemplate must be an https:// URL template');
    }
    if ((p.urlTemplate ?? '').length > MAX_URL_LENGTH) errors.push(`urlTemplate exceeds ${MAX_URL_LENGTH} chars`);
    try {
        assertSafeForgedUrl(p.urlTemplate, 'urlTemplate');
        if (hasHostSlot(p.urlTemplate)) errors.push('urlTemplate must not place {param} slots in the host');
    } catch (e) {
        // Keep the legacy message shape for non-parseable templates.
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('not a valid absolute URL')) errors.push('urlTemplate is not a valid URL');
        else errors.push(msg.replace(/^urlTemplate/, 'urlTemplate'));
    }
    const method = (p.method ?? 'GET').toUpperCase();
    if (!FORGE_ALLOWED_METHODS.includes(method as 'GET' | 'POST')) errors.push('method must be GET or POST');
    for (const [k, v] of Object.entries(p.headers ?? {})) {
        if (/\{[a-zA-Z]+\}/.test(v)) errors.push(`header "${k}" must not embed {param} slots`);
        if (/cookie|authorization/i.test(k) === false && /bearer|secret|token/i.test(v)) {
            // Non-auth headers carrying token-looking values are a leak vector.
            errors.push(`header "${k}" looks like it carries a secret`);
        }
    }
    for (const v of Object.values(p.parameters ?? {})) {
        if (!['string', 'number', 'boolean'].includes(v)) errors.push('parameters must be string/number/boolean types');
    }
    return { ok: errors.length === 0, errors };
};

/** Expand `{param}` slots in a template; unknown slots resolve to ''. */
const expandTemplate = (template: string, args: Record<string, unknown>): string =>
    template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, key) => {
        const v = args[key];
        return v === undefined || v === null ? '' : encodeURIComponent(String(v));
    });

/** Extract a dot path from parsed JSON ('data.result.0.price'). */
const extractDotPath = (data: unknown, path?: string): unknown => {
    if (!path) return data;
    return path.split('.').reduce<unknown>((acc, seg) => {
        if (acc === null || acc === undefined) return undefined;
        if (Array.isArray(acc)) return acc[Number(seg)];
        if (typeof acc === 'object') return (acc as Record<string, unknown>)[seg];
        return undefined;
    }, data);
};

/** Build the DeskToolDefinition a provider sees (OpenAI function shape). */
export const forgedToolDefinition = (t: ForgedTool): DeskToolDefinition => ({
    type: 'function',
    function: {
        name: t.id,
        description: t.proposal.description.slice(0, 400),
        parameters: {
            type: 'object',
            properties: Object.fromEntries(
                Object.entries(t.proposal.parameters ?? {}).map(([k, typ]) => [k, { type: typ }]),
            ),
            required: Object.keys(t.proposal.parameters ?? {}),
            additionalProperties: false,
        },
    },
});

/** All confirmed forged tools as definitions (merged into the desk set). */
export const confirmedForgedToolDefinitions = (tools?: ForgedTool[]): DeskToolDefinition[] =>
    (tools ?? loadForgedTools()).filter(t => t.status === 'confirmed').map(forgedToolDefinition);

// ── Execution (the harness runs the recipe; never the model) ──

/**
 * Fetch with a redirect policy that never leaves the approved host:
 * `redirect: 'manual'` + re-validate EVERY `Location` (https, no credentials,
 * no private/loopback) AND require the same hostname as the original request
 * before following. A redirect to a new host (or an internal range) fails
 * closed instead of silently hopping there.
 */
const MAX_FORGED_REDIRECTS = 3;

const fetchForgedRecipe = async (
    startUrl: string,
    init: { method: string; headers: Record<string, string> },
    signal?: AbortSignal,
): Promise<Response> => {
    const origin = assertSafeForgedUrl(startUrl, 'Expanded url');
    let current = origin;
    for (let hop = 0; ; hop += 1) {
        const res = await fetch(current.toString(), {
            method: hop === 0 ? init.method : 'GET', // browsers downgrade 301/302 POST→GET; mirror that
            headers: init.headers,
            signal,
            redirect: 'manual',
        });
        if (res.type === 'opaqueredirect') {
            throw new Error('the endpoint redirected but did not disclose a Location (redirects are blocked)');
        }
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!location) return res;
        if (hop >= MAX_FORGED_REDIRECTS) throw new Error('too many redirects');
        let next: URL;
        try {
            next = assertSafeForgedUrl(new URL(location, current).toString(), 'Redirect target');
        } catch (e) {
            throw new Error(`redirect refused: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
        }
        if (next.hostname.toLowerCase() !== origin.hostname.toLowerCase()) {
            throw new Error(`redirect refused: ${next.hostname} is a different host than ${origin.hostname}`);
        }
        current = next;
    }
};

/**
 * Execute a forged-tool call. Returns null when `name` is not a forged
 * tool (the desk executor falls through to the built-ins).
 */
export const executeForgedTool = async (
    name: string,
    call: DeskToolCall,
    signal?: AbortSignal,
    tools?: ForgedTool[],
): Promise<DeskToolResult | null> => {
    if (!name.startsWith('custom_')) return null;
    const tool = (tools ?? loadForgedTools()).find(t => t.id === name);
    if (!tool || tool.status !== 'confirmed') {
        return { toolCallId: call.id, name, ok: false, content: `${name} is not an approved tool` };
    }
    const method = (tool.proposal.method ?? 'GET').toUpperCase();
    // GET-only cache: a forged POST performs a WRITE on the third-party
    // endpoint; replaying a cached "success" receipt for a re-issued POST
    // within the TTL lies about an action that never happened (and hides one
    // that did). Only reads are served from — and stored in — the cache.
    const cacheable = method === 'GET';
    // Per-call cache keyed like the desk cache (name + JSON args) with the
    // tool's own TTL — forged recipes hit slower third-party APIs.
    const cacheKey = `forged:${name}:${JSON.stringify(call.arguments ?? {})}`;
    const cached = cacheable ? forgedCache.get(cacheKey) : undefined;
    const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, tool.proposal.ttlMs ?? DEFAULT_TTL_MS));
    if (cached && Date.now() - cached.at < ttl) {
        return { toolCallId: call.id, name, ok: true, content: cached.content };
    }
    try {
        const url = expandTemplate(tool.proposal.urlTemplate, call.arguments ?? {});
        // EXEC-TIME re-validation of the EXPANDED url: save-time validation
        // only ever saw the template, so `{param}` slots (even in the host
        // position of a tool stored before the slot rule existed, or crafted
        // directly in storage) can expand to a private/loopback target. This
        // gate runs per call, immediately before the fetch.
        const safeUrl = assertSafeForgedUrl(url, 'Expanded url');
        const queryEntries = Object.entries(tool.proposal.paramMapping ?? {})
            .map(([param, slot]) => [slot, (call.arguments ?? {})[param]] as const)
            .filter(([, v]) => v !== undefined && v !== null && v !== '');
        for (const [slot, v] of queryEntries) safeUrl.searchParams.set(slot, String(v));
        const finalUrl = safeUrl.toString();
        assertSafeForgedUrl(finalUrl, 'Expanded url');
        const res = await fetchForgedRecipe(
            finalUrl,
            { method, headers: { Accept: 'application/json', ...(tool.proposal.headers ?? {}) } },
            signal,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = (await res.text()).slice(0, MAX_RESPONSE_CHARS * 4);
        let content: string;
        try {
            const parsed: unknown = JSON.parse(text);
            const extracted = extractDotPath(parsed, tool.proposal.extractPath);
            // A missing extractPath must not fail the call — fall back to
            // the full payload (JSON.stringify(undefined) is undefined,
            // which would otherwise crash .slice below).
            if (extracted === undefined) {
                content = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
            } else {
                content = typeof extracted === 'string' ? extracted : JSON.stringify(extracted, null, 2);
            }
        } catch {
            content = text;
        }
        content = content.slice(0, MAX_RESPONSE_CHARS);
        // The body is third-party text that lands in a fence carrying the
        // harness-note allowance — strip the app's privileged prefixes from
        // it AT INGESTION or a hostile endpoint can author "system notes"
        // the model has been told to act on (see utils/harnessMarks).
        content = neutralizeHarnessNotes(content);
        if (!content.trim()) throw new Error('empty response');
        if (cacheable) {
            forgedCache.set(cacheKey, { at: Date.now(), content });
            trimForgedCache();
        }
        recordForgedUse(name, true);
        return { toolCallId: call.id, name, ok: true, content };
    } catch (err) {
        recordForgedUse(name, false);
        return {
            toolCallId: call.id,
            name,
            ok: false,
            content: `${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
};

const forgedCache = new Map<string, { at: number; content: string }>();
const FORGED_CACHE_MAX = 50;

/** Expired sweep + insertion-ordered eviction on WRITE — the cache grew
 *  without bound for the whole session (one entry per tool × arg-combination,
 *  each up to ~2400 chars) and its read-time TTL check alone never reclaimed
 *  anything. Not wired into clearDeskToolCache: forged results survive a
 *  debate change by design. */
const trimForgedCache = (): void => {
    const now = Date.now();
    for (const [key, entry] of forgedCache) {
        if (now - entry.at >= MAX_TTL_MS) forgedCache.delete(key);
    }
    while (forgedCache.size > FORGED_CACHE_MAX) {
        const oldest = forgedCache.keys().next().value;
        if (oldest === undefined) break;
        forgedCache.delete(oldest);
    }
};

// ── Persistence + lifecycle (same store pattern as the roster) ──

const load = (): ForgedTool[] => {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    try {
        const raw = window.localStorage.getItem(KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? (parsed as ForgedTool[]) : [];
    } catch { return []; }
};

/**
 * Persist the list, and SAY whether it landed.
 *
 * It used to return `void` and swallow a quota error, so the caller reported the
 * intent: `forge_tool` answered `{proposed:true}` to a model while
 * `localStorage.getItem('desk_tools_forged_v1')` was null (reproduced in the
 * browser, the 2026-10-27 audit T-5), and a human's Approve rendered as done after
 * writing nothing. Every writer here now has to look at the answer.
 */
const save = (items: ForgedTool[]): boolean => {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    try {
        window.localStorage.setItem(KEY, JSON.stringify(items));
        return true;
    } catch { return false; }
};

export const loadForgedTools = (): ForgedTool[] => load();

/** Proposals can arrive mid-session — App listens and toasts. */
export const FORGED_PROPOSAL_EVENT = 'august:forged-proposal';

/**
 * Propose: validate + store as a CANDIDATE. Throws on invalid proposals —
 * the caller surfaces the errors; nothing invalid is ever stored.
 *
 * A re-proposal whose slug collides with a CONFIRMED tool never downgrades
 * it: models routinely re-propose the same recipe, and the old
 * filter-out-and-replace deleted the human-approved record (with its usage
 * stats) and silently undid the approval gate mid-session. The confirmed
 * tool keeps its place; the new proposal is not stored.
 */
export const proposeForgedTool = (proposal: ToolForgeProposal, proposedBy?: string): ForgedTool => {
    const v = validateProposal(proposal);
    if (!v.ok) throw new Error(`Invalid tool proposal: ${v.errors.join('; ')}`);
    const id = `custom_${slugify(proposal.name)}`;
    const existing = load().find(t => t.id === id);
    if (existing?.status === 'confirmed') {
        console.warn(`[toolForge] Re-proposal "${proposal.name}" ignored — a confirmed tool already owns the id "${id}". Retire it first to replace it.`);
        return existing;
    }
    const items = load().filter(t => t.id !== id);
    const tool: ForgedTool = {
        id,
        proposal,
        status: 'candidate',
        uses: 0,
        successes: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        proposedBy,
    };
    if (!save([...items, tool])) {
        // Nothing was stored, so nothing may be reported as stored. The caller's
        // catch turns this into a real failure the model can act on, instead of a
        // receipt for a tool that does not exist.
        throw new Error('the proposal could not be stored (storage is full or unavailable), so nothing was saved');
    }
    try {
        window.dispatchEvent(new CustomEvent(FORGED_PROPOSAL_EVENT, { detail: { id: tool.id, name: proposal.name } }));
    } catch { /* non-DOM envs — ignore */ }
    return tool;
};

/** The human gate: only a user action moves candidate → confirmed. */
export const approveForgedTool = (id: string): ForgedTool | undefined => {
    const items = load();
    const t = items.find(x => x.id === id);
    if (!t) return undefined;
    t.status = 'confirmed';
    t.updatedAt = nowIso();
    // Undefined means the write did not land, so the caller must not report a
    // state change it cannot see after a reload.
    return save(items) ? t : undefined;
};

export const retireForgedTool = (id: string): ForgedTool | undefined => {
    const items = load();
    const t = items.find(x => x.id === id);
    if (!t) return undefined;
    t.status = 'retired';
    t.updatedAt = nowIso();
    return save(items) ? t : undefined;
};

/** True when the deletion reached storage. A caller that ignores this reports a
 *  removal that a reload will undo. */
export const deleteForgedTool = (id: string): boolean => save(load().filter(t => t.id !== id));

export const recordForgedUse = (id: string, ok: boolean): void => {
    const items = load();
    const t = items.find(x => x.id === id);
    if (!t) return;
    t.uses += 1;
    if (ok) t.successes += 1;
    t.updatedAt = nowIso();
    // Deliberately ignored: this runs AFTER the tool's real network call, and
    // turning a telemetry write into a thrown error would report a successful
    // request as a failed one. The count is best-effort; the action is not.
    save(items);
};

/** Promotion evidence — reuse the skill shape: uses + success rate. */
export const forgedToolStats = (id: string): { uses: number; successRate: number } => {
    const t = load().find(x => x.id === id);
    return { uses: t?.uses ?? 0, successRate: t && t.uses > 0 ? t.successes / t.uses : 0 };
};
