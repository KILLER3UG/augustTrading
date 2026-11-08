/**
 * useSurfaceRouter — which surface is showing, and what the URL says about it.
 *
 * First slice of the App.tsx context split (handoff 2.1). This state is a
 * self-contained routing cluster: the surface, the journal's deep-link state,
 * and the two hash effects that keep the URL and
 * the screen in agreement. It had no reason to live inside a 3,400-line
 * component alongside 140-odd unrelated hook calls.
 *
 * WHY THE OVERLAY SETTERS ARE INJECTED rather than owned here. `openJournal`
 * has to close whatever overlay is up, and the hash effects have to close all
 * three on every route. Those overlays belong to `useUIState` and to two
 * App-local flags. Moving that ownership here would either fork the overlay
 * state or drag the whole of `useUIState` along behind it — so this hook takes
 * the nine values it needs and hands control back. The seam is explicit and
 * small, which is the point of taking it deliberately.
 *
 * TWO EFFECTS, and the ref between them is load-bearing. The apply effect
 * writes state from the URL and sets `applyingHashRef`; the write-back effect
 * writes the URL from the state and skips while that ref is set. Without it
 * each would feed the other and the hash would thrash. The reset is deferred
 * to a microtask because the state writes above are not visible to this
 * render — clearing the ref synchronously would let the write-back effect see
 * the pre-apply values and undo them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSurface, type AppSurface } from './useSurface';
import { parseAppHash, serializeAppHash } from '../utils/appHash';
import type { JournalUIState } from './useJournalUI';

export interface SurfaceRouterOptions {
    isSettingsMenuVisible: boolean;
    setIsSettingsMenuVisible: (visible: boolean) => void;
    isLiveMarketVisible: boolean;
    setIsLiveMarketVisible: (visible: boolean) => void;
    isWatchListVisible: boolean;
    setIsWatchListVisible: (visible: boolean) => void;
}

export interface SurfaceRouter {
    surface: AppSurface;
    setSurface: (s: AppSurface) => void;
    journalTab: JournalUIState['tab'];
    setJournalTab: (tab: JournalUIState['tab']) => void;
    journalOpenNonce: number;
    openJournal: (tab?: JournalUIState['tab']) => void;
    handleSurfaceSelect: (next: AppSurface) => void;
}

export const useSurfaceRouter = (opts: SurfaceRouterOptions): SurfaceRouter => {
    const {
        isSettingsMenuVisible, setIsSettingsMenuVisible,
        isLiveMarketVisible, setIsLiveMarketVisible,
        isWatchListVisible, setIsWatchListVisible,
    } = opts;

    // Top-level surfaces chosen from the header's hamburger menu
    // (hooks/useSurface.ts). The trade surface is home.
    const { surface, setSurface } = useSurface();
    const [journalTab, setJournalTab] = useState<JournalUIState['tab']>('log');
    /** Monotonic counter bumped on EVERY openJournal. The mounted Journal keys
     *  its tab re-apply effect on this nonce instead of value-diffing its
     *  props: re-opening the SAME tab while the journal is already open
     *  changed no value and was silently dropped (id-dedup) or applied late. */
    const [journalOpenNonce, setJournalOpenNonce] = useState(0);
    const applyingHashRef = useRef(false);

    /** The single "open the journal" entry point for every affordance:
     *  the surface list, Settings' launcher, and the #/journal hash. */
    const openJournal = useCallback((tab: JournalUIState['tab'] = 'log'): void => {
        setJournalTab(tab);
        setJournalOpenNonce(n => n + 1);
        // Overlays sit above surfaces — close them so the journal actually
        // lands visible.
        setIsSettingsMenuVisible(false);
        setIsLiveMarketVisible(false);
        setIsWatchListVisible(false);
        setSurface('journal');
    }, [setSurface, setIsSettingsMenuVisible, setIsLiveMarketVisible, setIsWatchListVisible]);

    /** Switching surfaces changes the CONTENT and nothing else — no slide, no
     *  resize tween. The hop used to carry a direction flag ('left' | 'right')
     *  into a keyframe on the entering surface; the owner asked for the plain
     *  swap instead, so the flag has no reader and must not come back as dead
     *  plumbing. */
    const handleSurfaceSelect = useCallback((next: AppSurface): void => {
        if (next === 'journal') {
            openJournal();
            return;
        }
        setSurface(next);
    }, [openJournal, setSurface]);

    useEffect(() => {
        const apply = (): void => {
            const route = parseAppHash(window.location.hash);
            applyingHashRef.current = true;
            if (route.view === 'journal' && /^#\/journal\/learning/i.test(window.location.hash)) {
                // WS-5.1: the Journal's old "Learn" tab moved onto the Learn
                // surface, so a bookmarked #/journal/learning lands where the
                // content actually lives now rather than a deleted tab. Matched
                // on the RAW hash because parseAppHash folds dead tabs to the
                // ledger — the fold must not strand this bookmark on Journal.
                setSurface('learn');
                setIsSettingsMenuVisible(false);
                setIsLiveMarketVisible(false);
                setIsWatchListVisible(false);
            } else if (route.view === 'journal') {
                setJournalTab(route.tab || 'log');
                setSurface('journal');
                setIsSettingsMenuVisible(false);
                setIsLiveMarketVisible(false);
                setIsWatchListVisible(false);
            } else if (route.view === 'market') {
                setIsLiveMarketVisible(true);
                setIsSettingsMenuVisible(false);
                setIsWatchListVisible(false);
            } else if (route.view === 'settings') {
                setIsSettingsMenuVisible(true);
                setIsLiveMarketVisible(false);
                setIsWatchListVisible(false);
            } else if (route.view === 'watch') {
                setIsWatchListVisible(true);
                setIsSettingsMenuVisible(false);
                setIsLiveMarketVisible(false);
            } else if (window.location.hash) {
                setIsSettingsMenuVisible(false);
                setIsLiveMarketVisible(false);
                setIsWatchListVisible(false);
            }
            queueMicrotask(() => { applyingHashRef.current = false; });
        };
        apply();
        window.addEventListener('hashchange', apply);
        return () => window.removeEventListener('hashchange', apply);
    }, [setSurface, setIsSettingsMenuVisible, setIsLiveMarketVisible, setIsWatchListVisible]);

    useEffect(() => {
        if (applyingHashRef.current) return;
        // Overlay precedence: the topmost visible overlay owns the URL (it
        // covers the surface). #/journal mirrors the deep-link tab so
        // #/journal/reasoning round-trips.
        const route = isSettingsMenuVisible
            ? { view: 'settings' as const }
            : isLiveMarketVisible
                ? { view: 'market' as const }
                : isWatchListVisible
                    ? { view: 'watch' as const }
                    : surface === 'journal'
                        ? { view: 'journal' as const, tab: journalTab }
                        : { view: 'chat' as const };
        if (route.view === 'chat' && !window.location.hash) return;
        const next = serializeAppHash(route);
        if (window.location.hash !== next) {
            history.replaceState(null, '', next);
        }
    }, [surface, journalTab, isLiveMarketVisible, isSettingsMenuVisible, isWatchListVisible]);

    return {
        surface, setSurface,
        journalTab, setJournalTab,
        journalOpenNonce,
        openJournal, handleSurfaceSelect,
    };
};
