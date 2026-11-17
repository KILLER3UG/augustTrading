/**
 * workspaceLayout — the [Desk | Chat] layout mode of the ONE workspace
 * (owner ruling 2026-11-17: a layout toggle, never a second surface).
 *
 * - `desk`: the chart canvas + the AI Dock side by side (the shipped default).
 * - `chat`: the chart pane hides and the conversation stream becomes a
 *   centered reading column (~760px).
 *
 * Both modes render the same `TradeView` over the same `chatStore` — switching
 * mid-stream or with a pending decision card is instant and zero-loss, because
 * nothing unmounts but the chart pane's visibility.
 *
 * Persisted per browser (`workspace_layout_v1`) — it is a viewing preference,
 * not profile data.
 */

export type WorkspaceLayout = 'desk' | 'chat';

const KEY = 'workspace_layout_v1';

let cache: WorkspaceLayout | null = null;
const listeners = new Set<(m: WorkspaceLayout) => void>();

const read = (): WorkspaceLayout => {
    try {
        return localStorage.getItem(KEY) === 'chat' ? 'chat' : 'desk';
    } catch {
        return 'desk';
    }
};

export const getWorkspaceLayout = (): WorkspaceLayout => {
    if (cache === null) cache = read();
    return cache;
};

export const setWorkspaceLayout = (mode: WorkspaceLayout): void => {
    if (mode === getWorkspaceLayout()) return;
    cache = mode;
    try {
        localStorage.setItem(KEY, mode);
    } catch { /* private mode: the mode still applies for the session */ }
    listeners.forEach(fn => { try { fn(mode); } catch { /* a listener must not break the switch */ } });
};

export const toggleWorkspaceLayout = (): WorkspaceLayout =>
    (getWorkspaceLayout() === 'desk' ? 'chat' : 'desk') as WorkspaceLayout;

export const subscribeWorkspaceLayout = (fn: (m: WorkspaceLayout) => void): (() => void) => {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
};

/** Flip the mode and persist — used by the pill and the Alt+D chord. */
export const toggleWorkspaceLayoutPersisted = (): WorkspaceLayout => {
    const next = toggleWorkspaceLayout();
    setWorkspaceLayout(next);
    return next;
};
