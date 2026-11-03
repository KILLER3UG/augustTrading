/**
 * AutoJournalRulesCard — the standing "always/never journal {coin}" rules the
 * approvals inbox creates (App.tsx answers an approval with Always/Never, and
 * `useWatchSideEffects` then enforces that answer on every pinned setup).
 *
 * Enforcement had readers but no surface: after the click that created a rule
 * it was invisible, and the only way to undo it was to click the OPPOSITE
 * policy — which wrote another standing rule instead of removing one. This
 * lists the rules and revokes through `setAutoJournalRule(coin, 'ask')`,
 * storage's own delete path (policy 'ask' writes no row), so nothing here
 * invents a shape the reader doesn't already understand.
 *
 * Styling mirrors SettingsGroup/SettingsRow — both local to SettingsMenu and
 * not exported — so the card sits in the Journal tab without a second dialect.
 */
import React, { useState } from 'react';
import { Ban, Check, Undo2 } from '../shared/Icons';
import {
    getAutoJournalRules, setAutoJournalRule, type AutoJournalRule,
} from '../../utils/autoJournalRules';
import { EmptyState } from '../ui/EmptyState';

interface AutoJournalRulesCardProps {
    /** Active profile — rules are stored per user, like the inbox that makes them. */
    username?: string;
}

export const AutoJournalRulesCard: React.FC<AutoJournalRulesCardProps> = ({ username }) => {
    const [rules, setRules] = useState<AutoJournalRule[]>(() => getAutoJournalRules(username));

    const revoke = (coin: string): void => {
        setAutoJournalRule(coin, 'ask', username);
        // Re-read the store instead of filtering locally: the inbox can add a
        // rule while this panel is open, and a stale local write would
        // resurrect the one just removed (or drop the new one).
        setRules(getAutoJournalRules(username));
    };

    return (
        <section className="space-y-1.5" aria-label="Standing journal rules">
            <div className="px-1">
                <h4 className="text-ui-dense font-semibold uppercase tracking-[0.08em] text-zinc-500">Standing journal rules</h4>
                <p className="mt-0.5 text-ui-dense leading-relaxed text-zinc-600">
                    Made from the approvals inbox. &ldquo;Always&rdquo; journals the coin without asking,
                    &ldquo;Never&rdquo; dismisses it — remove a rule to go back to asking.
                </p>
            </div>
            <div className="divide-y divide-white/[0.05] overflow-hidden rounded-bubble border border-white/[0.07] bg-zinc-900/50">
                {rules.length === 0 ? (
                    <EmptyState
                        compact
                        align="start"
                        icon={<Undo2 className="h-5 w-5" aria-hidden="true" />}
                        title="No standing rules"
                        description="Every approval asks before it journals. Pick Always or Never on one to make it standing."
                    />
                ) : rules.map(rule => (
                    <div key={rule.coin} className="flex items-center gap-3 p-4">
                        <span
                            aria-hidden="true"
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-white/[0.06] bg-white/[0.04] ${
                                rule.policy === 'always' ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                        >
                            {rule.policy === 'always'
                                ? <Check className="h-4 w-4" aria-hidden="true" />
                                : <Ban className="h-4 w-4" aria-hidden="true" />}
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="text-ui-caption font-semibold leading-5 text-zinc-200">{rule.coin}</div>
                            <div className="mt-0.5 text-ui-dense leading-relaxed text-zinc-500">
                                {rule.policy === 'always'
                                    ? 'Always journal — logged without asking.'
                                    : 'Never journal — dismissed without asking.'}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => revoke(rule.coin)}
                            aria-label={`Remove the ${rule.policy === 'always' ? 'always' : 'never'} journal rule for ${rule.coin}`}
                            className="shrink-0 rounded-control border border-white/10 bg-zinc-800 px-2.5 py-1 text-ui-dense font-semibold text-zinc-200 transition-colors hover:border-white/20 hover:bg-zinc-700 hover:text-zinc-100 active:scale-[0.98]"
                        >
                            Ask instead
                        </button>
                    </div>
                ))}
            </div>
        </section>
    );
};

export default AutoJournalRulesCard;
