import { DurableObject } from "cloudflare:workers";
import { resolveConfig, type EnvOverrides, type GatewayConfig } from "./config";
import { handleChat, type EdgeCache } from "./gateway";
import { MetricsAggregator } from "./metrics";
import { mockFetchFromUrl } from "./mockUpstream";
import { takeToken, type BucketState } from "./tokenBucket";
import { BreakerRegistry, type UpstreamResult } from "./upstream";
import type { CachedEntry, LogEvent } from "./types";

export interface Env extends EnvOverrides {
  RATE_LIMITER: DurableObjectNamespace<RateLimiterDO>;
  METRICS: DurableObjectNamespace<MetricsDO>;
  [secret: string]: unknown;
}

export class RateLimiterDO extends DurableObject<Env> {
  private bucket?: BucketState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.bucket = await ctx.storage.get<BucketState>("bucket");
    });
  }

  async take(capacity: number, refillPerSecond: number) {
    const r = takeToken(this.bucket, Date.now(), { capacity, refillPerSecond });
    this.bucket = r.state;
    this.ctx.storage.put("bucket", r.state);
    return { allowed: r.allowed, remaining: r.remaining, retryAfterSeconds: r.retryAfterSeconds };
  }
}

/** Single global aggregator: fine for a demo, a hotspot at real scale (see README). */
export class MetricsDO extends DurableObject<Env> {
  private agg = new MetricsAggregator();
  async record(e: LogEvent) {
    this.agg.record(e);
  }
  async snapshot() {
    return this.agg.snapshot();
  }
  async logs(limit: number) {
    return this.agg.recentLogs(limit);
  }
  async reset() {
    this.agg = new MetricsAggregator();
  }
}

const CACHE_ORIGIN = "https://edge-ai-gateway.internal/v1/cache/";

export const cacheApiStore: EdgeCache = {
  async get(key) {
    const res = await caches.default.match(new Request(CACHE_ORIGIN + key));
    if (!res) return null;
    return {
      status: res.status,
      body: await res.text(),
      provider: res.headers.get("x-gw-provider") ?? "unknown",
      storedAt: Number(res.headers.get("x-gw-stored-at") ?? 0),
    } satisfies CachedEntry;
  },
  async put(key, entry, storeForSeconds) {
    await caches.default.put(
      new Request(CACHE_ORIGIN + key),
      new Response(entry.body, {
        status: entry.status,
        headers: {
          "content-type": "application/json",
          "cache-control": `s-maxage=${storeForSeconds}`,
          "x-gw-provider": entry.provider,
          "x-gw-stored-at": String(entry.storedAt),
        },
      }),
    );
  },
};

let breakers: BreakerRegistry | undefined;
const inflight = new Map<string, Promise<UpstreamResult>>();

function metricsStub(env: Env) {
  return env.METRICS.getByName("global");
}

async function route(req: Request, env: Env, ctx: ExecutionContext, config: GatewayConfig): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/v1/chat/completions" && req.method === "POST") {
    breakers ??= new BreakerRegistry(config.circuitBreaker);
    return handleChat(req, {
      config,
      cache: cacheApiStore,
      limiter: {
        take: (tenant) => env.RATE_LIMITER.getByName(tenant).take(config.rateLimit.capacity, config.rateLimit.refillPerSecond),
      },
      fetchImpl: (u, init) => (u.startsWith("mock://") ? mockFetchFromUrl(u, init) : fetch(u, init)),
      breakers,
      inflight,
      now: () => Date.now(),
      waitUntil: (p) => ctx.waitUntil(p),
      emit: (e) => {
        console.log(JSON.stringify(e));
        ctx.waitUntil(metricsStub(env).record(e));
      },
      headersFor: (u): Record<string, string> => {
        const secret = u.apiKeyEnv ? env[u.apiKeyEnv] : undefined;
        return typeof secret === "string" ? { authorization: `Bearer ${secret}` } : {};
      },
    });
  }
  if (path === "/metrics" && req.method === "GET") return Response.json(await metricsStub(env).snapshot());
  if (path === "/admin/logs" && req.method === "GET") {
    const raw = Number(url.searchParams.get("limit"));
    const limit = Number.isInteger(raw) && raw > 0 ? raw : 5000;
    const lines = (await metricsStub(env).logs(limit)).map((e) => JSON.stringify(e)).join("\n");
    return new Response(lines, { headers: { "content-type": "application/x-ndjson" } });
  }
  if (path === "/admin/reset" && req.method === "POST") {
    await metricsStub(env).reset();
    return Response.json({ ok: true });
  }
  if (path === "/admin/purge" && req.method === "POST") {
    const { key } = ((await req.json().catch(() => ({}))) ?? {}) as { key?: string };
    if (!key || !/^[0-9a-f]{64}$/.test(key)) return Response.json({ error: "key must be a 64-char hex cache key" }, { status: 400 });
    const deleted = await caches.default.delete(new Request(CACHE_ORIGIN + key));
    return Response.json({ deleted, scope: "this PoP only" });
  }
  if (path === "/healthz") {
    return Response.json({
      ok: true,
      upstreams: config.upstreams.map((u) => ({ name: u.name, enabled: u.enabled })),
      fallback: config.fallback.enabled,
    });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

export default {
  fetch(req, env, ctx) {
    return route(req, env, ctx, resolveConfig(env));
  },
} satisfies ExportedHandler<Env>;
