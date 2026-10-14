import { describe, expect, it } from "vitest";
import { buildCacheKey, decideCaching, parseCacheControl } from "../../src/cacheKey";
import { DEFAULT_CONFIG } from "../../src/config";

const cfg = DEFAULT_CONFIG.cache;
const base = { model: "gpt-x", temperature: 0, messages: [{ role: "user", content: "What is a CDN?" }] };
const key = async (b: Record<string, unknown>, tenant = "t1", c = cfg) => (await buildCacheKey(b, c, tenant)).key;

describe("cache key normalization", () => {
  it("ignores whitespace and casing differences in message content and model", async () => {
    const variant = { model: " GPT-X ", temperature: 0, messages: [{ role: "USER", content: "  what   is a\n cdn? " }] };
    expect(await key(variant)).toBe(await key(base));
  });

  it("is independent of JSON key order", async () => {
    const reordered = { messages: base.messages, temperature: 0, model: "gpt-x" };
    expect(await key(reordered)).toBe(await key(base));
  });

  it("ignores cache-busting fields from the ignore list (request_id, user, metadata)", async () => {
    const busted = { ...base, request_id: "req-123", user: "u-9", metadata: { trace: "abc" } };
    expect(await key(busted)).toBe(await key(base));
  });

  it("keeps unknown fields in the key so output-changing params never share an entry", async () => {
    expect(await key({ ...base, response_format: { type: "json_object" } })).not.toBe(await key(base));
    expect(await key({ ...base, timestamp: 1 })).not.toBe(await key(base));
  });

  it("separates different decoding params and models", async () => {
    expect(await key({ ...base, max_tokens: 10 })).not.toBe(await key(base));
    expect(await key({ ...base, model: "other" })).not.toBe(await key(base));
  });

  it("scopes keys per tenant by default and shares them in global scope", async () => {
    expect(await key(base, "t1")).not.toBe(await key(base, "t2"));
    const global = { ...cfg, scope: "global" as const };
    expect(await key(base, "t1", global)).toBe(await key(base, "t2", global));
  });

  it("changes every key when keyVersion is bumped (global purge)", async () => {
    expect(await key(base, "t1", { ...cfg, keyVersion: 2 })).not.toBe(await key(base));
  });

  it("can keep case when caseFold is off", async () => {
    const c = { ...cfg, caseFold: false };
    const upper = { ...base, messages: [{ role: "user", content: "WHAT IS A CDN?" }] };
    expect(await key(upper, "t1", c)).not.toBe(await key(base, "t1", c));
  });

  it("exposes per-field hashes for diagnostics", async () => {
    const r = await buildCacheKey({ ...base, timestamp: 5 }, cfg, "t1");
    expect(Object.keys(r.fieldHashes).sort()).toEqual(["messages", "model", "temperature", "timestamp"]);
    expect(r.promptHash).toBe(r.fieldHashes.messages);
  });
});

describe("cacheability decision", () => {
  it("caches only deterministic (temperature 0) requests by default", () => {
    expect(decideCaching(base, parseCacheControl(null), cfg)).toMatchObject({ cacheable: true, read: true });
    expect(decideCaching({ ...base, temperature: 0.7 }, parseCacheControl(null), cfg)).toEqual({ cacheable: false, reason: "nondeterministic" });
    const { temperature: _t, ...noTemp } = base;
    expect(decideCaching(noTemp, parseCacheControl(null), cfg)).toEqual({ cacheable: false, reason: "nondeterministic" });
  });

  it("respects client Cache-Control directives", () => {
    expect(decideCaching(base, parseCacheControl("no-store"), cfg)).toEqual({ cacheable: false, reason: "no-store" });
    expect(decideCaching(base, parseCacheControl("no-cache"), cfg)).toMatchObject({ cacheable: true, read: false });
    expect(decideCaching(base, parseCacheControl("max-age=30"), cfg)).toMatchObject({ cacheable: true, maxAgeSeconds: 30 });
  });
});
