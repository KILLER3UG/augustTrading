
import React from 'react';
import { Message, TradeOutcome } from '../../types';

import { useEscapeClose } from '../../hooks/useEscapeClose';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface EntryNotHitCaptureModalProps {
    message: Message;
    correctedEntry?: string;
    onClose: () => void;
    onAutoCapture: () => void;
    onSkip: () => void;
    isCapturing?: boolean;
}

export const EntryNotHitCaptureModal: React.FC<EntryNotHitCaptureModalProps> = ({
    message,
    correctedEntry,
    onClose,
    onAutoCapture,
    onSkip,
    isCapturing = false
}) => {
    useEscapeClose(true, onClose);
    const dialogRef = useFocusTrap<HTMLDivElement>(true);

    const coinName = message.analysis?.coinName || 'this trade';

    return (
        <div ref={dialogRef} className="fixed inset-0 bg-black/70 z-modal flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Entry not hit capture">
            <div className="bg-zinc-900 rounded-bubble shadow-elevated w-full max-w-lg border border-cyan-500/30 animate-fade-in max-h-[90vh] overflow-y-auto">
                {/* Header */}
                <div className="p-5 border-b border-hairline bg-cyan-950/30">
                    <div className="flex items-center gap-3">
                        <div>
                            <h3 className="text-lg font-bold text-cyan-400">
                                Entry Not Hit - Capture Data
                            </h3>
                            <p className="text-ui-base text-zinc-400 mt-0.5">
                                <span className="text-white font-semibold">{coinName}</span>
                                {correctedEntry && (
                                    <span className="text-zinc-500 ml-2">
                                        (Corrected entry: {correctedEntry})
                                    </span>
                                )}
                            </p>
                        </div>
                    </div>
                </div>

                {/* Info Section */}
                <div className="p-5 border-b border-hairline bg-zinc-800">
                    <div className="flex items-start gap-3 p-3 rounded-control bg-cyan-500/5 border border-cyan-500/10">
                        <div>
                            <p className="text-ui-base text-zinc-300">
                                Trade recorded as <span className="text-cyan-400 font-semibold">Entry Not Hit</span>
                            </p>
                            <p className="text-ui-sm text-zinc-500 mt-1">
                                The AI will analyze why the entry was missed and learn from this setup.
                            </p>
                        </div>
                    </div>
                </div>

                {/* Data Capture Options */}
                <div className="p-5 space-y-3">
                    <p className="text-ui-sm text-zinc-500 uppercase tracking-widest font-bold mb-3">
                        Choose how to capture current market data
                    </p>

                    {/* Auto-Capture Option */}
                    <button
                        onClick={onAutoCapture}
                        disabled={isCapturing}
                        className="w-full p-4 rounded-bubble border border-cyan-500/20 bg-cyan-950/30 hover:bg-cyan-950/50 hover:border-cyan-500/40 transition-colors duration-[150ms] ease-[var(--ease-snappy)] text-left group disabled:opacity-50 disabled:cursor-not-allowed relative overflow-hidden"
                    >
                        {isCapturing && (
                            <div className="absolute inset-0 bg-cyan-500/10 animate-pulse" />
                        )}
                        <div className="flex items-start gap-4 relative z-10">
                            <div className="text-3xl">{isCapturing ? '⏳' : ''}</div>
                            <div className="flex-1">
                                <div className="font-bold text-cyan-300 group-hover:text-cyan-200 transition-colors flex items-center gap-2">
                                    {isCapturing ? 'Capturing...' : 'Auto-Capture'}
                                    {!isCapturing && (
                                        <span className="text-ui-2xs bg-cyan-500/20 text-cyan-400 px-1.5 py-0.5 rounded-control uppercase tracking-wider font-bold">
                                            Recommended
                                        </span>
                                    )}
                                </div>
                                <div className="text-ui-sm text-zinc-400 mt-1 leading-relaxed">
                                    {isCapturing
                                        ? 'Fetching market data from Binance...'
                                        : 'Instantly fetch current market data to analyze why entry was missed.'
                                    }
                                </div>
                            </div>
                        </div>
                    </button>

                    {/* Skip Option */}
                    <button
                        onClick={onSkip}
                        disabled={isCapturing}
                        className="w-full p-3 rounded-control border border-hairline bg-zinc-800 hover:bg-zinc-800 hover:border-line transition-colors duration-[150ms] ease-[var(--ease-snappy)] text-center disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <span className="text-ui-base text-zinc-500 hover:text-zinc-400 transition-colors">
                            Skip data capture →
                        </span>
                    </button>
                </div>

                {/* Footer */}
                <div className="px-5 py-4 border-t border-hairline bg-zinc-950">
                    <div className="flex items-center justify-between">
                        <p className="text-ui-xs text-zinc-600 max-w-[200px]">
                            AI will analyze why the setup didn't trigger
                        </p>
                        <button
                            onClick={onClose}
                            disabled={isCapturing}
                            className="py-2 px-4 rounded-control text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors text-ui-base disabled:opacity-50"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default EntryNotHitCaptureModal;
