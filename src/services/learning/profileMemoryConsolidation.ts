/**
 * profileMemoryConsolidation — the owner's "auto-consolidate" rule for a full
 * or over-long collaboration memory.
 *
 * The store is bounded (40 entries, 2,000 chars per body). It used to enforce
 * that by silently slicing the oldest rows out of the array. That is data loss
 * the trader cannot see. This pass spends ONE model call before the write:
 *
 *   • full store → merge the oldest non-sensitive facts into one inferred
 *     entry (the oldest slug survives, so references to it still resolve),
 *     keeping every durable detail the model can preserve;
 *   • over-long new fact → compress that fact to the store's cap;
 *   • no provider / no safe candidate / a malformed answer → refuse the write
 *     with a reason. Never fall back to truncation.
 *
 * It is deliberately a separate module: the store stays synchronous and pure,
 * and the provider dependency lives at the one write site that can pay for it.
 */

import { getQuickResponse } from '../providers/GenericProviderService';
import { getReadyProviders, loadProviderConfigs } from '../infrastructure/ProviderConfigService';
import {
    listProfileMemories, rememberProfileMemory, retireMergedMemory, slugify,
    PROFILE_MEMORY_MAX_BODY_CHARS,
    type ProfileMemoryEntry, type ProfileMemoryKind, type RememberResult,
} from './profileMemory';
import { filterMemoryWrite } from '../../utils/memoryWriteFilters';

const MAX_CANDIDATES = 5;
const COMPRESS_TARGET = PROFILE_MEMORY_MAX_BODY_CHARS - 100;

export interface ConsolidationOutcome {
    removed: string[];
    merged?: string;
    compressed?: boolean;
}

export type RememberWithConsolidationResult =
    | { ok: true; result: RememberResult; consolidation?: ConsolidationOutcome }
    | { ok: false; error: string };

export interface ConsolidationInput {
    slug?: string;
    name?: string;
    /** The row's display name, passed straight through to the store. */
    title?: string;
    description: string;
    kind: ProfileMemoryKind;
    body: string;
    source?: ProfileMemoryEntry['source'];
    tag?: ProfileMemoryEntry['tag'];
    author?: ProfileMemoryEntry['author'];
    sourceTurnId?: string;
    sensitive?: boolean;
    aliases?: string[];
    /** What the fact is about, and the session it was written in — passed
     *  straight through to the store, so consolidation cannot quietly drop the
     *  two provenance fields a writer just set. */
    subject?: ProfileMemoryEntry['subject'];
    /** The display section, passed straight through to the store. */
    section?: string;
    sourceSession?: string;
    ifVersion?: number;
    /** Ask the merge path to absorb the oldest rows. Only the background
     *  consolidation pass sets this — a normal write never merges. */
    forceMerge?: boolean;
}

export interface ConsolidationDeps {
    /** Test seam: one completion. Production resolves the first ready provider. */
    complete?: (prompt: string) => Promise<string>;
    username?: string;
}

const asKind = (v: unknown, fallback: ProfileMemoryKind): ProfileMemoryKind =>
    v === 'user' || v === 'feedback' || v === 'project' || v === 'reference' ? v : fallback;

const parseJson = (text: string): Record<string, unknown> | null => {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
        const parsed: unknown = JSON.parse(m[0]);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
};

const resolveComplete = async (): Promise<((prompt: string) => Promise<string>) | null> => {
    const configs = await loadProviderConfigs();
    const config = getReadyProviders(configs)[0];
    if (!config) return null;
    return (prompt: string) => getQuickResponse(
        config,
        prompt,
        'You maintain a trader\'s durable collaboration memory. Preserve durable facts exactly; never invent. Output only what the prompt asks for.',
        { maxTokens: 1200, jsonMode: true, temperature: 0.2 },
    );
};

const mergePrompt = (candidates: ProfileMemoryEntry[]): string => [
    'Merge the OLDEST facts below into ONE compact memory entry. Preserve every durable detail: names, dates, preferences, corrections, and why/how notes. Do not invent or generalise away specifics.',
    'Output ONLY JSON: {"description":"one line (<=140 chars) saying WHEN it matters","body":"the merged fact (<=1800 chars)","kind":"user|feedback|project|reference"}.',
    'Facts:',
    ...candidates.map(e => `- [${e.slug}] (${e.kind}) ${e.description}\n${e.body}`),
].join('\n');

const compressPrompt = (body: string): string => [
    `Compress the fact below to at most ${COMPRESS_TARGET} characters. Keep every durable detail (names, dates, preferences, corrections); drop repetition and prose, not facts. Output ONLY the compressed body text.`,
    'Fact:',
    body,
].join('\n');

/**
 * Write a memory through the consolidation gate. The caller must treat
 * `ok:false` as "nothing was saved" (except a merge that may already have
 * landed before a later failure — the error says so).
 */
export const rememberWithConsolidation = async (
    input: ConsolidationInput,
    deps: ConsolidationDeps = {},
): Promise<RememberWithConsolidationResult> => {
    const user = deps.username;
    const slug = input.slug?.trim() ? slugify(input.slug) : slugify(input.name || input.description);
    const all = listProfileMemories(user);
    const existing = all.find(e => e.slug === slug);
    // A lock miss is answered before any consolidation: nothing should be
    // rewritten for a turn that is about to be told to merge and retry.
    if (existing && typeof input.ifVersion === 'number' && (existing.version ?? 1) !== input.ifVersion) {
        return { ok: true, result: rememberProfileMemory({ ...input, slug }, user) };
    }
    const needsCompression = input.body.trim().length > PROFILE_MEMORY_MAX_BODY_CHARS;
    // MERGING IS NO LONGER A SIDE EFFECT OF A FULL STORE. The entry cap is gone
    // (a soft warning now), so nothing has to be absorbed for a write to land.
    // The merge machinery stays reachable for the background consolidation pass
    // (section F.4), which asks for it explicitly.
    const needsSlot = input.forceMerge === true && !existing;
    if (!needsCompression && !needsSlot) {
        return { ok: true, result: rememberProfileMemory({ ...input, slug }, user) };
    }

    const complete = deps.complete ?? await resolveComplete();
    if (!complete) {
        return { ok: false, error: 'the fact is too long to store as written and no model is available to compress it' };
    }

    let body = input.body;
    let compressed = false;
    if (needsCompression) {
        try {
            const answer = await complete(compressPrompt(input.body.trim()));
            const clean = answer.trim();
            if (!clean || clean.length > COMPRESS_TARGET + 100) {
                return { ok: false, error: 'the consolidation model did not return a usable compressed fact' };
            }
            body = clean;
            compressed = true;
        } catch (err) {
            return { ok: false, error: `compression failed: ${err instanceof Error ? err.message : String(err)}` };
        }
    }

    const outcome: ConsolidationOutcome = { removed: [], compressed };
    if (needsSlot) {
        // Sensitive rows are never sent to a model or merged away; if the store
        // is full only of them, the honest answer is "full", not an arbitrary
        // deletion of the trader's health/finance facts.
        const candidates = all.filter(e => !e.sensitive && e.slug !== slug).slice(0, MAX_CANDIDATES);
        if (candidates.length < 2) {
            return { ok: false, error: 'the memory is full of sensitive facts that cannot be consolidated automatically; delete one first' };
        }
        let answer: Record<string, unknown> | null;
        try {
            answer = parseJson(await complete(mergePrompt(candidates)));
        } catch (err) {
            return { ok: false, error: `consolidation failed: ${err instanceof Error ? err.message : String(err)}` };
        }
        const mergedBody = typeof answer?.body === 'string' ? answer.body.trim() : '';
        const mergedDesc = typeof answer?.description === 'string' ? answer.description.trim() : '';
        if (!answer || !mergedBody || !mergedDesc || mergedBody.length > PROFILE_MEMORY_MAX_BODY_CHARS) {
            return { ok: false, error: 'the consolidation model did not return a usable merged fact' };
        }
        // The merge is the one write that does not pass the tool's filters: its
        // text comes from a model reading stored rows, not from the trader. A
        // merge that would put a secret (or an honesty-suppressing line) into
        // the survivor is refused before anything is deleted, so a full store
        // stays full rather than silently gaining text no `remember` could write.
        const mergedVerdict = filterMemoryWrite(`${mergedDesc}\n${mergedBody}`);
        if (mergedVerdict.refused) {
            return { ok: false, error: `the merged fact cannot be stored: ${mergedVerdict.refused}` };
        }
        const keeper = candidates[0];
        const mergeResult = rememberProfileMemory({
            slug: keeper.slug,
            description: mergedDesc.slice(0, 160),
            kind: asKind(answer.kind, keeper.kind),
            body: mergedBody,
            source: 'auto',
            tag: 'inferred',
            // A merge must not quietly cost the survivor its match words. The
            // aliases are what the deterministic pre-read hits on, and dropping
            // them at the exact moment the store fills is the opposite of what
            // consolidation is for; subject and the session the merge happened
            // in travel with the row for the same reason.
            aliases: [...new Set([...(keeper.aliases ?? []), ...(input.aliases ?? [])])].slice(0, 8),
            subject: input.subject ?? keeper.subject,
            sourceSession: input.sourceSession ?? keeper.sourceSession,
            // What this row now contains that used to be somewhere else. The
            // losers are deleted a few lines below, so without this the merged
            // record would be untraceable — and `forgetProfileMemory`'s
            // "delete anything derived solely from it" rule would have nothing
            // to read. The keeper's own history rides along, so a row merged
            // twice does not lose its first merge.
            derivedFrom: [...new Set([
                ...(keeper.derivedFrom ?? []),
                ...candidates.slice(1).map(c => c.slug),
            ])].filter(s => s !== keeper.slug).slice(0, 12),
        }, user);
        if (mergeResult.conflict || mergeResult.persisted === false) {
            return { ok: false, error: 'the merged memory could not be stored; nothing was deleted' };
        }
        for (const candidate of candidates.slice(1)) {
            // retire, not forget: the survivor's derivedFrom names these very
            // slugs, and the trader-facing cascade would take the merged row
            // down with its own first input.
            if (retireMergedMemory(candidate.slug, user)) outcome.removed.push(candidate.slug);
        }
        outcome.merged = keeper.slug;
    }

    const result = rememberProfileMemory({ ...input, slug, body }, user);
    return { ok: true, result, consolidation: outcome };
};
