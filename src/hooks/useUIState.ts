import { useReducer, useCallback, useMemo } from 'react';

// =============================================================================
// STATE SHAPE
// =============================================================================

interface UIStateShape {
    // Modal / Panel Visibility
    isUserModalOpen: boolean;
    isSavedAnalysesVisible: boolean;
    isSettingsMenuVisible: boolean;
    isVersionHistoryVisible: boolean;
    isVisionDataVisible: boolean;
    showScrollDown: boolean;
    showScrollUp: boolean;

    // Loading / Progress State
    isLoading: boolean;
    isHybridLoading: boolean;
    isCalculatingAIProbabilities: boolean;
    isAnalysisInProgress: boolean;
    isSummaryInProgress: boolean;
    isInsightGenerating: boolean;
    isAutoCapturing: boolean;
    isEntryNotHitCapturing: boolean;
    // Transient capture spinners — SEPARATE from the persisted "prompt for
    // capture" settings above. Previously the modals drove the setting flags
    // as busy indicators, so a profile save mid-capture persisted a stuck
    // `true` (and the toggle flickered during every capture).
    isAutoCaptureBusy: boolean;
    isUpdateCaptureBusy: boolean;
    isEntryNotHitCaptureBusy: boolean;
    isRateLimited: boolean;
}

const initialState: UIStateShape = {
    isUserModalOpen: false,
    isSavedAnalysesVisible: false,
    isSettingsMenuVisible: false,
    isVersionHistoryVisible: false,
    isVisionDataVisible: false,
    showScrollDown: false,
    showScrollUp: false,
    isLoading: false,
    isHybridLoading: false,
    isCalculatingAIProbabilities: false,
    isAnalysisInProgress: false,
    isSummaryInProgress: false,
    isInsightGenerating: false,
    isAutoCapturing: false,
    isEntryNotHitCapturing: false,
    isAutoCaptureBusy: false,
    isUpdateCaptureBusy: false,
    isEntryNotHitCaptureBusy: false,
    isRateLimited: false,
};

// =============================================================================
// ACTIONS
// =============================================================================

type UIAction =
    | { type: 'SET'; key: keyof UIStateShape; value: boolean }
    | { type: 'SET_FUNCTIONAL'; key: keyof UIStateShape; fn: (prev: boolean) => boolean }
    | { type: 'TOGGLE'; key: keyof UIStateShape };

function uiReducer(state: UIStateShape, action: UIAction): UIStateShape {
    switch (action.type) {
        case 'SET':
            return { ...state, [action.key]: action.value };

        case 'SET_FUNCTIONAL':
            return { ...state, [action.key]: action.fn(state[action.key]) };

        case 'TOGGLE':
            return { ...state, [action.key]: !state[action.key] };

        default:
            return state;
    }
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Custom hook that encapsulates all UI visibility and progress state.
 * Uses a single useReducer for predictable, auditable transitions.
 *
 * Backward-compatible: returns the same { isX, setIsX } shape as before.
 */
export function useUIState() {
    const [state, dispatch] = useReducer(uiReducer, initialState);

    // Generate setter functions that match the old useState API.
    // Built once via useMemo (the setters depend only on the stable
    // dispatch) — a useCallback-per-key loop would call a hook inside a
    // loop, which only works while initialState stays a compile-time
    // constant and trips react-hooks linting.
    // Functional updates dispatch SET_FUNCTIONAL so the reducer computes
    // the new value from its OWN latest state — avoiding the stale closure
    // bug where render-time `state[key]` was used instead.
    const setters = useMemo(() => {
        const map = {} as { [K in keyof UIStateShape as `set${Capitalize<string & K>}`]: (value: boolean | ((prev: boolean) => boolean)) => void };
        for (const key of Object.keys(initialState) as (keyof UIStateShape)[]) {
            const setterName = `set${key.charAt(0).toUpperCase()}${key.slice(1)}` as keyof typeof map;
            // The cast is required: the mapped type keys can't be narrowed to
            // a concrete call signature per setter.
            map[setterName] = ((value: boolean | ((prev: boolean) => boolean)) => {
                if (typeof value === 'function') {
                    dispatch({ type: 'SET_FUNCTIONAL', key, fn: value });
                } else {
                    dispatch({ type: 'SET', key, value });
                }
            }) as any;
        }
        return map;
    }, [dispatch]);

    return {
        ...state,
        ...setters,
    };
}

export type UIState = ReturnType<typeof useUIState>;
