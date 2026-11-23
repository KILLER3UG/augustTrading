/**
 * Pass 4 — dock streaming coalescing, verified through the real store.
 *
 * A live SSE delta is an ephemeral publish: it must paint at most once per
 * animation frame, never re-arm the 400ms persistence debounce, and a
 * structural `mutate` must flush queued tokens before its own write.
 *
 * The suite shares one process (`--test-isolation=none`), so each test
 * installs and restores its own RAF shim inside a synchronous block — no
 * other file's async continuation can interleave with that window.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.localStorage === 'undefined') {
    const backing = new Map<string, string>();
    g.localStorage = {
        get length() { return backing.size; },
        clear: () => backing.clear(),
        getItem: (k: string) => backing.get(k) ?? null,
        key: (i: number) => Array.from(backing.keys())[i] ?? null,
        removeItem: (k: string) => { backing.delete(k); },
        setItem: (k: string, v: string) => { backing.set(k, String(v)); },
    };
}

type Frame = { cb: FrameRequestCallback; cancelled: boolean };

const withFrames = (fn: (ctx: {
    frames: Map<number, Frame>;
    runFrame: (id: number) => void;
    timers: () => number;
}) => void): void => {
    if (!g.window) {
        g.window = {
            setTimeout, clearTimeout, setInterval, clearInterval,
            addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
        };
    }
    type TimerHandle = ReturnType<typeof setTimeout>;
    type WinShim = {
        requestAnimationFrame: (cb: FrameRequestCallback) => number;
        cancelAnimationFrame: (id: number) => void;
        setTimeout: (cb: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => TimerHandle;
    };
    const win = g.window as unknown as WinShim;
    const frames = new Map<number, Frame>();
    let nextFrame = 1;
    let persistTimers = 0;
    const prevRaf = win.requestAnimationFrame;
    const prevCaf = win.cancelAnimationFrame;
    const prevTimeout = win.setTimeout;
    win.requestAnimationFrame = (cb: FrameRequestCallback): number => {
        const id = nextFrame++;
        frames.set(id, { cb, cancelled: false });
        return id;
    };
    win.cancelAnimationFrame = (id: number): void => {
        const frame = frames.get(id);
        if (frame) frame.cancelled = true;
    };
    win.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
        if (ms === 400) persistTimers += 1;
        return prevTimeout.call(win, cb, ms, ...a);
    }) as typeof win.setTimeout;
    try {
        fn({
            frames,
            runFrame: id => {
                const frame = frames.get(id);
                frames.delete(id);
                if (frame && !frame.cancelled) frame.cb(0);
            },
            timers: () => persistTimers,
        });
    } finally {
        win.requestAnimationFrame = prevRaf;
        win.cancelAnimationFrame = prevCaf;
        win.setTimeout = prevTimeout;
    }
};

const store = await import('../src/services/trade/chatStore');

describe('pass4 — per-frame streaming coalescing', () => {
    it('collapses a 60-token burst into one scheduled frame and one publish', () => {
        withFrames(({ frames, runFrame, timers }) => {
            const sid = store.addSession({ kind: 'solo', title: 'RAF stream' });
            let publishes = 0;
            const unsubscribe = store.subscribe(() => { publishes += 1; });
            const beforeTimers = timers();
            for (let i = 0; i < 60; i += 1) {
                store.mutateEphemeral(sid, s => ({
                    ...s,
                    entries: [...s.entries, { id: `t-${i}`, role: 'ai', text: String(i), tools: [] }],
                }));
            }
            assert.equal(frames.size, 1, '60 tokens schedule exactly one frame');
            assert.equal(timers() - beforeTimers, 0, 'ephemeral publishes never re-arm the debounce');
            assert.equal(publishes, 0, 'nothing paints before the frame');

            const [id] = [...frames.keys()];
            runFrame(id);
            assert.equal(publishes, 1, 'the burst paints once');
            const entries = store.getActiveSession()?.entries ?? [];
            assert.equal(entries.at(-1)?.text, '59', 'every token was applied, in order');
            unsubscribe();
        });
    });

    it('a structural write flushes queued tokens before applying itself', () => {
        withFrames(({ frames, runFrame }) => {
            const sid = store.addSession({ kind: 'solo', title: 'RAF flush' });
            store.mutateEphemeral(sid, s => ({
                ...s,
                entries: [...s.entries, { id: 'pending', role: 'ai', text: 'token', tools: [] }],
            }));
            const pending = [...frames.entries()][0];
            assert.ok(pending, 'a frame is pending');

            store.mutate(sid, s => ({ ...s, title: 'settled' }));
            assert.equal(pending[1].cancelled, true, 'the stale frame was cancelled');
            runFrame(pending[0]); // a stale callback must be inert

            const session = store.getActiveSession();
            assert.equal(session?.title, 'settled');
            assert.equal(session?.entries.at(-1)?.text, 'token', 'queued token survived the flush');
        });
    });

    it('flushEphemeral is immediate at a tool boundary', () => {
        withFrames(() => {
            const sid = store.addSession({ kind: 'solo', title: 'RAF boundary' });
            let publishes = 0;
            const unsubscribe = store.subscribe(() => { publishes += 1; });
            store.mutateEphemeral(sid, s => ({
                ...s,
                entries: [...s.entries, { id: 'boundary', role: 'ai', text: 'done', tools: [] }],
            }));
            store.flushEphemeral(sid);
            assert.equal(publishes, 1, 'the boundary published without waiting for a frame');
            unsubscribe();
        });
    });
});
