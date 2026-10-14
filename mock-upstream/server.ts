import { mockCompletion, type MockOptions } from "../src/mockUpstream";
import { mulberry32 } from "../src/rng";

const env = process.env;
const providers: Record<string, MockOptions> = {
  primary: { latencyMs: Number(env.PRIMARY_LATENCY_MS ?? 700), failureRate: Number(env.PRIMARY_FAILURE_RATE ?? 0) },
  secondary: { latencyMs: Number(env.SECONDARY_LATENCY_MS ?? 700), failureRate: Number(env.SECONDARY_FAILURE_RATE ?? 0) },
};
const calls: Record<string, { total: number; failed: number }> = { primary: { total: 0, failed: 0 }, secondary: { total: 0, failed: 0 } };
const rand = mulberry32(Number(env.MOCK_SEED ?? 42));

const server = Bun.serve({
  port: Number(env.MOCK_PORT ?? 8788),
  hostname: "127.0.0.1",
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/__control" && req.method === "POST") {
      const patch = (await req.json()) as Record<string, Partial<MockOptions>>;
      for (const [name, opts] of Object.entries(patch)) if (providers[name]) Object.assign(providers[name], opts);
      return Response.json(providers);
    }
    if (pathname === "/__stats") {
      if (req.method === "DELETE") for (const c of Object.values(calls)) (c.total = 0), (c.failed = 0);
      return Response.json({ calls, providers });
    }
    const m = pathname.match(/^\/(primary|secondary)\/v1\/chat\/completions$/);
    if (!m || req.method !== "POST") return Response.json({ error: "not found" }, { status: 404 });
    const res = await mockCompletion(await req.text(), providers[m[1]], m[1], rand);
    calls[m[1]].total++;
    if (res.status >= 500) calls[m[1]].failed++;
    return res;
  },
});

console.log(`mock upstream listening on http://127.0.0.1:${server.port} (simulated provider, no real LLM calls)`);
