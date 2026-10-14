import type { CacheStatus, LogEvent } from "./types";

const RING = 5000;

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95) };
}

export interface MetricsSnapshot {
  requests: number;
  by_cache: Record<CacheStatus, number>;
  hit_ratio: number | null;
  latency_ms: Partial<Record<CacheStatus, { n: number; p50: number | null; p95: number | null }>>;
  upstream_calls: number;
  upstream_calls_avoided: number;
  fallbacks: number;
  coalesced: number;
  errors_by_provider: Record<string, Record<string, number>>;
  status: Record<string, number>;
  rate_limited: number;
  window_note: string;
}

export class MetricsAggregator {
  private requests = 0;
  private byCache: Record<CacheStatus, number> = { HIT: 0, STALE: 0, MISS: 0, BYPASS: 0, NONE: 0 };
  private latencies: Partial<Record<CacheStatus, number[]>> = {};
  private upstreamCalls = 0;
  private avoided = 0;
  private fallbacks = 0;
  private coalesced = 0;
  private errors: Record<string, Record<string, number>> = {};
  private status: Record<string, number> = {};
  private rateLimited = 0;
  private log: LogEvent[] = [];

  record(e: LogEvent): void {
    this.requests++;
    this.byCache[e.cache]++;
    const arr = (this.latencies[e.cache] ??= []);
    arr.push(e.latency_ms);
    if (arr.length > RING) arr.shift();
    const realCalls = (e.attempts ?? []).filter((a) => a.outcome !== "circuit_open");
    this.upstreamCalls += realCalls.length;
    if ((e.cache === "HIT" || e.cache === "STALE" || e.coalesced) && realCalls.length === 0) this.avoided++;
    if (e.fallback) this.fallbacks++;
    if (e.coalesced) this.coalesced++;
    for (const a of e.attempts ?? []) {
      if (a.outcome === "ok" || a.outcome === "4xx") continue;
      const p = (this.errors[a.provider] ??= {});
      p[a.outcome] = (p[a.outcome] ?? 0) + 1;
    }
    this.status[String(e.status)] = (this.status[String(e.status)] ?? 0) + 1;
    if (e.status === 429 && e.cache === "NONE") this.rateLimited++;
    this.log.push(e);
    if (this.log.length > RING) this.log.shift();
  }

  snapshot(): MetricsSnapshot {
    const { HIT, STALE, MISS } = this.byCache;
    const lookups = HIT + STALE + MISS;
    const latency: MetricsSnapshot["latency_ms"] = {};
    for (const [k, v] of Object.entries(this.latencies)) latency[k as CacheStatus] = summarize(v);
    return {
      requests: this.requests,
      by_cache: { ...this.byCache },
      hit_ratio: lookups ? (HIT + STALE) / lookups : null,
      latency_ms: latency,
      upstream_calls: this.upstreamCalls,
      upstream_calls_avoided: this.avoided,
      fallbacks: this.fallbacks,
      coalesced: this.coalesced,
      errors_by_provider: structuredClone(this.errors),
      status: { ...this.status },
      rate_limited: this.rateLimited,
      window_note: `counters since last reset; latency percentiles over the last ${RING} requests per cache status`,
    };
  }

  recentLogs(limit = RING): LogEvent[] {
    return this.log.slice(-limit);
  }
}
