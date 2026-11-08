/**
 * SkillFormatService — the model's pen for a skill that does not follow the
 * format.
 *
 * The skill store (`SkillFileService`) deliberately never rewrites a trader's
 * prose, and its create/update path stays permissive because the contract pins
 * a sectionless create as legal. This service is the OTHER answer to the same
 * problem: the trader picks a model, the model reshapes ONE document into the
 * SKILL.md shape, and the result goes through the normal write path with the
 * version that was read — so it carries the same optimistic-concurrency and
 * duplicate-scan guarantees a human edit does.
 *
 * It never throws: a failure to find a provider, a transport error and a
 * malformed answer are three different reasons, and the caller shows them
 * differently.
 */

import type { ProviderConfig } from '../../types/provider';
import { sendChatRequest } from '../providers/GenericProviderService';
import { TASK_BUDGETS } from '../providers/taskBudgets';
import { effortForTask } from '../providers/reasoningControls';
import { skillFormatIssues, type SkillFormatIssue } from '../../utils/skillFrontmatter';
import {
    getSkill,
    parseSkillMarkdown,
    writeSkillFile,
    SKILL_BODY_SECTIONS,
} from './SkillFileService';

const SYSTEM_PROMPT = [
    'You format ONE skill document. You do not invent procedure and you do not summarise it:',
    'you keep every step, level, condition and caveat the author wrote, and you change only the SHAPE.',
    '',
    'The format is exactly this:',
    '',
    '---',
    'name: "<the skill\'s short display title>"',
    'description: "<what it does, then when to use it>"',
    '---',
    '',
    ...SKILL_BODY_SECTIONS.map(s => `## ${s}`),
    '',
    '...where the four headings are:',
    ...SKILL_BODY_SECTIONS.map(s => `- ## ${s}`),
    '',
    'Rules:',
    '- The frontmatter is a --- fence, then name: and description:, then ---. Nothing else in the head.',
    `- Use those four ## headings and no others at that level.`,
    "- Keep the author's own words where they are already clear; do not add steps they did not write.",
    '- Return ONLY the SKILL.md content. No commentary, no preamble, no code fence.',
].join('\n');

/** Pull the SKILL.md out of a reply that may be fenced or may carry prose
 *  around it. A model that wraps the document in ```markdown or opens with
 *  "Here is the skill:" is answering correctly; only the bytes change. */
const extractSkillMarkdown = (raw: string): string => {
    let text = (raw || '').trim();
    const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
    if (fenced) text = fenced[1].trim();
    if (!text.startsWith('---')) {
        const at = text.indexOf('\n---');
        if (at >= 0) text = text.slice(at + 1).trim();
    }
    if (text.endsWith('```')) text = text.slice(0, -3).trim();
    return text;
};

export interface SkillRewriteResult {
    ok: boolean;
    message: string;
    /** The format problems that were fixed, or the ones that remain. */
    issues?: string[];
    /** The model that wrote the rewrite, for the note the trader reads. */
    model?: string;
}

export const rewriteSkillWithModel = async (opts: {
    slug: string;
    config: ProviderConfig;
    username?: string;
    signal?: AbortSignal;
}): Promise<SkillRewriteResult> => {
    const skill = getSkill(opts.slug);
    if (!skill) return { ok: false, message: `No skill "${opts.slug}" exists.` };

    const before = skillFormatIssues(skill.file.content);
    const prompt = [
        `Skill: ${skill.name}`,
        `Slug: ${skill.slug}`,
        '',
        '--- SKILL.md (current) ---',
        skill.file.content,
        '--- end ---',
        '',
        'Rewrite it into the format above.',
    ].join('\n');

    let raw: string;
    try {
        raw = await sendChatRequest(
            opts.config,
            [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: prompt },
            ],
            {
                maxTokens: TASK_BUDGETS.skillFormat,
                temperature: 0.2,
                reasoningEffort: effortForTask('skillFormat'),
                signal: opts.signal,
            },
        );
    } catch (err) {
        return {
            ok: false,
            message: `The model could not be reached: ${err instanceof Error ? err.message : String(err)}. Nothing was written.`,
        };
    }
    if (!raw || !raw.trim()) {
        return { ok: false, message: 'The model returned nothing. Nothing was written.' };
    }

    const candidate = extractSkillMarkdown(raw);
    const remaining: SkillFormatIssue[] = skillFormatIssues(candidate);
    if (remaining.length > 0) {
        return {
            ok: false,
            message: `The model's rewrite still does not follow the format: ${remaining.map(i => i.what).join('; ')}. Nothing was written.`,
            issues: remaining.map(i => i.what),
        };
    }
    const parsed = parseSkillMarkdown(candidate);
    if (!parsed) return { ok: false, message: 'The model returned no readable SKILL.md. Nothing was written.' };

    const result = await writeSkillFile({
        slug: skill.slug,
        name: parsed.name || skill.name,
        description: parsed.description || skill.description,
        body: parsed.body,
        ifVersion: skill.version,
    }, opts.username);

    if (!result.ok) return { ok: false, message: result.message };
    return {
        ok: true,
        message: `Reformatted "${skill.name}" — ${before.length} format issue${before.length === 1 ? '' : 's'} fixed.`,
        issues: before.map(i => i.what),
        model: opts.config.selectedModel,
    };
};

export default rewriteSkillWithModel;
