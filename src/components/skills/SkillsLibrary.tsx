// The skill library: the Studio, the trade plans it writes, and the forged-tool
// queue.
//
// It has had three homes. A full-screen surface in the rail (two ways to reach
// one library with two chrome treatments), then Settings → Skills under a
// "Customize" shortcut, then a tab of the Learning surface — and it is a
// SURFACE again since 2026-11-08 (v4 plan, D2), which reverses the removal
// `docs/plan/open-items.md` §5 Q2 argued for. The file moved out of
// `settings/tabs/` with it, because a component that belongs to no dialog
// should not live in one.
//
// The Studio is `flex h-full` with its own scroll, so it gets a measured box
// rather than the surrounding column's auto height — otherwise it collapses to
// its own header.
//
// THE SHAPE, from the reference's Skills page: a page title, then
// the primary list, then the SECONDARY groups as category rows — the group's
// name in muted text with a raised pill beside it, saying what the group
// actually holds. The reference's own second row ("Agentic-Trading" with a
// "System" pill) is that shape, and the two groups below the Studio are
// August's version of it: a name, and a pill that names the fact a reader
// would otherwise have to dig the subtitle out for.
import React from 'react';
import ToolForgeManager from '../settings/ToolForgeManager';
import StrategyPlans from '../settings/StrategyPlans';
import StatusPill from '../ui/StatusPill';

const SkillsLibrary: React.FC<{ studio?: React.ReactNode }> = ({ studio }) => {
    return (
        <div className="h-full min-h-0 animate-fade-in flex flex-col px-4 pb-4 gap-6">
            <div className="flex min-h-[60vh] flex-1 flex-col overflow-hidden rounded-bubble border border-zinc-800/80 bg-zinc-900">
                {studio}
            </div>
            <div className="border-t border-zinc-800/80 pt-4">
                <div className="flex items-center gap-2">
                    <h3 className="text-ui-sm text-zinc-500">Trade plans</h3>
                    {/* The pill names what the list HOLDS (the per-row chips carry
                        each plan's state) — it read "Active only" while drafts and
                        retired plans are listed here too, and only an ACTIVE one
                        reaches the desk. */}
                    <StatusPill tone="neutral">Draft · Active · Retired</StatusPill>
                </div>
                <p className="mt-1 text-ui-dense text-zinc-500">
                    Named strategies the model proposed. Only an ACTIVE plan is shown to the desk —
                    a draft is an unapproved proposal and no seat follows it.
                </p>
                <div className="mt-3">
                    <StrategyPlans />
                </div>
            </div>
            <div className="border-t border-zinc-800/80 pt-4">
                <div className="flex items-center gap-2">
                    <h3 className="text-ui-sm text-zinc-500">Forged tools</h3>
                    <StatusPill tone="neutral">Candidates · Confirmed · Retired</StatusPill>
                </div>
                <p className="mt-1 text-ui-dense text-zinc-500">
                    Desk tools the model wrote. A candidate waits for your decision; a
                    confirmed one stays listed with its usage; a retired one is kept for
                    its history.
                </p>
                <div className="mt-3">
                    <ToolForgeManager />
                </div>
            </div>
        </div>
    );
};

export default SkillsLibrary;
