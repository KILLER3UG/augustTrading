/**
 * skillFrontmatter — the ONE vocabulary of SKILL.md frontmatter keys.
 *
 * The parser (`SkillMemoryService.parseSkillMarkdown`) and the serializer
 * (`serializeSkill`) both read this list, so a key can never be "known" to one
 * and "unknown" to the other — which is exactly the drift that would silently
 * drop a third-party key on rewrite. Keys the app has semantics for are known;
 * everything else (author, license, `metadata.hermes.*`, …) is captured
 * VERBATIM and re-emitted verbatim, because a rewrite that eats a key the
 * importer's author put there is data loss the next import round-trip turns
 * into a diff the user cannot explain.
 */

/** Every key the app parses or serializes on its own behalf. */
export const KNOWN_SKILL_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
    // the portable face
    'name', 'description', 'version', 'kind', 'coin', 'timeframe', 'source',
    'direction', 'family', 'regime', 'when', 'predicate',
    'strategyFamily', 'signals', 'invalidation', 'horizon', 'sizing', 'prior',
    'audience', 'compatibility',
    // provenance
    'approvedBy', 'approvedAt', 'whyAccepted', 'reason',
    'originBotId', 'originBotName', 'originMessageId',
    // the ledger face
    'status', 'wins', 'losses', 'sample', 'consecutiveLosses', 'recentOutcomes',
    'netR', 'grossR', 'netRKnown', 'netRUnknown', 'rSampled', 'tradeIds',
    'evidenceCount', 'birthEvidence', 'lastEvidenceAt', 'shadow', 'suspendedAt',
    'disabledByUser', 'prediction', 'supersededBy', 'revisedAt',
    // The rest of the ledger face `serializeSkill` writes. Without these, a
    // rewrite reads its OWN output back as third-party keys, appends them
    // verbatim, and writes the ledger field a second time — every rewrite
    // grew another copy of `modified:` and the eval/history fields.
    'manualOnly', 'modified', 'evalVerdict', 'lastEvalAt', 'refinedAt',
    'lastMatchedAt', 'evalStreak', 'controlIds', 'controlWins', 'controlLosses',
    'overriddenIds', 'crossRegimeIds', 'regimeStats', 'claimTestedEvidence',
    'history', 'previousVersion',
]);

/**
 * The raw lines of every UNKNOWN top-level key, verbatim, in file order —
 * including the key line itself and any indented block that belongs to it
 * (that is how `metadata:` + its nested map survive). Comment lines and blank
 * lines are not captured: they are formatting, not data, and re-emitting them
 * could duplicate a decorative rule the app's own writer also draws.
 */
export const captureUnknownFrontmatter = (fm: string): string[] => {
    const lines = fm.split(/\r?\n/);
    const captured: string[] = [];
    let inUnknown: string | null = null;
    for (const line of lines) {
        const top = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):/);
        if (top) {
            inUnknown = KNOWN_SKILL_FRONTMATTER_KEYS.has(top[1]) ? null : top[1];
            if (inUnknown) captured.push(line);
            continue;
        }
        // Indented or list content belongs to whatever key is open.
        if (inUnknown && (/^[ \t]/.test(line) || /^-\s/.test(line))) captured.push(line);
    }
    return captured;
};

/** The spec's name rule: lowercase, digits, hyphens; starts alphanumeric; ≤64. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;

/**
 * Compatibility stated in the OTHER vocabulary skills arrive with.
 *
 * A SKILL.md writer declares what a skill needs as frontmatter keys —
 * `requires_tools`, `fallback_for_tools`, `platforms`, either flat or nested
 * under `metadata: hermes:` — while August keeps its own `compatibility:` JSON
 * blob. Until now only the blob was read, so an imported skill declared a
 * constraint this app never enforced: a false promise to its author, and the
 * drift the key registry exists to prevent, just on the semantics side.
 *
 * Pure text in, plain data out. Nothing here imports the skill service (the
 * parser calls it, not the other way round), and the keys it reads are still
 * captured VERBATIM by `captureUnknownFrontmatter` — reading a key is not the
 * same as owning it, and a rewrite must still emit the author's line.
 */
export interface DeclaredCompatibility {
    requiresTools?: string[];
    fallbackForTools?: string[];
    platforms?: string[];
    /** Read and reported, never acted on: August names no toolsets, so there
     *  is nothing to resolve one against. Kept distinct from the live gates so
     *  a caller can say "declared, inert" instead of pretending. */
    requiresToolsets?: string[];
    fallbackForToolsets?: string[];
}

/** The declaration keys this app gives meaning to, in the spelling the file
 *  uses. `requires_toolsets` / `fallback_for_toolsets` are recorded, not honoured. */
const DECLARED_KEYS: Readonly<Record<string, keyof DeclaredCompatibility>> = {
    requires_tools: 'requiresTools',
    requiresTools: 'requiresTools',
    fallback_for_tools: 'fallbackForTools',
    fallbackForTools: 'fallbackForTools',
    platforms: 'platforms',
    requires_toolsets: 'requiresToolsets',
    requiresToolsets: 'requiresToolsets',
    fallback_for_toolsets: 'fallbackForToolsets',
    fallbackForToolsets: 'fallbackForToolsets',
};

interface Node { inline: string; items: string[]; children: Map<string, Node>; }

/** The YAML subset a frontmatter block actually uses: `key: value`,
 *  `key: [a, b]`, a `key:` followed by `- item` lines, nesting by indentation,
 *  and quoted scalars. Anything richer stays in the verbatim capture — this
 *  reader is deliberately not a YAML implementation, and a key it cannot read
 *  is a key that declares no constraint rather than a guess at one. */
const parseBlock = (text: string): Map<string, Node> => {
    const root = new Map<string, Node>();
    const stack: Array<{ indent: number; node: Node | null; map: Map<string, Node> }> =
        [{ indent: -1, node: null, map: root }];
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const indent = line.length - trimmed.length;
        while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
        const frame = stack[stack.length - 1];
        const kv = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(trimmed);
        if (kv) {
            const node: Node = { inline: kv[2].trim(), items: [], children: new Map() };
            frame.map.set(kv[1], node);
            stack.push({ indent, node, map: node.children });
            continue;
        }
        const item = /^-\s*(.*)$/.exec(trimmed);
        if (item && frame.node) {
            frame.node.items.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
            continue;
        }
        // A line this reader cannot place (a folded scalar, a nested map under a
        // list item) ends the block it would have belonged to. Ignoring it is
        // honest: no constraint is asserted that the file did not plainly state.
        if (frame.node) frame.node.inline = frame.node.inline || '';
    }
    return root;
};

const unquote = (v: string): string => v.trim().replace(/^['"]|['"]$/g, '');

/** One node's value as a list, in whichever of the three forms it appears. */
const listOf = (node: Node | undefined): string[] | undefined => {
    if (!node) return undefined;
    if (node.items.length > 0) return node.items.map(unquote).filter(Boolean);
    const inline = node.inline.trim();
    if (!inline) return undefined;
    if (inline.startsWith('[')) {
        const close = inline.lastIndexOf(']');
        const inner = close > 0 ? inline.slice(1, close) : inline.slice(1);
        return inner.split(',').map(unquote).filter(Boolean);
    }
    return [unquote(inline)].filter(Boolean);
};

const metadataHermes = (tree: Map<string, Node>): Map<string, Node> | undefined => {
    const meta = tree.get('metadata');
    if (!meta) return undefined;
    const nested = meta.children.get('hermes');
    if (nested) return nested.children;
    // `metadata: {"hermes": {…}}` — the inline-JSON form this app's own
    // serializer uses for a map inside a YAML scalar.
    const inline = meta.inline.trim();
    if (!inline.startsWith('{')) return undefined;
    try {
        const parsed: unknown = JSON.parse(inline);
        const hermes = (parsed as { hermes?: unknown })?.hermes;
        if (!hermes || typeof hermes !== 'object' || Array.isArray(hermes)) return undefined;
        const out = new Map<string, Node>();
        for (const [key, value] of Object.entries(hermes as Record<string, unknown>)) {
            out.set(key, Array.isArray(value)
                ? { inline: '', items: value.map(v => String(v)), children: new Map() }
                : { inline: typeof value === 'string' ? value : JSON.stringify(value), items: [], children: new Map() });
        }
        return out;
    } catch { return undefined; }
};

/** Read every declaration the block makes, nested first, flat second. */
export const declaredCompatibility = (frontmatter: string): DeclaredCompatibility => {
    const tree = parseBlock(frontmatter || '');
    const hermes = metadataHermes(tree);
    const out: Record<string, string[]> = {};
    for (const [rawKey, field] of Object.entries(DECLARED_KEYS)) {
        const found = [...(listOf(hermes?.get(rawKey)) ?? []), ...(listOf(tree.get(rawKey)) ?? [])]
            .map(v => String(v).trim())
            .filter(Boolean);
        const merged = [...new Set(found)];
        if (merged.length) out[field] = merged;
    }
    return out as DeclaredCompatibility;
};

/** Which declared keys this app can honour, and which it cannot say it will.
 *  Used by the review and the import receipt so an author is told the truth
 *  about a key that round-trips and does nothing. */
export const inertDeclaredKeys = (declared: DeclaredCompatibility): string[] => [
    ...(declared.requiresToolsets ? ['requires_toolsets'] : []),
    ...(declared.fallbackForToolsets ? ['fallback_for_toolsets'] : []),
];

/**
 * Face validation for import and discovery. Returns one issue per problem, in
 * the caller's display vocabulary — empty array means the face is valid. A
 * skill with issues is SKIPPED with these reasons logged, never silently
 * filtered and never allowed to break discovery of the others.
 */
export const skillFaceIssues = (face: { name: string; description: string; body: string }): string[] => {
    const issues: string[] = [];
    if (!face.name || !face.name.trim()) issues.push('missing required name');
    else if (face.name.length > SKILL_NAME_MAX) issues.push(`name longer than ${SKILL_NAME_MAX} chars`);
    else if (!SKILL_NAME_PATTERN.test(face.name)) issues.push('name must be lowercase letters, digits and hyphens');
    if (!face.description || !face.description.trim()) issues.push('missing required description');
    else if (face.description.length > SKILL_DESCRIPTION_MAX) issues.push(`description longer than ${SKILL_DESCRIPTION_MAX} chars`);
    if (!face.body || !face.body.trim()) issues.push('empty body');
    return issues;
};

/**
 * `platforms:` values this app understands, mapped onto the three runtimes it
 * actually has (browser, Electron desktop, Capacitor mobile). Anything else
 * (freebsd, …) is unmapped — an all-unmapped list states no constraint for a
 * runtime we ship, which is the tolerant reading, not the silent-drop one.
 */
export type SkillRuntime = 'web' | 'desktop' | 'mobile';

export const PLATFORM_OF: Readonly<Record<string, SkillRuntime>> = {
    web: 'web',
    webui: 'web',
    browser: 'web',
    desktop: 'desktop',
    electron: 'desktop',
    macos: 'desktop',
    mac: 'desktop',
    linux: 'desktop',
    windows: 'desktop',
    native: 'mobile',
    android: 'mobile',
    ios: 'mobile',
    mobile: 'mobile',
};

/**
 * Invocation control, enforced: does THIS runtime satisfy the skill's declared
 * compatibility? `platforms` hides a skill on runtimes it does not name;
 * `requiresTools` hides it when the desk does not expose a tool it needs;
 * `requiresEnv` hides it always in a renderer — there is no honest way to
 * verify an environment variable from the app's process, and a constraint
 * that cannot be checked must fail closed, not pass silently. Absent
 * compatibility = no constraint, exactly as before the key existed.
 */
export const skillRunsHere = (
    compat: {
        platforms?: string[]; requiresTools?: string[]; requiresEnv?: string[];
        fallbackForTools?: string[]; fallbackForToolsets?: string[];
    } | undefined,
    runtime: SkillRuntime,
    availableTools: ReadonlySet<string> | readonly string[],
): boolean => {
    if (!compat) return true;
    if (compat.requiresEnv && compat.requiresEnv.length > 0) return false;
    if (compat.platforms?.length) {
        const mapped = compat.platforms.map(p => PLATFORM_OF[(p || '').toLowerCase()]).filter(Boolean);
        // Only entries that map count: [freebsd] is unreadable, not refused.
        if (mapped.length > 0 && !mapped.includes(runtime)) return false;
    }
    const have = availableTools instanceof Set ? availableTools : new Set(availableTools);
    if (compat.requiresTools?.length) {
        if (!compat.requiresTools.every(t => have.has(t))) return false;
    }
    // `fallback_for_tools` is the inverse gate, and it means what it says: the
    // skill exists to cover a tool the desk does not have. So once that tool IS
    // available the skill stops being injected — a procedure that duplicates a
    // live tool taxes every prompt for nothing, which is the failure the
    // starter shelf's approval exists to avoid.
    if (compat.fallbackForTools?.length) {
        if (compat.fallbackForTools.some(t => have.has(t))) return false;
    }
    // `fallback_for_toolsets` stays tolerated-but-inert on purpose: August has
    // no named toolsets, so there is nothing to resolve a set name against.
    // It round-trips untouched and gates nothing; guessing a set out of tool
    // names would make a skill invisible for a reason no author wrote.
    return true;
};

/** Authoring caps: ~200 lines soft (warn, suggest `references/`), 100k chars
 *  hard (refuse). Long material belongs in a bundled file, not the body. */
export const SKILL_BODY_SOFT_LINES = 200;
export const SKILL_BODY_HARD_CHARS = 100_000;

export const skillBodyCaps = (body: string): { lines: number; chars: number; overSoft: boolean; overHard: boolean } => {
    const lines = body.split('\n').length;
    const chars = body.length;
    return { lines, chars, overSoft: lines > SKILL_BODY_SOFT_LINES, overHard: chars > SKILL_BODY_HARD_CHARS };
};

// ── THE ONE FORMAT, AUDITED (2026-11-03) ────────────────────────────────────
// A skill is a slug-named file carrying ONE `when` trigger, a description the
// index and recall read, and a non-empty procedure body inside the caps. The
// draft gates and the craft enforce this on the way in; this audit is the gate
// for everything ALREADY in the library — an imported file, a hand-edited one,
// a pre-format legacy file — so the Health tab can name every file that does
// not follow the same shape as the rest. Structural input on purpose: the
// checker never imports the service layer's types.

export interface SkillFormatInput {
    fileName: string;
    when?: string;
    description?: string;
    body?: string;
}

/** Every reason `fileName` does not follow the one format. Empty = conforms. */
export const skillFormatIssues = (input: SkillFormatInput): string[] => {
    const issues: string[] = [];
    const slug = input.fileName.replace(/\.md$/i, '');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
        issues.push('file name is not a slug (lowercase letters, digits, hyphens, up to 64)');
    }
    if (!input.when || !input.when.trim()) {
        issues.push('no `when` trigger — the one checkable sentence a match reads');
    }
    if (!input.description || !input.description.trim()) {
        issues.push('no `description` — the skills index and the recall tool read it');
    }
    if (!input.body || !input.body.trim()) {
        issues.push('empty procedure body — the format is one trigger plus steps');
    } else {
        const caps = skillBodyCaps(input.body);
        if (caps.overHard) issues.push(`body is over the ${SKILL_BODY_HARD_CHARS}-character hard cap`);
    }
    return issues;
};

/** The missing face, DERIVED from what the file already says.
 *
 *  The gate can refuse a new file before it is written, but an existing file
 *  is bytes a trader can see: deleting it because its frontmatter is old is
 *  worse than filling in the one key it lacks. So the repair reads, in order,
 *  the `when` key, the body's own `**When:**` line, a "Use this skill
 *  whenever …" description, and finally the first prose line for a
 *  description. Nothing is invented when the file states nothing — the caller
 *  keeps the file and reports it instead. Pure text in, fields out, so the
 *  gate can pin the derivation without a notebook. */
export interface SkillFaceDefaults {
    when?: string;
    description?: string;
}

export const deriveSkillFace = (input: {
    when?: string;
    description?: string;
    body?: string;
}): SkillFaceDefaults => {
    const body = input.body ?? '';
    const clean = (value?: string): string | undefined => {
        const text = (value ?? '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
        return text ? text.slice(0, 280) : undefined;
    };
    const whenFromKey = clean(input.when);
    const whenFromBody = clean(/^\*\*When:\*\*\s*(.+)$/im.exec(body)?.[1])
        ?? clean(/^##\s*When to use\s*\n+([^\n#]+)$/im.exec(body)?.[1]);
    const whenFromDescription = clean(
        /^use (?:this skill )?whenever\s+(.+?)(?:\.\s+do not use for|$)/im.exec(input.description ?? '')?.[1],
    );
    const when = whenFromKey ?? whenFromBody ?? whenFromDescription;
    const description = clean(input.description)
        ?? (when ? `Use this skill whenever ${when}.` : undefined)
        ?? clean(body.split(/\n\s*\n/).map(p => p.trim()).find(p => p && !/^[#*\-0-9]/.test(p)));
    return {
        ...(when ? { when } : {}),
        ...(description ? { description } : {}),
    };
};

/** A description that tells the model WHEN to use the skill — the trigger —
 *  in the same spirit as the spec's "Use when / Don't use for". Warned on at
 *  authoring, never blocking. */
/**
 * Stamp the provenance of a skill the user imported, unless the author
 * already declared one.
 *
 * Text-level on purpose: the import path must not reserialize a third-party
 * skill — its body, key order and comments belong to its author. A missing
 * `source` currently renders as "seeded" in the skills library, which is a
 * false label for a file that arrived from outside; `imported` is the truth,
 * and the author's own value (when present) always wins.
 */
export const stampImportedSource = (content: string, source = 'imported'): string => {
    const match = /^---(\r?\n)([\s\S]*?)\r?\n---/.exec(content);
    if (!match) return content;
    if (/^\s*source\s*:/m.test(match[2])) return content;
    const nl = match[1];
    const closingAt = match.index + match[0].length - 3;
    const insertAt = closingAt - nl.length;
    return `${content.slice(0, insertAt)}${nl}source: ${source}${content.slice(insertAt)}`;
};

export const hasUseWhenTrigger = (description: string): boolean =>
    /\b(?:use when|use this when|when|if|whenever|for|during|before|after)\b/i.test(description);

/**
 * Import scan for third-party skill text (item 6): exfiltration and
 * destructive-command patterns a skill body or bundled file must not carry.
 * Returns one finding per hit, human-readable. DESTRUCTIVE findings refuse
 * the import; EXFIL findings refuse too — a procedure that phones home is
 * not a procedure this app runs, and there is no terminal tool to run it on.
 */
export type ScanSeverity = 'destructive' | 'exfil' | 'policy';

const SCAN_PATTERNS: Array<{ re: RegExp; severity: ScanSeverity; what: string }> = [
    { re: /\brm\s+-rf\b|\bmkfs\b|\bdd\s+if=/i, severity: 'destructive', what: 'a destructive filesystem command (rm -rf / mkfs / dd)' },
    { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};\s*:/, severity: 'destructive', what: 'a fork bomb' },
    { re: /\b(?:curl|wget)\b[^\n]*\|\s*(?:ba)?sh/i, severity: 'exfil', what: 'a piped shell download (curl|sh)' },
    { re: /\bbase64\s+(-d|--decode)\b/i, severity: 'exfil', what: 'inline base64 decoding' },
    { re: /\b(?:cat|type)\b[^\n]*(?:\.ssh|id_rsa|credentials|\.env|\.aws)\b/i, severity: 'exfil', what: 'a credential-file read' },
    { re: /\b(?:nc|ncat|netcat)\b[^\n]*\s-e\b/i, severity: 'exfil', what: 'a netcat reverse shell' },
    { re: /\bhttps?:\/\/[^\s]*(?:token|key|secret|password)=[^\s]+/i, severity: 'exfil', what: 'a URL carrying a credential parameter' },
    // A third-party procedure has no business telling the seat to write the
    // trader into its collaboration memory. It is not code execution, but it
    // is an instruction to change future prompts, so it refuses at the door.
    { re: /\b(?:remember|memorize)\b[^\n]{0,80}\b(?:the\s+)?(?:user|trader)\b/i, severity: 'policy', what: 'an instruction to write the user into memory' },
    { re: /\b(?:write|save|store)\b[^\n]{0,40}\b(?:to\s+)?memory\b/i, severity: 'policy', what: 'an instruction to write memory' },
];

export const scanSkillText = (text: string): Array<{ severity: ScanSeverity; what: string }> => {
    const hits: Array<{ severity: ScanSeverity; what: string }> = [];
    for (const { re, severity, what } of SCAN_PATTERNS) {
        if (re.test(text)) hits.push({ severity, what });
    }
    return hits;
};

/**
 * ── Support-file references (item 6's URL import) ──────────────────────────
 * A SKILL.md folder keeps its extra material in four role directories beside
 * the head file. When a skill arrives by URL instead of as a picked folder,
 * the body is the ONLY manifest of what else exists, so those four prefixes
 * are the whitelist of what the fetcher may even consider.
 *
 * The match is anchored on the role, not on a filename-looking word: a
 * reference must read `references/x.md`, so `See the references folder`,
 * an absolute URL and a bare word all yield nothing. The lookbehind rejects a
 * `/`, `:` or word character before the role, which is what keeps
 * `https://other.example/references/a.md` out of the candidate set — that is
 * another site's path that merely happens to be spelled like a role.
 */
export const SKILL_SUPPORT_ROLES = ['references', 'templates', 'scripts', 'assets'] as const;

/** How many siblings one URL import will fetch. A skill naming more is not a
 *  skill this notebook has room for, and the remainder is REPORTED, never
 *  silently dropped — so discovery returns MAX + 1 and the extra slot is the
 *  caller's proof that there was an overflow to announce. */
export const SKILL_SUPPORT_REF_MAX = 12;

const SUPPORT_REF_RE = /(?<![\w./-])(?:references|templates|scripts|assets)\/[^\s)\]'"<>,;:#]+/g;

export const skillSupportRefs = (text: string): string[] => {
    const found: string[] = [];
    const seen = new Set<string>();
    for (const raw of text.match(SUPPORT_REF_RE) ?? []) {
        const ref = raw.replace(/[.,;:!?]+$/, '');
        // Only "is this a file at all" is decided here. Path legality is NOT:
        // a `references/../../env.md` escape must reach resolveSiblingUrl so
        // the receipt can say it was refused, instead of the author's named
        // file vanishing without a word.
        const last = ref.split('/').pop() ?? '';
        if (!/\.[A-Za-z0-9]{1,10}$/.test(last)) continue;
        if (seen.has(ref)) continue;
        seen.add(ref);
        found.push(ref);
        if (found.length > SKILL_SUPPORT_REF_MAX) break;
    }
    return found;
};

/**
 * Resolve one support reference against the SKILL.md it was named in, or say
 * why it is not fetched. Pure, and it runs BEFORE any request leaves.
 *
 * Two layers, and they are not equally load-bearing. The textual rules
 * (scheme, `//`, leading `/`, `..`) give the precise reason and stop anything
 * a body could spell normally. The RESOLVED checks are what actually holds,
 * because the URL parser treats `\` as `/` for an https base — so
 * `references\..\..\env.md` sails through every textual rule and is caught
 * only by "the resolved path is still under the head file's own folder".
 * Measured with .verify/url-ref-probe.cjs, not assumed. The host lock is the
 * same kind of second guard: discovery's role prefix makes a cross-host ref
 * unreachable today, and a guard at an untrusted-text boundary should not
 * depend on that staying true.
 */
export type SiblingUrl = { ok: true; url: string } | { ok: false; reason: string };

export const resolveSiblingUrl = (head: URL, ref: string): SiblingUrl => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return { ok: false, reason: 'it names its own scheme — a URL import fetches only siblings beside the SKILL.md' };
    if (ref.startsWith('//')) return { ok: false, reason: 'it is protocol-relative — a URL import fetches only siblings beside the SKILL.md' };
    if (ref.startsWith('/')) return { ok: false, reason: 'it is an absolute path — a URL import fetches only siblings beside the SKILL.md' };
    if (ref.split('/').some(s => s === '' || s === '.' || s === '..')) return { ok: false, reason: 'it tries to leave the skill folder (.. or an empty segment)' };
    let abs: URL;
    try { abs = new URL(ref, head) } catch { return { ok: false, reason: 'it is not a usable path' } }
    if (abs.protocol !== 'https:') return { ok: false, reason: `it resolves to ${abs.protocol}// — only https:// is fetched` };
    if (abs.host !== head.host) return { ok: false, reason: `it points at ${abs.host}, not ${head.host} — only the skill's own server is fetched` };
    const folderPath = decodeURIComponent(head.pathname).replace(/[^/]*$/, '');
    const resolvedPath = decodeURIComponent(abs.pathname);
    if (!resolvedPath.startsWith(folderPath) || resolvedPath.split('/').some(s => s === '..')) {
        return { ok: false, reason: `it resolves to ${resolvedPath}, outside the skill's own folder` };
    }
    return { ok: true, url: abs.toString() };
};
