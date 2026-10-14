import { buildCacheKey, decideCaching, parseCacheControl, type ChatBody } from "./cacheKey";
import type { GatewayConfig, UpstreamConfig } from "./config";
import { shortHash } from "./hash";
import { callUpstreams, type BreakerRegistry, type FetchLike, type UpstreamResult } from "./upstream";
import type { CachedEntry, CacheStatus, LogEvent } from "./types";

export interface EdgeCache {
  get(key: string): Promise<CachedEntry | null>;
  put(key: string, entry: CachedEntry, storeForSeconds: number): Promise<void>;
}

export interface RateLimiter {
  take(tenant: string): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }>;
}

export interface GatewayDeps {
  config: GatewayConfig;
  cache: EdgeCache;
  limiter: RateLimiter;
  fetchImpl: FetchLike;
  breakers: BreakerRegistry;
  inflight: Map<string, Promise<UpstreamResult>>;
  now: () => number;
  waitUntil: (p: Promise<unknown>) => void;
  emit: (e: LogEvent) => void;
  headersFor?: (u: UpstreamConfig) => Record<string, string>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const apiError = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  json(status, { error: { type, message } }, headers);

function bearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;
  return req.headers.get("x-api-key");
}

export async function handleChat(req: Request, deps: GatewayDeps): Promise<Response> {
  const { config, now } = deps;
  const start = now();
  const apiKey = bearer(req);
  if (!apiKey) return apiError(401, "authentication_error", "Missing API key (Authorization: Bearer <key>)");
  const tenant = await shortHash(apiKey, 12);

  const base = { ts: start, key_hash: tenant, fallback: false };
  const finish = (res: Response, e: Omit<LogEvent, "ts" | "key_hash" | "fallback" | "status" | "latency_ms"> & { fallback?: boolean }) => {
    deps.emit({ ...base, ...e, status: res.status, latency_ms: now() - start });
    return res;
  };

  const rl = await deps.limiter.take(tenant);
  if (!rl.allowed) {
    return finish(
      apiError(429, "rate_limit_exceeded", "Too many requests for this key", {
        "retry-after": String(rl.retryAfterSeconds),
        "x-ratelimit-remaining": "0",
      }),
      { cache: "NONE", cache_reason: "rate_limited" },
    );
  }

  const bodyText = await req.text();
  let body: ChatBody;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return finish(apiError(400, "invalid_request_error", "Body must be JSON"), { cache: "NONE", cache_reason: "bad_request" });
  }
  if (!Array.isArray(body.messages)) {
    return finish(apiError(400, "invalid_request_error", "`messages` must be an array"), { cache: "NONE", cache_reason: "bad_request" });
  }
  if (body.stream === true) {
    return finish(apiError(400, "invalid_request_error", "Streaming is not supported by this gateway"), { cache: "NONE", cache_reason: "stream" });
  }

  const rlHeaders = { "x-ratelimit-remaining": String(rl.remaining) };
  const decision = decideCaching(body, parseCacheControl(req.headers.get("cache-control")), config.cache);
  const callOpts = {
    fetchImpl: deps.fetchImpl,
    breakers: deps.breakers,
    now,
    fallbackEnabled: config.fallback.enabled,
    headersFor: deps.headersFor,
  };

  const respond = (r: UpstreamResult, cache: CacheStatus, extra: Record<string, string>) =>
    json(r.status, r.body, {
      "x-cache": cache,
      ...(r.provider ? { "x-gateway-provider": r.provider } : {}),
      ...rlHeaders,
      ...extra,
    });

  if (!decision.cacheable) {
    const r = await callUpstreams(bodyText, config.upstreams, callOpts);
    return finish(respond(r, "BYPASS", { "x-cache-reason": decision.reason }), {
      cache: "BYPASS",
      cache_reason: decision.reason,
      provider: r.provider,
      attempts: r.attempts,
      fallback: r.attempts.length > 1,
    });
  }

  const { key, promptHash, fieldHashes } = await buildCacheKey(body, config.cache, tenant);
  const ttl = config.cache.ttlSeconds;
  const swr = config.cache.staleWhileRevalidateSeconds;
  const keyInfo = { cache_key: key.slice(0, 16), prompt_hash: promptHash, field_hashes: fieldHashes, ttl_s: ttl };

  const fetchAndStore = (): { promise: Promise<UpstreamResult>; coalesced: boolean } => {
    const existing = deps.inflight.get(key);
    if (existing) return { promise: existing, coalesced: true };
    const promise = callUpstreams(bodyText, config.upstreams, callOpts);
    deps.inflight.set(key, promise);
    deps.waitUntil(
      promise
        .then((r) =>
          r.status === 200 && r.provider
            ? deps.cache.put(key, { status: 200, body: r.body, provider: r.provider, storedAt: now() }, ttl + swr)
            : undefined,
        )
        .catch(() => undefined)
        .finally(() => deps.inflight.delete(key)),
    );
    return { promise, coalesced: false };
  };

  let missReason: string | undefined = decision.read ? undefined : "no-cache";
  if (decision.read) {
    const entry = await deps.cache.get(key);
    if (entry) {
      const ageS = Math.max(0, Math.floor((now() - entry.storedAt) / 1000));
      const r: UpstreamResult = { status: entry.status, body: entry.body, provider: entry.provider, attempts: [] };
      const headers = { age: String(ageS), "x-cache-key": key };
      if (decision.maxAgeSeconds !== undefined && ageS > decision.maxAgeSeconds) {
        missReason = "client-max-age";
      } else if (ageS <= ttl) {
        return finish(respond(r, "HIT", headers), { cache: "HIT", age_s: ageS, provider: entry.provider, ...keyInfo });
      } else if (ageS <= ttl + swr) {
        const refresh = fetchAndStore();
        deps.waitUntil(refresh.promise.catch(() => undefined));
        return finish(respond(r, "STALE", headers), { cache: "STALE", age_s: ageS, provider: entry.provider, ...keyInfo });
      } else {
        missReason = "expired";
      }
    }
  }

  const { promise, coalesced } = fetchAndStore();
  const r = await promise;
  return finish(respond(r, "MISS", { "x-cache-key": key, ...(coalesced ? { "x-coalesced": "1" } : {}) }), {
    cache: "MISS",
    cache_reason: missReason,
    provider: r.provider,
    attempts: coalesced ? [] : r.attempts,
    fallback: !coalesced && r.attempts.length > 1,
    coalesced: coalesced || undefined,
    ...keyInfo,
  });
}
