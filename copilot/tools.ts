import type { GatewayConfig } from "../src/config";
import { percentile } from "../src/metrics";
import type { LogEvent } from "../src/types";

export interface ToolContext {
  logs: LogEvent[];
  config: GatewayConfig;
}

export interface Tool<A = Record<string, unknown>, R = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(ctx: ToolContext, args: A): R;
}

const isLookup = (e: LogEvent) => e.cache === "HIT" || e.cache === "STALE" || e.cache === "MISS";
const isHit = (e: LogEvent) => e.cache === "HIT" || e.cache === "STALE";
const ratio = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 1000) / 1000);
const roundMs = (x: number | null) => (x === null ? null : Math.round(x));
const median = (xs: number[]) => percentile([...xs].sort((a, b) => a - b), 50);

function countBy<T>(xs: T[], f: (x: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) {
    const k = f(x);
    if (k !== undefined) out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function halves(logs: LogEvent[], splitTs?: number) {
  if (logs.length === 0) return { before: [], after: [] };
  const t0 = logs[0].ts;
  const t1 = logs[logs.length - 1].ts;
  const split = splitTs ?? t0 + (t1 - t0) / 2;
  return { before: logs.filter((e) => e.ts < split), after: logs.filter((e) => e.ts >= split) };
}

export interface CacheOverview {
  requests: number;
  by_cache: Record<string, number>;
  hit_ratio: number | null;
  bypass_share_before: number | null;
  bypass_share_after: number | null;
  bypass_reasons_after: Record<string, number>;
  top_bypass_tenant_share: number | null;
}

export const cacheOverview: Tool<{}, CacheOverview> = {
  name: "cache_overview",
  description: "Counts requests by cache status (HIT/STALE/MISS/BYPASS/NONE), overall hit ratio, and how the BYPASS share and its reasons changed between the first and second half of the log window.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  run({ logs }) {
    const lookups = logs.filter(isLookup);
    const { before, after } = halves(logs);
    const bypassAfter = after.filter((e) => e.cache === "BYPASS");
    const byTenant = countBy(bypassAfter, (e) => e.key_hash);
    const top = Math.max(0, ...Object.values(byTenant));
    return {
      requests: logs.length,
      by_cache: countBy(logs, (e) => e.cache),
      hit_ratio: ratio(lookups.filter(isHit).length, lookups.length),
      bypass_share_before: ratio(before.filter((e) => e.cache === "BYPASS").length, before.length),
      bypass_share_after: ratio(bypassAfter.length, after.length),
      bypass_reasons_after: countBy(bypassAfter, (e) => e.cache_reason),
      top_bypass_tenant_share: ratio(top, bypassAfter.length),
    };
  },
};

export interface HitRatioWindows {
  window_s: number;
  series: { start: number; lookups: number; hit_ratio: number | null }[];
  baseline: number | null;
  recent: number | null;
  drop: number | null;
  change_point_ts: number | null;
}

export const hitRatioWindows: Tool<{ windowSeconds?: number }, HitRatioWindows> = {
  name: "hit_ratio_windows",
  description: "Hit ratio per time window. Baseline = first quarter of windows, recent = last quarter; reports the drop and the first window that fell 20+ points below baseline (change point).",
  inputSchema: { type: "object", properties: { windowSeconds: { type: "number" } }, additionalProperties: false },
  run({ logs }, { windowSeconds = 60 }) {
    const lookups = logs.filter(isLookup);
    if (lookups.length === 0) return { window_s: windowSeconds, series: [], baseline: null, recent: null, drop: null, change_point_ts: null };
    const t0 = lookups[0].ts;
    const buckets = new Map<number, LogEvent[]>();
    for (const e of lookups) {
      const b = Math.floor((e.ts - t0) / (windowSeconds * 1000));
      (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(e);
    }
    const series = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([b, es]) => ({ start: t0 + b * windowSeconds * 1000, lookups: es.length, hit_ratio: ratio(es.filter(isHit).length, es.length) }));
    const q = Math.max(1, Math.floor(series.length / 4));
    const pooled = (s: typeof series) => {
      const n = s.reduce((a, x) => a + x.lookups, 0);
      const h = s.reduce((a, x) => a + (x.hit_ratio ?? 0) * x.lookups, 0);
      return ratio(h, n);
    };
    const baseline = pooled(series.slice(0, q));
    const recent = pooled(series.slice(-q));
    const cp = baseline === null ? undefined : series.find((s) => s.hit_ratio !== null && s.hit_ratio < baseline - 0.2);
    return {
      window_s: windowSeconds,
      series,
      baseline,
      recent,
      drop: baseline !== null && recent !== null ? Math.round((baseline - recent) * 1000) / 1000 : null,
      change_point_ts: cp?.start ?? null,
    };
  },
};

export interface FieldCardinality {
  since_ts: number | null;
  lookups: number;
  keys_per_prompt: number | null;
  distinct_prompt_ratio_before: number | null;
  distinct_prompt_ratio_after: number | null;
  fields: { field: string; values_per_prompt: number; new_since_change: boolean }[];
  offenders: string[];
}

export const cacheKeyCardinality: Tool<{ sinceTs?: number }, FieldCardinality> = {
  name: "cache_key_cardinality",
  description: "For cacheable lookups, groups requests by (tenant, prompt hash) and measures how many distinct values each request field takes per prompt. A non-message field whose fan-out explains the number of cache keys per prompt is busting the cache.",
  inputSchema: { type: "object", properties: { sinceTs: { type: "number" } }, additionalProperties: false },
  run({ logs }, { sinceTs }) {
    const all = logs.filter((e) => isLookup(e) && e.field_hashes);
    const { before, after } = halves(all, sinceTs);
    const groups = new Map<string, LogEvent[]>();
    for (const e of after) {
      const g = `${e.key_hash}:${e.prompt_hash}`;
      (groups.get(g) ?? groups.set(g, []).get(g)!).push(e);
    }
    const repeated = [...groups.values()].filter((g) => g.length >= 2);
    const fieldsBefore = new Set(before.flatMap((e) => Object.keys(e.field_hashes!)));
    const fieldNames = [...new Set(after.flatMap((e) => Object.keys(e.field_hashes!)))].filter((f) => f !== "messages");
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const keysPerPrompt = repeated.length ? mean(repeated.map((g) => new Set(g.map((e) => e.cache_key)).size)) : null;
    const fields = fieldNames
      .map((field) => ({
        field,
        values_per_prompt: Math.round(mean(repeated.map((g) => new Set(g.map((e) => e.field_hashes![field] ?? "-")).size)) * 100) / 100,
        new_since_change: !fieldsBefore.has(field) && before.length > 0,
      }))
      .sort((a, b) => b.values_per_prompt - a.values_per_prompt);
    const offenders =
      keysPerPrompt !== null && keysPerPrompt > 1.5
        ? fields.filter((f) => f.values_per_prompt > 1.5 && f.values_per_prompt >= 0.8 * keysPerPrompt).map((f) => f.field)
        : [];
    const dpr = (es: LogEvent[]) => ratio(new Set(es.map((e) => `${e.key_hash}:${e.prompt_hash}`)).size, es.length);
    return {
      since_ts: sinceTs ?? null,
      lookups: after.length,
      keys_per_prompt: keysPerPrompt === null ? null : Math.round(keysPerPrompt * 100) / 100,
      distinct_prompt_ratio_before: dpr(before),
      distinct_prompt_ratio_after: dpr(after),
      fields,
      offenders,
    };
  },
};

export interface TtlChurn {
  ttl_s: number;
  lookups: number;
  misses: number;
  re_misses: number;
  re_miss_share_of_lookups: number | null;
  median_re_miss_gap_s: number | null;
}

export const ttlChurn: Tool<{ sinceTs?: number }, TtlChurn> = {
  name: "ttl_churn",
  description: "Counts misses on cache keys that were already fetched earlier (entry expired and had to be refetched), and the median gap between refetches, compared with the configured TTL.",
  inputSchema: { type: "object", properties: { sinceTs: { type: "number" } }, additionalProperties: false },
  run({ logs, config }, { sinceTs }) {
    const lastFill = new Map<string, number>();
    const gaps: number[] = [];
    let lookups = 0;
    let misses = 0;
    for (const e of logs.filter(isLookup)) {
      const counted = sinceTs === undefined || e.ts >= sinceTs;
      if (counted) lookups++;
      if (e.cache !== "MISS" || !e.cache_key) continue;
      if (counted) misses++;
      const prev = lastFill.get(e.cache_key);
      if (prev !== undefined && counted) gaps.push((e.ts - prev) / 1000);
      lastFill.set(e.cache_key, e.ts);
    }
    const m = median(gaps);
    return {
      ttl_s: config.cache.ttlSeconds,
      lookups,
      misses,
      re_misses: gaps.length,
      re_miss_share_of_lookups: ratio(gaps.length, lookups),
      median_re_miss_gap_s: m === null ? null : Math.round(m * 10) / 10,
    };
  },
};

export interface ProviderHealth {
  providers: Record<
    string,
    {
      attempts: number;
      outcomes: Record<string, number>;
      error_rate: number | null;
      timeout_rate: number | null;
      peak_window_error_rate: number | null;
      success_p50_ms: number | null;
      success_p95_ms: number | null;
      timeout_ms: number | null;
    }
  >;
  fallback_share: number | null;
  failed_requests: number;
}

export const providerHealth: Tool<{ windowSeconds?: number }, ProviderHealth> = {
  name: "provider_health",
  description: "Per upstream provider: attempts, outcome counts (ok/5xx/429/timeout/network/circuit_open), error and timeout rates, peak error rate in any time window, success latency p50/p95 vs the configured timeout; plus share of requests that needed fallback.",
  inputSchema: { type: "object", properties: { windowSeconds: { type: "number" } }, additionalProperties: false },
  run({ logs, config }, { windowSeconds = 60 }) {
    const providers: ProviderHealth["providers"] = {};
    const attempts = logs.flatMap((e) => (e.attempts ?? []).map((a) => ({ ...a, ts: e.ts })));
    const t0 = logs[0]?.ts ?? 0;
    for (const name of new Set(attempts.map((a) => a.provider))) {
      const real = attempts.filter((a) => a.provider === name && a.outcome !== "circuit_open");
      const isErr = (o: string) => o === "5xx" || o === "429" || o === "network" || o === "timeout";
      const errs = real.filter((a) => isErr(a.outcome));
      const ok = real.filter((a) => a.outcome === "ok").map((a) => a.latency_ms).sort((a, b) => a - b);
      const windows = new Map<number, { n: number; e: number }>();
      for (const a of real) {
        const w = Math.floor((a.ts - t0) / (windowSeconds * 1000));
        const cur = windows.get(w) ?? { n: 0, e: 0 };
        cur.n++;
        if (isErr(a.outcome)) cur.e++;
        windows.set(w, cur);
      }
      const peak = Math.max(0, ...[...windows.values()].filter((w) => w.n >= 10).map((w) => w.e / w.n));
      providers[name] = {
        attempts: real.length,
        outcomes: countBy(attempts.filter((a) => a.provider === name), (a) => a.outcome),
        error_rate: ratio(errs.length, real.length),
        timeout_rate: ratio(real.filter((a) => a.outcome === "timeout").length, real.length),
        peak_window_error_rate: Math.round(peak * 1000) / 1000,
        success_p50_ms: roundMs(percentile(ok, 50)),
        success_p95_ms: roundMs(percentile(ok, 95)),
        timeout_ms: config.upstreams.find((u) => u.name === name)?.timeoutMs ?? null,
      };
    }
    const upstreamRequests = logs.filter((e) => (e.attempts ?? []).length > 0);
    return {
      providers,
      fallback_share: ratio(logs.filter((e) => e.fallback).length, upstreamRequests.length),
      failed_requests: logs.filter((e) => e.status >= 500).length,
    };
  },
};

export interface RateLimitHotKeys {
  requests: number;
  rate_limited: number;
  rate_limited_share: number | null;
  active_keys: number;
  keys_limited: number;
  top_keys: { key_hash: string; requests: number; rate_limited: number; share_of_429s: number | null; peak_rps: number }[];
  config: { capacity: number; refillPerSecond: number };
}

export const rateLimitHotKeys: Tool<{ top?: number }, RateLimitHotKeys> = {
  name: "rate_limit_hot_keys",
  description: "429 counts overall and per API key hash: which keys are limited, their share of all 429s, request volume and peak per-second rate, compared with the configured token bucket.",
  inputSchema: { type: "object", properties: { top: { type: "number" } }, additionalProperties: false },
  run({ logs, config }, { top = 5 }) {
    const limited = logs.filter((e) => e.status === 429 && e.cache === "NONE");
    const byKey = new Map<string, LogEvent[]>();
    for (const e of logs) (byKey.get(e.key_hash) ?? byKey.set(e.key_hash, []).get(e.key_hash)!).push(e);
    const rows = [...byKey.entries()].map(([key_hash, es]) => {
      const perSecond = countBy(es, (e) => String(Math.floor(e.ts / 1000)));
      const rl = es.filter((e) => e.status === 429 && e.cache === "NONE").length;
      return { key_hash, requests: es.length, rate_limited: rl, share_of_429s: ratio(rl, limited.length), peak_rps: Math.max(0, ...Object.values(perSecond)) };
    });
    rows.sort((a, b) => b.rate_limited - a.rate_limited || b.requests - a.requests);
    return {
      requests: logs.length,
      rate_limited: limited.length,
      rate_limited_share: ratio(limited.length, logs.length),
      active_keys: byKey.size,
      keys_limited: rows.filter((r) => r.rate_limited > 0).length,
      top_keys: rows.slice(0, top),
      config: { ...config.rateLimit },
    };
  },
};

export const TOOLS = [cacheOverview, hitRatioWindows, cacheKeyCardinality, ttlChurn, providerHealth, rateLimitHotKeys] as Tool<any, any>[];
