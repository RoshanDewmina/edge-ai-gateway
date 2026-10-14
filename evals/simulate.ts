/**
 * Produces synthetic gateway logs for an incident scenario by replaying generated traffic through
 * the real handleChat() (real cache-key code, token bucket, fallback, circuit breaker) with a
 * virtual clock, an in-memory TTL cache and a simulated provider.
 */
import { DEFAULT_CONFIG, type GatewayConfig } from "../src/config";
import { handleChat, type EdgeCache } from "../src/gateway";
import { mulberry32 } from "../src/rng";
import { takeToken, type BucketState } from "../src/tokenBucket";
import { BreakerRegistry, type FetchLike } from "../src/upstream";
import type { CachedEntry, LogEvent } from "../src/types";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export type Incident =
  | { type: "none" }
  | { type: "extra_field"; startS: number; field: string; tenantShare: number }
  | { type: "config_change"; startS: number; config: DeepPartial<GatewayConfig> }
  | { type: "provider_errors"; startS: number; provider: string; failureRate: number }
  | { type: "provider_latency"; startS: number; provider: string; meanMs: number; sdMs: number }
  | { type: "tenant_flood"; startS: number; tenant: number; rps: number }
  | { type: "client_no_store"; startS: number; tenantShare: number }
  | { type: "temperature"; startS: number; tenantShare: number; value: number }
  | { type: "novel_traffic"; startS: number; poolSize: number };

export interface ExpectedFix {
  path: string;
  contains?: string;
  equals?: unknown;
  gte?: number;
  gtCurrent?: boolean;
}

export interface Scenario {
  id: string;
  description: string;
  question: string;
  config?: DeepPartial<GatewayConfig>;
  traffic: { durationS: number; rps: number; tenants: number; prompts: number; zipf: number; seed: number };
  incident: Incident;
  expected: { root_cause: string; fix: ExpectedFix | null };
}

function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" ? merge(out[k], v as any) : v;
  }
  return out;
}

const BACKGROUND = { primaryFailureRate: 0.01, nondeterministicShare: 0.05, latencyMeanMs: 700, latencySdMs: 120 };

export async function simulate(s: Scenario): Promise<{ logs: LogEvent[]; finalConfig: GatewayConfig }> {
  const rand = mulberry32(s.traffic.seed);
  const config: GatewayConfig = merge(structuredClone(DEFAULT_CONFIG), s.config);
  const t0 = Date.UTC(2026, 9, 14, 12, 0, 0);
  const inc = s.incident;
  const startMs = "startS" in inc ? t0 + inc.startS * 1000 : Infinity;

  const exp = (rate: number) => -Math.log(1 - rand()) / rate;
  const normal = (mean: number, sd: number) => mean + sd * Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const zipfCdf = (() => {
    const w = Array.from({ length: s.traffic.prompts }, (_, k) => 1 / Math.pow(k + 1, s.traffic.zipf));
    const tot = w.reduce((a, b) => a + b, 0);
    let acc = 0;
    return w.map((x) => (acc += x / tot));
  })();
  const zipf = () => {
    const u = rand();
    const i = zipfCdf.findIndex((c) => c >= u);
    return i < 0 ? zipfCdf.length - 1 : i;
  };

  const arrivals: { t: number; tenant: number }[] = [];
  for (let t = t0 + exp(s.traffic.rps) * 1000; t < t0 + s.traffic.durationS * 1000; t += exp(s.traffic.rps) * 1000)
    arrivals.push({ t, tenant: Math.floor(rand() * s.traffic.tenants) });
  if (inc.type === "tenant_flood")
    for (let t = startMs; t < t0 + s.traffic.durationS * 1000; t += exp(inc.rps) * 1000) arrivals.push({ t, tenant: inc.tenant });
  arrivals.sort((a, b) => a.t - b.t);

  let clock = t0;
  const store = new Map<string, { entry: CachedEntry; expiresAt: number }>();
  const cache: EdgeCache = {
    async get(k) {
      const v = store.get(k);
      if (!v || clock > v.expiresAt) return null;
      return v.entry;
    },
    async put(k, entry, storeFor) {
      store.set(k, { entry, expiresAt: entry.storedAt + storeFor * 1000 });
    },
  };
  const buckets = new Map<string, BucketState>();
  const fetchImpl: FetchLike = async (url, init) => {
    const provider = new URL(url).host;
    const timeoutMs = config.upstreams.find((u) => u.name === provider)!.timeoutMs;
    let mean = BACKGROUND.latencyMeanMs;
    let sd = BACKGROUND.latencySdMs;
    let failureRate = provider === "primary" ? BACKGROUND.primaryFailureRate : 0;
    if (clock >= startMs && inc.type === "provider_latency" && inc.provider === provider) [mean, sd] = [inc.meanMs, inc.sdMs];
    if (clock >= startMs && inc.type === "provider_errors" && inc.provider === provider) failureRate = inc.failureRate;
    const latency = Math.round(Math.max(80, normal(mean, sd)));
    if (latency > timeoutMs) {
      clock += timeoutMs;
      throw new DOMException("The operation timed out.", "TimeoutError");
    }
    clock += latency;
    if (rand() < failureRate) return Response.json({ error: "simulated" }, { status: 503 });
    return Response.json({ id: "sim", choices: [{ message: { role: "assistant", content: `answer ${String(init.body).length}` } }] });
  };
  const pending: Promise<unknown>[] = [];
  const logs: LogEvent[] = [];
  const deps = {
    config,
    cache,
    limiter: {
      take: async (tenant: string) => {
        const r = takeToken(buckets.get(tenant), clock, config.rateLimit);
        buckets.set(tenant, r.state);
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

  const affected = (tenant: number, share: number) => tenant < Math.round(share * s.traffic.tenants);
  let configChanged = false;
  let seq = 0;
  for (const a of arrivals) {
    clock = Math.round(a.t);
    const active = a.t >= startMs;
    if (active && inc.type === "config_change" && !configChanged) {
      Object.assign(config, merge(config, inc.config));
      configChanged = true;
    }
    const promptIdx = active && inc.type === "novel_traffic" ? 10_000 + Math.floor(rand() * inc.poolSize) : zipf();
    const body: Record<string, unknown> = {
      model: "gpt-mini",
      temperature: rand() < BACKGROUND.nondeterministicShare ? 0.7 : 0,
      max_tokens: 256,
      messages: [
        { role: "system", content: "You are a concise support assistant." },
        { role: "user", content: `Support question #${promptIdx}: how do I resolve issue ${promptIdx % 37}?` },
      ],
    };
    const headers: Record<string, string> = { authorization: `Bearer tenant-${a.tenant}-key`, "content-type": "application/json" };
    if (active && inc.type === "extra_field" && affected(a.tenant, inc.tenantShare)) body[inc.field] = `${a.t}-${seq++}`;
    if (active && inc.type === "temperature" && affected(a.tenant, inc.tenantShare)) body.temperature = inc.value;
    if (active && inc.type === "client_no_store" && affected(a.tenant, inc.tenantShare)) headers["cache-control"] = "no-store";

    await handleChat(new Request("https://gateway.sim/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body) }), deps);
    await Promise.all(pending.splice(0));
  }
  return { logs, finalConfig: config };
}
