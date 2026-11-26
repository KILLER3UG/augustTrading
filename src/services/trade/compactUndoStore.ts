/**
 * compactUndoStore — short-lived in-memory snapshot map for 1-click `/compact` Undo.
 *
 * Pure module state (zero React, zero persistence bloat): stores exact
 * pre-compaction entry/message arrays so clicking Undo on `CompactReceiptCard`
 * restores the exact prior transcript and composer context ring immediately.
 */

export interface CompactUndoRecord {
    kind: 'desk' | 'chat';
    targetId: string;
    entries?: unknown[];
    messages?: unknown[];
}

const MAX_UNDO_RECORDS = 20;
const undoRecords = new Map<string, CompactUndoRecord>();

export const saveCompactUndo = (undoId: string, record: CompactUndoRecord): void => {
    if (!undoId) return;
    if (undoRecords.has(undoId)) undoRecords.delete(undoId);
    undoRecords.set(undoId, record);
    while (undoRecords.size > MAX_UNDO_RECORDS) {
        const oldest = undoRecords.keys().next().value;
        if (oldest === undefined) break;
        undoRecords.delete(oldest);
    }
};

export const hasCompactUndo = (undoId: string | undefined): boolean =>
    typeof undoId === 'string' && undoId.length > 0 && undoRecords.has(undoId);

export const peekCompactUndo = (undoId: string | undefined): CompactUndoRecord | null =>
    typeof undoId === 'string' ? (undoRecords.get(undoId) ?? null) : null;

export const takeCompactUndo = (undoId: string): CompactUndoRecord | null => {
    const hit = undoRecords.get(undoId) ?? null;
    if (hit) undoRecords.delete(undoId);
    return hit;
};

export const __clearCompactUndoForTests = (): void => {
    undoRecords.clear();
};
