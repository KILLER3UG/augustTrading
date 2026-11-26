/**
 * ProviderConfigJsonModal — read-only redacted JSON viewer for Settings → Models.
 *
 * Opened from `Open configuration` on the Provider Roster. Always passes configs
 * through `redactProviderConfigsForView` so raw API keys are NEVER displayed,
 * copied, or exported in plaintext.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Check, CloseIcon, Copy, Download } from '../shared/Icons';
import type { ProviderConfig } from '../../types/provider';
import { redactProviderConfigsForView } from '../../services/providers/modelCatalogCore';

export interface ProviderConfigJsonModalProps {
    configs: readonly ProviderConfig[];
    onClose: () => void;
}

export const ProviderConfigJsonModal: React.FC<ProviderConfigJsonModalProps> = ({
    configs,
    onClose,
}) => {
    const [copied, setCopied] = useState(false);

    const redactedJson = useMemo(
        () => JSON.stringify({ providers: redactProviderConfigsForView(configs) }, null, 2),
        [configs],
    );

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [onClose]);

    const handleCopy = async (): Promise<void> => {
        try {
            await navigator.clipboard.writeText(redactedJson);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
        } catch { /* clipboard denied */ }
    };

    const handleDownload = (): void => {
        try {
            const blob = new Blob([redactedJson], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'august-providers-redacted.json';
            a.click();
            URL.revokeObjectURL(url);
        } catch { /* ignore */ }
    };

    return (
        <div
            className="fixed inset-0 z-modal flex items-center justify-center bg-black/75 p-4"
            onClick={onClose}
            role="presentation"
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="provider-config-json-title"
                data-testid="provider-config-json-modal"
                onClick={e => e.stopPropagation()}
                className="flex max-h-[min(80vh,640px)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-hairline bg-zinc-950 shadow-elevated"
            >
                <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-3.5">
                    <div>
                        <h3 id="provider-config-json-title" className="text-ui-base font-semibold text-zinc-100">
                            Provider configuration (read-only · keys redacted)
                        </h3>
                        <p className="text-ui-2xs text-zinc-500">
                            API keys are masked before display, copy, or export.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close configuration viewer"
                        className="flex h-7 w-7 items-center justify-center rounded-control text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                    >
                        <CloseIcon className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>
                <pre
                    data-testid="provider-config-json-body"
                    className="custom-scrollbar min-h-0 flex-1 overflow-auto bg-zinc-950 p-4 font-mono text-ui-2xs leading-relaxed text-zinc-300"
                >
                    {redactedJson}
                </pre>
                <div className="flex items-center justify-end gap-2 border-t border-hairline bg-zinc-900/40 px-5 py-3">
                    <button
                        type="button"
                        onClick={handleCopy}
                        data-testid="provider-config-copy-btn"
                        className="flex h-8 items-center gap-1.5 rounded-control border border-hairline bg-zinc-900 px-3 text-ui-dense font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
                    >
                        {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                        {copied ? 'Copied' : 'Copy JSON'}
                    </button>
                    <button
                        type="button"
                        onClick={handleDownload}
                        className="flex h-8 items-center gap-1.5 rounded-control border border-hairline bg-zinc-900 px-3 text-ui-dense font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
                    >
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        Export JSON
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="h-8 rounded-control bg-zinc-100 px-3.5 text-ui-dense font-semibold text-zinc-950 transition-colors hover:bg-white"
                    >
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ProviderConfigJsonModal;
