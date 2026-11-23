/**
 * pass5ReasoningRender — runtime proof for 0-tool reasoning rows.
 *
 * These tests mount the REAL components in a jsdom document (no mocks of the
 * components under test) and read the rendered disclosure: its label, its
 * collapsed state, and the native `<summary>` toggle that keeps keyboard
 * access for free. The settled case is the regression this file exists for:
 * a reasoning-only turn is the whole receipt, so it must carry the reference
 * "Thought for 14s" headline instead of the card-step "Thinking complete".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import React, { act } from 'react';
import type { ReactElement } from 'react';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

// Node has no CSS loader; the real (lazy) MarkdownRenderer imports KaTeX's
// stylesheet. Stub .css to an empty module so the lazy chunk resolves, while
// every other specifier still goes through tsx's normal loader chain.
register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
}
`));

// The production modules capture `document` at import time (idleMotion applies
// its body class on load), and react-dom binds to a document when it loads.
// Install the DOM globals BEFORE the dynamic imports below.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, 'navigator', { configurable: true, value: dom.window.navigator });
g.HTMLElement = dom.window.HTMLElement;
g.HTMLDetailsElement = dom.window.HTMLDetailsElement;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import('react-dom/client');
const { default: ChatWorkTimeline } = await import('../src/components/trade/panels/ChatWorkTimeline');
const { default: ReasoningRow } = await import('../src/components/shared/ReasoningRow');
const { default: AnalyzedRow, thoughtForLabel } = await import('../src/components/shared/AnalyzedRow');

interface Rendered {
    container: HTMLElement;
    unmount: () => void;
}

const render = async (element: ReactElement): Promise<Rendered> => {
    const container = dom.window.document.createElement('div') as HTMLElement;
    dom.window.document.body.appendChild(container);
    const root = createRoot(container);
    // Async act flushes the lazily-imported MarkdownRenderer inside the test,
    // so no suspended resource settles outside act.
    await act(async () => { root.render(element); });
    return {
        container,
        unmount: () => {
            act(() => { root.unmount(); });
            container.remove();
        },
    };
};

describe('pass5 — 0-tool reasoning render', () => {
    it('settles a reasoning-only turn as a collapsed "Thought for 14s" disclosure', async () => {
        const view = await render(React.createElement(ChatWorkTimeline, {
            entry: {
                id: 'turn-settled',
                reasoning: 'I checked the order book and found a clean bid above the range.',
                tools: [],
                streaming: false,
                workedMs: 14_000,
            },
        }));
        try {
            const block = view.container.querySelector('[data-testid="thinking-block"]');
            assert.ok(block, 'a thinking disclosure must be present for a settled reasoning-only turn');
            const details = block as HTMLDetailsElement;
            const summary = details.querySelector('summary') as HTMLElement;
            assert.equal(details.open, false, 'settled disclosure starts collapsed');
            assert.match(summary.textContent ?? '', /^Thought for 14s/, 'visible label');
            assert.match(summary.getAttribute('aria-label') ?? '', /^Thought for 14s.* — expand$/, 'aria label');
            assert.equal(summary.tagName, 'SUMMARY', 'native summary keeps keyboard access');

            act(() => {
                summary.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            assert.equal(details.open, true, 'the summary expands the trace');
            assert.match(details.textContent ?? '', /clean bid above the range/, 'trace is readable when open');
        } finally {
            view.unmount();
        }
    });

    it('shows a live "Thinking" disclosure immediately for a streaming reasoning-only turn', async () => {
        const view = await render(React.createElement(ChatWorkTimeline, {
            entry: {
                id: 'turn-live',
                reasoning: 'Reading the tape',
                tools: [],
                streaming: true,
            },
        }));
        try {
            const block = view.container.querySelector('[data-testid="thinking-block"]');
            assert.ok(block, 'live reasoning still renders the thinking disclosure');
            const details = block as HTMLDetailsElement;
            assert.equal(details.dataset.state, 'running', 'live state is preserved');
            assert.equal(details.open, true, 'live disclosure is open immediately');
            const summary = details.querySelector('summary') as HTMLElement;
            assert.match(summary.textContent ?? '', /Thinking/, 'live label');
            assert.doesNotMatch(summary.textContent ?? '', /Thought for/, 'live never uses the settled headline');
            assert.match(summary.getAttribute('aria-label') ?? '', /^Thinking.* — collapse$/, 'live aria label');
            assert.equal(summary.tagName, 'SUMMARY', 'native summary keeps keyboard access');
        } finally {
            view.unmount();
        }
    });

    it('prints the settled headline from one shared helper, not duplicated label logic', async () => {
        assert.equal(thoughtForLabel(14), 'Thought for 14s');
        const view = await render(React.createElement(AnalyzedRow, { persistedMs: 14_000, children: 'step' }));
        try {
            const summary = view.container.querySelector('summary') as HTMLElement;
            assert.match(summary.textContent ?? '', /^Thought for 14s/, 'card header uses the same phrase');
        } finally {
            view.unmount();
        }
        const card = await render(React.createElement(ReasoningRow, {
            thinking: 'trace',
            persistedMs: 14_000,
        }));
        try {
            const summary = card.container.querySelector('summary') as HTMLElement;
            assert.match(summary.textContent ?? '', /^Thinking complete/, 'opt-in stays scoped to 0-tool turns');
        } finally {
            card.unmount();
        }
    });

    it('keeps 0-tool Thinking live even while answer text is already streaming and clamps sub-second settled turns to 1s', async () => {
        const liveWithAnswer = await render(React.createElement(ChatWorkTimeline, {
            entry: {
                id: 'turn-live-with-text',
                reasoning: 'Evaluating market regime first.',
                text: 'Here is the initial reply token',
                tools: [],
                streaming: true,
            },
        }));
        try {
            const block = liveWithAnswer.container.querySelector('[data-testid="thinking-block"]') as HTMLDetailsElement | null;
            assert.ok(block, '0-tool thinking block must stay visible while answer text streams');
            assert.equal(block.dataset.state, 'running');
            assert.equal(block.open, true);
            assert.match(block.querySelector('summary')?.textContent ?? '', /Thinking/);
        } finally {
            liveWithAnswer.unmount();
        }

        const subSecondSettled = await render(React.createElement(ChatWorkTimeline, {
            entry: {
                id: 'turn-subsecond',
                reasoning: 'Quick greeting thought.',
                text: 'Hello!',
                tools: [],
                streaming: false,
                workedMs: 120,
            },
        }));
        try {
            const block = subSecondSettled.container.querySelector('[data-testid="thinking-block"]') as HTMLDetailsElement | null;
            assert.ok(block);
            assert.equal(block.open, false);
            assert.match(block.querySelector('summary')?.textContent ?? '', /^Thought for 1s/, 'sub-500ms turn must still display Thought for 1s');
        } finally {
            subSecondSettled.unmount();
        }
    });
});
