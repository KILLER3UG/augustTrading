/**
 * useJournalUI — manages journal panel state and message expansion toggles.
 * Extracted from App.tsx to reduce component complexity.
 *
 * The post-mortem expansion maps and the candidate that gated the upload modal
 * are gone: the post-mortem feature that filled them has been deleted.
 */

import { useState } from 'react';

/** Journal panel route state — consumed only for its `tab` vocabulary since
 *  the surface router owns opening (journalState was deleted after the dead
 *  overlay went; audit 2026-09-15). The tab set is the Journal's own:
 *  ledger, stats. The old models/reasoning/learning/memory tabs are
 *  gone — model stats and the reasoning browser were deleted with them
 *  (2026-10-07) and the saved-analyses archive went with the debate that
 *  wrote them (2026-10-18). */
export interface JournalUIState {
    tab: 'log' | 'analytics';
}

export function useJournalUI() {
    const [selectedProbabilityMessageId, setSelectedProbabilityMessageId] = useState<string | null>(null);
    const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

    return {
        selectedProbabilityMessageId, setSelectedProbabilityMessageId,
        copiedMessageId, setCopiedMessageId,
    };
}
