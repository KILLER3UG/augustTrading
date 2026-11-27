/**
 * ProviderHealthService — in-memory health telemetry for configured providers.
 *
 * Records per-provider call counts, latency and last errors so the Settings
 * provider list can show a live health view (and a Test button). Purely
 * additive instrumentation — it never throws into the provider path.
 *
 * Cooldown (opengrok F11): a provider that keeps failing PERSISTED requests
 * is benched for a window instead of burning a seat on every run. Only
 * PERSISTED errors count — the transports retry transient blips FIRST (the
 * 10-retry automatic 429/upstream/5xx recovery in `retryPolicyCore` +
 * `withRetry`/`withStreamOpenRetry`), and an error is recorded here only
 * after that budget is exhausted, never while retries are still in
 * progress — a rate-limited gateway under backoff is NOT a benched
 * provider. 3+ persisted errors within 15 minutes → 10-minute cooldown,
 * cleared by the next success.
 *
 * Scope ruling: the bench is IN-MEMORY by design — it is a
 * live-run circuit breaker, not durable state; an app restart clears it
 * (the errors that caused it are gone too). A success clearing the whole
 * window is likewise intentional: a provider that answers one request
 * correctly is not benched, even if it flaps.
 */

export interface ProviderHealth {
  providerId: string;
  requestCount: number;
  /** Successes ONLY — the denominator behind avgLatencyMs. requestCount
   *  counts errors too, and errors carry no latency: averaging over it
   *  pulled the mean toward 0 as failures accumulated. */
  successCount?: number;
  errorCount: number;
  rateLimitCount: number;
  lastError?: string;
  lastSuccessAt?: string;
  lastLatencyMs?: number;
  avgLatencyMs?: number;
  lastCheckedAt?: string;
  /** Timestamps of persisted errors inside the rolling window. */
  recentErrorAts?: string[];
}

/** Cooldown law: ≥3 persisted errors inside the window → benched for COOLDOWN. */
export const COOLDOWN_ERROR_THRESHOLD = 3;
export const COOLDOWN_WINDOW_MS = 15 * 60 * 1000;
export const COOLDOWN_DURATION_MS = 10 * 60 * 1000;

const health = new Map<string, ProviderHealth>();

const entryFor = (providerId: string): ProviderHealth => {
  let entry = health.get(providerId);
  if (!entry) {
    entry = { providerId, requestCount: 0, errorCount: 0, rateLimitCount: 0, recentErrorAts: [] };
    health.set(providerId, entry);
  }
  return entry;
};

/** Drop window-expired error timestamps (mutates the entry's array). */
const pruneErrors = (entry: ProviderHealth, now = Date.now()): void => {
  if (!entry.recentErrorAts) entry.recentErrorAts = [];
  entry.recentErrorAts = entry.recentErrorAts.filter(
    ts => now - Date.parse(ts) < COOLDOWN_WINDOW_MS,
  );
};

export const recordProviderSuccess = (providerId: string, latencyMs: number): void => {
  const entry = entryFor(providerId);
  entry.requestCount++;
  entry.lastSuccessAt = new Date().toISOString();
  entry.lastLatencyMs = latencyMs;
  // The running average is over SUCCESSFUL requests only: errors increment
  // requestCount (and never a latency sample), so folding them into the
  // denominator silently dragged avgLatencyMs toward 0 as failures piled up.
  const successes = (entry.successCount ?? 0) + 1;
  entry.successCount = successes;
  entry.avgLatencyMs = successes === 1
    ? latencyMs
    : Math.round(((entry.avgLatencyMs ?? latencyMs) * (successes - 1) + latencyMs) / successes);
  entry.lastCheckedAt = new Date().toISOString();
  // A success proves the provider is back — clear the cooldown path.
  entry.recentErrorAts = [];
};

export const recordProviderError = (providerId: string, error: unknown): void => {
  const entry = entryFor(providerId);
  entry.requestCount++;
  entry.errorCount++;
  entry.lastCheckedAt = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  entry.lastError = message.slice(0, 200);
  if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
    entry.rateLimitCount++;
  }
  // Cooldown substrate only counts errors that survived the transports'
  // own retries (persisted at this layer).
  pruneErrors(entry);
  entry.recentErrorAts!.push(new Date().toISOString());
};

/**
 * Whether the provider is benched: ≥ COOLDOWN_ERROR_THRESHOLD persisted
 * errors in the last COOLDOWN_WINDOW_MS, and the bench window (starting at
 * the most recent error) has not elapsed. Consulted at roster build so a
 * failing provider loses its seat instead of sabotaging runs.
 */
export const isProviderOnCooldown = (providerId: string, now = Date.now()): boolean => {
  const entry = health.get(providerId);
  if (!entry) return false;
  pruneErrors(entry, now);
  if ((entry.recentErrorAts?.length ?? 0) < COOLDOWN_ERROR_THRESHOLD) return false;
  const lastErrorAt = Date.parse(entry.recentErrorAts![entry.recentErrorAts!.length - 1]);
  return now - lastErrorAt < COOLDOWN_DURATION_MS;
};

/** Remaining cooldown milliseconds (0 when not benched). */
export const providerCooldownRemainingMs = (providerId: string, now = Date.now()): number => {
  const entry = health.get(providerId);
  if (!entry) return 0;
  pruneErrors(entry, now);
  if ((entry.recentErrorAts?.length ?? 0) < COOLDOWN_ERROR_THRESHOLD) return 0;
  const lastErrorAt = Date.parse(entry.recentErrorAts![entry.recentErrorAts!.length - 1]);
  const elapsed = now - lastErrorAt;
  return elapsed < COOLDOWN_DURATION_MS ? COOLDOWN_DURATION_MS - elapsed : 0;
};

export const getProviderHealth = (providerId: string): ProviderHealth | undefined => health.get(providerId);

export const getAllProviderHealth = (): ProviderHealth[] => [...health.values()];

export const resetProviderHealth = (providerId?: string): void => {
  if (providerId) health.delete(providerId);
  else health.clear();
};
