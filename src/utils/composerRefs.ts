/**
 * composerRefs — the composer's inline reference grammar and slash templates
 * (pi's `@` references + slash commands, adapted to the desk).
 *
 * `@` REFS: `@#D1` (a chart shape), `@4h` (a timeframe), `@skill:slug` (a
 * playbook), `@plan:planId` (an armed plan). Parsed OUT of the sent text and
 * delivered to the turn context as a FOCUS line — the Tier 0 manifest already
 * carries everything they point at, so the refs tell the model WHERE to look
 * first, not what to invent.
 *
 * SLASH TEMPLATES: `/brief`, `/audit`, `/scan`, `/handoff` — each expands to a
 * deterministic desk instruction. `/handoff` is special: it does NOT send; it
 * mints a fresh session whose first entry is a compact checkpoint (symbol/TF,
 * live thesis, #D levels, armed plans) so a new thread starts warm.
 */

export interface ComposerRefs {
    shapes: string[];
    timeframes: string[];
    skills: string[];
    plans: string[];
}

export interface ParsedComposerInput {
    /** The text with `@` refs stripped — the prompt the model reads. */
    cleaned: string;
    refs: ComposerRefs;
}

const SHAPE_RE = /@#D\d+/g;
const TF_RE = /@(?:\d{1,2}m|\d{1,2}h|\d{1,2}d|1D)\b/g;
const SKILL_RE = /@skill:[a-z0-9][a-z0-9-]*/g;
const PLAN_RE = /@plan:[A-Za-z0-9_-]+/g;

const matchesOf = (text: string, re: RegExp): string[] => {
    const out: string[] = [];
    for (const m of text.match(re) ?? []) out.push(m);
    return [...new Set(out)];
};

/** Parse `@` refs out of the draft. Unknown `@word` tokens are LEFT ALONE
 *  (an email-like mention must not vanish). */
export const parseComposerRefs = (text: string): ParsedComposerInput => {
    const refs: ComposerRefs = {
        shapes: matchesOf(text, SHAPE_RE).map(s => s.slice(1)),
        timeframes: matchesOf(text, TF_RE).map(s => s.slice(1)),
        skills: matchesOf(text, SKILL_RE).map(s => s.slice(7)),
        plans: matchesOf(text, PLAN_RE).map(s => s.slice(6)),
    };
    let cleaned = text;
    for (const token of [...refs.shapes.map(s => `@${s}`), ...refs.timeframes.map(t => `@${t}`), ...refs.skills.map(s => `@skill:${s}`), ...refs.plans.map(p => `@plan:${p}`)]) {
        cleaned = cleaned.split(`${token}`).join('');
    }
    return { cleaned: cleaned.replace(/\s{2,}/g, ' ').trim(), refs };
};

/** The FOCUS line the turn context carries for the parsed refs. Empty when
 *  the draft had none — zero bytes is the contract. */
export const focusLineForRefs = (refs: ComposerRefs): string => {
    const parts: string[] = [];
    if (refs.shapes.length > 0) parts.push(`shapes ${refs.shapes.join(' ')}`);
    if (refs.timeframes.length > 0) parts.push(`timeframes ${refs.timeframes.join(' ')}`);
    if (refs.skills.length > 0) parts.push(`skills ${refs.skills.map(s => `\`${s}\``).join(' ')} (open each with skill_view before applying)`);
    if (refs.plans.length > 0) parts.push(`plans ${refs.plans.join(' ')}`);
    return parts.length > 0 ? `[TRADER FOCUS — prioritize: ${parts.join(' · ')}]` : '';
};

export const SLASH_TEMPLATES = ['plan', 'context', 'compact', 'doctor', 'dream', 'brief', 'audit', 'scan', 'handoff'] as const;
export type SlashTemplate = (typeof SLASH_TEMPLATES)[number];

export interface SlashCommandSuggestion {
    command: SlashTemplate;
    usage: string;
    description: string;
}

export const SLASH_COMMAND_SUGGESTIONS: readonly SlashCommandSuggestion[] = [
    { command: 'plan', usage: '/plan [on|off]', description: 'Toggle read-only Plan Mode (locks execution & writes)' },
    { command: 'context', usage: '/context', description: 'Inspect session token breakdown & compaction headroom' },
    { command: 'compact', usage: '/compact [focus]', description: 'Compress older turns into an in-place checkpoint (0 LLM tokens)' },
    { command: 'doctor', usage: '/doctor', description: 'Run 6-subsystem harness health diagnostics' },
    { command: 'dream', usage: '/dream', description: 'Consolidate curated memory files (0 LLM tokens)' },
    { command: 'brief', usage: '/brief [focus]', description: 'Structured multi-TF desk brief on active symbol' },
    { command: 'audit', usage: '/audit [focus]', description: 'Counter-thesis check on every drawn #D shape' },
    { command: 'scan', usage: '/scan [symbols]', description: 'Run multi-TF confluence scan across watchlist' },
    { command: 'handoff', usage: '/handoff', description: 'Mint a fresh session with a compact checkpoint' },
];

export type PlanSlashAction =
    | { action: 'toggle' }
    | { action: 'on' }
    | { action: 'off' }
    | { action: 'invalid'; usage: string };

/** Parse `/plan` arguments safely so trailing whitespace or invalid args never fall through to LLM send. */
export const parsePlanSlashArgs = (rest: string): PlanSlashAction => {
    const arg = (rest ?? '').trim().toLowerCase();
    if (!arg) return { action: 'toggle' };
    if (arg === 'on' || arg === 'true' || arg === 'enable') return { action: 'on' };
    if (arg === 'off' || arg === 'false' || arg === 'disable') return { action: 'off' };
    return { action: 'invalid', usage: 'Usage: `/plan`, `/plan on`, or `/plan off` (Shift+Tab also toggles when focused in the composer).' };
};

/** The draft's slash template, or null. Matches only at position 0. */
export const slashTemplateOf = (text: string): SlashTemplate | null => {
    const m = /^\/(plan|context|compact|doctor|dream|brief|audit|scan|handoff)\b/i.exec(text.trim());
    return m ? (m[1].toLowerCase() as SlashTemplate) : null;
};

export interface SlashSkillInvocation {
    slug: string;
    rest: string;
}

/**
 * Parse a leading `/<skill-slug> [rest]` command against installed skill slugs.
 * Built-in slash templates (`/plan`, `/context`, etc.) take precedence and return null here.
 */
export const parseSlashSkillInvocation = (
    text: string,
    availableSlugs: readonly string[],
): SlashSkillInvocation | null => {
    const trimmed = (text ?? '').trim();
    if (!trimmed.startsWith('/') || slashTemplateOf(trimmed)) return null;
    const m = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(trimmed);
    if (!m) return null;
    const wanted = m[1].toLowerCase();
    const matched = availableSlugs.find(s => s.trim().toLowerCase() === wanted);
    if (!matched) return null;
    return {
        slug: matched,
        rest: (m[2] ?? '').trim(),
    };
};

/** Expand a NON-special slash template into its desk instruction. `/plan`,
 *  `/context`, `/doctor`, `/handoff`, and `/dream` are handled locally. */
export const expandSlashTemplate = (
    template: SlashTemplate,
    ctx: { symbol: string; interval: string },
    rest: string,
): string => {
    const tail = rest.trim();
    switch (template) {
        case 'brief':
            return `Give me a STRUCTURED desk brief on ${ctx.symbol} ${ctx.interval}: (1) trend read per timeframe from the packet, (2) nearest levels with distances, (3) funding/OI stance, (4) one sentence: is there a trade here now or WAIT${tail ? ` — focus: ${tail}` : ''}. Plan format if a trade exists.`;
        case 'audit':
            return `AUDIT my current chart setup on ${ctx.symbol} ${ctx.interval}: run the counter-thesis check on every #D shape on screen (strongest case against each), verify the levels against the tape, and flag anything whose invalidation has already broken.${tail ? ` Focus: ${tail}` : ''}`;
        case 'scan':
            return `Scan for confluence on my watchlist: run scan_confluence across the symbols I trade and rank what agrees across timeframes.${tail ? ` Symbols: ${tail}` : ''}`;
        case 'plan':
        case 'context':
        case 'compact':
        case 'doctor':
        case 'handoff':
        case 'dream':
            return tail || '';
    }
};
