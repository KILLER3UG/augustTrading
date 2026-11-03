/**
 * ChatAttachmentStrip — the composer's pending-attachment chip row.
 *
 * Extracted from TradeChatPanel unchanged. The parent keeps OWNING the
 * attachment list (`send()` and the full-analysis launch both read it), so
 * this row is render-only: it draws one chip per queued attachment — an image
 * thumbnail or a file glyph — and reports removals upward. A still-reading
 * attachment mounts in its loading state: the image chip is the app's standard
 * pulsing placeholder, the file glyph pulses — the chip EXISTS from the click,
 * it is just not filled yet.
 */

import React from 'react';
import { FileText, X } from '../../shared/Icons';
import type { Attachment } from '../../../hooks/useChatAttachments';

export interface ChatAttachmentStripProps {
    attachments: Attachment[];
    onRemove: (id: string) => void;
}

const ChatAttachmentStrip: React.FC<ChatAttachmentStripProps> = ({ attachments, onRemove }) => (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
        {attachments.map(a => (
            <span
                key={a.id}
                data-testid="chat-attachment"
                data-attachment-loading={a.loading ? 'true' : 'false'}
                className="flex items-center gap-1 rounded-control border border-white/10 bg-zinc-800 py-1 pl-1 pr-1.5 text-ui-xs text-zinc-300"
            >
                {a.kind === 'image'
                    ? (a.loading || !a.payload
                        // The standard loading treatment, thumbnail-sized: the
                        // same animate-pulse the app's skeletons use.
                        ? <span aria-hidden="true" className="h-8 w-12 animate-pulse rounded-control bg-zinc-700/70" />
                        : <img src={a.payload} alt={a.name} className="h-8 w-12 rounded-control object-cover" />)
                    : <FileText className={`h-3 w-3 text-zinc-500 ${a.loading ? 'animate-pulse' : ''}`} aria-hidden="true" />}
                <span className="max-w-[120px] truncate" title={a.name}>{a.name}</span>
                <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.id)}
                    className="text-zinc-500 hover:text-rose-400"><X className="h-3 w-3" aria-hidden="true" /></button>
            </span>
        ))}
    </div>
);

export default ChatAttachmentStrip;
