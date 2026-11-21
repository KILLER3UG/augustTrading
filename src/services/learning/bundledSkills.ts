/**
 * bundledSkills — runtime seeding of shipped `skills/<slug>/SKILL.md` playbooks.
 *
 * Writes through the ONE pen (`writeSkillFile`) once per shipped slug per user,
 * recording seeded slugs so a trader who explicitly deletes a bundled skill does
 * not have it resurrected on next launch.
 */

import { getPreference, setPreference } from '../infrastructure/PreferencesService';
import { getSkill, parseSkillMarkdown, writeSkillFile } from './SkillFileService';

export interface BundledSkillEntry {
    slug: string;
    content: string;
}

const SEEDED_KEY_PREFIX = 'bundled_skills_seeded_v1_';

export const getBundledSkills = (): readonly BundledSkillEntry[] =>
    typeof __AUGUST_BUNDLED_SKILLS__ !== 'undefined' && Array.isArray(__AUGUST_BUNDLED_SKILLS__)
        ? __AUGUST_BUNDLED_SKILLS__
        : [];

export const seedBundledSkills = async (
    username: string,
    skills: readonly BundledSkillEntry[] = getBundledSkills(),
): Promise<string[]> => {
    if (!username || skills.length === 0) return [];
    const prefKey = `${SEEDED_KEY_PREFIX}${username}`;
    let seededSet = new Set<string>();
    try {
        const raw = await getPreference(prefKey);
        if (raw) {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                seededSet = new Set(parsed.filter((s): s is string => typeof s === 'string'));
            }
        }
    } catch {
        seededSet = new Set<string>();
    }

    const newlySeeded: string[] = [];
    for (const entry of skills) {
        const slug = String(entry.slug || '').trim();
        if (!slug || seededSet.has(slug)) continue;
        seededSet.add(slug);
        if (getSkill(slug)) continue;
        const parsed = parseSkillMarkdown(entry.content);
        if (!parsed?.name || !parsed?.description || !parsed?.body) continue;
        try {
            const res = await writeSkillFile(
                {
                    slug,
                    name: parsed.name,
                    description: parsed.description,
                    body: parsed.body,
                },
                username,
            );
            if (res.ok) newlySeeded.push(slug);
        } catch {
            // Skip conflicting or unseedable entry cleanly without breaking boot.
        }
    }

    try {
        await setPreference(prefKey, JSON.stringify([...seededSet]));
    } catch {
        // Best-effort tracking; notebook persistence remains authoritative.
    }
    return newlySeeded;
};
