import { beforeAll, describe, expect, it } from "vitest";
import { diagnose } from "../../copilot/planner";
import { applyProposal, renderDiff, formatConfig, validateProposal } from "../../copilot/proposal";
import { cacheKeyCardinality, rateLimitHotKeys, ttlChurn } from "../../copilot/tools";
import { DEFAULT_CONFIG } from "../../src/config";
import type { LogEvent } from "../../src/types";
import { simulate, type Scenario } from "../../evals/simulate";

const cfg = DEFAULT_CONFIG;
const ev = (p: Partial<LogEvent>): LogEvent => ({ ts: 0, key_hash: "k1", cache: "MISS", fallback: false, status: 200, latency_ms: 1, ...p });

describe("copilot tools (deterministic)", () => {
  it("cache_key_cardinality flags a field whose fan-out explains the extra keys per prompt", () => {
    const logs: LogEvent[] = [];
    for (let i = 0; i < 40; i++) {
      const prompt = `p${i % 4}`;
      logs.push(ev({ ts: i * 1000, prompt_hash: prompt, cache_key: `${prompt}-${i}`, field_hashes: { messages: prompt, model: "m", ts_field: `t${i}` } }));
    }
    const r = cacheKeyCardinality.run({ logs, config: cfg }, {});
    expect(r.offenders).toEqual(["ts_field"]);
    expect(r.fields.find((f) => f.field === "model")?.values_per_prompt).toBe(1);
  });

  it("ttl_churn counts refetches of keys seen before", () => {
    const logs = [0, 10, 20, 30].flatMap((t) => [ev({ ts: t * 1000, cache_key: "a" }), ev({ ts: t * 1000 + 1, cache: "HIT", cache_key: "a" })]);
    const r = ttlChurn.run({ logs, config: cfg }, {});
    expect(r.re_misses).toBe(3);
    expect(r.median_re_miss_gap_s).toBe(10);
  });

  it("rate_limit_hot_keys attributes 429s to keys", () => {
    const logs = [
      ...Array.from({ length: 30 }, (_, i) => ev({ ts: i, key_hash: "noisy", status: 429, cache: "NONE" })),
      ...Array.from({ length: 10 }, (_, i) => ev({ ts: i, key_hash: "quiet" })),
    ];
    const r = rateLimitHotKeys.run({ logs, config: cfg }, {});
    expect(r.top_keys[0]).toMatchObject({ key_hash: "noisy", rate_limited: 30, share_of_429s: 1 });
    expect(r.keys_limited).toBe(1);
  });
});

describe("config proposals", () => {
  it("validates against an allowlist and never lets every upstream be disabled", () => {
    expect(validateProposal(cfg, { changes: [{ path: "cache.ttlSeconds", from: 300, to: 600 }], rationale: "" })).toEqual([]);
    expect(validateProposal(cfg, { changes: [{ path: "upstreams.0.url", from: "", to: "http://evil" }], rationale: "" })[0]).toMatch(/not tunable/);
    expect(validateProposal(cfg, { changes: [{ path: "cache.ignoreFields", from: [], to: ["messages"] }], rationale: "" })[0]).toMatch(/invalid/);
    const both = { changes: [0, 1].map((i) => ({ path: `upstreams.${i}.enabled`, from: true, to: false })), rationale: "" };
    expect(validateProposal(cfg, both)).toContain("proposal would disable every upstream");
  });

  it("applies changes without mutating the original and renders a diff", () => {
    const p = { changes: [{ path: "cache.ttlSeconds", from: 300, to: 900 }], rationale: "" };
    const next = applyProposal(cfg, p);
    expect(next.cache.ttlSeconds).toBe(900);
    expect(cfg.cache.ttlSeconds).toBe(300);
    const diff = renderDiff(formatConfig(cfg), formatConfig(next));
    expect(diff).toContain('-     "ttlSeconds": 300,');
    expect(diff).toContain('+     "ttlSeconds": 900,');
  });
});

describe("planner on simulated incidents (real gateway code, virtual clock)", () => {
  const base: Omit<Scenario, "id" | "incident" | "expected"> = {
    description: "",
    question: "why did hit ratio drop?",
    traffic: { durationS: 400, rps: 5, tenants: 4, prompts: 40, zipf: 1.1, seed: 99 },
  };
  let timestampLogs: Awaited<ReturnType<typeof simulate>>;
  let healthyLogs: Awaited<ReturnType<typeof simulate>>;
  beforeAll(async () => {
    timestampLogs = await simulate({ ...base, id: "t", incident: { type: "extra_field", startS: 200, field: "timestamp", tenantShare: 1 }, expected: { root_cause: "", fix: null } });
    healthyLogs = await simulate({ ...base, id: "h", incident: { type: "none" }, expected: { root_cause: "", fix: null } });
  });

  it("finds the cache-busting field and proposes ignoring it (not applied)", () => {
    const d = diagnose(base.question, timestampLogs.logs, timestampLogs.finalConfig);
    expect(d.root_cause).toBe("cache_key_field_busting");
    expect(d.proposal?.changes[0]).toMatchObject({ path: "cache.ignoreFields" });
    expect(d.proposal?.changes[0].to).toContain("timestamp");
    expect(d.plan.map((p) => p.tool)).toContain("cache_key_cardinality");
  });

  it("does not invent an incident for a leading question on healthy traffic", () => {
    const d = diagnose(base.question, healthyLogs.logs, healthyLogs.finalConfig);
    expect(d.root_cause).toBe("healthy");
    expect(d.proposal).toBeNull();
  });
});
