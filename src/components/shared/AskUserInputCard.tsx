import React, { useEffect, useState } from 'react';
import {
    answerUserInput,
    cancelUserInput,
    listPendingInput,
    subscribeUserInput,
    type AskRequest,
} from '../../services/analysis/askUserInput';

/**
 * The trader's half of `ask_user_input`: the questions a seat parked its turn on.
 *
 * It is deliberately NOT a modal. The trader may need the chart, the journal or
 * the order book to answer ("which of these two setups?"), so the card floats
 * above the composer without a backdrop and without a focus trap. One card at a
 * time — the service supersedes an older question — and it disappears the moment
 * the turn is answered, stopped, or the window closes, because it renders from
 * the service's live state rather than from its own copy.
 */
export const AskUserInputCard: React.FC = () => {
    const [request, setRequest] = useState<AskRequest | null>(null);
    const [draft, setDraft] = useState<Record<string, string>>({});
    const [text, setText] = useState<Record<string, string>>({});

    useEffect(() => {
        const sync = (): void => {
            const next = listPendingInput()[0] ?? null;
            setRequest(prev => (prev?.id === next?.id ? prev : next));
        };
        sync();
        return subscribeUserInput(sync);
    }, []);

    // A NEW question starts from a blank slate; the previous draft must never
    // answer it.
    useEffect(() => { setDraft({}); setText({}); }, [request?.id]);

    if (!request) return null;

    const answered = (qid: string): boolean => Boolean(draft[qid] || text[qid]?.trim());
    const allAnswered = request.questions.every(q => answered(q.id));
    const submit = (): void => {
        const answers: Record<string, string> = {};
        for (const q of request.questions) {
            const typed = text[q.id]?.trim();
            const picked = draft[q.id];
            const label = picked ? (q.options.find(o => o.id === picked)?.label ?? picked) : '';
            answers[q.id] = typed || label || '';
        }
        answerUserInput(request.id, answers);
    };

    return (
        <div
            data-testid="ask-user-input"
            role="group"
            aria-label={`${request.asker} is asking`}
            className="fixed bottom-24 left-1/2 z-drawer w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 rounded-bubble border border-line bg-zinc-900 p-3 shadow-elevated"
        >
            <div className="flex items-baseline justify-between gap-2">
                <p className="text-ui-2xs font-bold uppercase tracking-widest text-zinc-500">
                    The desk needs one thing
                </p>
                <button
                    type="button"
                    onClick={() => cancelUserInput(request.id)}
                    data-testid="ask-user-input-cancel"
                    className="rounded-control px-1.5 py-0.5 text-ui-xs text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                >
                    Cancel
                </button>
            </div>
            <div className="mt-1.5 space-y-2.5">
                {request.questions.map(q => (
                    <div key={q.id}>
                        <p className="text-ui-dense leading-snug text-zinc-200">{q.question}</p>
                        {q.options.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {q.options.map(o => {
                                    const active = draft[q.id] === o.id;
                                    return (
                                        <button
                                            key={o.id}
                                            type="button"
                                            aria-pressed={active}
                                            data-testid={`ask-option-${q.id}-${o.id}`}
                                            onClick={() => setDraft(prev => ({ ...prev, [q.id]: o.id }))}
                                            className={`rounded-control border px-2.5 py-1 text-ui-dense font-semibold transition-colors ${
                                                active
                                                    ? 'border-zinc-100 bg-zinc-100 text-zinc-900'
                                                    : 'border-hairline bg-zinc-950 text-zinc-200 hover:border-line hover:bg-zinc-800'
                                            }`}
                                        >
                                            {o.label}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                        {(q.allowText || q.options.length === 0) && (
                            <input
                                type="text"
                                value={text[q.id] ?? ''}
                                onChange={e => setText(prev => ({ ...prev, [q.id]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter' && allAnswered) submit(); }}
                                placeholder={q.options.length > 0 ? 'Or type your own answer' : 'Your answer'}
                                aria-label={q.question}
                                data-testid={`ask-text-${q.id}`}
                                className="mt-1.5 w-full rounded-control border border-hairline bg-zinc-950 px-2.5 py-1.5 text-ui-dense text-zinc-200 placeholder:text-zinc-600 focus:border-accent/40 focus:outline-none"
                            />
                        )}
                    </div>
                ))}
            </div>
            <div className="mt-2.5 flex items-center justify-between gap-2">
                <p className="text-ui-2xs text-zinc-600">
                    The turn is paused until you answer.
                </p>
                <button
                    type="button"
                    onClick={submit}
                    disabled={!allAnswered}
                    data-testid="ask-user-input-send"
                    className="rounded-control bg-zinc-100 px-3 py-1 text-ui-dense font-bold text-zinc-900 transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                >
                    Answer
                </button>
            </div>
        </div>
    );
};

export default AskUserInputCard;
