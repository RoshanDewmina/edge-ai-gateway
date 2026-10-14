import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../../src/circuitBreaker";
import { takeToken } from "../../src/tokenBucket";
import { BreakerRegistry, callUpstreams, type FetchLike } from "../../src/upstream";
import type { UpstreamConfig } from "../../src/config";

describe("token bucket", () => {
  const cfg = { capacity: 3, refillPerSecond: 1 };

  it("allows a burst up to capacity, then rejects with retry-after", () => {
    let s;
    for (let i = 0; i < 3; i++) {
      const r = takeToken(s, 0, cfg);
      expect(r.allowed).toBe(true);
      s = r.state;
    }
    const denied = takeToken(s, 0, cfg);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(1);
  });

  it("refills over time but never above capacity", () => {
    const empty = { tokens: 0, updatedAt: 0 };
    expect(takeToken(empty, 500, cfg).allowed).toBe(false);
    expect(takeToken(empty, 1000, cfg).allowed).toBe(true);
    expect(takeToken(empty, 60_000, cfg).remaining).toBe(2);
  });
});

describe("circuit breaker", () => {
  it("opens after N consecutive failures, half-opens after cooldown, closes on success", () => {
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    for (let i = 0; i < 3; i++) b.onFailure(0);
    expect(b.state).toBe("open");
    expect(b.canRequest(500)).toBe(false);
    expect(b.canRequest(1000)).toBe(true);
    expect(b.state).toBe("half-open");
    expect(b.canRequest(1001)).toBe(false);
    b.onSuccess();
    expect(b.state).toBe("closed");
  });

  it("re-opens immediately if the half-open trial fails", () => {
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    for (let i = 0; i < 3; i++) b.onFailure(0);
    b.canRequest(1000);
    b.onFailure(1000);
    expect(b.state).toBe("open");
    expect(b.canRequest(1500)).toBe(false);
  });

  it("a success resets the consecutive failure count", () => {
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    b.onFailure(0);
    b.onFailure(0);
    b.onSuccess();
    b.onFailure(0);
    expect(b.state).toBe("closed");
  });
});

describe("upstream fallback", () => {
  const ups: UpstreamConfig[] = [
    { name: "primary", url: "http://primary", timeoutMs: 50, enabled: true },
    { name: "secondary", url: "http://secondary", timeoutMs: 50, enabled: true },
  ];
  const ok = () => Response.json({ ok: true });
  const mkFetch = (behaviour: Record<string, () => Promise<Response> | Response>): FetchLike & { calls: string[] } => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const name = new URL(url).host;
      calls.push(name);
      return new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        Promise.resolve(behaviour[name]()).then(resolve, reject);
      });
    }) as FetchLike & { calls: string[] };
    f.calls = calls;
    return f;
  };
  const opts = (fetchImpl: FetchLike, fallbackEnabled = true, breakers = new BreakerRegistry({ failureThreshold: 2, cooldownMs: 10_000 })) => ({
    fetchImpl,
    breakers,
    now: () => Date.now(),
    fallbackEnabled,
  });

  it("falls back to the secondary on a 5xx", async () => {
    const f = mkFetch({ primary: () => new Response("x", { status: 503 }), secondary: ok });
    const r = await callUpstreams("{}", ups, opts(f));
    expect(r.status).toBe(200);
    expect(r.provider).toBe("secondary");
    expect(r.attempts.map((a) => a.outcome)).toEqual(["5xx", "ok"]);
  });

  it("falls back on timeout", async () => {
    const f = mkFetch({ primary: () => new Promise(() => {}), secondary: ok });
    const r = await callUpstreams("{}", ups, opts(f));
    expect(r.provider).toBe("secondary");
    expect(r.attempts[0].outcome).toBe("timeout");
  });

  it("does not retry client errors (4xx)", async () => {
    const f = mkFetch({ primary: () => new Response("bad", { status: 400 }), secondary: ok });
    const r = await callUpstreams("{}", ups, opts(f));
    expect(r.status).toBe(400);
    expect(f.calls).toEqual(["primary"]);
  });

  it("returns 502 when fallback is disabled and the primary fails", async () => {
    const f = mkFetch({ primary: () => new Response("x", { status: 500 }), secondary: ok });
    const r = await callUpstreams("{}", ups, opts(f, false));
    expect(r.status).toBe(502);
    expect(f.calls).toEqual(["primary"]);
  });

  it("skips a provider whose circuit is open", async () => {
    const breakers = new BreakerRegistry({ failureThreshold: 2, cooldownMs: 10_000 });
    const f = mkFetch({ primary: () => new Response("x", { status: 500 }), secondary: ok });
    await callUpstreams("{}", ups, opts(f, true, breakers));
    await callUpstreams("{}", ups, opts(f, true, breakers));
    f.calls.length = 0;
    const r = await callUpstreams("{}", ups, opts(f, true, breakers));
    expect(f.calls).toEqual(["secondary"]);
    expect(r.attempts[0]).toMatchObject({ provider: "primary", outcome: "circuit_open" });
  });

  it("returns 503 fast when every circuit is open", async () => {
    const breakers = new BreakerRegistry({ failureThreshold: 1, cooldownMs: 10_000 });
    const f = mkFetch({ primary: () => new Response("x", { status: 500 }), secondary: () => new Response("x", { status: 500 }) });
    await callUpstreams("{}", ups, opts(f, true, breakers));
    const r = await callUpstreams("{}", ups, opts(f, true, breakers));
    expect(r.status).toBe(503);
  });
});
