/**
 * StrategyStudio — the skill library surface.
 *
 * The analytics, evidence badges and management queue that used to live here
 * belonged to the retired skill ledger. What remains is the thing a trader
 * actually needs: the library, readable and editable, in one place.
 */

import React, { useEffect, useState } from 'react';
import type { LoggedTrade } from '../../types';
import type { ProviderConfig } from '../../types/provider';
import SkillLibrary from '../skills/SkillLibrary';
import { consumePendingSkillOpen } from '../chat/skillDeepLink';

interface StrategyStudioProps {
    trades?: LoggedTrade[];
    username?: string;
    currentRegime?: string;
    memoryConfig?: ProviderConfig | null;
    onOpenStrategySearch?: () => void;
    onClose?: () => void;
    /** Configured providers, for the format-with-model picker. */
    providers?: ProviderConfig[];
    /** The model that reformats a skill, as `providerId::modelId`. */
    formatModel?: string;
    onFormatModelChange?: (value: string) => void;
}

/** The slug a skill-citation chip parked, or broadcast while this surface was
 *  already mounted. Tapping a citation has to open THAT document: App's own
 *  listener only changes the surface, and a parked value nobody consumes is a
 *  deep link that lands on the library and stops there. */
const StrategyStudio: React.FC<StrategyStudioProps> = ({
    providers, formatModel, onFormatModelChange,
}) => {
    const [deepLink, setDeepLink] = useState<string | null>(() => consumePendingSkillOpen());

    useEffect(() => {
        const onOpenSkill = (e: Event): void => {
            const slug = (e as CustomEvent<{ slug?: string }>).detail?.slug;
            if (slug) setDeepLink(slug);
        };
        window.addEventListener('august:open-skill', onOpenSkill);
        return () => window.removeEventListener('august:open-skill', onOpenSkill);
    }, []);

    return (
        <div className="flex h-full min-h-0 flex-col bg-surface-page px-5 py-4 text-zinc-100" data-testid="studio-view">
            <header className="mb-3 shrink-0">
                <h2 className="font-serif text-ui-xl tracking-tight text-zinc-100">Skills</h2>
                <p className="text-ui-dense text-zinc-500">
                    One folder per skill: SKILL.md plus references, templates, scripts and assets.
                </p>
            </header>
            <div className="min-h-0 flex-1">
                <SkillLibrary
                    initialSlug={deepLink}
                    providers={providers}
                    formatModel={formatModel}
                    onFormatModelChange={onFormatModelChange}
                />
            </div>
        </div>
    );
};

export default StrategyStudio;
