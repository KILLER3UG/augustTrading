import React, { useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle,
    Ban,
    Check,
    Pause,
    PowerOff,
    RefreshCw,
    RotateCcw,
    Search,
    Settings,
} from '../shared/Icons';
import {
    listSkills,
    skillEnabledFlag,
    isApprovedSkill,
    type SkillMeta,
} from '../../services/learning/SkillMemoryService';
import {
    reviewAllSkills,
    type SkillReviewFinding,
    type SkillReviewReport,
    type SkillReviewVerdict,
} from '../../services/learning/skillReview';
import { queueLearningProposal } from '../../utils/learningQueue';
import { humanizeSkillName } from '../../utils/skillNames';
import { EmptyState } from '../ui/EmptyState';
import StatusPill, { type PillTone } from '../ui/StatusPill';

/**
 * SkillsCatalog — the reference Customize → Skills screen, on August's own data.
 *
 * WHAT THIS IS NOT: a second place to approve a draft. The skill-draft path is
 * the Coach inbox (`probe-skill-approval.cjs` drives it byte-for-byte), and a
 * sixth approval surface is the exact information-architecture defect the
 * 2026-10-07 audit named. This is a BROWSER: it lists the roster, filters it,
 * and routes elsewhere for anything that changes a belief.
 *
 * Every field rendered here is real, none invented:
 *   name        ← the file slug
 *   description ← `SkillMeta.description`
 *   checkmark   ← `skillEnabledFlag(meta)` — the ONE place `enabled` is derived.
 *                 Suspension is `enabled:false` + `meta.suspendedAt`, NOT a
 *                 fourth `SkillStatus`, so this must never be derived a second
 *                 way or an unrelated attribution write silently un-suspends.
 *   tabs        ← `family` (falling back to `kind`), a real partition of the
 *                 roster. A tab with zero skills is not drawn at all — the
 *                 decorative-group defect this screen exists to avoid.
 *
 * THE REFERENCE, AND WHAT AUGUST KNOWS INSTEAD
 * ---------------------------------------------
 * The reference draws a catalogue: a title and a one-line subtitle, a header
 * row carrying search / refresh / settings / Add, an "Installed" heading over a
 * two-column grid of cards (a coloured icon tile, the name, a one-line muted
 * description, a checkmark at the right edge), and then a category row — the
 * category's name in muted text with a raised "System" pill beside it.
 *
 * August has no plugins, so it has no plugin-provided category to repeat the
 * installed list under. The one provenance axis it DOES have is `prior`:
 * `prior: 'book'` is the vetted starter shelf that ships with the app. That
 * is the reference's "System", so it gets the reference's badge — and it gets
 * its OWN category row rather than a second copy of the same cards, because
 * the same skill printed twice under two headings is a duplicate, not a
 * grouping.
 *
 * The reference's checkmark means ONE thing: this skill is available. August
 * has three honest answers to that question, so it has three marks, and the
 * two that are not "yes" say WHICH no they are (`skillAvailability` below).
 * A check on a suspended rule would be a lie the trader cannot see through.
 */

/** A roster row, flattened for rendering. */
interface CatalogSkill {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    status: SkillMeta['status'];
    kind: SkillMeta['kind'];
    /** The idle sweep's stamp. Its presence IS the suspension. */
    suspendedAt?: string;
    /** The trader switched this one off in the notebook. */
    disabledByUser?: boolean;
    /** The vetted shelf that ships with the app (`prior: 'book'`). */
    system: boolean;
    /** The SEAT's answer, read from `isApprovedSkill` where the row is built.
     *  Passed in rather than re-derived here for the same reason `enabled` is:
     *  a second implementation is how the label and the injectors drift apart. */
    approved: boolean;
    wins: number;
    losses: number;
    family: string;
}

/** Family → collection tab label. `kind` is the fallback partition so a roster
 *  with no families at all still gets one honest, non-empty group rather than an
 *  empty tab strip. */
const collectionOf = (meta: SkillMeta): string => meta.family?.trim() || (meta.kind === 'avoid' ? 'Avoid' : 'Repeat');

/**
 * THE AVAILABILITY VOCABULARY — one word per state, and the reason beside it.
 *
 * The reference draws a checkmark on a card, and the check means exactly one
 * thing: the skill is available. August has three honest answers to that
 * question, so it has three marks, and the two that are not "yes" say WHICH
 * no they are. A check on a rule that reaches no seat is a lie, and the
 * trader has no way to see through it.
 *
 * ONE home: the catalogue's card mark and the reader's chip
 * (`components/learn/SkillViewerPanel.tsx`) both read this, so the two
 * surfaces cannot spell one state two ways — which is how a suspended skill
 * ends up reading as "active" on one of them.
 */
export type SkillAvailability = 'enabled' | 'suspended' | 'off';

export interface SkillAvailabilityRead {
    state: SkillAvailability;
    /** The one word. */
    label: string;
    /** Why it is in that state — the sentence a tooltip and a screen reader
     *  both need, because "Suspended" alone invites "by whom?". */
    title: string;
}

/**
 * The state a skill is in, and why.
 *
 * `enabled` is passed in rather than re-derived: `skillEnabledFlag` is the ONE
 * place `enabled` may be derived, and a second implementation here is exactly
 * how the label and the injectors drifted apart the first time.
 */
export const skillAvailability = (
    meta: Pick<SkillMeta, 'status' | 'suspendedAt' | 'disabledByUser'>,
    enabled: boolean,
    approved: boolean,
): SkillAvailabilityRead => {
    if (meta.suspendedAt) {
        return {
            state: 'suspended',
            label: 'Suspended',
            title: 'Not injected — the idle sweep suspended it after 90 days of silence. It is still matched, so it can revive on its own.',
        };
    }
    if (meta.disabledByUser) {
        return { state: 'off', label: 'Off', title: 'Not injected — you switched this off in the notebook.' };
    }
    if (meta.status === 'retired') {
        return { state: 'off', label: 'Off', title: 'Not injected — this rule was retired, so no seat follows it.' };
    }
    if (!enabled) {
        return { state: 'off', label: 'Off', title: 'Not injected — this skill is not reaching a seat.' };
    }
    // THE SAME GATE THE SEAT READS, supplied by the caller. The injection and
    // (since P10) the skills index both refuse an unapproved rule, so a card
    // that said "injected" here would be a check on a rule that reaches no
    // seat — the exact lie this function exists to prevent. `approved` is read
    // from `isApprovedSkill` where the row is built, never re-derived here.
    if (!approved) {
        return {
            state: 'off',
            label: 'Off',
            title: 'Not injected — nothing has approved this rule, so no seat is given it. A skill reaches a seat only on a human approval; a rule the LLM supervisor accepted is not one, and the starter library has its own switch in Settings.',
        };
    }
    return {
        state: 'enabled',
        label: 'Enabled',
        title: 'Enabled — this skill is injected into the seat prompt.',
    };
};

/**
 * What one manual re-read found, said in the trader's words.
 *
 * The Refresh press used to be invisible: `reload()` genuinely re-reads the
 * store, but when nothing on disk changed the screen was byte-identical after
 * it, so a working button and a dead one looked the same. That is what the
 * render-probe's inert-control gate measures, and the gate was right — the fix
 * is to report the outcome, not to exempt the control.
 */
const describeRosterSync = (prev: CatalogSkill[] | null, next: CatalogSkill[]): string => {
    if (prev === null) return 'Skill list read';
    const sig = (s: CatalogSkill): string =>
        `${s.name}|${s.description}|${s.enabled}|${s.status}|${s.kind}|${s.suspendedAt ?? ''}|${s.disabledByUser ?? false}|${s.system}|${s.approved}|${s.wins}|${s.losses}|${s.family}`;
    const before = new Map(prev.map(s => [s.id, sig(s)]));
    let added = 0;
    let changed = 0;
    for (const s of next) {
        const old = before.get(s.id);
        if (old === undefined) added += 1;
        else if (old !== sig(s)) changed += 1;
        before.delete(s.id);
    }
    const parts: string[] = [];
    if (added) parts.push(`${added} new`);
    if (changed) parts.push(`${changed} updated`);
    if (before.size) parts.push(`${before.size} removed`);
    return parts.length ? `Refreshed — ${parts.join(', ')}` : 'Refreshed — nothing changed';
};

/**
 * The icon tile — the reference's coloured square, in the theme's own hues.
 *
 * The COLOUR says the STATE (emerald = reaching a seat, amber = suspended,
 * zinc = not in play) and the GLYPH says what the rule DOES (an avoid is a
 * power-off, a repeat is a rotation — the same pair the Studio's card uses,
 * because one kind must not have two marks). Colouring the tile by KIND, the
 * way this did before, would read a rule that never traded as a LOSS, and
 * rose means loss in this theme.
 */
const tileClass = (s: CatalogSkill): string => {
    const base = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-control border';
    if (s.status === 'retired') return `${base} border-zinc-800 bg-zinc-900 text-zinc-600`;
    const state = skillAvailability(s, s.enabled, s.approved).state;
    if (state === 'enabled') return `${base} border-emerald-500/30 bg-emerald-500/10 text-emerald-300`;
    if (state === 'suspended') return `${base} border-amber-500/30 bg-amber-500/10 text-amber-300`;
    return `${base} border-zinc-700 bg-zinc-800 text-zinc-500`;
};

/**
 * The mark at the card's right edge — the reference's checkmark, in August's
 * own vocabulary.
 *
 * The check stays the reference's quiet grey: the tile is where the colour
 * lives, so a green check beside a green tile would shout the same fact
 * twice.
 */
const MARK: Record<SkillAvailability, { Icon: React.FC<{ className?: string }>; className: string }> = {
    enabled: { Icon: Check, className: 'text-zinc-400' },
    suspended: { Icon: Pause, className: 'text-amber-400' },
    off: { Icon: Ban, className: 'text-zinc-500' },
};

/**
 * The review's four verdicts, and how each one is WORDED.
 *
 * These are NOT run statuses, so `utils/runStatus.ts` does not apply to them —
 * that module is the vocabulary for a RUN (queued / running / done / stopped /
 * failed). A skill verdict is a different question: "is this file healthy?".
 * The wording is the load-bearing part, because two of the four are warnings
 * and one is a defect:
 *
 *  - **ghost** — the file is in the skills folder and does not parse. It is in
 *    the backup and the export and in NO list: not the index, not the
 *    retrieval, not the Health card. It is a defect, and the only one.
 *  - **dormant** — it parses, but it names no setup it applies to, so it will
 *    not fire. A WARNING, not a defect: a general rule is *meant* to be
 *    unscoped. It also holds one of the 30 index slots in file order.
 *  - **clipped** — the recall card drops characters, so the seat gets half a
 *    procedure in every prompt. A warning.
 *  - **fine** — everything checks out.
 */
export const VERDICT_LABEL: Record<SkillReviewVerdict, string> = {
    fine: 'Fine',
    dormant: 'Dormant',
    clipped: 'Clipped',
    ghost: 'Ghost',
};

/** One line for the trader, per verdict. The reason it says "names no setup"
 *  and NOT "never fired" is the run-cap: the injection log is run-capped, so
 *  absence from it is the same fact as "aged out of the window" and proves
 *  nothing (`services/learning/memoryHealth.ts:15-18`). */
export const VERDICT_HINT: Record<SkillReviewVerdict, string> = {
    fine: 'Every format check passes.',
    dormant: 'Names no setup it applies to — it will not fire, and it holds one of the 30 index slots.',
    clipped: 'The recall card drops characters — the seat gets half a procedure.',
    ghost: 'In the notebook, in the backup, and in no list at all.',
};

/** The theme's own semantic ramp, as the ONE chip component's tones: rose for
 *  the defect, amber for the two warnings, zinc for the quiet one. */
export const VERDICT_TONE: Record<SkillReviewVerdict, PillTone> = {
    fine: 'up',
    dormant: 'warn',
    clipped: 'warn',
    ghost: 'down',
};

/** The report's one-line summary. Every number is counted, never estimated. */
const describeReview = (report: SkillReviewReport): string => {
    const { fine, dormant, clipped, ghost } = report.counts;
    const total = fine + dormant + clipped + ghost;
    if (total === 0) return 'No skill files to review.';
    const parts = [`${fine} fine`];
    if (dormant) parts.push(`${dormant} dormant`);
    if (clipped) parts.push(`${clipped} clipped`);
    if (ghost) parts.push(`${ghost} ghost`);
    return `Reviewed ${total} skill file${total === 1 ? '' : 's'}: ${parts.join(', ')}.`;
};

export interface SkillsCatalogProps {
    /** Refresh — the gear routes to Settings → Skills. */
    onOpenSettings?: () => void;
    /** Read — opens this skill's rendered record in the viewer panel. The
     *  browser's whole job is to make a row readable without leaving the
     *  surface; without this the catalog is a list of file names. */
    onOpenSkill?: (fileId: string) => void;
}

/**
 * One card of the grid — the reference's card, on August's data.
 *
 * A coloured icon tile on the left, the name in medium weight, a ONE-LINE
 * muted description truncated with an ellipsis, and the availability mark at
 * the right edge. The row is the opener: a card that cannot be pressed is a
 * list of file names, and the record behind it — description, body, outcome
 * ledger — was unreachable without leaving for the memory manager.
 */
const SkillCard: React.FC<{
    skill: CatalogSkill;
    onOpen?: (fileId: string) => void;
    /** The format review's finding for THIS skill, when one has been run. */
    verdict?: SkillReviewFinding;
}> = ({ skill, onOpen, verdict }) => {
    const availability = skillAvailability(skill, skill.enabled, skill.approved);
    const Mark = MARK[availability.state].Icon;
    const retired = skill.status === 'retired';
    return (
        <li className="flex items-center gap-3" data-testid="skills-catalog-card">
            <span className={tileClass(skill)} aria-hidden="true">
                {/* aria-hidden on the glyph itself as well as its
                    tile: the tile's hidden is enough for assistive
                    tech, and the icon-semantics scan reads JSX, not
                    the rendered tree — a glyph that is hidden in the
                    DOM but unsaid in the source is a regression the
                    guard cannot see coming back. */}
                {skill.kind === 'avoid'
                    ? <PowerOff className="h-4 w-4" aria-hidden="true" />
                    : <RotateCcw className="h-4 w-4" aria-hidden="true" />}
            </span>
            <button type="button"
                onClick={() => onOpen?.(skill.id)}
                aria-label={`Read ${humanizeSkillName(skill.name)}`}
                className="min-w-0 flex-1 rounded-control text-left transition-colors hover:text-zinc-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500">
                <span
                    className={`block truncate text-ui-base font-medium ${retired ? 'text-zinc-500 line-through' : 'text-zinc-100'}`}
                    title={skill.name}
                >
                    {/* The reference's cards name a skill the way a person
                        would ("Fc Nginx Website"), not the file behind it. The
                        slug is still the identity: it is the tooltip and
                        everything that writes to the notebook. */}
                    {humanizeSkillName(skill.name)}
                </span>
                <span className="block truncate text-ui-dense text-zinc-500" title={skill.description || undefined}>
                    {skill.description || (retired ? 'Retired' : 'No description')}
                </span>
            </button>
            {/* The mark. The tooltip names WHY — "Off" alone would be a
                shrug, and the reason is the one thing a trader needs. */}
            <span className="shrink-0" title={availability.title}>
                <Mark className={`h-4 w-4 ${MARK[availability.state].className}`} aria-label={availability.label} />
            </span>
            {/* The row says what the review found, so a problem is
                visible where the skill is — not only in the
                report. A ghost has no row at all (it is not in
                the list), which is exactly why the report
                exists. */}
            {verdict && (
                <span data-testid="skills-row-verdict" title={verdict.evidence}>
                    <StatusPill tone={VERDICT_TONE[verdict.verdict]}>
                        {VERDICT_LABEL[verdict.verdict]}
                    </StatusPill>
                </span>
            )}
        </li>
    );
};

/**
 * The two-column grid of cards, under one section heading.
 *
 * The reference's cards are laid out in two columns with the mark at the far
 * edge of each column, so the mark reads as the column's own "available"
 * column rather than as a stray glyph.
 */
const CardGrid: React.FC<{
    skills: CatalogSkill[];
    onOpen?: (fileId: string) => void;
    verdictBySlug: Map<string, SkillReviewFinding>;
}> = ({ skills, onOpen, verdictBySlug }) => (
    <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {skills.map(s => (
            <SkillCard
                key={s.id}
                skill={s}
                onOpen={onOpen}
                verdict={verdictBySlug.get(s.name.replace(/\.md$/i, ''))}
            />
        ))}
    </ul>
);

const SkillsCatalog: React.FC<SkillsCatalogProps> = ({ onOpenSettings, onOpenSkill }) => {
    const [skills, setSkills] = useState<CatalogSkill[] | null>(null);
    const [query, setQuery] = useState('');
    const [collection, setCollection] = useState<string>('all');
    /** The last manual re-read, in words. null until the user presses Refresh. */
    const [syncNote, setSyncNote] = useState<string | null>(null);
    /** The last format review, or null until the user presses Review. */
    const [review, setReview] = useState<SkillReviewReport | null>(null);
    /** What the review said, and what the trader did about it. */
    const [reviewNote, setReviewNote] = useState<string | null>(null);

    const reload = (manual = false): void => {
        try {
            const next = listSkills().map(({ file, meta }) => ({
                id: file.id,
                name: file.name,
                description: meta.description ?? '',
                enabled: skillEnabledFlag(meta),
                status: meta.status,
                kind: meta.kind,
                suspendedAt: meta.suspendedAt,
                disabledByUser: meta.disabledByUser,
                system: meta.prior === 'book',
                approved: isApprovedSkill(meta),
                wins: meta.wins,
                losses: meta.losses,
                family: collectionOf(meta),
            }));
            if (manual) setSyncNote(describeRosterSync(skills, next));
            setSkills(next);
        } catch {
            // A store read failure is not a reason to draw an empty grid that
            // reads as "you have no skills" — leave it null so the empty state
            // says it could not load instead.
            setSkills(null);
            if (manual) setSyncNote('Could not read the skill files');
        }
    };

    useEffect(reload, []);

    /**
     * "Review all my skills" — a DETERMINISTIC read of every file in the skills
     * folder, and nothing else.
     *
     * The review finds the files the app cannot: `listSkills()` DROPS a skill
     * that does not parse, so a malformed file sits in the notebook, in the
     * backup and in the export while appearing in NO list — not the index, not
     * the retrieval, not the Health card. The same file, imported, is rejected
     * WITH A REASON. Two opposite answers for one file, depending on how it
     * arrived.
     *
     * THIS BUTTON WRITES NOTHING. Not the notebook, not a skill. It reads the
     * files and reports; a repair is a PROPOSAL, and it goes into the existing
     * approval queue where the human acts on it — never straight into the
     * notebook. That is the plan's rule and it is the safe one: a
     * reconstruction GIVES a skill a reach it did not have (it can suddenly be
     * matched and injected), so it must be confirmed by a person, one skill at
     * a time.
     */
    const runReview = (): void => {
        try {
            const report = reviewAllSkills();
            setReview(report);
            setReviewNote(describeReview(report));
        } catch {
            setReview(null);
            setReviewNote('Could not read the skill files');
        }
    };

    /**
     * Queue ONE repair as a proposal. The notebook is not touched: the queue
     * is where a human decision lives, and the queue's dedupe key means the
     * same repair is not proposed twice.
     */
    const proposeRepair = (finding: SkillReviewFinding): void => {
        const repair = finding.repair;
        if (!repair) return;
        const queued = queueLearningProposal({
            kind: repair.queueKind,
            skillSlug: finding.slug,
            text: `${repair.summary}\n${repair.reason}`
                + `\nSkill: ${finding.name}`
                + `\n${repair.widens
                    ? 'This repair WIDENS the skill\'s reach: it would become a skill the models can use. It is inactive until you approve it.'
                    : 'This repair only narrows the skill\'s reach.'}`
                + '\nNothing has been written — the notebook is unchanged until you approve this in the queue.',
            fingerprint: `skill-review|${repair.queueKind}|${finding.slug}|${repair.kind}`,
            payload: {
                source: 'skill-review',
                evidence: repair.reason,
                widens: repair.widens,
                old: { content: repair.before },
                new: { content: repair.after },
            },
        });
        setReviewNote(queued
            ? `Proposed a repair for ${finding.name}. It is waiting for you in the queue — nothing was written.`
            : `A repair for ${finding.name} is already waiting in the queue.`);
    };

    /** The problems, worst first: the defect before the warnings. */
    const problems = useMemo(() => {
        const rank: Record<SkillReviewVerdict, number> = { ghost: 0, clipped: 1, dormant: 2, fine: 3 };
        return (review?.findings ?? [])
            .filter(f => f.verdict !== 'fine')
            .sort((a, b) => rank[a.verdict] - rank[b.verdict]);
    }, [review]);

    /** The review's finding for each skill, by slug — so a roster row can
     *  carry its own verdict. */
    const verdictBySlug = useMemo(() => {
        const map = new Map<string, SkillReviewFinding>();
        for (const finding of review?.findings ?? []) {
            if (finding.verdict === 'fine') continue;
            map.set(finding.slug, finding);
        }
        return map;
    }, [review]);

    /** Collections that actually hold skills. An empty tab is never drawn. */
    const collections = useMemo(() => {
        const counts = new Map<string, number>();
        for (const s of skills ?? []) counts.set(s.family, (counts.get(s.family) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, n }));
    }, [skills]);

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return (skills ?? []).filter(s => {
            if (collection !== 'all' && s.family !== collection) return false;
            if (!q) return true;
            // The haystack is BOTH names: the slug the notebook uses and the
            // label the card shows. A trader types what they can see, and a
            // search that cannot find the name in front of them is a search
            // that looks broken.
            return s.name.toLowerCase().includes(q)
                || humanizeSkillName(s.name).toLowerCase().includes(q)
                || s.description.toLowerCase().includes(q);
        });
    }, [skills, query, collection]);

    /**
     * The two sections of the page.
     *
     * "Installed" is the trader's own roster — the rules the desk learned or
     * the trader approved. The starter shelf is the reference's "System"
     * category: the vetted playbooks that ship with the app, which no trade
     * of yours earned and no evidence ledger will ever own.
     *
     * The partition is EXCLUSIVE, and that is the one place this page parts
     * company with the reference. Claude lists the same skill twice — once
     * under "Installed" and once under the plugin category that provides it —
     * because a plugin and an install are two different routes to one skill.
     * August has no plugins, so the second route here would be a second copy
     * of the same cards. The shelf gets its own category row instead.
     */
    const own = useMemo(() => shown.filter(s => !s.system), [shown]);
    const shipped = useMemo(() => shown.filter(s => s.system), [shown]);

    // The active collection must survive a reload that drops it: pinning a tab
    // whose skills were all retired would render an empty grid that looks broken.
    const activeCollection = collections.some(c => c.label === collection) || collection === 'all'
        ? collection
        : 'all';

    return (
        <section
            className="rounded-control border border-zinc-800/80 bg-zinc-900 p-3"
            data-testid="skills-catalog"
            aria-label="Skill catalog"
        >
            {/* Title block + the reference's top row: search, refresh, gear, Add. */}
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="text-ui-xl font-semibold tracking-tight text-zinc-100">Skills</h3>
                    <p className="mt-0.5 text-ui-dense text-zinc-500" role="status" data-testid="skills-status">
                        {syncNote ?? 'What the desk has learned to do, and what it has learned to avoid.'}
                    </p>
                </div>
                <div className="flex items-center gap-1.5">
                    <div className="flex h-8 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800 px-2.5">
                        <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                        <input
                            type="search"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder="Search skills"
                            aria-label="Search skills"
                            className="h-6 w-56 bg-transparent text-ui-dense text-zinc-200 outline-none placeholder:text-zinc-600"
                        />
                    </div>
                    <button type="button" onClick={() => reload(true)} aria-label="Refresh the skill list" title="Refresh"
                        className="flex h-8 w-8 hit-target items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500">
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button type="button" onClick={runReview} aria-label="Review all my skills"
                        title="Review all my skills — check every skill file's format"
                        className="flex h-8 items-center gap-1 rounded-control border border-zinc-700 bg-zinc-800 px-2 text-ui-dense text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500">
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                        Review
                    </button>
                    {onOpenSettings && (
                        <button type="button" onClick={onOpenSettings} aria-label="Skill settings" title="Skill settings"
                            className="flex h-8 w-8 hit-target items-center justify-center rounded-control text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500">
                            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    )}
                </div>
            </div>

            {/* The review report. It appears only after the trader asks for
                it, and it is a REPORT: nothing here has been written. The
                block also appears on a FAILED read — a silent failure would
                leave the trader thinking the button did nothing. */}
            {(review || reviewNote) && (
                <div className="mt-3 rounded-control border border-zinc-800/80 bg-zinc-950/60 p-3" data-testid="skills-review">
                    <p className="text-ui-dense text-zinc-400" role="status" data-testid="skills-review-note">
                        {reviewNote ?? describeReview(review!)}
                    </p>
                    {!review ? null : problems.length === 0 ? (
                        <p className="mt-2 text-ui-dense text-zinc-500">
                            Every skill file parses, names a setup it applies to, and fits its recall card.
                        </p>
                    ) : (
                        <ul className="mt-2 flex flex-col gap-2">
                            {problems.map(finding => (
                                <li key={finding.fileId} data-testid="skills-review-row" className="rounded-control border border-zinc-800/80 bg-zinc-900/60 p-2.5">
                                    <div className="flex items-start gap-2">
                                        <StatusPill tone={VERDICT_TONE[finding.verdict]}>
                                            {VERDICT_LABEL[finding.verdict]}
                                        </StatusPill>
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate font-mono text-ui-dense text-zinc-300" title={finding.name}>
                                                {finding.name}
                                            </span>
                                            <span className="mt-0.5 block text-ui-dense text-zinc-400">{finding.evidence}</span>
                                        </span>
                                    </div>
                                    {finding.reasons.length > 0 && (
                                        <ul className="mt-1.5 flex flex-col gap-0.5 pl-2">
                                            {finding.reasons.map((reason, i) => (
                                                <li key={i} className="text-ui-2xs text-zinc-500">· {reason}</li>
                                            ))}
                                        </ul>
                                    )}
                                    {finding.repair && (
                                        <div className="mt-2 border-t border-zinc-800/80 pt-2">
                                            <p className="text-ui-2xs text-zinc-400">
                                                {finding.repair.summary}
                                            </p>
                                            {finding.repair.widens && (
                                                <p className="mt-1 text-ui-2xs text-amber-300">
                                                    This repair widens the skill&rsquo;s reach — it would become a skill the models can use.
                                                </p>
                                            )}
                                            <details className="mt-1.5">
                                                <summary className="cursor-pointer text-ui-2xs text-zinc-400 hover:text-zinc-200">
                                                    Show the proposed change
                                                </summary>
                                                <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                                    <div>
                                                        <p className="text-ui-2xs uppercase tracking-wider text-zinc-500">Now</p>
                                                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control border border-zinc-800/80 bg-zinc-950 p-2 font-mono text-ui-2xs text-zinc-400">{finding.repair.before}</pre>
                                                    </div>
                                                    <div>
                                                        <p className="text-ui-2xs uppercase tracking-wider text-zinc-500">Proposed</p>
                                                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control border border-zinc-800/80 bg-zinc-950 p-2 font-mono text-ui-2xs text-zinc-300">{finding.repair.after}</pre>
                                                    </div>
                                                </div>
                                            </details>
                                            <button type="button" onClick={() => proposeRepair(finding)}
                                                aria-label={`Propose the repair for ${finding.name}`}
                                                className="mt-2 flex h-8 items-center gap-1 rounded-control border border-zinc-700 bg-zinc-800 px-2.5 text-ui-dense text-zinc-200 transition-colors hover:border-zinc-600 hover:text-zinc-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500">
                                                Propose this repair
                                            </button>
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {/* Segmented collection tabs — a real partition, so no empty groups. */}
            {collections.length > 1 && (
                <div className="mt-3 flex flex-wrap items-center gap-1" role="tablist" aria-label="Skill collections">
                    <button type="button" role="tab" aria-selected={activeCollection === 'all'}
                        onClick={() => setCollection('all')}
                        className={`rounded-full px-3 py-1 text-ui-dense font-medium transition-colors ${
                            activeCollection === 'all' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                        }`}>
                        All {(skills ?? []).length}
                    </button>
                    {collections.map(c => (
                        <button key={c.label} type="button" role="tab" aria-selected={activeCollection === c.label}
                            onClick={() => setCollection(c.label)}
                            className={`rounded-full px-3 py-1 text-ui-dense font-medium transition-colors ${
                                activeCollection === c.label ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                            }`}>
                            {c.label} {c.n}
                        </button>
                    ))}
                </div>
            )}

            {skills === null ? (
                <p className="py-6 text-center text-ui-dense text-zinc-500" data-testid="skills-catalog-error">
                    The skill library could not be read.
                </p>
            ) : shown.length === 0 ? (
                <div data-testid="skills-catalog-empty">
                    <EmptyState
                        compact
                        align="center"
                        title={query.trim() ? `No skill matches “${query.trim()}”.` : 'No skills yet.'}
                        description={query.trim()
                            ? 'Clear the search to see the whole roster.'
                            : 'Approve a drafted skill in the Approvals inbox, or import a SKILL.md, and it lands here.'}
                    />
                </div>
            ) : (
                <div data-testid="skills-catalog-grid">
                    {/* The reference's "Installed" heading: a label with a
                        hairline under it, then the two-column card grid. */}
                    {own.length > 0 && (
                        <section aria-labelledby="skills-installed-label">
                            <h4 id="skills-installed-label"
                                className="mt-4 border-b border-zinc-800/80 pb-2 text-ui-base font-semibold text-zinc-100">
                                Installed
                            </h4>
                            <CardGrid skills={own} onOpen={onOpenSkill} verdictBySlug={verdictBySlug} />
                        </section>
                    )}
                    {/* The reference's category row: the name in muted text,
                        and the raised pill that says WHAT the category is. */}
                    {shipped.length > 0 && (
                        <section aria-labelledby="skills-system-label">
                            <div className="mt-5 flex items-center gap-2">
                                <h4 id="skills-system-label" className="text-ui-sm text-zinc-500">
                                    Starter library
                                </h4>
                                <StatusPill tone="neutral" title="Vetted playbooks that ship with August — they are not learned from your trades.">
                                    System
                                </StatusPill>
                            </div>
                            <CardGrid skills={shipped} onOpen={onOpenSkill} verdictBySlug={verdictBySlug} />
                        </section>
                    )}
                </div>
            )}
        </section>
    );
};

export default React.memo(SkillsCatalog);
