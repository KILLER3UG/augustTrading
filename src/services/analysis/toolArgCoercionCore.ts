/**
 * toolArgCoercionCore — pure tolerant JSON/schema coercion, canonical argument
 * hashing, and structured typed repair rejection signals.
 *
 * Zero React, DOM, `window`, storage, or network imports (`check:boundaries`).
 *
 * Design rules:
 *  - Never mutate caller objects; always return a fresh normalized bag plus an
 *    audit trail of every applied coercion.
 *  - Coerce harmless transport/casing drift (snake_case <-> camelCase, finite
 *    numeric strings, scalar takeProfits -> array, markdown-fenced JSON,
 *    trailing commas) WITHOUT hiding genuine semantic errors (negative prices,
 *    inverted brackets, unknown direction).
 *  - Emit compact machine-readable typed repair signals so the model can fix a
 *    constraint violation in at most 1 bounded auto-repair attempt per turn.
 */

export interface CoercedToolArgsResult {
    args: Record<string, unknown>;
    coercions: string[];
}

export interface TypedRepairRejectionInput {
    tool: string;
    errorCode: string;
    field?: string;
    expectedConstraint: string;
    repairHint: string;
    autoRepairRemaining: number;
    message?: string;
}

export interface TypedRepairRejectionPayload {
    ok: false;
    kind: 'typed_repair_rejection';
    tool: string;
    errorCode: string;
    field?: string;
    expectedConstraint: string;
    repairHint: string;
    autoRepairRemaining: number;
    message: string;
}

export interface CoercionAuditRecord {
    tool: string;
    coercions: string[];
    at: number;
}

const MAX_AUDIT_RECORDS = 100;
const coercionAuditLog: CoercionAuditRecord[] = [];

/** Record silent argument coercions for diagnostics without polluting chat prose. */
export const recordCoercionAudit = (tool: string, coercions: readonly string[], nowMs = Date.now()): void => {
    if (!coercions.length) return;
    coercionAuditLog.push({ tool, coercions: [...coercions], at: nowMs });
    if (coercionAuditLog.length > MAX_AUDIT_RECORDS) {
        coercionAuditLog.splice(0, coercionAuditLog.length - MAX_AUDIT_RECORDS);
    }
};

export const getCoercionAuditLog = (): readonly CoercionAuditRecord[] => coercionAuditLog;

export const resetCoercionAuditForTests = (): void => {
    coercionAuditLog.length = 0;
};

/**
 * Remove trailing commas before `}` or `]` outside quoted JSON strings.
 * Safe against strings containing `,}` or `,]`.
 */
const stripTrailingCommasOutsideStrings = (input: string): string => {
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < input.length; i += 1) {
        const ch = input[i];
        if (inString) {
            out += ch;
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === ',') {
            let j = i + 1;
            while (j < input.length && /\s/.test(input[j])) j += 1;
            if (j < input.length && (input[j] === '}' || input[j] === ']')) {
                continue;
            }
        }
        out += ch;
    }
    return out;
};

/**
 * Strip markdown code fences (```json ... ``` or ``` ... ```) and trailing
 * commas from streamed or text-emitted JSON tool arguments.
 */
export const stripJsonMarkdownFences = (raw: string): string => {
    let text = String(raw ?? '').trim();
    if (!text) return '';
    const fenced = /^```(?:json|jsonc|js|javascript|ts)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(text);
    if (fenced) {
        text = fenced[1].trim();
    } else if (text.startsWith('```')) {
        text = text.replace(/^```[a-z0-9_-]*\s*/i, '').replace(/\s*```$/i, '').trim();
    }
    return stripTrailingCommasOutsideStrings(text);
};

/**
 * Parse a JSON object tolerantly (strips markdown fences & trailing commas).
 * Returns `null` if the cleaned payload is still not valid JSON.
 */
export const parseTolerantJsonObject = (raw: string): Record<string, unknown> | null => {
    const cleaned = stripJsonMarkdownFences(raw);
    if (!cleaned) return null;
    try {
        const parsed: unknown = JSON.parse(cleaned);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return { value: parsed };
    } catch {
        return null;
    }
};

/**
 * Recursively canonicalize any argument bag with deterministically sorted keys
 * so `{a:1,b:2}` and `{b:2,a:1}` produce identical stall/idempotency hashes.
 */
export const canonicalizeArgsForHash = (value: unknown): string => {
    const normalize = (v: unknown): unknown => {
        if (v === null || v === undefined) return null;
        if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
        if (typeof v !== 'object') return v;
        if (Array.isArray(v)) return v.map(normalize);
        const sorted: Record<string, unknown> = {};
        const entries = Object.entries(v as Record<string, unknown>)
            .filter(([, val]) => val !== undefined)
            .sort(([a], [b]) => a.localeCompare(b));
        for (const [k, val] of entries) {
            sorted[k] = normalize(val);
        }
        return sorted;
    };
    try {
        return JSON.stringify(normalize(value));
    } catch {
        return String(value ?? '');
    }
};

const STRICT_NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const COMMA_NUM_RE = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

const parseFiniteNumericString = (v: unknown): number | undefined => {
    if (typeof v !== 'string') return undefined;
    const trimmed = v.trim();
    if (!trimmed) return undefined;
    if (STRICT_NUM_RE.test(trimmed)) {
        const n = Number(trimmed);
        return Number.isFinite(n) ? n : undefined;
    }
    if (COMMA_NUM_RE.test(trimmed)) {
        const n = Number(trimmed.replace(/,/g, ''));
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
};

const applyAliases = (
    out: Record<string, unknown>,
    aliases: ReadonlyArray<readonly [from: string, to: string]>,
    coercions: string[],
): void => {
    for (const [from, to] of aliases) {
        if (out[to] === undefined && out[from] !== undefined) {
            out[to] = out[from];
            delete out[from];
            coercions.push(`alias:${from}->${to}`);
        }
    }
};

const coerceNumericFields = (
    out: Record<string, unknown>,
    fields: readonly string[],
    coercions: string[],
): void => {
    for (const field of fields) {
        const val = out[field];
        if (typeof val === 'string') {
            const parsed = parseFiniteNumericString(val);
            if (parsed !== undefined) {
                out[field] = parsed;
                coercions.push(`string->number:${field}`);
            }
        }
    }
};

const coerceNumberArrayField = (
    out: Record<string, unknown>,
    field: string,
    coercions: string[],
): void => {
    const val = out[field];
    if (val === undefined || val === null) return;
    if (typeof val === 'number' && Number.isFinite(val)) {
        out[field] = [val];
        coercions.push(`scalar->array:${field}`);
        return;
    }
    if (typeof val === 'string') {
        const parsed = parseFiniteNumericString(val);
        if (parsed !== undefined) {
            out[field] = [parsed];
            coercions.push(`scalar_string->array:${field}`);
        }
        return;
    }
    if (Array.isArray(val)) {
        let changed = false;
        const next = val.map(item => {
            if (typeof item === 'string') {
                const parsed = parseFiniteNumericString(item);
                if (parsed !== undefined) {
                    changed = true;
                    return parsed;
                }
            }
            return item;
        });
        if (changed) {
            out[field] = next;
            coercions.push(`string_items->numbers:${field}`);
        }
    }
};

/**
 * Tolerantly normalize casing aliases, numeric strings, and scalar->array
 * targets for trading math/proposal/order tools without mutating `rawArgs`.
 */
export const coerceToolArguments = (
    toolName: string,
    rawArgs: Record<string, unknown> | null | undefined,
): CoercedToolArgsResult => {
    const out: Record<string, unknown> = rawArgs && typeof rawArgs === 'object' ? { ...rawArgs } : {};
    const coercions: string[] = [];

    if (toolName === 'present_trade') {
        applyAliases(out, [
            ['stop_loss', 'stopLoss'],
            ['take_profits', 'takeProfits'],
            ['risk_pct', 'riskPct'],
            ['skill_slug', 'skillSlug'],
            ['entry_price', 'entry'],
            ['entryPrice', 'entry'],
        ], coercions);
        coerceNumericFields(out, ['entry', 'stopLoss', 'riskPct'], coercions);
        coerceNumberArrayField(out, 'takeProfits', coercions);
        if (typeof out.direction === 'string') {
            const lower = out.direction.trim().toLowerCase();
            if (lower === 'long' && out.direction !== 'Long') {
                out.direction = 'Long';
                coercions.push('case:direction->Long');
            } else if (lower === 'short' && out.direction !== 'Short') {
                out.direction = 'Short';
                coercions.push('case:direction->Short');
            }
        }
    } else if (toolName === 'paper_order') {
        applyAliases(out, [
            ['entryPrice', 'entry_price'],
            ['entry', 'entry_price'],
            ['stopLoss', 'stop_loss'],
            ['takeProfits', 'take_profits'],
            ['riskPct', 'risk_pct'],
            ['notionalUsd', 'notional_usd'],
            ['positionId', 'position_id'],
            ['orderId', 'order_id'],
            ['skillSlug', 'skill_slug'],
        ], coercions);
        coerceNumericFields(out, ['entry_price', 'stop_loss', 'risk_pct', 'notional_usd', 'leverage'], coercions);
        coerceNumberArrayField(out, 'take_profits', coercions);
        if (typeof out.side === 'string') {
            const lower = out.side.trim().toLowerCase();
            if ((lower === 'long' || lower === 'short') && out.side !== lower) {
                out.side = lower;
                coercions.push(`case:side->${lower}`);
            }
        }
    } else if (toolName === 'trade_math') {
        applyAliases(out, [
            ['stopLoss', 'stop_loss'],
            ['takeProfits', 'take_profits'],
            ['entryPrice', 'entry'],
            ['entry_price', 'entry'],
            ['tpWeights', 'tp_weights'],
            ['equityUsd', 'equity_usd'],
            ['riskPercent', 'risk_percent'],
            ['expectedHoldHours', 'expected_hold_hours'],
        ], coercions);
        coerceNumericFields(out, ['entry', 'stop_loss', 'equity_usd', 'risk_percent', 'leverage', 'expected_hold_hours'], coercions);
        coerceNumberArrayField(out, 'take_profits', coercions);
        coerceNumberArrayField(out, 'tp_weights', coercions);
    }

    return { args: out, coercions };
};

/**
 * Format a compact, machine-readable repair rejection payload.
 * Preserves the `{tool} rejected: ...` message text so legacy substring
 * checks and human receipts stay legible alongside structured JSON fields.
 */
export const formatTypedRepairRejection = (input: TypedRepairRejectionInput): string => {
    const remaining = Math.max(0, Math.floor(input.autoRepairRemaining));
    const repairHint = remaining > 0
        ? input.repairHint
        : 'Auto-repair budget exhausted for this turn (autoRepairRemaining=0). Do NOT retry this tool — synthesize your verdict or Wait/decline_trade from verified data.';
    const payload: TypedRepairRejectionPayload = {
        ok: false,
        kind: 'typed_repair_rejection',
        tool: input.tool,
        errorCode: input.errorCode,
        ...(input.field ? { field: input.field } : {}),
        expectedConstraint: input.expectedConstraint,
        repairHint,
        autoRepairRemaining: remaining,
        message: input.message ?? `${input.tool} rejected: ${input.expectedConstraint}`,
    };
    return JSON.stringify(payload);
};

/** Update `autoRepairRemaining` on an already-formatted typed repair payload. */
export const stampAutoRepairBudgetOnRejection = (
    content: string,
    autoRepairRemaining: number,
): { content: string; isTypedRepair: boolean } => {
    try {
        const parsed = JSON.parse(content) as Partial<TypedRepairRejectionPayload> | null;
        if (!parsed || parsed.kind !== 'typed_repair_rejection' || typeof parsed.tool !== 'string') {
            return { content, isTypedRepair: false };
        }
        const remaining = Math.max(0, Math.floor(autoRepairRemaining));
        return {
            isTypedRepair: true,
            content: formatTypedRepairRejection({
                tool: parsed.tool,
                errorCode: parsed.errorCode ?? 'validation_failed',
                field: parsed.field,
                expectedConstraint: parsed.expectedConstraint ?? 'valid arguments',
                repairHint: parsed.repairHint ?? 'Fix the invalid field and retry once.',
                autoRepairRemaining: remaining,
                message: parsed.message,
            }),
        };
    } catch {
        return { content, isTypedRepair: false };
    }
};
