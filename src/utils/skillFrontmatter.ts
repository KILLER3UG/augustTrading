/**
 * The two things an imported skill must survive that are not about format:
 * a security scan, and the paths of the files bundled beside it.
 *
 * The old module also owned a frontmatter key registry, compatibility gates,
 * body caps and a format repair pass. All of that went with the skill ledger:
 * a skill is a document, and the app does not rewrite one ON ITS OWN — the
 * one rewrite path is `services/learning/SkillFormatService.ts`, at the
 * trader's explicit request and still through the store's write path.
 */

/** Exfiltration and destructive-command patterns a skill body or bundled file
 *  must not carry. DESTRUCTIVE and EXFIL findings refuse the import; POLICY
 *  findings refuse an instruction to write the trader into memory. */
export type ScanSeverity = 'destructive' | 'exfil' | 'policy';

const SCAN_PATTERNS: Array<{ re: RegExp; severity: ScanSeverity; what: string }> = [
    { re: /\brm\s+-rf\b|\bmkfs\b|\bdd\s+if=/i, severity: 'destructive', what: 'a destructive filesystem command (rm -rf / mkfs / dd)' },
    { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};\s*:/, severity: 'destructive', what: 'a fork bomb' },
    { re: /\b(?:curl|wget)\b[^\n]*\|\s*(?:ba)?sh/i, severity: 'exfil', what: 'a piped shell download (curl|sh)' },
    { re: /\bbase64\s+(-d|--decode)\b/i, severity: 'exfil', what: 'inline base64 decoding' },
    { re: /\b(?:cat|type)\b[^\n]*(?:\.ssh|id_rsa|credentials|\.env|\.aws)\b/i, severity: 'exfil', what: 'a credential-file read' },
    { re: /\b(?:nc|ncat|netcat)\b[^\n]*\s-e\b/i, severity: 'exfil', what: 'a netcat reverse shell' },
    { re: /\bhttps?:\/\/[^\s]*(?:token|key|secret|password)=[^\s]+/i, severity: 'exfil', what: 'a URL carrying a credential parameter' },
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

/** The four role directories a skill folder may carry. */
export const SKILL_SUPPORT_ROLES = ['references', 'templates', 'scripts', 'assets'] as const;

/** The headings a skill body reads best with, in order. `skillFormatIssues`
 *  reports a missing heading and the LOAD path drops a row that carries an
 *  issue; the STORE stays permissive so a sectionless create remains legal.
 *  The editor hint and the `skill_write` body description both name these,
 *  from this one list. */
export const SKILL_BODY_SECTIONS = ['When to use', 'Steps', 'Pitfalls', 'Verification'] as const;

/** The suggested headings a body does not have yet, read off its `## `
 *  headings case-insensitively (closing hashes tolerated). */
export const missingSkillSections = (body: string): string[] => {
    const present = new Set<string>();
    for (const match of (body || '').matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
        present.add(match[1].trim().toLowerCase());
    }
    return SKILL_BODY_SECTIONS.filter(section => !present.has(section.toLowerCase()));
};

/** What a SKILL.md must carry to BE a skill, as opposed to a stray markdown
 *  file. One list, so the editor's create check, the card's indicator, the
 *  detail banner and the model's rewrite all read the same definition instead
 *  of four copies that drift. */
export interface SkillFormatIssue {
    kind: 'frontmatter' | 'name' | 'description' | 'body' | 'section';
    what: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Every way this SKILL.md departs from the format, most fundamental first.
 *  Empty means it conforms. Deliberately a CHECK and not a repair: the app
 *  does not rewrite a trader's prose, so the answers are "show the trader"
 *  and "ask the model", never "fix it silently". */
export const skillFormatIssues = (content: string): SkillFormatIssue[] => {
    const issues: SkillFormatIssue[] = [];
    const text = content || '';
    const match = FRONTMATTER_RE.exec(text);
    if (!match) {
        issues.push({ kind: 'frontmatter', what: 'no --- fence around a name and description' });
    } else {
        const head = match[1];
        if (!/^\s*name\s*:/m.test(head)) issues.push({ kind: 'name', what: 'no name: in the frontmatter' });
        if (!/^\s*description\s*:/m.test(head)) {
            issues.push({ kind: 'description', what: 'no description: in the frontmatter' });
        }
    }
    // A file with no fence is judged on its whole text: refusing it outright
    // would report a missing body for a document that is nothing BUT body.
    const body = (match ? match[2] : text).trim();
    if (!body) {
        issues.push({ kind: 'body', what: 'no body under the frontmatter' });
    } else {
        for (const section of missingSkillSections(body)) {
            issues.push({ kind: 'section', what: `no ## ${section} heading` });
        }
    }
    return issues;
};

export const skillIsFormatted = (content: string): boolean => skillFormatIssues(content).length === 0;

/** How many siblings one URL import will fetch. */
export const SKILL_SUPPORT_REF_MAX = 12;

const SUPPORT_REF_RE = /(?<![\w./-])(?:references|templates|scripts|assets)\/[^\s)\]'"<>,;:#]+/g;

export const skillSupportRefs = (text: string): string[] => {
    const found: string[] = [];
    const seen = new Set<string>();
    for (const raw of text.match(SUPPORT_REF_RE) ?? []) {
        const ref = raw.replace(/[.,;:!?]+$/, '');
        const last = ref.split('/').pop() ?? '';
        if (!/\.[A-Za-z0-9]{1,10}$/.test(last)) continue;
        if (seen.has(ref)) continue;
        seen.add(ref);
        found.push(ref);
        if (found.length > SKILL_SUPPORT_REF_MAX) break;
    }
    return found;
};

export type SiblingUrl = { ok: true; url: string } | { ok: false; reason: string };

/** Resolve one support reference against the SKILL.md it was named in, or say
 *  why it is not fetched. The resolved checks are what holds: the URL parser
 *  treats a backslash as a slash for an https base, so textual rules alone
 *  would let `references..\..\env.md` through. */
export const resolveSiblingUrl = (head: URL, ref: string): SiblingUrl => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return { ok: false, reason: 'it names its own scheme - a URL import fetches only siblings beside the SKILL.md' };
    if (ref.startsWith('//')) return { ok: false, reason: 'it is protocol-relative - a URL import fetches only siblings beside the SKILL.md' };
    if (ref.startsWith('/')) return { ok: false, reason: 'it is an absolute path - a URL import fetches only siblings beside the SKILL.md' };
    if (ref.split('/').some(s => s === '' || s === '.' || s === '..')) return { ok: false, reason: 'it tries to leave the skill folder (.. or an empty segment)' };
    let abs: URL;
    try { abs = new URL(ref, head) } catch { return { ok: false, reason: 'it is not a usable path' } }
    if (abs.protocol !== 'https:') return { ok: false, reason: `it resolves to ${abs.protocol}// - only https:// is fetched` };
    if (abs.host !== head.host) return { ok: false, reason: `it points at ${abs.host}, not ${head.host} - only the skill's own server is fetched` };
    const folderPath = decodeURIComponent(head.pathname).replace(/[^/]*$/, '');
    const resolvedPath = decodeURIComponent(abs.pathname);
    if (!resolvedPath.startsWith(folderPath) || resolvedPath.split('/').some(s => s === '..')) {
        return { ok: false, reason: `it resolves to ${resolvedPath}, outside the skill's own folder` };
    }
    return { ok: true, url: abs.toString() };
};
