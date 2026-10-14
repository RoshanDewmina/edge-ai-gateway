/**
 * Local benchmark: drives `wrangler dev` (workerd + real Cache API + Durable Objects) against the
 * Bun mock upstream. Everything is simulated; no real LLM provider is called.
 */
import { spawn, type Subprocess } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { percentile } from "../src/metrics";
import { mulberry32 } from "../src/rng";

const ROOT = new URL("..", import.meta.url).pathname;
const MOCK = "http://127.0.0.1:8788";
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const N_REQUESTS = Number(args.requests ?? 2000);
const N_PROMPTS = Number(args.prompts ?? 200);
const ZIPF_S = Number(args.zipf ?? 1.0);
const CONCURRENCY = Number(args.concurrency ?? 16);
const LATENCY_MS = Number(args.latency ?? 700);
const FALLBACK_REQUESTS = Number(args.fallbackRequests ?? 500);
const PRIMARY_FAILURE = Number(args.failureRate ?? 0.3);
const COSMETIC_VARIATION = 0.2;
const rand = mulberry32(Number(args.seed ?? 7));

const procs: Subprocess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url: string, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${url}`);
}

function startGateway(port: number, vars: Record<string, string>) {
  const persist = `${ROOT}.wrangler/bench-${port}`;
  rmSync(persist, { recursive: true, force: true });
  const varArgs = Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
  const p = spawn(
    ["bunx", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(port + 1000), "--persist-to", persist, ...varArgs],
    { cwd: ROOT, stdout: "ignore", stderr: "ignore" },
  );
  procs.push(p);
  return `http://127.0.0.1:${port}`;
}

const TOPICS = ["refund policy", "password reset", "shipping delays", "invoice download", "API rate limits", "SSO setup", "data export", "billing cycle", "webhook retries", "account deletion"];
const TASKS = ["Summarize", "Classify the intent of", "Draft a reply to", "Extract the order id from", "Translate to French", "Write a title for", "Detect sentiment in", "List action items in", "Rewrite politely", "Give a one-line answer to"];
const prompts = Array.from({ length: N_PROMPTS }, (_, i) => `${TASKS[i % 10]} this support ticket about ${TOPICS[Math.floor(i / 10) % 10]} (template ${i}).`);

function zipfSampler(n: number, s: number) {
  const w = Array.from({ length: n }, (_, k) => 1 / Math.pow(k + 1, s));
  const total = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  const cdf = w.map((x) => (acc += x / total));
  return () => {
    const u = rand();
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

function cosmetic(text: string): string {
  if (rand() >= COSMETIC_VARIATION) return text;
  return rand() < 0.5 ? `  ${text.toUpperCase()} ` : text.replace(/ /g, "   ");
}

interface Sample { cache: string; status: number; ms: number }

async function drive(base: string, bodies: object[], headers: Record<string, string>): Promise<Sample[]> {
  const out: Sample[] = new Array(bodies.length);
  let next = 0;
  const worker = async () => {
    while (next < bodies.length) {
      const i = next++;
      const t0 = performance.now();
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer bench-app-key", "content-type": "application/json", ...headers },
        body: JSON.stringify(bodies[i]),
      });
      await res.arrayBuffer();
      out[i] = { cache: res.headers.get("x-cache") ?? "NONE", status: res.status, ms: performance.now() - t0 };
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

const round = (x: number | null, d = 1) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
function latency(samples: Sample[]) {
  const s = samples.map((x) => x.ms).sort((a, b) => a - b);
  return { n: s.length, p50_ms: round(percentile(s, 50)), p95_ms: round(percentile(s, 95)) };
}

async function mockStats() {
  return (await (await fetch(`${MOCK}/__stats`)).json()) as { calls: Record<string, { total: number; failed: number }> };
}

const env = {
  os: `${os.platform()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model,
  bun: Bun.version,
  note: "Local run: wrangler dev (workerd) on one machine against a simulated provider (Bun mock upstream). Not a production or real-provider measurement.",
};

async function cacheBench() {
  const gw = startGateway(8787, {
    PRIMARY_URL: `${MOCK}/primary/v1/chat/completions`,
    SECONDARY_URL: `${MOCK}/secondary/v1/chat/completions`,
    RATE_LIMIT_CAPACITY: "100000",
  });
  await waitFor(`${gw}/healthz`);
  await fetch(`${MOCK}/__stats`, { method: "DELETE" });
  await fetch(`${gw}/admin/reset`, { method: "POST" });

  const sample = zipfSampler(N_PROMPTS, ZIPF_S);
  const picks = Array.from({ length: N_REQUESTS }, sample);
  const bodies = picks.map((i) => ({ model: "mock-model", temperature: 0, messages: [{ role: "user", content: cosmetic(prompts[i]) }] }));
  const t0 = performance.now();
  const samples = await drive(gw, bodies, {});
  const wallS = (performance.now() - t0) / 1000;
  await sleep(500);
  const stats = await mockStats();
  const gatewayMetrics = await (await fetch(`${gw}/metrics`)).json();
  const upstreamCalls = stats.calls.primary.total + stats.calls.secondary.total;
  const by = (c: string) => samples.filter((s) => s.cache === c);
  const hits = by("HIT").length + by("STALE").length;
  const lookups = hits + by("MISS").length;

  return {
    kind: "cache",
    run_at: new Date().toISOString(),
    env,
    params: { requests: N_REQUESTS, distinct_prompt_templates: N_PROMPTS, zipf_s: ZIPF_S, concurrency: CONCURRENCY, upstream_latency_ms: LATENCY_MS, cosmetic_variation_share: COSMETIC_VARIATION, temperature: 0, tenants: 1 },
    distinct_prompts_requested: new Set(picks).size,
    wall_clock_s: round(wallS, 2),
    status_counts: Object.fromEntries([...new Set(samples.map((s) => s.status))].map((st) => [st, samples.filter((s) => s.status === st).length])),
    by_cache: Object.fromEntries(["HIT", "STALE", "MISS", "BYPASS", "NONE"].map((c) => [c, by(c).length])),
    hit_ratio: round(hits / lookups, 4),
    client_latency: { HIT: latency(by("HIT")), MISS: latency(by("MISS")) },
    upstream_calls: upstreamCalls,
    upstream_calls_avoided_pct: round((1 - upstreamCalls / N_REQUESTS) * 100, 2),
    gateway_metrics: gatewayMetrics,
  };
}

async function fallbackBench() {
  const common = {
    PRIMARY_URL: `${MOCK}/primary/v1/chat/completions`,
    SECONDARY_URL: `${MOCK}/secondary/v1/chat/completions`,
    RATE_LIMIT_CAPACITY: "100000",
  };
  const withFb = startGateway(8790, { ...common, FALLBACK_ENABLED: "true" });
  const withoutFb = startGateway(8792, { ...common, FALLBACK_ENABLED: "false" });
  await Promise.all([waitFor(`${withFb}/healthz`), waitFor(`${withoutFb}/healthz`)]);
  await fetch(`${MOCK}/__control`, { method: "POST", body: JSON.stringify({ primary: { failureRate: PRIMARY_FAILURE } }) });

  const bodies = Array.from({ length: FALLBACK_REQUESTS }, (_, i) => ({ model: "mock-model", temperature: 0, messages: [{ role: "user", content: `fallback probe ${i}` }] }));
  const runs: Record<string, any> = {};
  for (const [name, gw] of [["fallback_enabled", withFb], ["fallback_disabled", withoutFb]] as const) {
    await fetch(`${MOCK}/__stats`, { method: "DELETE" });
    const samples = await drive(gw, bodies, { "cache-control": "no-store" });
    await sleep(500);
    const ok = samples.filter((s) => s.status === 200);
    runs[name] = {
      requests: samples.length,
      success_rate: round(ok.length / samples.length, 4),
      status_counts: Object.fromEntries([...new Set(samples.map((s) => s.status))].map((st) => [st, samples.filter((s) => s.status === st).length])),
      client_latency_all: latency(samples),
      client_latency_success: latency(ok),
      mock_upstream_calls: (await mockStats()).calls,
      gateway_metrics: await (await fetch(`${gw}/metrics`)).json(),
    };
  }
  await fetch(`${MOCK}/__control`, { method: "POST", body: JSON.stringify({ primary: { failureRate: 0 } }) });
  return {
    kind: "fallback",
    run_at: new Date().toISOString(),
    env,
    params: { requests_per_mode: FALLBACK_REQUESTS, primary_failure_rate: PRIMARY_FAILURE, secondary_failure_rate: 0, upstream_latency_ms: LATENCY_MS, concurrency: CONCURRENCY, cache: "bypassed via Cache-Control: no-store so every request reaches an upstream" },
    ...runs,
  };
}

async function main() {
  mkdirSync(`${ROOT}bench/results`, { recursive: true });
  procs.push(spawn(["bun", "mock-upstream/server.ts"], { cwd: ROOT, env: { ...process.env, PRIMARY_LATENCY_MS: String(LATENCY_MS), SECONDARY_LATENCY_MS: String(LATENCY_MS) }, stdout: "ignore", stderr: "inherit" }));
  await waitFor(`${MOCK}/__stats`);
  const which = args.only ?? "all";
  if (which === "all" || which === "cache") {
    const r = await cacheBench();
    writeFileSync(`${ROOT}bench/results/cache.json`, JSON.stringify(r, null, 2) + "\n");
    console.log("cache:", JSON.stringify({ hit_ratio: r.hit_ratio, latency: r.client_latency, upstream_calls: r.upstream_calls, avoided_pct: r.upstream_calls_avoided_pct, status: r.status_counts }));
  }
  if (which === "all" || which === "fallback") {
    const r: any = await fallbackBench();
    writeFileSync(`${ROOT}bench/results/fallback.json`, JSON.stringify(r, null, 2) + "\n");
    const pick = (x: any) => ({ success_rate: x.success_rate, status: x.status_counts, p50: x.client_latency_success.p50_ms, p95: x.client_latency_success.p95_ms });
    console.log("fallback:", JSON.stringify({ on: pick(r.fallback_enabled), off: pick(r.fallback_disabled) }));
  }
}

try {
  await main();
} finally {
  for (const p of procs) p.kill();
}
