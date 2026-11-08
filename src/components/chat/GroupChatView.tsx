/**
 * GroupChatView — the group-chat screen: header with
 * stacked member faces + the member-name title + "N bots", a
 * collapsible Activity feed ("You sent a message / X is working… /
 * ✓ X replied / ○ X passed" with relative stamps), prompt threads
 * ("You: analyze btc" + each member's reply with its face, name and
 * time), "X is thinking…" lines while a member runs, and the bottom
 * composer "New thread in A, B, C… (@name to direct, @everyone for
 * all)" with a New Thread button.
 */

import React from 'react';
import { Settings, Trash2, Square, Copy, Check, Activity as ActivityIcon, ChevronDown, Loader2, MessageSquare, Minus } from '../shared/Icons';
import { BotAvatar } from './BotAvatar';
import type { AgentBot, AgentGroup } from '../../services/agents/agentRoster';
import { findBotById, groupDisplayName } from '../../services/agents/agentRoster';
import type { GroupActivityEntry } from '../../hooks/useAgentGroups';
import { GroupThread, splitGroupThreads, threadForGroup } from '../../utils/agentThreads';
import { MessageRole } from '../../types/enums';
import { Message } from '../../types/message';
import MarkdownContent from '../shared/MarkdownContent';
import { formatModelDisplayName } from '../../utils/providerUtils';
import { faceForName, type BotFaceSpec } from './BotFace';

/** The card tint IS the bot's identity: face-kind bots wear their own
 *  avatar hue; auto/pixel/upload avatars derive one from the name (the
 *  same hash that draws the auto face), so the gradient never changes
 *  between renders. */
const tintForBot = (bot: { name: string; avatar: AgentBot['avatar'] }): string => {
    const spec: BotFaceSpec = bot.avatar.kind === 'face' ? bot.avatar.spec : faceForName(bot.name);
    return spec.hue;
};

export interface GroupChatViewProps {
    group: AgentGroup;
    bots: AgentBot[];
    messages: Message[];
    activity: GroupActivityEntry[];
    workingBotId: string | null;
    isRunning: boolean;
    onSendThread: (prompt: string) => void;
    /** The debate harness is itself a room: the title links to the Team
     *  transcript. Omit when this group has no Team backing. */
    onOpenTeam?: () => void;
    /** Open the group editor (roster membership). */
    onEditGroup?: () => void;
    /** Delete the room (App confirms). */
    onDeleteGroup?: () => void;
    /** Reply into an existing prompt thread — a direct @everyone round.
     *  Members' incremental context carries the prior thread, so
     *  the round continues it in place. Omit to hide reply affordances. */
    onReplyInThread?: (prompt: string) => void;
    /** Abort the in-flight room round (cancel the request). When
     *  provided, a Stop button replaces New Thread while a round runs. */
    onCancelRun?: () => void;
    /** Hybrid Intelligence toggle: when ON, live market data is
     *  fetched once per send and injected into EVERY member's prompt. */
    hybridEnabled?: boolean;
    onToggleHybrid?: () => void;
}

const relTime = (iso: string | number): string => {
    const ms = Date.now() - (typeof iso === 'number' ? iso : Date.parse(iso));
    if (ms < 60_000) return 'now';
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const ACTIVITY_ICON: Record<GroupActivityEntry['kind'], React.ReactNode> = {
    sent: <MessageSquare className="h-3 w-3" aria-hidden="true" />,
    working: <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />,
    replied: <Check className="h-3 w-3 text-emerald-400" aria-hidden="true" />,
    passed: <Minus className="h-3 w-3 text-zinc-500" aria-hidden="true" />,
};

const GroupChatViewImpl: React.FC<GroupChatViewProps> = ({
    group,
    bots,
    messages,
    activity,
    workingBotId,
    isRunning,
    onSendThread,
    onOpenTeam,
    onEditGroup,
    onDeleteGroup,
    onReplyInThread,
    onCancelRun,
    hybridEnabled = false,
    onToggleHybrid,
}) => {
    const [input, setInput] = React.useState('');
    const [replyDrafts, setReplyDrafts] = React.useState<Record<string, string>>({});
    const [openReplyId, setOpenReplyId] = React.useState<string | null>(null);
    const [activityOpen, setActivityOpen] = React.useState(true);
    const [copiedId, setCopiedId] = React.useState<string | null>(null);
    const members = React.useMemo(
        () => group.memberIds
            .map(id => findBotById(bots, id))
            .filter((b): b is AgentBot => Boolean(b)),
        [group.memberIds, bots],
    );
    const slice = React.useMemo(
        () => threadForGroup(messages, members.map(m => ({ providerId: m.providerId, modelId: m.modelId })), group.id)
            .filter(m => !m.hidden),
        [messages, members, group.id],
    );
    const threads = React.useMemo(() => splitGroupThreads(slice), [slice]);
    const scrollRef = React.useRef<HTMLDivElement | null>(null);

    // Follow the newest thread while a run streams in.
    React.useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [threads.length, workingBotId, slice.length]);

    const send = (): void => {
        const text = input.trim();
        if (!text || isRunning) return;
        setInput('');
        onSendThread(text);
    };

    // Per-thread reply: clears the draft, closes the composer, runs a
    // direct @everyone round (onReplyInThread). Guarded against double-fire.
    const sendReply = (promptId: string): void => {
        const text = (replyDrafts[promptId] ?? '').trim();
        if (!text || isRunning || !onReplyInThread) return;
        onReplyInThread(text);
        setReplyDrafts(d => ({ ...d, [promptId]: '' }));
        setOpenReplyId(null);
    };

    const memberByName = (name: string | undefined): AgentBot | undefined =>
        name ? members.find(m => m.name.toLowerCase() === name.toLowerCase()) : undefined;

    const copyReply = async (reply: Message): Promise<void> => {
        try {
            await navigator.clipboard.writeText(reply.text);
            setCopiedId(reply.id);
            window.setTimeout(() => setCopiedId(cur => (cur === reply.id ? null : cur)), 1600);
        } catch { /* clipboard unavailable — silently ignore */ }
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col bg-zinc-950" data-testid="group-chat-view">
            {/* Header — Back, stacked faces, title, hybrid toggle, actions */}
            <div className="flex items-center gap-3 border-b border-hairline bg-zinc-950/80 px-4 py-2.5 backdrop-blur">
                <span className="relative flex shrink-0">
                    {members.slice(0, 2).map((m, i) => (
                        <span key={m.id} className={i === 0 ? 'z-10' : '-ml-2.5'}>
                            <BotAvatar bot={m} size={32} />
                        </span>
                    ))}
                </span>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-ui-lede font-semibold text-zinc-100" title={groupDisplayName(group, bots)}>
                        {groupDisplayName(group, bots)}
                    </p>
                </div>
                {onToggleHybrid && (
                    <button
                        type="button"
                        role="switch"
                        aria-checked={hybridEnabled}
                        onClick={onToggleHybrid}
                        data-testid="group-hybrid-toggle"
                        title={hybridEnabled
                            ? 'Hybrid Intelligence is ON — live market data is injected into every member'
                            : 'Hybrid Intelligence is OFF — members answer from their own knowledge'}
                        className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-ui-xs font-bold uppercase tracking-wider transition-colors ${
                            hybridEnabled
                                ? 'border-zinc-400/60 bg-zinc-800 text-zinc-100'
                                : 'border-hairline text-zinc-500 hover:text-zinc-300'
                        }`}
                    >
                        <ActivityIcon className="h-3 w-3" aria-hidden="true" />
                        Hybrid
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${hybridEnabled ? 'bg-zinc-200' : 'bg-zinc-600'}`} />
                    </button>
                )}
                <span className="shrink-0 text-ui-dense text-zinc-500">{members.length} bots</span>
                {onEditGroup && (
                    <button
                        type="button"
                        onClick={onEditGroup}
                        aria-label="Group settings"
                        data-testid="group-edit"
                        className="shrink-0 rounded-control p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                    >
                        <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                )}
                {onDeleteGroup && (
                    <button
                        type="button"
                        onClick={onDeleteGroup}
                        aria-label="Delete group"
                        data-testid="group-delete"
                        className="shrink-0 rounded-control p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-rose-300"
                    >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                )}
            </div>

            {/* Activity feed — hidden while the room is virgin: an empty
                feed's only content was a hint duplicating the hero below,
                and a collapsed disclosure bar reads as noise, not invite. */}
            {(activity.length > 0 || isRunning) && (
            <div className="border-b border-hairline px-4 py-1.5" data-testid="group-activity">
                <button
                    type="button"
                    onClick={() => setActivityOpen(v => !v)}
                    aria-expanded={activityOpen}
                    className="flex w-full items-center gap-2 py-1 text-left"
                >
                    <ChevronDown className={`h-3 w-3 text-zinc-500 transition-transform ${activityOpen ? '' : '-rotate-90'}`} />
                    <span className="text-ui-dense font-semibold text-zinc-400">Activity</span>
                    {isRunning && workingBotId && (
                        <span className="text-ui-dense text-zinc-500">
                            {members.find(m => m.id === workingBotId)?.name} is working…
                        </span>
                    )}
                </button>
                {activityOpen && (
                    <ul className="max-h-32 space-y-0.5 overflow-y-auto pb-1">
                        {activity.length === 0 ? (
                            <li className="py-1 text-ui-dense text-zinc-600">
                                Quiet room — send the first prompt below.
                            </li>
                        ) : (
                            [...activity].reverse().map(entry => {
                                const bot = memberByName(entry.botName);
                                return (
                                    <li key={entry.id} className="flex items-center gap-2 py-0.5 text-ui-dense">
                                        <span
                                            className={`w-3 shrink-0 text-center ${
                                                entry.kind === 'replied' ? 'text-emerald-400' : entry.kind === 'passed' ? 'text-zinc-500' : 'text-zinc-400'
                                            }`}
                                        >
                                            {ACTIVITY_ICON[entry.kind]}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-zinc-400" title={entry.kind === 'sent' ? 'You sent a message' : entry.kind === 'working' ? `${entry.botName} is working…` : entry.kind === 'replied' ? `${entry.botName} replied` : entry.kind === 'passed' ? `${entry.botName} passed${entry.detail ? ` (${entry.detail})` : ''}` : undefined}>
                                            {entry.kind === 'sent' && 'You sent a message'}
                                            {entry.kind === 'working' && `${entry.botName} is working…`}
                                            {entry.kind === 'replied' && `${entry.botName} replied`}
                                            {entry.kind === 'passed' && `${entry.botName} passed${entry.detail ? ` (${entry.detail})` : ''}`}
                                            {bot && (
                                                <span className="ml-1.5 inline-block align-middle">
                                                    <BotAvatar bot={bot} size={14} />
                                                </span>
                                            )}
                                        </span>
                                        <span className="shrink-0 text-zinc-600">{relTime(entry.at)}</span>
                                    </li>
                                );
                            })
                        )}
                    </ul>
                )}
            </div>
            )}

            {/* Threads */}
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                {threads.length === 0 ? (
                    /* Empty room — OpenBot's onboarding shape, grounded in the
                        real members: a headline, who is on this floor (cards,
                        not a sentence), and starter prompts that prefill the
                        composer. Never auto-send; prefill is a hand on the
                        wheel, not a turn taken. */
                    <div className="flex h-full flex-col items-center justify-center px-6 py-10">
                        <p className="mb-3 text-ui-xs font-bold uppercase tracking-[0.2em] text-zinc-600">
                            {members.length} bots · every member answers in turn
                        </p>
                        <h1 className="mb-2 text-center font-serif text-ui-display tracking-tight text-zinc-100 sm:text-ui-hero">
                            Start a new thread
                        </h1>
                        <p className="mb-8 max-w-md text-center text-ui-sm leading-relaxed text-zinc-500">
                            One prompt opens the floor. @name to direct one member, @everyone for all.
                        </p>
                        <div className="mb-8 flex max-w-xl flex-wrap justify-center gap-2" data-testid="group-members-strip">
                            {members.map(m => (
                                <div
                                    key={m.id}
                                    className="member-tint flex min-w-0 items-center gap-2.5 rounded-control border border-hairline py-2 pl-2 pr-3"
                                    style={{ '--member-tint': tintForBot(m) } as React.CSSProperties}
                                >
                                    <BotAvatar bot={m} size={28} />
                                    <span className="min-w-0">
                                        <span className="block truncate text-ui-sm font-semibold text-zinc-200" title={m.name}>{m.name}</span>
                                        <span className="block truncate text-ui-xs text-zinc-500" title={m.title || formatModelDisplayName(m.modelId)}>
                                            {m.title || formatModelDisplayName(m.modelId)}
                                        </span>
                                    </span>
                                </div>
                            ))}
                        </div>
                        <div className="flex flex-wrap justify-center gap-2">
                            {['Introduce yourselves', 'Check the current BTC setup', 'What is the biggest risk right now?'].map(starter => (
                                <button
                                    key={starter}
                                    type="button"
                                    data-testid={`group-starter-${starter.slice(0, 8)}`}
                                    onClick={() => {
                                        setInput(starter);
                                        document.getElementById('group-room-composer')?.focus();
                                    }}
                                    className="rounded-full border border-hairline bg-zinc-900 px-3 py-1.5 text-ui-dense text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-100"
                                >
                                    {starter}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="space-y-8">
                        {threads.map((thread: GroupThread, ti) => {
                            const isLast = ti === threads.length - 1;
                            return (
                                <div key={thread.prompt.id} className="space-y-3">
                                    {/* You — reference pattern: full-width card
                                        with a "You · time" header, left-aligned. */}
                                    <div className="relative rounded-bubble border border-hairline bg-zinc-900/60 px-4 py-3">
                                        <p className="mb-1 text-ui-sm">
                                            <span className="font-bold text-zinc-100">You</span>
                                            <span className="ml-2 text-zinc-500">{relTime(thread.prompt.createdAt)}</span>
                                        </p>
                                        <div className="text-ui-caption text-zinc-100 whitespace-pre-wrap break-words">{thread.prompt.text}</div>
                                        {onReplyInThread && (
                                            <button
                                                type="button"
                                                onClick={() => setOpenReplyId(id => (id === thread.prompt.id ? null : thread.prompt.id))}
                                                data-testid={`reply-link-${thread.prompt.id}`}
                                                className="mt-1.5 block text-ui-dense text-zinc-500 transition-colors hover:text-zinc-200"
                                            >
                                                Reply in thread
                                            </button>
                                        )}
                                    </div>
                                    {/* Member replies — reference: flat markdown on
                                        the canvas, copy icon at the row's right. */}
                                    {thread.replies.map(reply => {
                                        const bot = members.find(m =>
                                            Object.keys(reply.modelsUsed ?? {}).some(pid =>
                                                pid === m.providerId && reply.modelsUsed?.[pid] === m.modelId,
                                            ),
                                        );
                                        if (!bot) return null;
                                        return (
                                            <div key={reply.id} className="group relative flex items-start gap-2.5">
                                                <BotAvatar bot={bot} size={28} working={reply.isStreaming} />
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-ui-sm font-semibold text-zinc-300">
                                                        {bot.name}
                                                        <span className="ml-2 font-normal text-zinc-600">{relTime(reply.createdAt)}</span>
                                                    </p>
                                                    <MarkdownContent
                                                        content={reply.text}
                                                        className="text-ui-caption leading-relaxed text-zinc-200 [&_strong]:text-zinc-50"
                                                    />
                                                    {reply.isStreaming && <span className="ml-1 animate-pulse text-zinc-500">▍</span>}
                                                </div>
                                                {!reply.isStreaming && reply.text && (
                                                    <button
                                                        type="button"
                                                        onClick={() => void copyReply(reply)}
                                                        aria-label={`Copy ${bot.name}'s reply`}
                                                        data-testid={`group-copy-${reply.id}`}
                                                        className="absolute right-0 top-0 rounded-control p-1 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-800 hover:text-zinc-300 focus:opacity-100 group-hover:opacity-100"
                                                    >
                                                        {copiedId === reply.id ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                                                    </button>
                                                )}
                                            </div>
                                        );
                                    })}
                                    {/* Working line on the open thread + cancel */}
                                    {isLast && isRunning && (
                                        <div className="flex items-center gap-3">
                                            {workingBotId && (
                                                <p className="pl-1 text-ui-sm italic text-zinc-500" data-testid="group-thinking" role="status">
                                                    {members.find(m => m.id === workingBotId)?.name} is thinking…
                                                </p>
                                            )}
                                            {onCancelRun && (
                                                <button
                                                    type="button"
                                                    onClick={onCancelRun}
                                                    data-testid="group-cancel"
                                                    className="flex items-center gap-1.5 rounded-control border border-hairline px-2.5 py-1 text-ui-dense font-semibold text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-100"
                                                >
                                                    <Square className="h-3 w-3" aria-hidden="true" />
                                                    Stop
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    {/* Inline reply composer (reference: Reply in thread) */}
                                    {onReplyInThread && openReplyId === thread.prompt.id && (
                                        <div className="flex items-center gap-2 rounded-bubble border border-hairline bg-zinc-900 px-3 py-2" data-testid={`reply-composer-${thread.prompt.id}`}>
                                            <input
                                                type="text"
                                                value={replyDrafts[thread.prompt.id] ?? ''}
                                                onChange={e => setReplyDrafts(d => ({ ...d, [thread.prompt.id]: e.target.value }))}
                                                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(thread.prompt.id); } }}
                                                placeholder={`Reply in thread… (@name to direct)`}
                                                aria-label="Reply in thread"
                                                className="min-w-0 flex-1 bg-transparent text-ui-caption text-zinc-100 placeholder-zinc-600 outline-none"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => sendReply(thread.prompt.id)}
                                                disabled={!(replyDrafts[thread.prompt.id] ?? '').trim() || isRunning}
                                                data-testid={`reply-send-${thread.prompt.id}`}
                                                className="shrink-0 rounded-control bg-zinc-200 px-3 py-1.5 text-ui-sm font-bold text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                                            >
                                                Reply
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Composer — New thread in … (@name to direct, @everyone for all);
                becomes a Stop control while the room is running. Centered on
                the column like the main composer, with a focus ring so the
                room's one interactive surface reads as one. */}
            <div className="border-t border-hairline px-4 py-3">
                <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-bubble border border-hairline bg-zinc-900 px-4 py-3 transition-colors focus-within:border-zinc-500">
                    <input
                        type="text"
                        id="group-room-composer"
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                        placeholder={`New thread in ${groupDisplayName(group, bots)}… (@name to direct, @everyone for all)`}
                        data-testid="group-composer"
                        aria-label="New group thread"
                        className="min-w-0 flex-1 bg-transparent text-ui-base text-zinc-100 placeholder-zinc-600"
                    />
                    {isRunning && onCancelRun ? (
                        <button
                            type="button"
                            onClick={onCancelRun}
                            data-testid="composer-cancel"
                            className="shrink-0 rounded-control border border-line px-3 py-1.5 text-ui-sm font-bold text-zinc-200 hover:border-zinc-400 hover:bg-zinc-800"
                        >
                            Stop
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={send}
                            disabled={!input.trim()}
                            data-testid="new-thread-button"
                            className="shrink-0 rounded-control bg-zinc-200 px-3 py-1.5 text-ui-sm font-bold text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            New Thread
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

// Memoized: the room re-renders on every price tick and activity change,
// but the transcript only needs to repaint when its own props move.
export const GroupChatView = React.memo(GroupChatViewImpl);

export default GroupChatView;
