/**
 * skillRoutingCore — pure deterministic condition-scoped skill routing.
 *
 * Parses optional trigger metadata (`regimes`, `sessions`, `symbols`,
 * `conditions`) from SKILL.md YAML frontmatter (top-level or under `metadata:`)
 * and matches against the active tape context without ever preloading skill
 * bodies into the static prompt.
 *
 * Pure TypeScript: zero React, DOM, window, localStorage, or network imports.
 */

export interface SkillTriggerSpec {
    regimes: string[];
    sessions: string[];
    symbols: string[];
    conditions: string[];
}

export interface SkillRoutingCandidate {
    slug: string;
    name?: string;
    description?: string;
    content: string;
    status?: 'probation' | 'verified' | 'stale' | 'archived';
    formatIssues?: readonly string[];
}

export interface SkillRoutingContext {
    symbol?: string | null;
    session?: string | null;
    nowMs?: number;
    regime?: string | null;
    fundingRate?: number | null;
    dailyDrawdownPct?: number | null;
    killSwitchActive?: boolean | null;
    maxItems?: number;
}

export interface RoutedSkillMatch {
    slug: string;
    matchedDimensions: string[];
    score: number;
}

export interface SkillRoutingResult {
    matches: RoutedSkillMatch[];
    promptTailBlock: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const TRIGGER_KEYS = ['regimes', 'sessions', 'symbols', 'conditions'] as const;
type TriggerKey = (typeof TRIGGER_KEYS)[number];

const EXTREME_FUNDING_ABS_THRESHOLD = 0.0005;
const DRAWDOWN_COOLDOWN_PCT = 1.5;

const stripQuotes = (raw: string): string => {
    const trimmed = raw.trim();
    if (trimmed.length >= 2) {
        if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
            return trimmed.slice(1, -1).trim();
        }
    }
    return trimmed;
};

const parseInlineList = (raw: string): string[] => {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const inner = trimmed.startsWith('[') && trimmed.endsWith(']')
        ? trimmed.slice(1, -1)
        : trimmed;
    if (!inner.trim()) return [];
    return inner
        .split(',')
        .map(part => stripQuotes(part))
        .filter(Boolean);
};

const indentOf = (line: string): number => line.match(/^[ \t]*/)?.[0].length ?? 0;

const isTriggerKey = (k: string): k is TriggerKey =>
    (TRIGGER_KEYS as readonly string[]).includes(k);

const parseYamlBlockList = (lines: string[], startIdx: number, parentIndent: number): { values: string[]; nextIdx: number } => {
    const values: string[] = [];
    let i = startIdx;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            i += 1;
            continue;
        }
        const ind = indentOf(line);
        if (ind <= parentIndent && !trimmed.startsWith('-')) break;
        if (ind < parentIndent) break;
        const item = /^-\s*(.+)$/.exec(trimmed);
        if (item) {
            const val = stripQuotes(item[1].replace(/\s+#.*$/, ''));
            if (val) values.push(val);
            i += 1;
            continue;
        }
        break;
    }
    return { values, nextIdx: i };
};

const collectSectionTriggers = (lines: string[], baseIndent: number, out: SkillTriggerSpec): void => {
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            i += 1;
            continue;
        }
        const ind = indentOf(line);
        if (ind !== baseIndent) {
            i += 1;
            continue;
        }
        const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(trimmed);
        if (!kv) {
            i += 1;
            continue;
        }
        const key = kv[1].toLowerCase();
        const rest = kv[2].replace(/\s+#.*$/, '').trim();
        if (isTriggerKey(key)) {
            if (rest) {
                out[key].push(...parseInlineList(rest));
                i += 1;
            } else {
                const block = parseYamlBlockList(lines, i + 1, ind);
                out[key].push(...block.values);
                i = block.nextIdx;
            }
            continue;
        }
        i += 1;
    }
};

/** Parse optional `regimes`, `sessions`, `symbols`, `conditions` from top-level or `metadata:` frontmatter. */
export const parseSkillTriggers = (content: string): SkillTriggerSpec => {
    const empty: SkillTriggerSpec = { regimes: [], sessions: [], symbols: [], conditions: [] };
    const m = FRONTMATTER_RE.exec(content || '');
    if (!m) return empty;
    const lines = m[1].split(/\r?\n/);
    collectSectionTriggers(lines, 0, empty);

    // Also inspect nested `metadata:` block if present
    const metaIdx = lines.findIndex(l => indentOf(l) === 0 && /^metadata\s*:\s*(?:#.*)?$/i.test(l.trim()));
    if (metaIdx >= 0) {
        const metaLines: string[] = [];
        let childIndent = -1;
        for (let i = metaIdx + 1; i < lines.length; i += 1) {
            const line = lines[i];
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                metaLines.push(line);
                continue;
            }
            const ind = indentOf(line);
            if (ind === 0) break;
            if (childIndent < 0) childIndent = ind;
            metaLines.push(line);
        }
        if (childIndent > 0 && metaLines.length > 0) {
            collectSectionTriggers(metaLines, childIndent, empty);
        }
    }

    const dedupe = (arr: string[]): string[] => [...new Set(arr.map(v => v.trim()).filter(Boolean))];
    return {
        regimes: dedupe(empty.regimes),
        sessions: dedupe(empty.sessions),
        symbols: dedupe(empty.symbols),
        conditions: dedupe(empty.conditions),
    };
};

const normalizeRegime = (raw: string | null | undefined): string => {
    if (typeof raw !== 'string') return '';
    const head = raw.trim().toLowerCase().split(':')[0]?.trim() ?? '';
    if (head === 'ranging') return 'range';
    if (head === 'trending') return 'trend';
    if (head === 'choppy') return 'chop';
    return head;
};

const normalizeSession = (raw: string | null | undefined): string => {
    if (typeof raw !== 'string') return '';
    const s = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (s === 'ny' || s === 'newyork') return 'newyork';
    return s;
};

const deriveUtcSession = (nowMs: number): string => {
    const h = new Date(nowMs).getUTCHours();
    if (h >= 0 && h < 7) return 'asia';
    if (h >= 7 && h < 13) return 'london';
    if (h >= 13 && h < 20) return 'newyork';
    return 'late';
};

const sessionDisplayLabel = (normalized: string): string => {
    if (normalized === 'asia') return 'Asia';
    if (normalized === 'london') return 'London';
    if (normalized === 'newyork') return 'NewYork';
    if (normalized === 'late') return 'Late';
    return normalized;
};

const symbolForms = (raw: string | null | undefined): Set<string> => {
    const forms = new Set<string>();
    if (typeof raw !== 'string') return forms;
    const upper = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!upper) return forms;
    forms.add(upper);
    for (const suffix of ['USDT', 'USDC', 'BUSD', 'PERP']) {
        if (upper.length > suffix.length && upper.endsWith(suffix)) {
            forms.add(upper.slice(0, -suffix.length));
        }
    }
    return forms;
};

const normalizeCondition = (raw: string): string =>
    raw.trim().toLowerCase().replace(/[\s-]+/g, '_');

const statusRank = (status?: SkillRoutingCandidate['status']): number => {
    if (status === 'verified') return 3;
    if (status === 'probation' || status === undefined) return 2;
    if (status === 'stale') return 1;
    return 0;
};

/**
 * Evaluate optional SKILL.md trigger metadata against live tape context.
 * Returns at most `maxItems` (hard-capped at 2) compact `skill_view("<slug>")`
 * recommendations for the dynamic prompt tail. Zero skill bodies are preloaded.
 */
export const routeSkillsForContext = (
    candidates: readonly SkillRoutingCandidate[],
    ctx: SkillRoutingContext,
): SkillRoutingResult => {
    const maxItems = Math.min(2, Math.max(0, ctx.maxItems ?? 2));
    if (maxItems === 0 || candidates.length === 0) {
        return { matches: [], promptTailBlock: '' };
    }

    const activeRegime = normalizeRegime(ctx.regime);
    const explicitSession = normalizeSession(ctx.session);
    const activeSession = explicitSession || (typeof ctx.nowMs === 'number' && Number.isFinite(ctx.nowMs) ? deriveUtcSession(ctx.nowMs) : '');
    const activeSymbolForms = symbolForms(ctx.symbol);

    const activeConditions = new Set<string>();
    if (typeof ctx.fundingRate === 'number' && Number.isFinite(ctx.fundingRate)) {
        if (Math.abs(ctx.fundingRate) >= EXTREME_FUNDING_ABS_THRESHOLD) activeConditions.add('extreme_funding');
        if (ctx.fundingRate >= EXTREME_FUNDING_ABS_THRESHOLD) activeConditions.add('positive_funding');
        if (ctx.fundingRate <= -EXTREME_FUNDING_ABS_THRESHOLD) activeConditions.add('negative_funding');
    }
    if (typeof ctx.dailyDrawdownPct === 'number' && Number.isFinite(ctx.dailyDrawdownPct)
        && ctx.dailyDrawdownPct >= DRAWDOWN_COOLDOWN_PCT) {
        activeConditions.add('drawdown');
        activeConditions.add('drawdown_cooldown');
    }
    if (ctx.killSwitchActive === true) {
        activeConditions.add('kill_switch');
    }
    if (activeRegime === 'chop' || activeRegime === 'range') {
        activeConditions.add('chop');
    }

    const matches: Array<RoutedSkillMatch & { statusScore: number }> = [];

    for (const candidate of candidates) {
        if (!candidate.slug || candidate.status === 'archived') continue;
        if (candidate.formatIssues && candidate.formatIssues.length > 0) continue;

        const triggers = parseSkillTriggers(candidate.content);
        const hasAnyTrigger =
            triggers.regimes.length > 0
            || triggers.sessions.length > 0
            || triggers.symbols.length > 0
            || triggers.conditions.length > 0;
        if (!hasAnyTrigger) continue;

        const matchedDimensions: string[] = [];
        let ok = true;

        if (triggers.regimes.length > 0) {
            const hit = activeRegime && triggers.regimes.some(r => normalizeRegime(r) === activeRegime);
            if (!hit) ok = false;
            else matchedDimensions.push(`regime=${activeRegime}`);
        }
        if (ok && triggers.sessions.length > 0) {
            const hit = activeSession && triggers.sessions.some(s => normalizeSession(s) === activeSession);
            if (!hit) ok = false;
            else matchedDimensions.push(`session=${sessionDisplayLabel(activeSession)}`);
        }
        if (ok && triggers.symbols.length > 0) {
            let hitSymbol: string | null = null;
            for (const sym of triggers.symbols) {
                for (const form of symbolForms(sym)) {
                    if (activeSymbolForms.has(form)) {
                        hitSymbol = sym.trim().toUpperCase();
                        break;
                    }
                }
                if (hitSymbol) break;
            }
            if (!hitSymbol) ok = false;
            else matchedDimensions.push(`symbol=${hitSymbol}`);
        }
        if (ok && triggers.conditions.length > 0) {
            const hitCond = triggers.conditions.find(c => activeConditions.has(normalizeCondition(c)));
            if (!hitCond) ok = false;
            else matchedDimensions.push(`condition=${normalizeCondition(hitCond)}`);
        }

        if (!ok || matchedDimensions.length === 0) continue;
        const sRank = statusRank(candidate.status);
        matches.push({
            slug: candidate.slug,
            matchedDimensions,
            score: matchedDimensions.length * 10 + sRank,
            statusScore: sRank,
        });
    }

    matches.sort((a, b) =>
        b.matchedDimensions.length - a.matchedDimensions.length
        || b.statusScore - a.statusScore
        || a.slug.localeCompare(b.slug));

    const top: RoutedSkillMatch[] = matches.slice(0, maxItems).map(({ slug, matchedDimensions, score }) => ({
        slug,
        matchedDimensions,
        score,
    }));

    if (top.length === 0) {
        return { matches: [], promptTailBlock: '' };
    }

    const promptTailBlock = top
        .map(m => `Matched playbook for current tape (${m.matchedDimensions.join(', ')}): call skill_view("${m.slug}") before sizing.`)
        .join('\n');

    return { matches: top, promptTailBlock };
};
