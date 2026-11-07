/**
 * Dock V1 — the tab vocabulary and the ONE persisted mode choice.
 *
 * The Chat surface's right workspace has four views. Two ways to hold them:
 *   `all`    every tab is open at once; the tab strip shows all of them and
 *            switching only changes which mounted view is visible.
 *   `single` one tab at a time; choosing another closes the previous one.
 *
 * In BOTH modes a view that has been opened stays MOUNTED. That is the
 * independent-state rule: a filter typed into Files or a chart's timeframe is
 * never reset by visiting another tab. `single` changes which tabs are OPEN,
 * not which views exist.
 */
export type DockTabId = 'files' | 'chart' | 'live' | 'evidence';
export type DockMode = 'all' | 'single';

export interface DockTabDef {
    id: DockTabId;
    label: string;
    description: string;
}

export const DOCK_TABS: readonly DockTabDef[] = [
    { id: 'files', label: 'Files', description: 'Notebook files and skill documents' },
    { id: 'chart', label: 'Chart', description: 'Candles for the active instrument' },
    { id: 'live', label: 'Live', description: 'Live candles and mark price' },
    { id: 'evidence', label: 'Evidence', description: 'Tool results and desk state' },
] as const;

/** Raw localStorage on purpose: a layout preference, not trading data. Listed
 *  in ExportService's raw sweep AND restore allow-list so a backup round-trips
 *  the trader's choice (see scripts/check-contracts.cjs's paired assertion). */
export const DOCK_MODE_KEY = 'agents_dock_mode_v1';

export const readDockMode = (): DockMode => {
    try {
        return localStorage.getItem(DOCK_MODE_KEY) === 'single' ? 'single' : 'all';
    } catch {
        return 'all';
    }
};

export const writeDockMode = (mode: DockMode): void => {
    try {
        localStorage.setItem(DOCK_MODE_KEY, mode);
    } catch {
        /* private mode — the choice simply does not survive a reload */
    }
};
