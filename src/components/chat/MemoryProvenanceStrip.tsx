/**
 * MemoryProvenanceStrip — the one place the app answers "what did the AI
 * actually remember for this answer?" (WS-5.2).
 *
 * This used to be three surfaces that all drifted out of use: a stats blurb
 * (InjectionContextBar), skill chips (SkillCitationChips) and a model byline
 * (ModelByline). None of them could be mounted on a dock entry, because the
 * join they all needed — which injections landed inside THIS answer's run —
 * had no lower bound: chat entries carried no timestamp. They do now
 * (`StoredChatEntry.at`), and the upper bound is the NEXT entry's stamp, so a
 * later run's injections cannot leak onto an older answer.
 *
 * What it reads is the injection log, not a setup match. That distinction is
 * the whole point: budgets, audience filters and lens scope all
 * mean a skill can match a setup and never be shown. "Skills used" has to mean
 * shown, or the row teaches the trader to distrust it.
 *
 * The row is one hairline; the paths open beneath it. Tapping a skill opens its
 * card; flagging it records negative evidence against the lesson store — the
 * only place a "that rule was wrong HERE" judgement can be captured while the
 * context is still on screen.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Flag } from '../shared/Icons';
import { getRecentMemoryInjections, type MemoryInjectionRecord } from '../../services/learning/MemoryInjectionService';
import { recordHarnessLesson } from '../../services/learning/harnessLessons';
import { getActiveUsername } from '../../utils/activeUser';
import { openSkillCard } from './skillDeepLink';

interface MemoryProvenanceStripProps {
    /** Epoch-ms the answer's entry was created — the window's lower bound. */
    startedAt?: number;
    /** Epoch-ms the NEXT entry was created, when there is one. Without it the
     *  window stays open-ended and only renders for a settled answer. */
    nextAt?: number;
    /** The answer's own entry id — used as the evidence id when flagging. */
    messageId: string;
    onLessonRecorded?: (text: string) => void;
}

interface Grouped {
    /** skills/<slug>, most recent stage first */
    skills: string[];
    /** everything that is not a skill, as `${kind}:${path}` */
    others: Array<{ kind: string; path: string }>;
}

/** One pass over the window's records: dedupe paths, group by kind. */
export const groupInjections = (recs: MemoryInjectionRecord[]): Grouped => {
    const skills: string[] = [];
    const others: Array<{ kind: string; path: string }> = [];
    const seen = new Set<string>();
    for (const r of recs) {
        for (const s of r.sources) {
            if (seen.has(s.path)) continue;
            seen.add(s.path);
            if (s.kind === 'skill' && s.path.startsWith('skills/')) {
                skills.push(s.path.slice('skills/'.length).replace(/\.md$/i, ''));
            } else {
                others.push({ kind: s.kind, path: s.path });
            }
        }
    }
    return { skills, others };
};

/** Human labels for the non-skill kinds, in read order. */
const KIND_LABEL: Record<string, string> = {
    identity: 'who you are',
    rules: 'risk rules',
    playbook: 'playbook',
    similar: 'similar trades',
    bot: 'agent notes',
    diary: 'diary',
};

const MemoryProvenanceStrip: React.FC<MemoryProvenanceStripProps> = ({
    startedAt, nextAt, messageId, onLessonRecorded,
}) => {
    const [recs, setRecs] = useState<MemoryInjectionRecord[]>([]);
    const [open, setOpen] = useState(false);
    const [flagged, setFlagged] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (!startedAt) return;
        let cancelled = false;
        void getRecentMemoryInjections(getActiveUsername()).then(all => {
            if (cancelled) return;
            setRecs(all.filter(r => {
                const t = Date.parse(r.ts);
                if (!Number.isFinite(t)) return false;
                // 1s slack either side: the entry is stamped before the fetch
                // and the record after the write, and both clocks tick.
                if (t < startedAt - 1000) return false;
                return nextAt ? t <= nextAt + 1000 : true;
            }));
        }).catch(() => { if (!cancelled) setRecs([]); });
        return () => { cancelled = true; };
    }, [startedAt, nextAt]);

    const grouped = useMemo(() => groupInjections(recs), [recs]);

    const flag = useCallback((slug: string): void => {
        recordHarnessLesson({
            kind: 'injection',
            scope: 'skillGuidance',
            pattern: `skill:${slug}`,
            lesson: `Skill "${slug}" was injected into an answer the trader flagged as wrong here — review its rule before it fires again.`,
            evidenceId: `message:${messageId}`,
        });
        setFlagged(prev => new Set(prev).add(slug));
        onLessonRecorded?.(`Flagged "/${slug}" as a harness lesson.`);
    }, [messageId, onLessonRecorded]);

    if (!startedAt || (grouped.skills.length === 0 && grouped.others.length === 0)) return null;

    const parts: string[] = [];
    if (grouped.skills.length > 0) parts.push(`${grouped.skills.length} skill${grouped.skills.length === 1 ? '' : 's'}`);
    for (const { kind } of grouped.others) {
        const label = KIND_LABEL[kind] ?? kind;
        if (!parts.includes(label)) parts.push(label);
    }

    return (
        <div className="border-t border-zinc-800/80 pt-1" data-testid="memory-provenance-strip">
            <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
                className="hit-target flex w-full items-center gap-1.5 py-0.5 text-left">
                <span className="shrink-0 font-mono text-ui-2xs uppercase tracking-widest text-zinc-600">memory</span>
                <span className="min-w-0 flex-1 truncate text-ui-xs text-zinc-500" title={parts.join(' · ')}>{parts.join(' · ')}</span>
                <ChevronDown className={`h-3 w-3 shrink-0 text-zinc-600 transition-transform duration-[120ms] ease-[var(--ease-snappy)] ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
                <div className="mt-0.5 mb-1 space-y-0.5 pl-1">
                    {grouped.skills.map(slug => (
                        <div key={slug} className="flex items-center gap-1.5">
                            <span className="w-9 shrink-0 font-mono text-ui-2xs uppercase tracking-wider text-cyan-300/80">skill</span>
                            <button type="button" onClick={() => openSkillCard(slug)}
                                className="min-w-0 flex-1 truncate text-left font-mono text-ui-xs text-zinc-300 hover:underline" title={`/${slug}`}>
                                /{slug}
                            </button>
                            <button type="button" onClick={() => flag(slug)}
                                aria-label={`Flag ${slug} as wrong in this answer`}
                                title="This rule was wrong here — record the negative evidence"
                                className="shrink-0 rounded-control p-0.5 text-zinc-600 transition-colors hover:bg-white/[0.06] hover:text-zinc-200">
                                {flagged.has(slug) ? <Check className="h-3 w-3 text-emerald-400" aria-hidden="true" /> : <Flag className="h-3 w-3" aria-hidden="true" />}
                            </button>
                        </div>
                    ))}
                    {grouped.others.map(({ kind, path }) => (
                        <div key={`${kind}:${path}`} className="flex items-center gap-1.5">
                            <span className="w-9 shrink-0 truncate font-mono text-ui-2xs uppercase tracking-wider text-zinc-600" title={(KIND_LABEL[kind] ?? kind).split(' ')[0]}>
                                {(KIND_LABEL[kind] ?? kind).split(' ')[0]}
                            </span>
                            <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-zinc-500" title={path}>{path}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default React.memo(MemoryProvenanceStrip);
