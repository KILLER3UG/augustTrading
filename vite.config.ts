import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import dns from 'dns';
import * as process from 'process';
import { readFileSync } from 'fs';
import {
  chatMessagesToGemini,
  googleGenerateUrl,
  parseGeminiResponse,
  usesGoogleGeminiDiscovery,
  googleModelsUrl,
} from './src/utils/googleGeminiFormat';
import {
  anthropicCachedSystem,
  anthropicThinkingFields,
  geminiThinkingParams,
  isLocalBaseUrl,
  normalizeProviderUrl,
  fetchFollowingSafeRedirects,
} from './shared/providerRequestPolicy.cjs';

// shared/providerRequestPolicy.cjs is the single wire-policy source for the
// Electron main process (require) AND the bundled renderer (ES import). Node
// handles the CJS natively (this config's own import above); the browser
// pipeline cannot execute `module.exports`, so this transform appends the ESM
// named-export list — the guarded `module.exports = …` assignment in the file
// then simply no-ops in the browser (where `typeof module === 'undefined'`).
// Vitest consumes the same file as plain CJS through vite-node's interop, so
// the module needs no second copy and the three transports ship ONE policy
// implementation.
const SHARED_POLICY_EXPORTS = [
  'isExtendedThinkingModel',
  'claudeThinkingBudgetTokens',
  'anthropicShouldSendThinking',
  'anthropicThinkingFields',
  'anthropicCachedSystem',
  'geminiThinkingParams',
  'isPrivateOrLoopbackHost',
  'isLinkLocalHost',
  'hostAddresses',
  'httpAllowedForHost',
  'isSafeProviderTargetUrl',
  'isLocalBaseUrl',
  'normalizeProviderUrl',
  'EXTENDED_THINKING_MODEL_RE',
  'MIN_EFFECTIVE_THINKING_TOKENS',
  'ANTHROPIC_DEFAULT_TEMPERATURE',
  'THINKING_BUDGET_FRACTIONS',
  'GEMINI_THINKING_BUDGETS',
  'requestReasoningSideChannel',
];

function sharedProviderPolicyEsmInterop(): any {
  return {
    name: 'shared-provider-policy-esm',
    enforce: 'pre' as const,
    transform(code: string, id: string): { code: string; map: null } | null {
      const file = id.split('?')[0].replace(/\\/g, '/');
      if (!file.endsWith('/shared/providerRequestPolicy.cjs')) return null;
      return { code: `${code}\nexport { ${SHARED_POLICY_EXPORTS.join(', ')} };\n`, map: null };
    },
  };
}

function devProviderProxy() {
  return {
    name: 'dev-provider-proxy',
    configureServer(server: any) {
      // Degrade chain shared with the renderer + Electron main:
      // json_schema → json_object (only when jsonMode was also asked) → none.
      const stepDownResponseFormat = (b: Record<string, unknown>, jsonMode?: unknown): void => {
        const rf = b.response_format as { type?: string } | undefined;
        if (rf?.type === 'json_schema' && jsonMode) b.response_format = { type: 'json_object' };
        else delete b.response_format;
      };
      server.middlewares.use('/__provider_proxy', async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next();
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const config = request?.config || {};
          // Base-URL policy is the SHARED one (HTTPS/private-LAN host rule, no
          // credentials/query/fragment, endpoint-path suffix stripped). The
          // proxy used to carry its own copy, which stripped only FOUR path
          // suffixes where the desktop stripped six — so the same saved
          // provider normalized differently per transport and worked on one
          // runtime and not the other.
          const baseUrl = normalizeProviderUrl(config?.baseUrl);
          const apiKey = String(config.apiKey || '').trim();
          if (request.discover) {
            const isGemini = usesGoogleGeminiDiscovery(baseUrl, config.apiFormat);
            const isAnthropic = config.apiFormat === 'messages' && !isGemini;
            const discoverHeaders: Record<string, string> = {
              Accept: 'application/json',
            };
            if (isAnthropic) {
              discoverHeaders['x-api-key'] = apiKey;
              discoverHeaders['anthropic-version'] = '2023-06-01';
            } else if (!isGemini && apiKey && apiKey !== 'not-needed') {
              discoverHeaders.Authorization = `Bearer ${apiKey}`;
            }

            const candidateUrls: string[] = [];
            if (isGemini) {
              candidateUrls.push(googleModelsUrl(baseUrl, apiKey));
            } else {
              candidateUrls.push(`${baseUrl}/models`);
              if (baseUrl.endsWith('/v1')) {
                const withoutV1 = baseUrl.slice(0, -3);
                if (withoutV1) candidateUrls.push(`${withoutV1}/models`);
              } else {
                candidateUrls.push(`${baseUrl}/v1/models`);
              }
              if (isLocalBaseUrl(baseUrl)) {
                candidateUrls.push(`${baseUrl.replace(/\/v1$/, '')}/api/tags`);
              }
            }

            let lastStatus = 0;
            let lastBody = '';
            let lastOk = false;

            for (const discoverUrl of [...new Set(candidateUrls)]) {
              try {
                const upstream = await fetchFollowingSafeRedirects(fetch, discoverUrl, {
                  method: 'GET',
                  headers: discoverHeaders,
                  signal: AbortSignal.timeout(15000),
                });
                const text = await upstream.text();
                lastStatus = upstream.status;
                lastBody = text;
                lastOk = upstream.ok;
                if (upstream.ok || upstream.status !== 404) {
                  break;
                }
              } catch (err: any) {
                lastStatus = 500;
                lastBody = err?.message || 'Discovery request failed';
                lastOk = false;
              }
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: lastOk, status: lastStatus, body: lastBody }));
            return;
          }
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          let url = '';
          let body: Record<string, unknown>;
          const messages = request.messages || [];
          if (config.apiFormat === 'chat_completions') {
            url = `${baseUrl}/chat/completions`;
            if (apiKey && apiKey !== 'not-needed') headers.Authorization = `Bearer ${apiKey}`;
            body = { model: config.selectedModel, messages: request.messages || [], max_tokens: request.maxTokens ?? 4096, temperature: request.temperature ?? 0.7 };
            if (request.jsonSchema && request.jsonSchema.schema) {
              // Pre-resolved by the renderer's jsonSchema capability class.
              body.response_format = {
                type: 'json_schema',
                json_schema: {
                  name: request.jsonSchema.name || 'august_json',
                  strict: false,
                  schema: request.jsonSchema.schema,
                },
              };
            } else if (request.jsonMode) body.response_format = { type: 'json_object' };
            if (Array.isArray(request.tools) && request.tools.length > 0) {
              body.tools = request.tools;
              body.tool_choice = request.toolChoice || 'auto';
            }
          } else if (config.apiFormat === 'messages') {
            url = `${baseUrl}/messages`;
            if (apiKey) headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
            const system = messages.find((message: any) => message?.role === 'system');
            body = { model: config.selectedModel, max_tokens: request.maxTokens ?? 4096, messages: messages.filter((message: any) => message?.role !== 'system').map((message: any) => ({ role: message.role, content: toAnthropicContent(message.content) })) };
            // Cache breakpoint on the stable system block (shared policy, O-58).
            if (system) body.system = anthropicCachedSystem(contentToText(system.content));
            // Extended thinking + temperature come from the SHARED policy
            // module — model-id list, effort-scaled budget, 1024 floor,
            // 0.7-default temperature omitted while thinking is active —
            // identical to the renderer/desktop by construction. (The old
            // local copy here had a stale model-id regex that missed
            // sonnet-5/opus-5, a fixed 0.35 budget ignoring the effort tier,
            // and never sent temperature at all.)
            const thinkingFields = anthropicThinkingFields({
              modelId: String(config.selectedModel || ''),
              displayName: String(config.name || ''),
              capabilityOverride: config.thinkingCapable,
              maxTokens: request.maxTokens,
              temperature: request.temperature,
              jsonMode: request.jsonMode,
              reasoningEffort: request.reasoningEffort,
            });
            if (typeof thinkingFields.temperature === 'number') body.temperature = thinkingFields.temperature;
            if (thinkingFields.thinking) body.thinking = thinkingFields.thinking;
          } else if (config.apiFormat === 'responses') {
            url = `${baseUrl}/responses`;
            if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
            const responsesMessages = messages.filter((message: any) => message?.role !== 'system');
            const responsesSystem = messages.find((message: any) => message?.role === 'system');
            body = {
              model: config.selectedModel,
              input: responsesMessages.map((message: any) => ({
                role: message.role,
                content: typeof message.content === 'string'
                  ? message.content
                  : (message.content || []).map((part: any) => part?.type === 'text'
                    ? { type: 'input_text', text: part.text }
                    : { type: 'input_image', image_url: part?.image_url?.url || '' })
              })),
              ...(responsesSystem ? { instructions: contentToText(responsesSystem.content) } : {}),
              max_output_tokens: request.maxTokens ?? 4096,
              temperature: request.temperature ?? 0.7
            };
          } else if (config.apiFormat === 'google') {
            url = googleGenerateUrl(baseUrl, config.selectedModel, apiKey, false);
            if (apiKey) headers['x-goog-api-key'] = apiKey;
            body = chatMessagesToGemini(messages, {
              maxTokens: request.maxTokens,
              temperature: request.temperature,
              jsonMode: request.jsonMode,
              model: config.selectedModel,
            }) as unknown as Record<string, unknown>;
            // Canonical Gemini thinking decision from the shared policy
            // (includeThoughts + 8192 budget; undefined under JSON mode),
            // so all three transports emit an identical thinkingConfig.
            {
              const geminiConfig = body.generationConfig as Record<string, unknown> | undefined;
              if (geminiConfig) {
                // The output cap is REQUIRED — Gemini bills thinking tokens
                // INSIDE maxOutputTokens, so an unclamped budget at or above
                // the cap is a hard 400. `chatMessagesToGemini` above already
                // produced a correctly clamped value via the 4-arg form; this
                // line was overwriting it with the raw ladder value.
                const geminiThinking = geminiThinkingParams(
                    request.jsonMode,
                    String(config.selectedModel || ''),
                    request.reasoningEffort,
                    request.maxTokens || 4096,
                );
                if (geminiThinking) geminiConfig.thinkingConfig = geminiThinking;
                else delete geminiConfig.thinkingConfig;
              }
            }
          } else {
            throw new Error('Unknown provider API format.');
          }
          // Reasoning knob for the dev proxy routes: the renderer translates
          // the composer's effort tier into wire fields (reasoningControls
          // capability classes) and sends them as reasoningPatch; merge them
          // into whatever body shape the format built. Absent ⇒ no change
          // (fail closed, same as the direct SDK path).
          if (request.reasoningPatch && typeof request.reasoningPatch === 'object') {
            Object.assign(body, request.reasoningPatch);
          }
          // Streaming (SSE) passthrough — used by streamChatRequest on localhost
          // so the renderer receives per-chunk deltas without CORS failures
          // (direct browser SDK calls are blocked by providers without CORS
          // headers, e.g. opencode). The renderer parses the SSE events.
          if (request.stream) {
            const streamBody: Record<string, unknown> = { ...body, stream: true, stream_options: { include_usage: true } };
            let sse = await fetchFollowingSafeRedirects(fetch, url, { method: 'POST', headers, body: JSON.stringify(streamBody), signal: AbortSignal.timeout(300000) });
            if (!sse.ok && (request.jsonMode || request.jsonSchema) && (sse.status === 400 || sse.status === 422) && streamBody.response_format) {
              const fallbackBody = { ...streamBody };
              stepDownResponseFormat(fallbackBody, request.jsonMode);
              sse = await fetchFollowingSafeRedirects(fetch, url, { method: 'POST', headers, body: JSON.stringify(fallbackBody), signal: AbortSignal.timeout(300000) });
              if (!sse.ok && (sse.status === 400 || sse.status === 422) && fallbackBody.response_format) {
                delete fallbackBody.response_format;
                sse = await fetchFollowingSafeRedirects(fetch, url, { method: 'POST', headers, body: JSON.stringify(fallbackBody), signal: AbortSignal.timeout(300000) });
              }
            }
            if (!sse.ok || !sse.body) {
              const text = await sse.text();
              res.statusCode = sse.status;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: false, status: sse.status, body: text.slice(0, 2000), message: '', reasoning: '' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            const reader = sse.body.getReader();
            const decoder = new TextDecoder();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(decoder.decode(value, { stream: true }));
              }
            } catch (streamError) {
              // Mid-stream upstream failure: headers are already committed as
              // text/event-stream with a 200 status, so a JSON error body
              // would corrupt the stream and be silently dropped by the
              // renderer's SSE parser — the failure would look like a clean
              // completion. Emit an SSE error event instead; streamViaProxy
              // treats a chunk.error as a real failure and surfaces it.
              const message = streamError instanceof Error ? streamError.message : 'Provider stream interrupted.';
              res.write(`data: ${JSON.stringify({ error: { message, code: 'stream_interrupted' } })}\n\n`);
            } finally {
              reader.releaseLock();
            }
            res.end();
            return;
          }
          let upstream = await fetchFollowingSafeRedirects(fetch, url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
          if (!upstream.ok && (request.jsonMode || request.jsonSchema) && (upstream.status === 400 || upstream.status === 422) && body.response_format) {
            const fallbackBody = { ...body };
            stepDownResponseFormat(fallbackBody, request.jsonMode);
            upstream = await fetchFollowingSafeRedirects(fetch, url, { method: 'POST', headers, body: JSON.stringify(fallbackBody), signal: AbortSignal.timeout(120000) });
            if (!upstream.ok && (upstream.status === 400 || upstream.status === 422) && fallbackBody.response_format) {
              delete fallbackBody.response_format;
              upstream = await fetchFollowingSafeRedirects(fetch, url, { method: 'POST', headers, body: JSON.stringify(fallbackBody), signal: AbortSignal.timeout(120000) });
            }
          }
          let text = await upstream.text();
          if (upstream.ok && (request.jsonMode || request.jsonSchema) && body.response_format) {
            try {
              const parsed = JSON.parse(text);
              const message = parsed?.choices?.[0]?.message || {};
              const content = Array.isArray(message.content)
                ? message.content.filter((part: any) => typeof part?.text === 'string').map((part: any) => part.text).join('')
                : message.content;
              const reasoning = message.reasoning_content || message.reasoning;
              if (!content && !reasoning) {
                const fallbackBody = { ...body };
                delete fallbackBody.response_format;
                upstream = await fetchFollowingSafeRedirects(fetch, url, { method: 'POST', headers, body: JSON.stringify(fallbackBody), signal: AbortSignal.timeout(120000) });
                text = await upstream.text();
              }
            } catch { /* non-JSON output is handled by the client parser */ }
          }
          res.statusCode = upstream.status;
          res.setHeader('Content-Type', 'application/json');
          let reasoning = '';
          let message = '';
          try {
            const parsed = JSON.parse(text);
            message = parsed.error?.message || parsed.error?.error?.message || parsed.message || parsed.detail || '';
            // Per-format chain-of-thought extraction (mirrors the renderer's
            // GenericProviderService helpers so the proxy's `reasoning` field
            // covers all three formats, not just chat_completions).
            if (config.apiFormat === 'messages') {
              reasoning = extractMessagesThinking(parsed.content);
            } else if (config.apiFormat === 'responses') {
              reasoning = extractResponsesReasoning(parsed.output);
            } else if (config.apiFormat === 'google') {
              reasoning = parseGeminiResponse(parsed).reasoning;
            } else {
              const msgReasoning = parsed.choices?.[0]?.message?.reasoning_content ?? parsed.choices?.[0]?.message?.reasoning;
              reasoning = Array.isArray(msgReasoning)
                ? msgReasoning.filter((part: any) => typeof part === 'string').join('\n')
                : (msgReasoning || '');
            }
          } catch { /* provider returned non-JSON content */ }
          if (!message && !upstream.ok) message = text.replace(/\s+/g, ' ').trim().slice(0, 300);
          // Successful analysis responses can be larger than 2,000 characters;
          // truncating them produces invalid JSON in the renderer. Only cap
          // failed response bodies because they are diagnostic text.
          res.end(JSON.stringify({ ok: upstream.ok, status: upstream.status, body: upstream.ok ? text : text.slice(0, 2000), reasoning, message }));
        } catch (error) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          const message = error instanceof Error ? error.message : 'Provider proxy failed.';
          res.end(JSON.stringify({ ok: false, status: 502, message: `Provider proxy could not reach the configured endpoint: ${message}` }));
        }
      });
    },
  };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('');
}

function toAnthropicContent(content: unknown): any[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((part: any) => {
    if (part?.type === 'text') return { type: 'text', text: part.text };
    const url = part?.image_url?.url || '';
    const commaIndex = url.indexOf(',');
    if (url.startsWith('data:') && commaIndex !== -1) {
      const header = url.slice(5, commaIndex);
      const mimeMatch = header.match(/^image\/(png|jpeg|webp|gif)\b/i);
      const mediaType = mimeMatch ? `image/${mimeMatch[1].toLowerCase()}` : 'image/png';
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: url.slice(commaIndex + 1) } };
    }
    return { type: 'image', source: { type: 'url', url } };
  });
}

function extractMessagesThinking(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      parts.push(block.thinking.trim());
    } else if (block?.type === 'redacted_thinking') {
      parts.push('[Thinking redacted by provider]');
    }
  }
  return parts.join('\n');
}

function extractResponsesReasoning(output: unknown): string {
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    if (item?.type !== 'reasoning') continue;
    if (Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block?.type === 'output_text' && typeof block.text === 'string') parts.push(block.text);
      }
    }
    if (Array.isArray(item.summary)) {
      for (const block of item.summary) {
        if (block?.type === 'summary_text' && typeof block.text === 'string') parts.push(block.text);
      }
    }
  }
  return parts.join('\n');
}

// Fix for a common issue with Node.js v17+ DNS resolution.
// This ensures 'localhost' resolves correctly.
dns.setDefaultResultOrder('verbatim');

// https://vitejs.dev/config/
export default defineConfig(() => {
  // package.json is the ONLY version source: expose it as
  // import.meta.env.PACKAGE_VERSION so the Sidebar + Settings "About" line
  // render the real app version (previously the define was missing entirely,
  // so the UI showed "August v" with no number).
  let pkgVersion = '0.0.0';
  try {
    pkgVersion = (JSON.parse(readFileSync(`${process.cwd()}/package.json`, 'utf8')) as { version?: string }).version || pkgVersion;
  } catch { /* build-time only; leave the placeholder */ }
  return {
    base: './', // Crucial: relative paths for Electron
    define: {
      'import.meta.env.PACKAGE_VERSION': JSON.stringify(pkgVersion),
    },
    plugins: [sharedProviderPolicyEsmInterop(), react(), tailwindcss(), devProviderProxy()],
    resolve: {
      alias: {
        '@': `${process.cwd()}/src`,
      },
    },
    server: {
      // Keep the unauthenticated development proxy local to this machine.
      host: '127.0.0.1',
      port: 3000,
      watch: {
        // Windows: a PDF opened by another app (reader/Explorer preview/
        // antivirus) locks the file, and chokidar crashes the whole dev
        // server with EBUSY trying to watch it (seen with the strategy PDFs
        // in "Pdf's Strategies"). PDFs are never HMR inputs — never watch
        // them. The globs keep Vite's default ignores (they are replaced,
        // not merged, when `ignored` is set).
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          (path: string) => path.toLowerCase().endsWith('.pdf') || path.includes("Pdf's Strategies"),
        ],
      },
      // Development assets must never be served from a stale browser cache.
      // Vite HMR remains responsible for live updates while this also makes
      // hard refreshes reliably pick up the current source.
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    },
    build: {
      sourcemap: false,
      rollupOptions: {
        external: ['protobufjs/minimal.js'],
        output: {
          // Function-form manualChunks: the string form only matched the
          // package root, so `react-dom/client` (and react-dom's other
          // subpaths) escaped the vendor chunk and got hoisted into index —
          // the exact shared-module problem the old comment described.
          manualChunks(id) {
            // Package-precise match: a bare `node_modules/react` substring
            // also catches react-markdown / react-virtuoso / react-* cousins
            // and drags them into the eager vendor chunk. Match the package
            // dir boundary instead.
            //
            // react-virtuoso was re-added to this chunk by hand after that
            // boundary fix, which undid it for exactly one dependency: its
            // ONLY importer app-wide is src/components/journal/TradeLog.tsx,
            // reached through the lazy Journal surface — so ~150 KB of a
            // screen that is not open at boot sat in the modulepreloaded
            // eager set. Recharts has the same react dependency and is not
            // force-grouped, so the graph is proven fine without it.
            if (/node_modules\/(?:react|react-dom|scheduler)(?:\/|$)/.test(id)) {
              return 'vendor-react';
            }
            if (id.includes('node_modules/openai')) return 'vendor-ai';
            if (id.includes('node_modules/technicalindicators')) return 'vendor-crypto';
            // zod is imported eagerly by the schema boundaries, but it changes
            // rarely — its own chunk keeps it out of the app-code hash so
            // schema tweaks don't invalidate the cached parsing bytes.
            if (id.includes('node_modules/zod')) return 'vendor-parsing';
            // NOTE: recharts + lightweight-charts intentionally have NO manual
            // chunk. A fixed 'vendor-charts' entry made rollup link the charts
            // chunk into vendor-react (shared-module hoisting), which put a
            // 363KB static import into the startup module graph and preloaded
            // it on every launch even though charts are only reachable through
            // lazy components (Journal, LiveMarket, VersionHistoryDashboard).
            // Without the entry they stay in their lazy consumer chunks.
            return undefined;
          },
        },
      },
    },
  };
});
