/**
 * memoryHealth — one pure read over every memory surface (WS-4.3).
 *
 * The learning loop writes into a dozen places (notebook folders, skills,
 * drafts, proposals, amendments, forged tools, the graveyard, settled
 * beliefs) and until now each had its own surface to inspect it, so nobody
 * could answer "is memory actually healthy?" in one look. This is that answer:
 * a selector, not a service — it mutates nothing, queues nothing, and is safe
 * to call on every render of the Health tab.
 *
 * Staleness is measured against the ONE signal that exists: the injection log
 * (`MemoryInjectionService`, newest-first, capped at `MAX_INJECTION_RECORDS`
 * runs). Two different facts come out of it and they are kept apart on
 * purpose:
 *  - `staleFiles` — a file the log DOES place a hit on, whose newest hit is
 *    older than `STALE_FILE_DAYS`. That is the real "no hits in N days".
 *  - `unobserved` — a file with no hit inside the retained window. Absence
 *    from a run-capped log is not the same as never being served (the hit may
 *    simply have aged out, and most notebook folders are never named in a
 *    source record at all), so these are reported as unobserved — with their
 *    days-since-edit — and never folded into the stale count.
 */

import { getMemoryFiles, getNotebookSize, getNotebookWriteFailure, SCOPE_LABEL, type NotebookWriteFailure } from './MemoryFilesService';
import { describePressure, type NotebookPressure } from '../../utils/memoryBudget';
import {
    isSkillFile, parseSkillMarkdown, EVIDENCE_STALE_DAYS, type SkillMeta,
} from './SkillMemoryService';
import { getRecentMemoryInjections, MAX_INJECTION_RECORDS } from './MemoryInjectionService';
import { estimateMemoryTokensPerRun } from './MemoryRetrievalService';
import { readSettledBeliefs } from './settledBeliefs';
import { BELIEF_FLAG_FINGERPRINT_PREFIX } from './beliefChallenge';
import { listTombstones } from './skillGraveyard';
import { listSuspendedSkills } from './skillIdleLifecycle';
import { listSkillDrafts, listWorthGateAttempts } from '../../utils/skillDrafts';
import { listLearningProposals } from '../../utils/learningQueue';
import { listAmendments } from './memoryAmendments';
import { loadForgedTools } from '../tools/toolForge';
import { skillFormatIssues } from '../../utils/skillFrontmatter';
import { countPendingSupervision } from './skillSupervisor';
import { loadHygieneLog, type HygieneLine } from './memoryHygiene';
import { loadBotLearningStats, type BotLearningStat } from '../agents/botLearning';

export interface HealthFolder {
    name: string;
    files: number;
    enabled: number;
    chars: number;
}

export interface HealthSkillBucket {
    total: number;
    candidate: number;
    confirmed: number;
    retired: number;
    /** ── LEARNED skills still untested: approved drafts injected as a labeled
     *  hypothesis. Book seeds are excluded — they carry external evidence by
     *  design and stay 0W/0L forever, so counting them made a healthy default
     *  workspace read as a stalled loop. */
    unproven: number;
    /** Curated literature corpus (seeded, 0W/0L by design). */
    bookSeeds: number;
    /** Latest causal eval said it hurts. */
    hurtsVerdict: number;
    /** LEARNED skills with no counted evidence inside the decay window. */
    staleEvidence: number;
    /** Auto-authored by a bot rather than the chart AI. */
    fromBots: number;
    /** Skill files in the skills folder that do NOT parse — the "ghosts".
     *  A ghost is in the notebook, in the backup and in the export, and appears
     *  in NO list: not the skills index, not the retrieval, not this card. The
     *  count of files against the count of parsed metas IS the ghost count, and
     *  until now this report computed it and threw it away.
     *
     *  Optional because the bucket is also built by callers that do not read
     *  the notebook (the card's own fixtures); absent means "not counted",
     *  never "zero ghosts". */
    ghosts?: number;
}

export interface HealthQueue {
    drafts: number;
    proposals: number;
    amendments: number;
    forgedTools: number;
    supervisorPending: number;
    graveyard: number;
    /** Proposal kinds that need a model-authored rewrite to actuate. */
    needsRewrite: number;
}

export interface MemoryHealthReport {
    generatedAt: number;
    folders: HealthFolder[];
    skills: HealthSkillBucket;
    notebook: {
        files: number;
        enabled: number;
        chars: number;
        /** UTF-16 bytes of the whole blob, which is the unit the platform's
         *  quota is metered in — `chars` cannot show that a CJK-heavy notebook
         *  is closer to refusing writes. */
        bytes: number;
        /** `null` until the notebook has been loaded or written this session. */
        pressure: NotebookPressure | null;
        /** The last write the storage layer REFUSED, or null when writes are
         *  reaching disk. Pressure says the blob is big; this says the trader's
         *  learning stopped being saved at all — a different, louder fact. */
        writeFailure: NotebookWriteFailure | null;
        /** Enabled skills the idle lifecycle dropped from prompts, so a
         *  silently-shrinking skill set is explainable on screen. */
        suspended: number;
        /** Worst-case prompt cost of memory injection, in tokens. */
        promptTokensWorstCase: number;
    };
    /** Enabled files with NO hit inside the retained injection window — an
     *  absence, not a staleness claim (see the module header). */
    unobserved: Array<{ path: string; chars: number; daysSinceEdit: number }>;
    /** Enabled files the injection log DOES place a hit on, whose newest hit
     *  is older than `STALE_FILE_DAYS` — the real "no hits in N days". */
    staleFiles: Array<{ path: string; chars: number; daysSinceHit: number; lastHitAt: string }>;
    /** How many runs the injection log retains — the width of the window the
     *  two signals above are measured against. */
    injectionLogWindowRuns: number;
    beliefs: {
        settled: number;
        invalidated: number;
        /** Still `settled`, but carrying a pending challenge flag from the
         *  belief-challenge pass — standing AND contradicted, which the
         *  status field alone cannot express. */
        challenged: number;
    };
    queues: HealthQueue;
    diary: { files: number; entries: number };
    bots: BotLearningStat[];
    /** Clusters the worth gate could not judge, held back by the attempt
     *  throttle. These are skills the loop KNOWS it should be learning and
     *  cannot, so they are visible rather than silent. The throttle lifts by
     *  itself when the cluster gains a trade the gate has not judged. */
    gateThrottled: Array<{ key: string; attempts: number; lastAt: string }>;
    /** The ONE-format audit (2026-11-03): every skill file in the library —
     *  existing, imported, hand-edited — checked against slug name + `when` +
     *  description + body-in-caps. Conforming is the expected state; the
     *  issues name what to fix, file by file. */
    skillFormat: {
        checked: number;
        conforming: number;
        issues: Array<{ file: string; problems: string[] }>;
    };
    /** One-line entries the weekly hygiene pass writes; newest first. */
    hygiene: HygieneLine[];
    /** Plain-English problems worth showing the user, empty when healthy. */
    flags: string[];
}

const DAY_MS = 86_400_000;
/** A file the injection log places a hit on, but not within this many days,
 *  is stale. The threshold is the loop's own evidence-decay window rather than
 *  a new number invented here: `EVIDENCE_STALE_DAYS` (30) is what the hygiene
 *  pass already treats as "this rule has stopped earning anything". */
const STALE_FILE_DAYS = EVIDENCE_STALE_DAYS;

/** Retrieval records source paths as `folder/name` (skills as
 *  `skills/<file>.md`); notebook files carry the extension in their own name.
 *  Normalizing both to one key is what makes a hit joinable at all. */
const hitKey = (path: string): string => path.replace(/\.md$/i, '').toLowerCase();

const bucketSkills = (metas: SkillMeta[]): HealthSkillBucket => {
    const staleCutoff = Date.now() - EVIDENCE_STALE_DAYS * DAY_MS;
    const out: HealthSkillBucket = {
        total: metas.length, candidate: 0, confirmed: 0, retired: 0,
        unproven: 0, bookSeeds: 0, hurtsVerdict: 0, staleEvidence: 0, fromBots: 0,
        ghosts: 0,
    };
    for (const m of metas) {
        // A book seed is a curated prior, not a belief this trader is still
        // testing. It is exempt from the zero-evidence injection ban by
        // design and never accrues a record of its own unless it proves out,
        // so it must not be counted as unproven or stale.
        const learned = m.prior !== 'book';
        if (!learned) out.bookSeeds += 1;
        if (m.originBotId) out.fromBots += 1;
        if (m.status === 'confirmed') out.confirmed += 1;
        else if (m.status === 'retired') out.retired += 1;
        else out.candidate += 1;
        if (m.evalVerdict === 'hurts') out.hurtsVerdict += 1;
        if (!learned || m.status === 'retired') continue;
        const evidenced = (m.wins + m.losses) > 0;
        if (!evidenced) out.unproven += 1;
        const evid = m.lastEvidenceAt ? Date.parse(m.lastEvidenceAt) : NaN;
        if (Number.isFinite(evid) ? evid < staleCutoff : true) out.staleEvidence += 1;
    }
    return out;
};

/** Assemble the report. Async only because three stores are Preferences-backed. */
export const buildMemoryHealthReport = async (username: string): Promise<MemoryHealthReport> => {
    const { folders, files } = getMemoryFiles();
    const skillFiles = files.filter(isSkillFile);
    const metas = skillFiles
        .map(f => parseSkillMarkdown(f.content))
        .filter((m): m is SkillMeta => Boolean(m));
    // The GHOST count: the skill files that do not parse. It was computed
    // right here and thrown away — the difference between "files in the
    // skills folder" and "skills the app can read" is exactly the number of
    // files that sit in the notebook, in the backup and in the export while
    // appearing in NO list. A ghost is invisible by construction, so the only
    // way it becomes visible is a card that counts it.
    const ghostSkills = skillFiles.length - metas.length;

    const folderName = new Map(folders.map(f => [f.id, f.name]));
    const byFolder = new Map<string, HealthFolder>();
    for (const f of files) {
        const name = folderName.get(f.folderId) ?? f.folderId;
        const row = byFolder.get(name) ?? { name, files: 0, enabled: 0, chars: 0 };
        row.files += 1;
        row.chars += f.content.length;
        if (f.enabled) row.enabled += 1;
        byFolder.set(name, row);
    }

    // What retrieval ACTUALLY served, inside the retained log window — keyed by
    // `folder/name` (extension stripped, lowercased) to the NEWEST hit only,
    // so `lastHitMs` is a real last-seen time and not a presence flag.
    const lastHitMs = new Map<string, number>();
    try {
        for (const rec of await getRecentMemoryInjections(username)) {
            const ts = Date.parse(rec.ts);
            if (!Number.isFinite(ts)) continue;
            for (const s of rec.sources) {
                const key = hitKey(s.path);
                const prev = lastHitMs.get(key);
                if (prev === undefined || ts > prev) lastHitMs.set(key, ts);
            }
        }
    } catch { /* no telemetry — every file reads as unobserved below */ }

    const pathOf = (f: { folderId: string; name: string }): string =>
        `${folderName.get(f.folderId) ?? f.folderId}/${f.name}`;

    const staleCutoffMs = Date.now() - STALE_FILE_DAYS * DAY_MS;
    // A newest-hit older than the threshold: the file is still in the corpus
    // and still enabled, but retrieval has not carried it into a prompt in
    // `STALE_FILE_DAYS` days — measurable because the log stamps every run.
    const staleFiles = files
        .filter(f => f.enabled)
        .map(f => {
            const hit = lastHitMs.get(hitKey(pathOf(f)));
            return hit === undefined || hit >= staleCutoffMs ? null : {
                path: pathOf(f),
                chars: f.content.length,
                daysSinceHit: Math.floor((Date.now() - hit) / DAY_MS),
                lastHitAt: new Date(hit).toISOString(),
            };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => b.daysSinceHit - a.daysSinceHit)
        .slice(0, 12);

    // No hit inside the retained window at all. NOT folded into `staleFiles`:
    // the log is run-capped, so absence only proves "not served recently".
    const unobserved = files
        .filter(f => f.enabled && !lastHitMs.has(hitKey(pathOf(f))))
        .map(f => ({
            path: pathOf(f),
            chars: f.content.length,
            daysSinceEdit: Math.max(0, Math.floor((Date.now() - (f.updatedAt || Date.now())) / DAY_MS)),
        }))
        .sort((a, b) => b.chars - a.chars)
        .slice(0, 12);

    const proposals = listLearningProposals(username);
    const beliefs = readSettledBeliefs();
    // Challenge flags the belief-challenge pass already queued. A flagged
    // belief is still `settled` by design (nothing auto-invalidates), so
    // without this the standing-but-challenged case was invisible: the old
    // count folded them into `needsRewrite` generically.
    const challengedSlugs = new Set(
        proposals
            .filter(p => p.kind === 'contradiction' && p.fingerprint.startsWith(BELIEF_FLAG_FINGERPRINT_PREFIX))
            .map(p => p.fingerprint.slice(BELIEF_FLAG_FINGERPRINT_PREFIX.length) || p.skillSlug || ''),
    );
    const challengedBeliefs = beliefs
        .filter(b => b.status === 'settled' && challengedSlugs.has(b.slug));
    const tombstones = await listTombstones(username);
    const queues: HealthQueue = {
        drafts: listSkillDrafts(username).length,
        proposals: proposals.length,
        amendments: listAmendments('pending').length,
        forgedTools: loadForgedTools().filter(t => t.status === 'candidate').length,
        supervisorPending: countPendingSupervision(username),
        graveyard: tombstones.length,
        needsRewrite: proposals.filter(p => p.kind === 'rescope' || p.kind === 'contradiction').length,
    };

    const diaryFiles = files.filter(f => folderName.get(f.folderId) === 'trader-diary');
    const skills = bucketSkills(metas);
    // The ghost count rides with the skill bucket, so the Health card can
    // show it as a number beside the other skill counts and not only as a
    // line of prose.
    skills.ghosts = ghostSkills;
    // P1-4: clusters the worth gate could not judge. Reading the ledger is how
    // "the loop stopped learning new skills" becomes visible instead of
    // looking like "there was nothing to learn".
    const gateThrottled = listWorthGateAttempts(username)
        .map(a => ({ key: a.key, attempts: a.attempts, lastAt: a.lastAt }));
    // Suspension is its own fact (`suspendedAt`), not `!enabled` — a
    // user-retired file is also disabled, and reporting that as "the app
    // stopped using it" would be a lie. Counted by the lifecycle module itself
    // so this report and the hygiene log can never disagree.
    const suspendedSkills = listSuspendedSkills();
    const notebookSize = getNotebookSize();
    const writeFailure = getNotebookWriteFailure();

    const flags: string[] = [];
    // FIRST, and above everything else: a notebook write that the storage layer
    // refused means nothing on this page is on disk. Every other flag here is a
    // question of what the app learned; this one is whether it kept it.
    if (writeFailure) {
        const mb = (writeFailure.bytes / (1024 * 1024)).toFixed(2);
        const lost = `${writeFailure.streak} write${writeFailure.streak === 1 ? '' : 's'} lost since the last one reached disk.`;
        // Name the store that actually refused. The amendment queue is small, so
        // quoting its size would read as a rounding joke — but it is the queue
        // holding unapproved model corrections, and saying "notebook" there
        // would point the user at the wrong place to look.
        const what = writeFailure.scope === 'notebook'
            ? `the ${mb} MB notebook`
            : 'the pending amendment queue';
        flags.push(writeFailure.kind === 'quota'
            ? `NOT SAVING — storage refused ${what} as full, so learning is living only in this session.`
                + ` ${lost} Free space or delete old backups, then export one.`
            : `NOT SAVING — the ${SCOPE_LABEL[writeFailure.scope]} write failed (${writeFailure.message}).`
                + ` ${lost} Everything below is read from memory, not from disk.`);
    }
    if (queues.supervisorPending > 0) {
        flags.push(`${queues.supervisorPending} item${queues.supervisorPending === 1 ? '' : 's'} waiting on the supervisor.`);
    }
    if (skills.hurtsVerdict > 0) {
        flags.push(`${skills.hurtsVerdict} skill${skills.hurtsVerdict === 1 ? '' : 's'} with a "hurts" eval verdict still enabled.`);
    }
    if (skills.staleEvidence > 0) {
        flags.push(`${skills.staleEvidence} learned skill${skills.staleEvidence === 1 ? '' : 's'} with no counted evidence in ${EVIDENCE_STALE_DAYS}+ days.`);
    }
    // A skill file that does not parse is a GHOST: it is in the notebook, in
    // the backup and in the export, and it is in NO list — not the skills
    // index, not the retrieval, not this card. Until now the report computed
    // that count and threw it away, so a malformed skill was the one failure
    // the Health tab could not see. It is a file the trader can fix by hand,
    // so it says where to look.
    if (ghostSkills > 0) {
        flags.push(`${ghostSkills} skill file${ghostSkills === 1 ? '' : 's'} could not be parsed — ${ghostSkills === 1 ? 'it is' : 'they are'} in the notebook and in every backup, but in no list.`);
    }
    // The ONE-format gate over the whole library, including the files that
    // predate it. The new-skill gates keep the shape on the way in; this is
    // what keeps "every skill in the skills folder follows the same format"
    // a checked claim instead of a hope.
    const skillFormatReport = {
        checked: skillFiles.length,
        conforming: 0,
        issues: skillFiles
            .map(f => {
                const meta = parseSkillMarkdown(f.content);
                return {
                    file: f.name,
                    problems: skillFormatIssues({
                        fileName: f.name,
                        ...(meta ?? {}),
                    }),
                };
            })
            .filter(r => r.problems.length > 0),
    };
    skillFormatReport.conforming = skillFormatReport.checked - skillFormatReport.issues.length;
    if (skillFormatReport.issues.length > 0) {
        flags.push(`${skillFormatReport.issues.length} skill file${skillFormatReport.issues.length === 1 ? ' does' : 's do'} not follow the one skill format (slug name, one \`when\` trigger, description, procedure body) — the file-by-file list is in the Health report.`);
    }
    if (queues.needsRewrite > 0) {
        flags.push(`${queues.needsRewrite} proposal${queues.needsRewrite === 1 ? '' : 's'} need a rewritten clause before anything can act on them.`);
    }
    if (staleFiles.length > 0) {
        flags.push(`${staleFiles.length} enabled file${staleFiles.length === 1 ? '' : 's'} last reached a prompt ${STALE_FILE_DAYS}+ days ago.`);
    }
    if (challengedBeliefs.length > 0) {
        flags.push(`${challengedBeliefs.length} settled belief${challengedBeliefs.length === 1 ? '' : 's'} ${challengedBeliefs.length === 1 ? 'is' : 'are'} contradicted by winning trades and still standing — the challenge is waiting in the queue.`);
    }

    // Skills the idle lifecycle took out of prompts are reversible, so they are
    // a note rather than a problem — but a user has to be able to see that the
    // app stopped using a rule on its own, and where to put it back.
    if (suspendedSkills.length > 0) {
        const plural = suspendedSkills.length === 1 ? '' : 's';
        const pronoun = suspendedSkills.length === 1 ? 'it' : 'them';
        flags.push(`${suspendedSkills.length} skill${plural} suspended from prompts by the idle sweep`
            + ` — re-enable ${pronoun} in the notebook, or retire ${pronoun} for good.`);
    }
    // The budget's own state, so a refused notebook write is explainable before
    // the user wonders why learning appears to have stopped.
    if (notebookSize && notebookSize.pressure !== 'ok') {
        flags.push(describePressure(notebookSize));
    }
    // P1-4: the loop wanted to judge a new skill and could not. Without this
    // line the throttle is invisible — the inbox simply stays empty, which
    // reads as "nothing to learn" rather than "learning is blocked".
    if (gateThrottled.length > 0) {
        const n = gateThrottled.length;
        flags.push(`${n} cluster${n === 1 ? '' : 's'} the skill worth-gate could not judge`
            + ` — no memory model is configured, or the last attempt saw no new evidence.`
            + ` Retries by itself when the cluster gains a trade; configure a memory model to judge now.`);
    }

    return {
        generatedAt: Date.now(),
        folders: [...byFolder.values()].sort((a, b) => b.files - a.files),
        skills,
        skillFormat: skillFormatReport,
        notebook: {
            files: files.length,
            enabled: files.filter(f => f.enabled).length,
            chars: files.reduce((n, f) => n + f.content.length, 0),
            bytes: notebookSize?.bytes ?? 0,
            pressure: notebookSize?.pressure ?? null,
            writeFailure,
            suspended: suspendedSkills.length,
            promptTokensWorstCase: estimateMemoryTokensPerRun().worstCase,
        },
        unobserved,
        staleFiles,
        injectionLogWindowRuns: MAX_INJECTION_RECORDS,
        beliefs: {
            settled: beliefs.filter(b => b.status === 'settled').length,
            invalidated: beliefs.filter(b => b.status === 'invalidated').length,
            challenged: challengedBeliefs.length,
        },
        queues,
        diary: {
            files: diaryFiles.length,
            entries: diaryFiles.reduce((n, f) => n + (f.content.split('\n## ').length - 1), 0),
        },
        bots: loadBotLearningStats(),
        gateThrottled,
        hygiene: await loadHygieneLog(username),
        flags,
    };
};

/** Cheap sync subset for a nav badge — counts only, no notebook walk. */
export const countPendingEverything = (username: string): number =>
    listSkillDrafts(username).length
    + listLearningProposals(username).length
    + listAmendments('pending').length;
