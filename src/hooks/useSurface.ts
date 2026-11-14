/**
 * useSurface — the app is a set of surfaces (Analyze, Journal, Agents, Learning,
 * Skills, Memory) chosen from the rail, not a single page with modal everything.
 *
 * 2026-11-08: Skills and Memory became first-class surfaces (owner ruling, D2 of
 * the v4 plan), reversing the earlier removal. The reasoning then was "a tab is
 * not a surface, so there is nothing to land on" — the v4 mock supplies the
 * landing screens (a library surface, a notebook surface), so the objection no
 * longer holds. 'chat' and 'boards' still migrate to trade.
 * Persisted like uiMode; unknown/absent values fall back to trade.
 */

import { useEffect, useState } from 'react';

export type AppSurface = 'trade' | 'agents' | 'settings';

const KEY = 'august_surface_v1';
const VALID: readonly string[] = ['trade', 'agents', 'settings'];

export const useSurface = (): { surface: AppSurface; setSurface: (s: AppSurface) => void } => {
    const [surface, setSurface] = useState<AppSurface>(() => {
        try {
            const stored = localStorage.getItem(KEY);
            // 'boards' was the first name of the trade surface and 'chat' lost
            // its surface — both land on trade. The four record surfaces
            // (journal/learn/skills/memory) became sections of the Settings
            // modal (2026-11-13), so a stored choice for any of them lands on
            // the trade surface, and the modal opens from the rail's Settings
            // entry.
            if (stored === 'boards' || stored === 'chat') return 'trade';
            return stored && VALID.includes(stored) ? stored as AppSurface : 'trade';
        } catch { return 'trade'; }
    });
    useEffect(() => {
        try { localStorage.setItem(KEY, surface); } catch { /* private mode */ }
    }, [surface]);
    return { surface, setSurface };
};
