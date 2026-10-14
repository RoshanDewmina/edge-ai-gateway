export type CacheStatus = "HIT" | "STALE" | "MISS" | "BYPASS" | "NONE";

export type AttemptOutcome = "ok" | "5xx" | "429" | "timeout" | "network" | "4xx" | "circuit_open";

export interface Attempt {
  provider: string;
  outcome: AttemptOutcome;
  status?: number;
  latency_ms: number;
}

/** One structured log line per request. Contains hashes only, never prompt text. */
export interface LogEvent {
  ts: number;
  key_hash: string;
  cache: CacheStatus;
  cache_reason?: string;
  cache_key?: string;
  prompt_hash?: string;
  field_hashes?: Record<string, string>;
  ttl_s?: number;
  age_s?: number;
  coalesced?: boolean;
  provider?: string;
  attempts?: Attempt[];
  fallback: boolean;
  status: number;
  latency_ms: number;
}

export interface CachedEntry {
  status: number;
  body: string;
  provider: string;
  storedAt: number;
}
