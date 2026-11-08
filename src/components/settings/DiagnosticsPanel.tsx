import React, { useState, useEffect } from 'react';
import { CheckCircle } from '../shared/Icons';
import { clearThinkingLeakBin, loadThinkingLeakBin, ThinkingLeakEntry } from '../../utils/thinkingLeakBin';

interface ErrorLog {
    timestamp: string;
    type: string;
    message: string;
    stack?: string;
    filename?: string;
    lineno?: number;
    colno?: number;
}

/**
 * DiagnosticsPanel — displays recent runtime errors captured by the global
 * error handlers in index.tsx. Useful for debugging production issues.
 */
export const DiagnosticsPanel: React.FC = () => {
    const [promiseError, setPromiseError] = useState<ErrorLog | null>(null);
    const [globalError, setGlobalError] = useState<ErrorLog | null>(null);
    const [showStack, setShowStack] = useState<string | null>(null);
    const [leaks, setLeaks] = useState<ThinkingLeakEntry[]>([]);

    useEffect(() => {
        try {
            const pe = localStorage.getItem('lastPromiseError');
            const ge = localStorage.getItem('lastGlobalError');
            if (pe) setPromiseError(JSON.parse(pe));
            if (ge) setGlobalError(JSON.parse(ge));
        } catch {
            // Ignore parse errors
        }
        setLeaks(loadThinkingLeakBin());
    }, []);

    const clearErrors = (): void => {
        localStorage.removeItem('lastPromiseError');
        localStorage.removeItem('lastGlobalError');
        setPromiseError(null);
        setGlobalError(null);
        setShowStack(null);
    };

    const hasErrors = promiseError || globalError;

    const renderError = (error: ErrorLog, label: string): React.ReactNode => (
        <div className="p-3 rounded-bubble bg-rose-950/30 border border-rose-500/20 space-y-1">
            <div className="flex items-center justify-between">
                <span className="text-ui-sm font-semibold text-rose-400">{label}</span>
                <span className="text-ui-xs text-zinc-500">
                    {new Date(error.timestamp).toLocaleString()}
                </span>
            </div>
            <p className="text-ui-sm text-zinc-300 break-all">{error.message}</p>
            {error.message === 'Cannot redefine property: onmessage' && (
                <p className="text-ui-sm text-zinc-400">
                    The origin of this error is unknown. It may involve instrumentation; the message alone does not establish the cause or impact.
                </p>
            )}
            {error.filename && (
                <p className="text-ui-xs text-zinc-500">
                    {error.filename}:{error.lineno}:{error.colno}
                </p>
            )}
            {error.stack && (
                <>
                    <button
                        onClick={() => setShowStack(showStack === label ? null : label)}
                        className="text-ui-xs text-zinc-400 underline hover:text-zinc-200"
                    >
                        {showStack === label ? 'Hide stack' : 'Show stack'}
                    </button>
                    {showStack === label && (
                        <pre className="text-ui-xs text-zinc-500 overflow-x-auto whitespace-pre-wrap mt-1 max-h-32 overflow-y-auto">
                            {error.stack}
                        </pre>
                    )}
                </>
            )}
        </div>
    );

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <h3 className="text-ui-base font-semibold text-zinc-300">Diagnostics</h3>
                {hasErrors && (
                    <button
                        onClick={clearErrors}
                        className="text-ui-sm text-zinc-400 hover:text-rose-400 transition-colors"
                    >
                        Clear Errors
                    </button>
                )}
            </div>

            {hasErrors ? (
                <div className="space-y-2">
                    {promiseError && renderError(promiseError, 'Unhandled Promise Rejection')}
                    {globalError && renderError(globalError, 'Uncaught Error')}
                </div>
            ) : (
                <p className="text-ui-sm text-zinc-500 flex items-center gap-1.5">
                    <CheckCircle className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                    <span>No runtime errors recorded.</span>
                </p>
            )}

            <div className="flex items-center justify-between pt-2">
                <h4 className="text-ui-sm font-semibold text-zinc-400">Thinking leak bin</h4>
                {leaks.length > 0 && (
                    <button
                        type="button"
                        onClick={() => {
                            clearThinkingLeakBin();
                            setLeaks([]);
                        }}
                        className="text-ui-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                    >
                        Clear leaks
                    </button>
                )}
            </div>
            {leaks.length > 0 ? (
                <ul className="space-y-2">
                    {leaks.map((entry, index) => (
                        <li key={`${entry.at}-${index}`} className="rounded-bubble border border-hairline bg-zinc-950/50 p-3">
                            <p className="text-ui-xs text-zinc-600">
                                {entry.at ? new Date(entry.at).toLocaleString() : 'Unknown time'}
                            </p>
                            <p className="mt-1 text-ui-sm text-zinc-400 break-words">{entry.snippet}</p>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-ui-sm text-zinc-500">No thinking leaks recorded. The splitter logs leftovers here when CoT still appears in Final output.</p>
            )}
        </div>
    );
};
