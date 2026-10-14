import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const chat = (body: object, key: string, headers: Record<string, string> = {}) =>
  SELF.fetch("https://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const prompt = { model: "m", temperature: 0, messages: [{ role: "user", content: "What is a CDN?" }] };

async function waitForMetrics(pred: (m: any) => boolean): Promise<any> {
  for (let i = 0; i < 50; i++) {
    const m: any = await (await SELF.fetch("https://gateway.test/metrics")).json();
    if (pred(m)) return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("metrics condition not met");
}

describe("worker integration (real Cache API + Durable Objects in workerd)", () => {
  it("MISS then HIT through the Workers Cache API", async () => {
    const a = await chat(prompt, "k-cache");
    expect(a.status).toBe(200);
    expect(a.headers.get("x-cache")).toBe("MISS");
    const b = await chat(prompt, "k-cache");
    expect(b.headers.get("x-cache")).toBe("HIT");
    expect(b.headers.get("age")).not.toBeNull();
    expect(await b.json()).toEqual(await a.json());
  });

  it("BYPASS on Cache-Control: no-store", async () => {
    const r = await chat(prompt, "k-bypass", { "cache-control": "no-store" });
    expect(r.headers.get("x-cache")).toBe("BYPASS");
  });

  it("tenant-scoped cache: another key does not get a HIT for the same prompt", async () => {
    await chat(prompt, "k-tenant-a");
    const r = await chat(prompt, "k-tenant-b");
    expect(r.headers.get("x-cache")).toBe("MISS");
  });

  it("purge deletes the entry at this PoP", async () => {
    const a = await chat({ ...prompt, max_tokens: 5 }, "k-purge");
    const key = a.headers.get("x-cache-key")!;
    const p = await SELF.fetch("https://gateway.test/admin/purge", { method: "POST", body: JSON.stringify({ key }) });
    expect(await p.json()).toMatchObject({ deleted: true });
    expect((await chat({ ...prompt, max_tokens: 5 }, "k-purge")).headers.get("x-cache")).toBe("MISS");
  });

  it("Durable Object token bucket returns 429 + retry-after once the burst is spent", async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await chat(prompt, "k-limited")).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const r = await chat(prompt, "k-limited");
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("/metrics aggregates cache status, latency and 429s", async () => {
    await chat(prompt, "k-metrics");
    await chat(prompt, "k-metrics");
    for (let i = 0; i < 4; i++) await chat(prompt, "k-metrics-limited");
    const m = await waitForMetrics((x) => x.rate_limited >= 1 && x.by_cache.HIT >= 1);
    expect(m.hit_ratio).toBeGreaterThan(0);
    expect(m.latency_ms.HIT.p50).not.toBeNull();
    expect(m.upstream_calls).toBeGreaterThan(0);
  });
});
