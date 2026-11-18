/**
 * askDesk — the ONE door the record surfaces use to reach the dock (Phase 4
 * P-5/P-6): switch the shell to the workspace (the dock only mounts there),
 * then hand the desk the request once the panel is up. The dock's listeners
 * own the wording; this helper owns the DELIVERY.
 */
export const askDesk = (kind: 'stats' | 'correct' | 'settle' | 'strategy' | 'setting', detail?: unknown): void => {
    window.dispatchEvent(new CustomEvent('august:goto-workspace'));
    window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent(`august:desk-${kind}`, { detail }));
    }, 400);
};
