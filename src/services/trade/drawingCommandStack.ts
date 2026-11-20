/**
 * drawingCommandStack — pure, immutable undo/redo history for chart drawings
 * (both user-origin and agent-origin layers).
 *
 * Every mutating commit bumps `version` on changed shapes so Phase 1's
 * `computeChartRevision` and Tier 0 manifest stay automatically synchronized
 * across creates, handle drags, body drags, inspector edits, deletes, and
 * one-click Clear AI Drawings.
 */

import type { ChartDrawing } from './chartDrawings';

export interface DrawingLayerSnapshot {
    userDrawings: ChartDrawing[];
    modelDrawings: ChartDrawing[];
}

export interface DrawingCommandHistory {
    past: DrawingLayerSnapshot[];
    present: DrawingLayerSnapshot;
    future: DrawingLayerSnapshot[];
}

export const MAX_DRAWING_HISTORY = 50;

const cloneDrawing = (d: ChartDrawing): ChartDrawing => ({
    ...d,
    points: d.points.map(p => ({ t: p.t, p: p.p })),
    ...(d.visibleOnTfs ? { visibleOnTfs: [...d.visibleOnTfs] } : {}),
});

const cloneSnapshot = (snap: DrawingLayerSnapshot): DrawingLayerSnapshot => ({
    userDrawings: snap.userDrawings.map(cloneDrawing),
    modelDrawings: snap.modelDrawings.map(cloneDrawing),
});

/** Increment a drawing's monotonic edit version so chartRevision invalidates. */
export const bumpDrawingVersion = (d: ChartDrawing): ChartDrawing => ({
    ...d,
    version: (typeof d.version === 'number' && Number.isInteger(d.version) && d.version > 0 ? d.version : 1) + 1,
});

/** Create a fresh command history seeded with the current layers. */
export const createDrawingHistory = (
    initial: DrawingLayerSnapshot = { userDrawings: [], modelDrawings: [] },
): DrawingCommandHistory => ({
    past: [],
    present: cloneSnapshot(initial),
    future: [],
});

/** Sync external loads/updates (e.g. AI tool adding a drawing or coin switch)
 *  into `present` without blowing away or fabricating an undo entry when
 *  `preserveHistory` is true, or resetting stacks on coin/session switch. */
export const syncDrawingHistoryPresent = (
    history: DrawingCommandHistory,
    next: DrawingLayerSnapshot,
    reset = false,
): DrawingCommandHistory => {
    if (reset) return createDrawingHistory(next);
    return {
        ...history,
        present: cloneSnapshot(next),
    };
};

/** Commit a new immutable drawing snapshot onto the undo stack and clear redo. */
export const pushDrawingSnapshot = (
    history: DrawingCommandHistory,
    next: DrawingLayerSnapshot,
    maxDepth = MAX_DRAWING_HISTORY,
): DrawingCommandHistory => {
    const cap = Math.max(1, maxDepth);
    const past = [...history.past, cloneSnapshot(history.present)].slice(-cap);
    return {
        past,
        present: cloneSnapshot(next),
        future: [],
    };
};

export const canUndoDrawing = (history: DrawingCommandHistory): boolean => history.past.length > 0;
export const canRedoDrawing = (history: DrawingCommandHistory): boolean => history.future.length > 0;

/** Step one snapshot backward (Ctrl+Z). Returns unchanged history when empty. */
export const undoDrawingState = (history: DrawingCommandHistory): DrawingCommandHistory => {
    if (history.past.length === 0) return history;
    const previous = history.past[history.past.length - 1];
    return {
        past: history.past.slice(0, -1),
        present: cloneSnapshot(previous),
        future: [cloneSnapshot(history.present), ...history.future].slice(0, MAX_DRAWING_HISTORY),
    };
};

/** Step one snapshot forward (Ctrl+Y / Ctrl+Shift+Z). */
export const redoDrawingState = (history: DrawingCommandHistory): DrawingCommandHistory => {
    if (history.future.length === 0) return history;
    const [next, ...rest] = history.future;
    return {
        past: [...history.past, cloneSnapshot(history.present)].slice(-MAX_DRAWING_HISTORY),
        present: cloneSnapshot(next),
        future: rest,
    };
};

/** Count drawings carrying `origin === 'agent'` across both layers. */
export const countAgentDrawings = (snap: DrawingLayerSnapshot): number => {
    const userAgentCount = snap.userDrawings.filter(d => d.origin === 'agent').length;
    const modelAgentCount = snap.modelDrawings.filter(d => d.origin !== 'user').length;
    return userAgentCount + modelAgentCount;
};

/**
 * One-click Clear AI Drawings: removes ONLY `origin === 'agent'` shapes
 * (all agent-origin model drawings + any agent-origin shapes in userDrawings),
 * never touching user-origin drawings. Pushes an undoable command so `Ctrl+Z`
 * restores the cleared AI shapes cleanly.
 */
export const clearAgentDrawingsFromHistory = (
    history: DrawingCommandHistory,
): { history: DrawingCommandHistory; removedCount: number } => {
    const { userDrawings, modelDrawings } = history.present;
    const nextUser = userDrawings.filter(d => d.origin !== 'agent');
    const nextModel = modelDrawings.filter(d => d.origin === 'user');
    const removedCount = (userDrawings.length - nextUser.length) + (modelDrawings.length - nextModel.length);
    if (removedCount === 0) return { history, removedCount: 0 };
    return {
        history: pushDrawingSnapshot(history, {
            userDrawings: nextUser,
            modelDrawings: nextModel,
        }),
        removedCount,
    };
};
