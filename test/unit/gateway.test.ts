import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type GatewayConfig } from "../../src/config";
import { handleChat, type EdgeCache } from "../../src/gateway";
import { mockFetchFromUrl } from "../../src/mockUpstream";
import { takeToken, type BucketState } from "../../src/tokenBucket";
import { BreakerRegistry, type FetchLike } from "../../src/upstream";
import type { CachedEntry, LogEvent } from "../../src/types";

function setup(overrides: (c: GatewayConfig) => void = () => {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstreams[0].url = "mock://primary?latencyMs=1";
  config.upstreams[1].url = "mock://secondary?latencyMs=1";
  overrides(config);
  let clock = 1_000_000;
  const store = new Map<string, CachedEntry>();
  const buckets = new Map<string, BucketState>();
  const pending: Promise<unknown>[] = [];
  const logs: LogEvent[] = [];
  let upstreamCalls = 0;
  const cache: EdgeCache = {
    get: async (k) => store.get(k) ?? null,
    put: async (k, e) => void store.set(k, e),
  };
  const fetchImpl: FetchLike = (u, init) => {
    upstreamCalls++;
    return mockFetchFromUrl(u, init);
  };
  const deps = {
    config,
    cache,
    limiter: {
      take: async (t: string) => {
        const r = takeToken(buckets.get(t), clock, config.rateLimit);
        buckets.set(t, r.state);
        return r;
      },
    },
    fetchImpl,
    breakers: new BreakerRegistry(config.circuitBreaker),
    inflight: new Map(),
    now: () => clock,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    emit: (e: LogEvent) => void logs.push(e),
  };
  const send = async (body: object, headers: Record<string, string> = {}, key = "sk-test") => {
    const res = await handleChat(
      new Request("https://gw/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, ...headers },
        body: JSON.stringify(body),
      }),
      deps,
    );
    await Promise.all(pending.splice(0));
    return res;
  };
  return {
    send,
    logs,
    advance: (ms: number) => (clock += ms),
    get upstreamCalls() {
      return upstreamCalls;
    },
  };
}

const prompt = { model: "m", temperature: 0, messages: [{ role: "user", content: "hello" }] };

describe("gateway caching (in-memory edge cache, fake clock)", () => {
  it("MISS then HIT with an age header; upstream called once", async () => {
    const g = setup();
    const a = await g.send(prompt);
    expect(a.headers.get("x-cache")).toBe("MISS");
    g.advance(7_000);
    const b = await g.send({ ...prompt, messages: [{ role: "user", content: "  hello  " }] });
    expect(b.headers.get("x-cache")).toBe("HIT");
    expect(b.headers.get("age")).toBe("7");
    expect(await b.json()).toEqual(await a.json());
    expect(g.upstreamCalls).toBe(1);
  });

  it("BYPASS for non-deterministic requests and for Cache-Control: no-store", async () => {
    const g = setup();
    const a = await g.send({ ...prompt, temperature: 0.8 });
    expect(a.headers.get("x-cache")).toBe("BYPASS");
    expect(a.headers.get("x-cache-reason")).toBe("nondeterministic");
    await g.send(prompt);
    const b = await g.send(prompt, { "cache-control": "no-store" });
    expect(b.headers.get("x-cache")).toBe("BYPASS");
    expect(g.upstreamCalls).toBe(3);
  });

  it("no-cache revalidates (skips the read, refreshes the entry)", async () => {
    const g = setup();
    await g.send(prompt);
    const r = await g.send(prompt, { "cache-control": "no-cache" });
    expect(r.headers.get("x-cache")).toBe("MISS");
    expect(g.logs.at(-1)?.cache_reason).toBe("no-cache");
  });

  it("client max-age rejects entries older than requested", async () => {
    const g = setup();
    await g.send(prompt);
    g.advance(20_000);
    expect((await g.send(prompt, { "cache-control": "max-age=60" })).headers.get("x-cache")).toBe("HIT");
    expect((await g.send(prompt, { "cache-control": "max-age=10" })).headers.get("x-cache")).toBe("MISS");
  });

  it("serves STALE inside the stale-while-revalidate window and refreshes in the background", async () => {
    const g = setup((c) => {
      c.cache.ttlSeconds = 10;
      c.cache.staleWhileRevalidateSeconds = 30;
    });
    await g.send(prompt);
    g.advance(15_000);
    const r = await g.send(prompt);
    expect(r.headers.get("x-cache")).toBe("STALE");
    expect(g.upstreamCalls).toBe(2);
    expect(g.logs.at(-1)).toMatchObject({ cache: "STALE", age_s: 15 });
    expect(g.logs.at(-1)?.attempts?.[0]).toMatchObject({ provider: "primary", outcome: "ok" });
    expect((await g.send(prompt)).headers.get("x-cache")).toBe("HIT");
    g.advance(60_000);
    expect((await g.send(prompt)).headers.get("x-cache")).toBe("MISS");
  });

  it("coalesces concurrent identical misses into one upstream call (origin shielding)", async () => {
    const g = setup();
    const results = await Promise.all([g.send(prompt), g.send(prompt), g.send(prompt)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(g.upstreamCalls).toBe(1);
    expect(g.logs.filter((l) => l.coalesced).length).toBe(2);
  });

  it("does not cache upstream failures", async () => {
    const g = setup((c) => {
      c.upstreams.forEach((u) => (u.url = `mock://${u.name}?latencyMs=1&failureRate=1`));
    });
    expect((await g.send(prompt)).status).toBe(502);
    expect((await g.send(prompt)).headers.get("x-cache")).toBe("MISS");
  });

  it("rate limits per key with 429 + retry-after, without affecting other keys", async () => {
    const g = setup((c) => (c.rateLimit = { capacity: 2, refillPerSecond: 0.5 }));
    await g.send(prompt, {}, "noisy");
    await g.send(prompt, {}, "noisy");
    const limited = await g.send(prompt, {}, "noisy");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("2");
    expect((await g.send(prompt, {}, "quiet")).status).toBe(200);
  });

  it("emits one structured log line per request with hashes, not prompt text", async () => {
    const g = setup();
    await g.send(prompt);
    expect(g.logs).toHaveLength(1);
    const line = JSON.stringify(g.logs[0]);
    expect(line).not.toContain("hello");
    expect(g.logs[0]).toMatchObject({ cache: "MISS", provider: "primary", status: 200, fallback: false });
    expect(g.logs[0].key_hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("rejects streaming and missing keys explicitly", async () => {
    const g = setup();
    expect((await g.send({ ...prompt, stream: true })).status).toBe(400);
    for (const bad of [null, [], "x", { messages: "hi" }]) expect((await g.send(bad as never)).status).toBe(400);
    const res = await handleChat(new Request("https://gw/v1/chat/completions", { method: "POST", body: "{}" }), { now: () => 0 } as never);
    expect(res.status).toBe(401);
  });
});
