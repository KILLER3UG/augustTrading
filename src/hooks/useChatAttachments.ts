/**
 * useChatAttachments — the image/file picker both chat surfaces use.
 *
 * Extracted from TradeChatPanel (WS-6 asked the Agents surface to REUSE the
 * dock's image pipeline rather than fork a second one). The dock reads images
 * into data URLs and hands `{ name, dataURL }[]` to the analysis pipeline; that
 * shape is the contract, so it lives here with the reading, not in a panel.
 *
 * The caller owns rendering: `attachFiles` takes a FileList, `remove` drops one
 * chip, and `openPicker` fires the hidden input the caller renders.
 */

import { useCallback, useRef, useState } from 'react';

export interface Attachment {
    id: string;
    kind: 'image' | 'file';
    name: string;
    /** data URL for images, text for everything else — same as the dock.
     *  Empty while `loading` (the read has not landed yet). */
    payload: string;
    /** The file is still being read. The chip mounts IMMEDIATELY with this
     *  set — a picker click that shows nothing until the decode finishes
     *  reads as a dead control — and clears when the payload lands or the
     *  chip is removed on failure. A loading chip never rides a send. */
    loading?: boolean;
}

/** What the analysis pipeline takes for a vision run. */
export interface PipelineImage {
    name: string;
    dataURL: string;
}

/** Four is the dock's ceiling; two surfaces, one limit. */
export const MAX_ATTACHMENTS = 4;

const newId = (prefix: string): string =>
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const useChatAttachments = (): {
    attachments: Attachment[];
    fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
    attachFiles: (files: FileList | null) => void;
    add: (entry: { kind: 'image' | 'file'; name: string; payload: string }) => void;
    remove: (id: string) => void;
    clear: () => void;
    openPicker: () => void;
    images: () => PipelineImage[];
} => {
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const attachFiles = useCallback((files: FileList | null): void => {
        if (!files) return;
        Array.from(files).slice(0, MAX_ATTACHMENTS - attachments.length).forEach(file => {
            const kind: Attachment['kind'] = file.type.startsWith('image/') ? 'image' : 'file';
            const id = newId('at');
            // The chip mounts NOW, in its loading state; the payload fills in
            // when the read lands. A click that shows nothing until the decode
            // finishes is a dead affordance, and a dead one is a lie.
            setAttachments(prev => (prev.length >= MAX_ATTACHMENTS
                ? prev
                : [...prev, { id, kind, name: file.name, payload: '', loading: true }]));
            const reader = new FileReader();
            reader.onload = () => {
                const payload = String(reader.result ?? '');
                if (!payload) {
                    setAttachments(prev => prev.filter(a => a.id !== id));
                    return;
                }
                setAttachments(prev => prev.map(a => (a.id === id
                    ? { ...a, payload, loading: false }
                    : a)));
            };
            reader.onerror = () => {
                // A failed read removes its chip — a stuck spinner on a file
                // that will never arrive is worse than no chip at all.
                setAttachments(prev => prev.filter(a => a.id !== id));
            };
            if (file.type.startsWith('image/')) reader.readAsDataURL(file);
            else reader.readAsText(file);
        });
    }, [attachments.length]);

    /** A file read elsewhere — the chart-snapshot button hands in a PNG the
     *  picker never saw. */
    const add = useCallback((entry: { kind: 'image' | 'file'; name: string; payload: string }): void => {
        if (!entry.payload) return;
        setAttachments(prev => (prev.length >= MAX_ATTACHMENTS
            ? prev
            : [...prev, { id: newId(entry.kind === 'image' ? 'shot' : 'at'), ...entry }]));
    }, []);

    const remove = useCallback((id: string): void => {
        setAttachments(prev => prev.filter(a => a.id !== id));
    }, []);

    /** Empty the tray. A send reads `attachments` first and carries it with
     *  the message, so nothing needs to come back out of here. */
    const clear = useCallback((): void => {
        setAttachments([]);
    }, []);

    const openPicker = useCallback((): void => {
        fileInputRef.current?.click();
    }, []);

    const images = useCallback((): PipelineImage[] => attachments
        .filter(a => a.kind === 'image' && !a.loading && a.payload)
        .map(a => ({ name: a.name, dataURL: a.payload })), [attachments]);

    return { attachments, fileInputRef, attachFiles, add, remove, clear, openPicker, images };
};
