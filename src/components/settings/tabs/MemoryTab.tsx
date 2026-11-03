// TAB: Memory — the switches Settings still owns (the notebook itself, the
// amendment inbox and the supervisor stream moved to the Learning surface).
//
// The page is the reference Settings → Memory shape: a short stack of switches,
// then the assistant's memories as named topics grouped under You / Topics /
// Areas, each opening its own page. The notebook stays one row away.
import React, { useState } from 'react';
import ProfileMemoryCard from '../ProfileMemoryCard';
import AmendmentsInbox from '../../learn/AmendmentsInbox';
import { SettingsGroup, SettingsPageHeader } from './shared';
import type { SettingsTabProps } from './types';

/** `SettingsTabProps`, narrowed to what this tab reads. An alias rather than an
 *  empty `interface extends` — that form is equivalent to its supertype and the
 *  lint rule flags it, and there is nothing to add here. The `onOpenLearn`
 *  binding is pre-narrowed in `SettingsMenu` so the child's callback stays
 *  typed. */
export type MemoryTabProps = SettingsTabProps;

const MemoryTab: React.FC<{ tab: MemoryTabProps }> = ({ tab: props }) => {
    const {
        memoryConfig,
        onOpenLearn,
    } = props;

    const model = memoryConfig?.selectedModel || memoryConfig?.name || undefined;
    // An entry's page IS the page — the reference drops the page title there and
    // leads with the back link, so the Memory heading belongs to the list only.
    const [detailOpen, setDetailOpen] = useState(false);

    return (
        <div className="animate-fade-in" data-testid="memory-tab">
            {!detailOpen && <SettingsPageHeader title="Memory" />}

            <div className={detailOpen ? 'pt-7' : 'mt-7'}>
                <ProfileMemoryCard
                    memoryModel={model}
                    onOpenNotebook={onOpenLearn ? () => onOpenLearn('memory') : undefined}
                    onDetailOpenChange={setDetailOpen}
                />
                {/* The corrections log lives with the notebook it edits (owner
                    ruling 2026-11-03: no Approvals tab). Model amendments apply
                    themselves; this keeps the before/after and the ONE Undo.
                    A pending row exists only when the supervisor or a
                    trader-requested edit deferred one to a human. */}
                <div className="mt-7">
                    <SettingsGroup
                        title="Corrections"
                        description="Notes the desk changed with amend_memory. Applied directly — the before and after are kept here so a correction can be undone."
                    >
                        <div className="py-3">
                            <AmendmentsInbox />
                        </div>
                    </SettingsGroup>
                </div>
            </div>
        </div>
    );
};

export default MemoryTab;
