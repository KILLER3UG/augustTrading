/**
 * skillReview — the DETERMINISTIC half of "review all my skills".
 *
 * The app has three ways to answer "is this skill file healthy?" and until now
 * they disagreed:
 *
 *  - `listSkills()` (SkillMemoryService.ts) DROPS a file that does not parse.
 *  - the retrieval (MemoryRetrievalService.ts) never sees it either.
 *  - the IMPORT path rejects the same file WITH A REASON (SkillImportService.ts).
 *
 * So one file gets two opposite answers depending on how it arrived, and in
 * the meantime it sits in the notebook, in the backup and in the export,
 * appearing in NO list — including the Health card, whose report already
 * computed the count of files and the count of parsed metas and threw the
 * difference away.
 *
 * This module is that difference, made visible. It is a **pure read**: it
 * mutates nothing, queues nothing, calls no model and needs no provider. It
 * audits every file in the skills folder and returns ONE verdict per file with
 * the evidence behind it.
 *
 * ## The four verdicts
 *
 *  - **ghost** — the file is in the skills folder and does not parse. It is
 *    invisible to every list, so it is reported with the FIRST FAILING LINE,
 *    never a generic "invalid".
 *  - **dormant** — it parses, but it has no structured trigger and its
 *    description is the `serializeSkill` FALLBACK rather than an authored one.
 *    A dormant skill is a WARNING, not a defect: a general rule is *meant* to
 *    be unscoped. It also occupies one of the 30 index slots in file order and
 *    will never fire.
 *  - **clipped** — the recall card (`projectSkillCard`) drops characters, so
 *    the seat gets HALF a procedure in every prompt. The count is reported.
 *  - **fine** — everything checks out.
 *
 * ## What this module deliberately does NOT say
 *
 * "Never fired" is NOT a verdict. The injection log is run-capped
 * (`MemoryInjectionService`, newest-first, `MAX_INJECTION_RECORDS` runs), so
 * absence from it is the same fact as "aged out of the retained window" and
 * most notebook folders are never named in a source record at all. The repo
 * already refuses to conflate "never served" with "aged out"
 * (`memoryHealth.ts:15-18`). So "never observed" is offered only as an
 * OPTIONAL HINT the caller supplies — this module never reads the log, so it
 * can never make that claim on its own.
 *
 * ## The repairs
 *
 * A repair is a PROPOSAL, never an application. The one this module can build
 * without a model is a ghost reconstruction: the file's OWN words (its H1 and
 * its first prose line) put back into a valid frontmatter, with the counters
 * at ZERO and the status `candidate` — so a repaired ghost can never claim
 * evidence it never earned. Everything else (writing a real trigger for a
 * dormant skill, shortening a clipped body) needs a model and is stage 2.
 *
 * Both halves are QUEUED rather than applied in place
 * (`utils/learningQueue.ts`); the learning heartbeat applies the applyable
 * ones automatically (owner ruling 2026-11-03: no approval inbox), and a row
 * whose write is refused keeps its attempt budget.
 */

import { getMemoryFiles } from './MemoryFilesService';
import {
    frontmatterName,
    isSkillFile,
    isSpecShapedSkillFile,
    LEDGER_MARKER,
    parseSkillMarkdown,
    serializeSkill,
    skillBody,
    skillFileNameFor,
    titleFromMeta,
    type SkillMeta,
} from './SkillMemoryService';
import { parseSkillBody, projectSkillCard } from './skillDocument';
import type { MemoryFile } from '../../types';

/**
 * The recall tier's body cap — the budget `MemoryRetrievalService` charges the
 * pull tier (`RECALL_SKILL_BODY_MAX`, a module-private constant there).
 *
 * It is re-declared here rather than imported because that module is not on
 * this change's file list, and the two MUST agree: a card that fits here but
 * is clipped in the prompt would make this report lie.
 * `tests/planE48SkillReview.test.ts` pins the equality by reading the source,
 * which is the same "pin it by source" trick `tests/deskToolCache.test.ts`
 * uses.
 */
export const SKILL_REVIEW_RECALL_BUDGET = 700;

/** The verdict vocabulary. */
export type SkillReviewVerdict = 'fine' | 'dormant' | 'clipped' | 'ghost';

/** Where a file's frontmatter contract fails, and on WHICH line. */
export interface SkillReviewParseFailure {
    /** 1-based line number of the first line that breaks the contract. */
    line: number;
    /** That line's text (trimmed, capped at 200 chars). */
    text: string;
    /** WHY it breaks — never a generic "invalid". */
    reason: string;
}

/** The per-skill format checks, reported for every file that parses. */
export interface SkillReviewChecks {
    /** The file parses as a skill. */
    parses: boolean;
    /** parse → serialize → parse leaves the same values. */
    roundTrips: boolean;
    /** The frontmatter carries a `name:`. */
    namePresent: boolean;
    /** …and it is within the spec's 64-character cap. */
    nameWithinLimit: boolean;
    /** The description is present and non-empty. */
    descriptionPresent: boolean;
    /** The description is the `serializeSkill` fallback, not an authored one. */
    descriptionIsFallback: boolean;
    /** HINT: the description appears to NAME a trigger ("whenever …"). */
    descriptionNamesTrigger: boolean;
    /** The skill carries a structured trigger (`when`). */
    hasStructuredTrigger: boolean;
    /** The portable/ledger split marker is present in the file. */
    ledgerSplitIntact: boolean;
    /** Every body heading is one the body parser recognises. */
    sectionsRecognised: boolean;
    /** The headings the body parser did NOT recognise (kept, never dropped). */
    unrecognisedSections: string[];
    /** How many characters the recall card would drop. */
    droppedChars: number;
    /** The body length before projection. */
    bodyChars: number;
    /** The file name is the one `skillFileNameFor` resolves for this skill. */
    fileNameMatchesSkill: boolean;
    /** The file is named like the Agent Skills convention's `SKILL.md`. */
    specShapedName: boolean;
}

/** A repair this verdict could support. NEVER applied here. */
export interface SkillReviewRepair {
    /**
     * What the repair does.
     *
     *  - `reconstruct` — rebuild a valid frontmatter around a ghost's own
     *    text. The only repair this module can build without a model.
     *  - `demote` / `archive` / `rewrite` — reserved for the model-assisted
     *    stage (2). They are named here so a caller can queue one without
     *    this module having to invent its text.
     */
    kind: 'demote' | 'rewrite' | 'archive' | 'reconstruct';
    /** The text as it is now. */
    before: string;
    /** The text the repair would write. */
    after: string;
    /**
     * TRUE when the repair WIDENS the skill's reach (gives it a trigger,
     * reconstructs it, changes its description) — that ACTIVATES it, so the
     * UI must label it and the trader must confirm it, one skill at a time.
     * FALSE for narrowing (demote / archive / retire), which is safe.
     */
    widens: boolean;
    /** One line for the trader. */
    summary: string;
    /** Why the repair is proposed. */
    reason: string;
    /**
     * The closest EXISTING `LearningProposalKind` this repair could ride.
     * `utils/learningQueue.ts` has no "reconstruct" kind, and that file is not
     * on this change's list — so a caller either maps it onto 'rewrite' or
     * asks for a new kind to be added.
     */
    queueKind: 'rewrite';
}

export interface SkillReviewFinding {
    /** The skill's `MemoryFile.id` — that is what the catalog row opens. */
    fileId: string;
    /** The file's name, for the report row. */
    name: string;
    verdict: SkillReviewVerdict;
    /**
     * ONE sentence, in the trader's words: what is wrong. For a ghost, the
     * FIRST FAILING LINE. For a clipped skill, how many characters are cut.
     * For a dormant skill, that it names no setup it applies to — NEVER that
     * it "never fired" (the injection log is run-capped, so absence is not
     * proof).
     */
    evidence: string;
    /** The repair, when a safe one exists. NOT applied by the UI. */
    repair?: SkillReviewRepair;

    // ── the detail behind the sentence ──
    /** The slug the rest of the app addresses this skill by. */
    slug: string;
    /** UTF-16 length of the file content. */
    chars: number;
    /** UTF-8 byte length of the file content. */
    bytes: number;
    /** Every reason behind the verdict, one short sentence each. */
    reasons: string[];
    /** The per-skill format checks. */
    checks: SkillReviewChecks;
    /** GHOST only: where and why the file fails to parse. */
    parseFailure?: SkillReviewParseFailure;
    /** The skill's description, when it parsed. */
    description?: string;
    /** The frontmatter `name:` the file carries (the spec's own identity). */
    skillName?: string;
    /** CLIPPED only: how many characters the recall card drops. */
    droppedChars?: number;
    /**
     * HINT ONLY — never the proof of anything, and never a verdict. True when
     * the CALLER says the skill was never observed in the retained injection
     * window. Undefined when no hint was supplied.
     */
    neverObserved?: boolean;
}

export interface SkillReviewReport {
    findings: SkillReviewFinding[];
    /** Count per verdict, so the button can print a summary. */
    counts: Record<SkillReviewVerdict, number>;
    /** When the report was built (epoch ms). */
    generatedAt: number;
    /** The number of files that do not parse — the Health card's ghost count. */
    ghostCount: number;
}

export interface SkillReviewOptions {
    /**
     * HINT ONLY. A caller-supplied "this skill was never observed in the
     * retained injection window". The service never reads the injection log
     * itself, so the verdict can never be "it never fired" — the log is
     * run-capped and absence from it is not evidence of anything.
     */
    neverObserved?: (fileName: string) => boolean;
}

// ─── the frontmatter contract, restated ───────────────────────────────────

/** The parser's own fence rule (`parseSkillMarkdown`). A file that does not
 *  match it is a ghost, and this is the rule the failure is reported against. */
const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * The FIRST line that breaks the frontmatter contract, and why.
 *
 * A generic "invalid skill" is the one answer that helps nobody: the trader
 * cannot act on it, and the model asked to repair it has nothing to repair.
 * So the diagnosis names the line and the rule it breaks.
 */
const diagnoseFrontmatter = (content: string): SkillReviewParseFailure => {
    // Defensive: the parser accepted this content, so there is nothing to
    // diagnose. The caller only reaches here when it did not.
    if (FRONTMATTER_FENCE.test(content)) {
        return { line: 1, text: '', reason: 'the file does not parse, but its frontmatter fence looks complete' };
    }
    const lines = content.split(/\r?\n/);
    const opener = lines[0] ?? '';
    if (opener.trim() !== '---') {
        return {
            line: 1,
            text: opener.trim().slice(0, 200),
            reason: opener.trim() === ''
                ? 'the file is empty — a skill file opens with a `---` frontmatter fence'
                : 'the file does not open with a `---` frontmatter fence (the parser requires `---` on the first line)',
        };
    }
    // The opener is there. A malformed CLOSE is the common hand-edit mistake:
    // `--- ` with trailing content, or `--`.
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('---') && line.trim() !== '---') {
            return {
                line: i + 1,
                text: line.trim().slice(0, 200),
                reason: 'the closing frontmatter fence has trailing content — it must be exactly `---` on its own line',
            };
        }
    }
    const last = lines.length - 1;
    return {
        line: last + 1,
        text: (lines[last] ?? '').trim().slice(0, 200),
        reason: 'the frontmatter fence is never closed — there is no closing `---` line',
    };
};

/** Normalise a description for comparison: whitespace collapsed, capped the
 *  way `serializeSkill` caps it. */
const normDescription = (value: string): string =>
    value.replace(/\s+/g, ' ').trim().slice(0, 1024);

/**
 * Every description a skill file could be carrying WITHOUT an author having
 * written one — the `serializeSkill` fallback chain, in every shape the
 * round trip can produce.
 *
 * The chain is: the trigger, else the body's first 24 words, else the
 * title. The body's first 24 words are computed over BOTH the parsed body
 * (which keeps the `# Title` line) and the instruction body (which does not),
 * because the writer saw one and the parser sees the other — and a skill that
 * was written before the title was derived from a body without one would
 * otherwise look authored.
 */
const derivedDescriptions = (meta: SkillMeta, content: string): string[] => {
    const out = new Set<string>();
    const add = (value: string): void => {
        const norm = normDescription(value);
        if (norm) out.add(norm);
    };
    const trigger = (meta.when ?? '').trim();
    if (trigger) add(trigger);
    for (const body of [meta.body ?? '', skillBody(content)]) {
        const words = body.trim().split(/\s+/).filter(Boolean).slice(0, 24).join(' ');
        if (words) add(words);
    }
    add(titleFromMeta(meta));
    const h1 = (meta.body ?? '').match(/^#\s+([^\r\n]+)/m)?.[1];
    if (h1) add(h1);
    return [...out];
};

/** HINT: does the description appear to NAME a trigger? A "when"-shaped
 *  phrase, or the shape `utils/skillDescription.ts` synthesises. */
const TRIGGER_HINT_RE = /\b(when|whenever|after|before|upon|following|if)\b/i;

/** The fields a skill file must carry unchanged across a serialize round
 *  trip. `body` is excluded on purpose — the file's title heading is written
 *  separately from the body, so the body legitimately grows a heading. */
const ROUND_TRIP_FIELDS: Array<keyof SkillMeta> = [
    'status', 'kind', 'coin', 'direction', 'family', 'regime',
    'when', 'predicate', 'strategyFamily', 'signals',
    'invalidation', 'horizon', 'sizing', 'prior', 'audience', 'manualOnly',
    'approvedBy', 'approvedAt', 'whyAccepted', 'reason', 'originBotId', 'originMessageId',
    'description', 'version', 'wins', 'losses', 'consecutiveLosses',
    'netR', 'grossR', 'rSampled', 'suspendedAt', 'disabledByUser', 'evalVerdict',
    'evalStreak', 'lastEvidenceAt', 'lastMatchedAt', 'supersededBy',
];

/** Which fields change across a serialize round trip. */
const roundTripFailures = (meta: SkillMeta): string[] => {
    const serialized = serializeSkill(meta, titleFromMeta(meta));
    const again = parseSkillMarkdown(serialized);
    if (!again) return ['the serialized form does not parse back'];
    const failures: string[] = [];
    for (const field of ROUND_TRIP_FIELDS) {
        const before = meta[field] ?? null;
        const after = again[field] ?? null;
        if (before === after) continue;
        // The description is derived on write, so an ABSENT description comes
        // back as the fallback. That is not a round-trip failure; it is the
        // DORMANT signal, reported there. The same for `version`: a file
        // written before the key existed comes back with the default, which is
        // the writer filling in a blank, not the writer changing a value.
        if (field === 'description' && before === null) continue;
        if (field === 'version' && before === null) continue;
        if (field === 'netR' && typeof before === 'number' && typeof after === 'number'
            && Math.abs(before - after) < 0.005) continue;
        failures.push(field);
    }
    return failures;
};

/**
 * A minimal, VALID frontmatter wrapped around a ghost's own words.
 *
 * Nothing is invented: the name is the file's own H1 (or its file name), the
 * description is its own first prose line. The counters are ZERO and the
 * status is `candidate`, because a skill that never parsed never earned an
 * outcome — a reconstruction that claimed one would be a fabricated claim.
 */
const reconstructGhost = (file: MemoryFile, failure: SkillReviewParseFailure): SkillReviewRepair | undefined => {
    const content = file.content;
    const h1 = content.match(/^#{1,6}\s+([^\r\n]+)/m)?.[1]?.trim();
    const name = (h1 || file.name.replace(/\.md$/i, '')).slice(0, 64);
    const prose = content
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('---'))
        .join(' ');
    const description = normDescription(prose).slice(0, 1024);
    if (!description) return undefined;
    const rebuilt = [
        '---',
        `name: ${JSON.stringify(name)}`,
        `description: ${JSON.stringify(description)}`,
        LEDGER_MARKER,
        'status: candidate',
        'wins: 0',
        'losses: 0',
        'sample: 0',
        '---',
        '',
        content.trim(),
        '',
    ].join('\n');
    return {
        kind: 'reconstruct',
        // Rebuilding the file gives it a reach it did not have: it can now be
        // matched and injected. That is a WIDENING, and it must be confirmed
        // one skill at a time.
        widens: true,
        before: content,
        after: rebuilt,
        summary: 'Rebuild the frontmatter around this file\'s own text so it stops being invisible (candidate, 0W/0L).',
        reason: `The frontmatter contract fails on line ${failure.line}: ${failure.reason}`,
        queueKind: 'rewrite',
    };
};

const reviewSkillFile = (file: MemoryFile, options: SkillReviewOptions = {}): SkillReviewFinding => {
    const content = file.content;
    const meta = parseSkillMarkdown(content);
    const slug = file.name.replace(/\.md$/i, '');
    const bytes = new TextEncoder().encode(content).length;
    const base = {
        fileId: file.id,
        name: file.name,
        slug,
        chars: content.length,
        bytes,
    };

    // ── ghost: the file is in the skills folder and does not parse ──
    if (!meta) {
        const failure = diagnoseFrontmatter(content);
        return {
            ...base,
            verdict: 'ghost',
            evidence: `Line ${failure.line}: ${failure.reason}.`
                + ' This file is in the skills folder but appears in no list — not the index, not the retrieval, not the Health card.',
            reasons: [
                `the frontmatter contract fails on line ${failure.line} — ${failure.reason}`,
                'this file is in the skills folder but appears in no list: not in the index, not in the retrieval, not in the Health card',
            ],
            checks: {
                parses: false,
                roundTrips: false,
                namePresent: false,
                nameWithinLimit: false,
                descriptionPresent: false,
                descriptionIsFallback: false,
                descriptionNamesTrigger: false,
                hasStructuredTrigger: false,
                ledgerSplitIntact: content.includes(LEDGER_MARKER),
                sectionsRecognised: true,
                unrecognisedSections: [],
                droppedChars: 0,
                bodyChars: content.length,
                fileNameMatchesSkill: false,
                specShapedName: file.name.toLowerCase() === 'skill.md',
            },
            parseFailure: failure,
            neverObserved: options.neverObserved?.(file.name),
            repair: reconstructGhost(file, failure),
        };
    }

    // ── everything that parses ──
    const body = skillBody(content);
    const card = projectSkillCard(body, {
        when: meta.when,
        budget: SKILL_REVIEW_RECALL_BUDGET,
    });
    const sections = parseSkillBody(body);
    const derived = derivedDescriptions(meta, content);
    const described = (meta.description ?? '').trim();
    const descriptionIsFallback = described.length === 0
        || derived.includes(normDescription(described));
    const hasStructuredTrigger = Boolean(meta.when);
    const failures = roundTripFailures(meta);
    const ledgerSplitIntact = content.includes(LEDGER_MARKER);
    const resolvedName = skillFileNameFor(meta);
    const fileNameMatchesSkill = resolvedName === null || resolvedName === file.name;
    const specShapedName = isSpecShapedSkillFile(file);

    const checks: SkillReviewChecks = {
        parses: true,
        roundTrips: failures.length === 0,
        namePresent: Boolean(frontmatterName(content)),
        nameWithinLimit: (frontmatterName(content)?.length ?? 0) <= 64,
        descriptionPresent: described.length > 0,
        descriptionIsFallback,
        descriptionNamesTrigger: described.length > 0 && TRIGGER_HINT_RE.test(described),
        hasStructuredTrigger,
        ledgerSplitIntact,
        sectionsRecognised: sections.other.length === 0,
        unrecognisedSections: sections.other.map(o => o.title),
        droppedChars: card.droppedChars,
        bodyChars: body.length,
        fileNameMatchesSkill,
        specShapedName,
    };

    const reasons: string[] = [];
    if (failures.length) {
        reasons.push(`${failures.length} field(s) change across a serialize round trip: ${failures.join(', ')}`);
    }
    if (!checks.ledgerSplitIntact) {
        reasons.push(`the portable/ledger split marker (${LEDGER_MARKER}) is missing — the file has only one face`);
    }
    if (!checks.sectionsRecognised) {
        reasons.push(`${checks.unrecognisedSections.length} body heading(s) are not recognised: ${checks.unrecognisedSections.join(', ')}`);
    }
    if (!checks.namePresent) reasons.push('the frontmatter carries no `name:`');
    if (!checks.nameWithinLimit) reasons.push('the frontmatter `name:` is longer than the spec\'s 64 characters');
    if (!fileNameMatchesSkill) {
        reasons.push(`the file name does not match the skill (${resolvedName ?? 'no match'} resolves to it)`);
    }
    if (specShapedName) {
        reasons.push('this file is named like the Agent Skills convention\'s SKILL.md');
    }

    // ── the verdict ──
    // A ghost is decided above. Among the rest: dormant outranks clipped,
    // because a skill that will never fire is a bigger hole than one that
    // fires with half a procedure — and a dormant skill's clipping is moot.
    let verdict: SkillReviewVerdict = 'fine';
    let evidence = 'Every format check passes.';
    if (!hasStructuredTrigger && descriptionIsFallback) {
        verdict = 'dormant';
        evidence = 'Names no setup it applies to: it has no trigger and its description is the generated fallback, so it will not fire.'
            + ' It still lists, and it still occupies one of the 30 index slots in file order.';
        reasons.push('no trigger, and the description is the generated fallback rather than an authored one');
        reasons.push('it lists, it occupies one of the 30 index slots in file order, and it will not fire');
    } else if (card.droppedChars > 0) {
        verdict = 'clipped';
        evidence = `The recall card drops ${card.droppedChars} character(s), so the seat gets half a procedure in every prompt.`;
        reasons.push(`the recall card drops ${card.droppedChars} character(s) — the seat gets half a procedure in every prompt`);
    }
    if (verdict === 'dormant' && card.droppedChars > 0) {
        reasons.push(`its recall card also drops ${card.droppedChars} character(s)`);
    }
    if (verdict === 'fine' && reasons.length === 0) {
        reasons.push('every format check passes');
    }

    return {
        ...base,
        verdict,
        evidence,
        reasons,
        checks,
        description: described || undefined,
        skillName: frontmatterName(content),
        droppedChars: card.droppedChars > 0 ? card.droppedChars : undefined,
        neverObserved: options.neverObserved?.(file.name),
    };
};

/**
 * Audit every skill file and return one verdict per file.
 *
 * SYNCHRONOUS, deterministic, no model call, no provider, no writes. Safe to
 * call from a render (it reads the notebook cache only).
 *
 * The files are read from the notebook directly — NOT through `listSkills()` —
 * because `listSkills()` drops what does not parse, and the ghosts are exactly
 * the files this pass exists to find.
 */
export const reviewAllSkills = (options: SkillReviewOptions = {}): SkillReviewReport => {
    const files = getMemoryFiles().files.filter(isSkillFile);
    const findings = files.map(file => reviewSkillFile(file, options));
    const counts: Record<SkillReviewVerdict, number> = {
        fine: 0, dormant: 0, clipped: 0, ghost: 0,
    };
    for (const finding of findings) counts[finding.verdict] += 1;
    return {
        findings,
        counts,
        generatedAt: Date.now(),
        ghostCount: counts.ghost,
    };
};

/**
 * Audit ONE skill file. The same verdict the whole-notebook pass would give
 * it, so a detail pane and the report can never disagree.
 */
export const reviewSkill = (file: MemoryFile, options: SkillReviewOptions = {}): SkillReviewFinding =>
    reviewSkillFile(file, options);

/**
 * The count of files in the skills folder that do not parse — the number the
 * Health card reports so a malformed skill is VISIBLE instead of invisible.
 *
 * It is the same difference `memoryHealth.ts` already computes and threw
 * away (the count of skill files against the count of parsed metas), read
 * through the review so both surfaces report the same number.
 */
export const countGhostSkills = (): number => {
    const files = getMemoryFiles().files.filter(isSkillFile);
    let ghosts = 0;
    for (const file of files) {
        if (!parseSkillMarkdown(file.content)) ghosts += 1;
    }
    return ghosts;
};
