/**
 * mock-provider — a local OpenAI-compatible chat-completions endpoint for
 * driving the real UI in a browser.
 *
 * WHY: the app configures providers in-app and refuses to send anything until a
 * provider is "ready", so every browser-level check of the chat surface, the
 * verdict panels, the streaming rows and the run audit was previously
 * impossible without spending real API calls against a real account. This
 * answers in milliseconds and costs nothing, which is what makes an end-to-end
 * UI test repeatable.
 *
 * Loopback plain-HTTP is explicitly allowed by
 * `shared/providerRequestPolicy.cjs` (the rule exists for Ollama and friends),
 * so this reads to the app as an ordinary local model server.
 *
 *   node scripts/mock-provider.cjs            # port 8787
 *   node scripts/mock-provider.cjs 8899       # another port
 *
 * Provider config to add in Settings → Providers:
 *   name mock · apiFormat chat_completions · baseUrl http://127.0.0.1:8787/v1
 *   apiKey mock-key · model mock-mini
 */

const http = require('http');

const PORT = Number(process.argv[2] || 8787);
const MODEL = 'mock-mini';

/**
 * OPT-IN tool-call scenario. `MOCK_TOOL_CALL=1` (or --tool-call) enables it.
 *
 * WHY: the desk tools are only reachable through a model turn, so the parts of
 * the write path that lives ABOVE the notebook — `skill_write`'s own argument
 * parsing, the duplicate scan, and a refused write — could not be driven in a
 * browser at all. Seeding a file skips every one of them.
 *
 * With the flag OFF nothing below runs: `toolScenario()` returns null on the
 * first line and the response is built by the same code as before. That is the
 * contract, because this file is a shared CI fixture used by boot-probe,
 * render-probe and the approval probe unchanged.
 */
const TOOL_SCENARIO = process.env.MOCK_TOOL_CALL === '1' || process.argv.includes('--tool-call');
const TOOL_NAME = process.env.MOCK_TOOL_NAME || 'skill_write';

const DEFAULT_SKILL_ARGS = {
    slug: 'probe-session-open-fade-short',
    name: 'Session-open fade short',
    description: 'Use this skill whenever price rallies into the first fifteen minutes of the US session and stalls at the open high. Do NOT use for a trending open.',
    body: [
        '## When to use',
        '',
        'Price rallies into the first fifteen minutes of the US session and stalls at the open high.',
        '',
        '## Steps',
        '',
        '1. Mark the US session-open high on 15m.',
        '2. Refuse longs under it until a close takes it out.',
        '3. Short a reclaim failure with the stop above that high.',
        '',
        '## Verification',
        '',
        'The open high held twice on closing prices.',
    ].join('\n'),
};

/** The scripted call, or null when this request must get a plain reply.
 *  `MOCK_SKILL_ARGS` overrides the payload as a JSON object, which is how a
 *  caller tests the rejection paths (e.g. a too-short trigger). */
function toolScenario(body) {
    // A request-scoped arming marker: the render probe sends one message
    // containing PROBE_TOOL_ROUND. A second mock instance with MOCK_TOOL_CALL=1 was
    // tried first and rejected, because it answers boot-time calls too and the app
    // then never reaches the trade screen.
    const marked = JSON.stringify((body && body.messages) || []).includes("PROBE_TOOL_ROUND");
    if (!TOOL_SCENARIO && !marked) return null;
    if (!Array.isArray(body.tools) || body.tools.length === 0) return null;
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    // One shot per TURN. After the app runs the tool it calls back with the
    // result, and re-emitting would loop forever. Keyed on the LAST user message,
    // not on any tool message in the history, or a second tool-bearing turn in the
    // same conversation could never get one — which is what the Stop-mid-tool
    // check needs.
    const lastUser = msgs.map(x => (x && x.role) || '').lastIndexOf('user');
    const results = msgs.slice(lastUser + 1).filter(x => x && x.role === 'tool');
    let args = DEFAULT_SKILL_ARGS;
    if (process.env.MOCK_SKILL_ARGS) {
        try { args = JSON.parse(process.env.MOCK_SKILL_ARGS); } catch { /* keep the default */ }
    }
    let name = TOOL_NAME;
    if (name === 'skill_write') {
        const index = results.find(x => String(x.content).includes('"skills":'));
        const read = results.find(x => /^# .*\nName:/.test(String(x.content)));
        const written = results.find(x => /"saved":true|skill_write rejected:/.test(String(x.content)));
        if (written) return null;
        if (!index) {
            name = 'skill_index';
            args = {};
        } else {
            const existing = JSON.parse(index.content).skills.find(s => s.slug === args.slug);
            if (existing && !read) {
                name = 'skill_view';
                args = { skill: existing.slug };
            } else if (existing) {
                args = { ...args, if_version: String(read.content).match(/\nVersion: (\w+)/)?.[1] };
            }
        }
    } else if (results.length) return null;
    return {
        model: MODEL,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: `call_${Date.now().toString(36)}`,
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) },
                }],
            },
            finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 40, completion_tokens: 40, total_tokens: 80 },
    };
}

const cors = (res, req) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    // Echo the requested headers rather than a fixed list: the app sends
    // Authorization for chat_completions and x-api-key for messages format,
    // and a preflight that doesn't name the one actually sent fails the real
    // request with a bare "Connection error".
    res.setHeader('Access-Control-Allow-Headers',
        req.headers['access-control-request-headers'] || 'content-type, authorization, x-api-key');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    // Chrome's Private Network Access: a page on 127.0.0.1:4183 asking a
    // different port on 127.0.0.1 is a public→private request, and the preflight
    // is only satisfied by this header. Invisible under `npm run dev`, where the
    // vite proxy keeps every provider call same-origin.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin, Access-Control-Request-Headers');
};

/** A reply that quotes the last user turn, so a browser check can tell WHICH
 *  message rendered where. */
const replyTo = (body) => {
    const msgs = Array.isArray(body && body.messages) ? body.messages : [];
    const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
    const raw = typeof lastUser?.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser?.content)
            ? (lastUser.content.find(p => p?.type === 'text')?.text ?? '')
            : '';
    const quoted = String(raw).replace(/\s+/g, ' ').trim().slice(0, 160);
    // The answer carries a CLOSED key-levels block so the transcript's
    // disclosure path is exercised by the probe's default turn — the block is
    // stripped from the rendered text by `parseKeyLevels`, exactly as a real
    // answer's would be.
    const levels = [
        '```key-levels',
        'entry | 78250 | break of the session high',
        'stop | 77600 | below the shelf',
        'target | 79250 | prior high',
        '```',
    ].join(String.fromCharCode(10));
    return `MOCK REPLY for "${quoted}" — the desk is up, the feed is live, and this answer came from the local mock.` + String.fromCharCode(10, 10) + levels;
};

/** OPT-IN slow scenario, keyed on a marker in the REQUEST rather than an env
 *  flag, for the same reason `PROBE_TOOL_ROUND` is: the default answer streams in
 *  ~60 ms, which is over before a surface switch even renders, so the live-sync
 *  check ("a turn asked in the dock is still ARRIVING on the Agents surface")
 *  could only ever measure a settled row. A sentinel in one message arms this
 *  for that message alone and cannot leak into another phase's turn. */
const SLOW_MARK = 'PROBE_SLOW_STREAM';
const SLOW_FILLER = 'The desk is up and the feed is live, so this sentence keeps '
    + 'arriving token by token while the trader reads the other surface. '.repeat(9);

/** The clock scenario: stream a REAL `reasoning_content` trace before any
 *  answer text, so both homes show the live "Thinking · Ns" row long enough
 *  to cross a surface hop. The timer check is a claim about the same turn
 *  continuing, which cannot be measured on a trace that settles in 60 ms. */
/** A MARKDOWN answer, streamed slowly. The streaming row must render the
 *  formatting AS IT ARRIVES — bold, lists and a table are the three the
 *  transcript actually uses — not only once the turn settles. Same
 *  opt-in-marker pattern as SLOW_MARK: it arms one message and cannot leak
 *  into another phase's turn. */
const MARKDOWN_MARK = 'PROBE_MARKDOWN_STREAM';
const MARKDOWN_REPLY = [
    '## Bias into the reclaim',
    '',
    '**Long** into the reclaim, stop below the shelf. The `key-levels` block',
    'below is the receipt, not a second opinion.',
    '',
    '- Entry: 84,210',
    '- Stop: 83,100',
    '- Target: 87,900',
    '',
    '| Level | Price | Note |',
    '| --- | --- | --- |',
    '| Entry | 84,210 | break of the session high |',
    '| Stop | 83,100 | below the shelf |',
    '',
    'Risk is **2.1%** of equity, and the invalidation is a close back under',
    'the shelf. That is the whole plan.',
].join(String.fromCharCode(10));

const REASONING_MARK = 'PROBE_REASONING_STREAM';
const REASONING_FILLER = 'The desk is checking structure, liquidity and the tape before it commits to a direction. '.repeat(20);

const stream = (res, text, delayMs = 12, reasoning = '') => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
    });
    // Chunk it: a single giant delta would never exercise the streaming rows.
    const words = text.split(' ');
    const reasoningWords = reasoning.split(' ').filter(Boolean);
    let i = 0;
    let r = 0;
    const tick = () => {
        if (res.writableEnded) return;
        // Reasoning first, as the providers that support it send it.
        if (r < reasoningWords.length) {
            const piece = reasoningWords.slice(r, r + 3).join(' ');
            r += 3;
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: `${piece} ` } }] })}\n\n`);
            setTimeout(tick, 90);
            return;
        }
        if (i >= words.length) {
            res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }
        const piece = words.slice(i, i + 4).join(' ');
        i += 4;
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `${piece} ` } }] })}\n\n`);
        setTimeout(tick, delayMs);
    };
    tick();
};

/** The scripted call as the frames a real OpenAI-compatible transport sends:
 *  one opening frame with the id + function name, then argument fragments,
 *  then `finish_reason: "tool_calls"` and the [DONE] sentinel. Chunked on
 *  purpose — the parser keys its slots on `index` and concatenates, so one fat
 *  frame would answer the question without exercising the accumulator. */
const streamToolCall = (res, call) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    const frame = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    frame({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] } }] });
    const args = String(call.function.arguments || '');
    const SIZE = 24;
    for (let i = 0; i < args.length; i += SIZE) {
        frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + SIZE) } }] } }] });
    }
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    res.write('data: [DONE]\n\n');
    res.end();
};

const server = http.createServer((req, res) => {
    cors(res, req);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url.endsWith('/models') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // `context_length` is what OpenRouter, Together, Groq (`context_window`),
        // llama.cpp and vLLM report, and it is the only way this app learns a
        // model's real window without the trader typing one. The probe and the
        // Settings editor can therefore exercise the discovered-window path
        // against a server that actually answers.
        res.end(JSON.stringify({ data: [{ id: MODEL, object: 'model', context_length: 131_072 }] }));
        return;
    }

    if (!req.url.includes('/chat/completions')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `mock-provider: no route ${req.url}` } }));
        return;
    }

    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* keep the default */ }
        // Opt-in scenario. Returns null unless MOCK_TOOL_CALL is on AND this
        // request carries tools AND no tool result is in the history yet, so a
        // flag-off run never reaches past the first statement.
        const scripted = toolScenario(body);
        if (scripted) {
            const call = scripted.choices[0].message.tool_calls[0];
            console.log(`[mock-provider] scripted ${call.function.name} call`);
            // A real OpenAI-compatible transport never answers `stream: true`
            // with a JSON body: the call arrives as index-keyed `delta.tool_calls`
            // fragments closed by `finish_reason: "tool_calls"`. The dock asks for
            // a stream, so replying with a bare object gave the SSE parser zero
            // frames — which is why the render probe could not see a tool line at
            // all. The accumulator itself was unit-tested
            // (tests/sseParser.test.ts:35); what had never run was a streamed call
            // through the real transport into a rendered row.
            if (body.stream) { streamToolCall(res, call); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(scripted));
            return;
        }
        const text = replyTo(body);
        if (body.stream) {
            const serialized = JSON.stringify((body && body.messages) || []);
            const slow = serialized.includes(SLOW_MARK);
            const markdown = serialized.includes(MARKDOWN_MARK);
            const reasoning = serialized.includes(REASONING_MARK) ? REASONING_FILLER : '';
            if (slow) console.log('[mock-provider] slow-stream scenario');
            if (markdown) console.log('[mock-provider] markdown-stream scenario');
            if (reasoning) console.log('[mock-provider] reasoning-clock scenario');
            stream(res, markdown ? MARKDOWN_REPLY : slow ? `${text} ${SLOW_FILLER}` : text, (slow || markdown) ? 90 : 12, reasoning);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            model: MODEL,
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 40, completion_tokens: 40, total_tokens: 80 },
        }));
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[mock-provider] http://127.0.0.1:${PORT}/v1  (model ${MODEL})${TOOL_SCENARIO ? '  TOOL-CALL SCENARIO ON' : ''}`);
});
