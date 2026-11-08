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

export type AppSurface = 'trade' | 'journal' | 'agents' | 'learn' | 'skills' | 'memory';

const KEY = 'august_surface_v1';
const VALID: readonly string[] = ['trade', 'journal', 'agents', 'learn', 'skills', 'memory'];

export const useSurface = (): { surface: AppSurface; setSurface: (s: AppSurface) => void } => {
    const [surface, setSurface] = useState<AppSurface>(() => {
        try {
            const stored = localStorage.getItem(KEY);
            // 'boards' was the first name of the trade surface and 'chat' lost
            // its surface — both land on trade. A stored 'skills' from before
            // 2026-11-08 is a real surface again, so it is NOT migrated.
            if (stored === 'boards' || stored === 'chat') return 'trade';
            return stored && VALID.includes(stored) ? stored as AppSurface : 'trade';
        } catch { return 'trade'; }
    });
    useEffect(() => {
        try { localStorage.setItem(KEY, surface); } catch { /* private mode */ }
    }, [surface]);
    return { surface, setSurface };
};
