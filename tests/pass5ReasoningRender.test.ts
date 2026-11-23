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
    rerender: (element: ReactElement) => Promise<void>;
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
        rerender: async next => {
            await act(async () => { root.render(next); });
        },
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

describe('pass5 — multi-round tool reasoning render', () => {
    const tools = [
        'calling trade log…',
        'trade log · 2 rows',
        'calling market pulse…',
        'market pulse · ready',
    ];
    const reasoning = [
        'Round one: inspect the recent trade-log edge.',
        '[Desk tools] calling trade log…',
        '[Desk tools] trade log · 2 rows',
        'Round two: compare that edge with the live pulse.',
        '[Desk tools] calling market pulse…',
        '[Desk tools] market pulse · ready',
        'Round three: state the conclusion with invalidation.',
    ].join('\n');
    const timeline = (streaming: boolean, text = '') => React.createElement(ChatWorkTimeline, {
        entry: { id: 'turn-tools', reasoning, tools, streaming, text, workedMs: 27_000 },
    });
    const page = (streaming: boolean, text = '') => React.createElement(
        React.Fragment,
        null,
        timeline(streaming, text),
        React.createElement('div', { 'data-testid': 'final-answer' }, text),
    );
    const blocks = (container: HTMLElement): HTMLDetailsElement[] =>
        Array.from(container.querySelectorAll<HTMLDetailsElement>('[data-testid="thinking-block"]'));

    it('keeps all three reasoning rounds open and interleaved live and after the outer work card is expanded', async () => {
        const view = await render(page(true));
        try {
            assert.equal(blocks(view.container).length, 3, 'one Thinking row per received reasoning round');
            assert.ok(blocks(view.container).every(block => block.open), 'earlier rounds stay readable while later tools run');
            assert.match(blocks(view.container)[0].textContent ?? '', /Round one/);
            assert.match(blocks(view.container)[1].textContent ?? '', /Round two/);
            assert.match(blocks(view.container)[2].textContent ?? '', /Round three/);
            assert.deepEqual(
                Array.from(view.container.querySelectorAll('[data-testid="thinking-block"], [data-testid="tool-row"]'))
                    .map(node => node.getAttribute('data-testid')),
                ['thinking-block', 'tool-row', 'thinking-block', 'tool-row', 'thinking-block'],
                'Thinking and its corresponding tool stay in chronological order',
            );

            await view.rerender(page(false, 'The edge is weak above 94.8k; invalidation is a close back inside the range.'));
            const outer = view.container.querySelector<HTMLDetailsElement>('[data-testid="analyzed-row"]');
            assert.ok(outer);
            assert.equal(outer.open, false, 'settling folds the outer work card so the answer owns the page');
            act(() => {
                (outer.querySelector('summary') as HTMLElement)
                    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            assert.equal(outer.open, true);
            assert.ok(blocks(view.container).every(block => block.open), 'expanding the work card reveals every round, not labels alone');
            assert.equal(view.container.querySelectorAll('[data-testid="tool-row"]').length, 2);
            const answer = view.container.querySelector('[data-testid="final-answer"]');
            assert.ok(answer);
            assert.ok(
                (outer.compareDocumentPosition(answer) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
                'all thinking and tool work stays strictly above the final answer',
            );
        } finally {
            view.unmount();
        }
    });

    it('keeps the same tool row mounted when the next reasoning segment arrives', async () => {
        const view = await render(React.createElement(ChatWorkTimeline, {
            entry: {
                id: 'turn-stable-tool',
                reasoning: 'Round one.\n[Desk tools] calling trade log…\n[Desk tools] trade log · 2 rows',
                tools: tools.slice(0, 2),
                streaming: true,
            },
        }));
        try {
            const before = view.container.querySelector('[data-testid="tool-row"]');
            assert.ok(before);
            await view.rerender(React.createElement(ChatWorkTimeline, {
                entry: {
                    id: 'turn-stable-tool',
                    reasoning: 'Round one.\n[Desk tools] calling trade log…\n[Desk tools] trade log · 2 rows\nRound two.',
                    tools: tools.slice(0, 2),
                    streaming: true,
                },
            }));
            assert.ok(
                view.container.querySelector('[data-testid="tool-row"]') === before,
                'a later thought must not remount the earlier tool disclosure',
            );
        } finally {
            view.unmount();
        }
    });

    it('does not reopen a manually collapsed tool-round thought when it starts running again', async () => {
        const view = await render(React.createElement(ReasoningRow, {
            thinking: 'Tool-round trace.', defaultOpen: true, running: false,
        }));
        try {
            const block = view.container.querySelector<HTMLDetailsElement>('[data-testid="thinking-block"]');
            assert.ok(block);
            assert.equal(block.open, true);
            act(() => {
                (block.querySelector('summary') as HTMLElement)
                    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            assert.equal(block.open, false);
            await view.rerender(React.createElement(ReasoningRow, {
                thinking: 'Tool-round trace.', defaultOpen: true, running: true,
            }));
            assert.equal(block.dataset.state, 'running');
            assert.equal(block.open, false, 'a manual collapse wins over a later running transition');
        } finally {
            view.unmount();
        }
    });

    it('reveals every stored reasoning round when a reloaded tool turn is expanded', async () => {
        const view = await render(page(false, 'Settled answer.'));
        try {
            const outer = view.container.querySelector<HTMLDetailsElement>('[data-testid="analyzed-row"]');
            assert.ok(outer);
            assert.equal(outer.open, false, 'a reloaded work card still starts folded');
            act(() => {
                (outer.querySelector('summary') as HTMLElement)
                    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            const received = blocks(view.container);
            assert.equal(received.length, 3);
            assert.ok(received.every(block => block.open), 'stored prose is visible on first expansion after reload');
            assert.match(received.map(block => block.textContent ?? '').join('\n'), /Round one[\s\S]*Round two[\s\S]*Round three/);
        } finally {
            view.unmount();
        }
    });
});
