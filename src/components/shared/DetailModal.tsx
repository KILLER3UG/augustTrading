/**
 * DetailModal — the ONE full-detail reader.
 *
 * It was born as the chain-of-thought reader (components/analysis/
 * ThinkingModal.tsx) and then nothing mounted it: a modal with no importer
 * is a modal nobody has ever opened, which is worse than no modal, because
 * the code reads as if the app had one.
 *
 * So it became what it always was underneath — a shared viewer that shows
 * something IN FULL, read-only — and it lives in shared/ with the agents
 * surface as its second caller. The reader is VIEW-ONLY on purpose: it shows
 * what a thing IS, and editing happens where the editor already is. A reader
 * that also edits is two editors.
 *
 * The trap, the Escape key, the backdrop click and the aria-modal are
 * unchanged: the reader is here to be read, and a keyboard that can leave the
 * dialog mid-read loses the thread (O-66).
 */
import React, { useEffect, useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { BrainIcon, CloseIcon } from './Icons';
import MarkdownContent from './MarkdownContent';

export interface DetailModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    subtitle?: string;
    /** The body, as markdown. Ignored when `children` is given. */
    content?: string;
    /** A custom body — the spec tables, the trace, whatever the thing is. */
    children?: React.ReactNode;
    /** The identity mark in the header. Defaults to the brain, which is right
     *  for a reasoning trace and wrong for an agent — an agent wears its own
     *  face, the same mark its rail row and its bylines wear. */
    icon?: React.ReactNode;
    /** The note along the bottom. Defaults to the reasoning caveat. */
    footer?: React.ReactNode;
    /** What the close button says it closes. */
    closeLabel?: string;
}

const DetailModal: React.FC<DetailModalProps> = ({
    isOpen, onClose, title, subtitle, content, children, icon, footer, closeLabel,
}) => {
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    // The reader is here to follow a chain of thought line by line; a keyboard
    // that can leave the dialog mid-read loses the thread (O-66).
    const dialogRef = useFocusTrap<HTMLDivElement>(isOpen);
    const closeName = closeLabel ?? 'Close detail';

    useEffect(() => {
        if (!isOpen) return undefined;
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        requestAnimationFrame(() => closeButtonRef.current?.focus());
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = previousOverflow;
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-3 sm:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
            <div className=" flex max-h-[min(86vh,760px)] w-full max-w-3xl flex-col overflow-hidden rounded-bubble border border-cyan-400/20 bg-zinc-950 shadow-2xl" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="detail-modal-title">
                <div className="flex shrink-0 items-start justify-between gap-4 border-b border-hairline bg-zinc-900/90 px-4 py-4 sm:px-6">
                    <div className="flex min-w-0 items-start gap-3">
                        {icon ?? (
                            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-control border border-cyan-400/20 bg-cyan-500/10 text-cyan-300"><BrainIcon className="h-4 w-4" aria-hidden="true" /></div>
                        )}
                        <div className="min-w-0">
                            <h2 id="detail-modal-title" className="truncate text-ui-base font-bold text-white sm:text-ui-lg" title={title}>{title}</h2>
                            {subtitle && <p className="mt-0.5 truncate text-ui-xs text-zinc-500" title={subtitle}>{subtitle}</p>}
                        </div>
                    </div>
                    <button ref={closeButtonRef} type="button" onClick={onClose} className="shrink-0 rounded-control p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={closeName} title={closeName}><CloseIcon /></button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 custom-scrollbar sm:px-6">
                    {children ?? (content ? <MarkdownContent content={content} className="text-ui-base leading-7 text-zinc-300" /> : <p className="text-ui-base italic text-zinc-600">This model did not return a separate reasoning trace.</p>)}
                </div>
                <div className="shrink-0 border-t border-hairline px-4 py-3 text-ui-xs text-zinc-600 sm:px-6">
                    {footer ?? 'Model reasoning is provided for review and may be incomplete. Press Escape to close.'}
                </div>
            </div>
        </div>
    );
};

export default DetailModal;
