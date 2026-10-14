import { CircuitBreaker } from "./circuitBreaker";
import type { GatewayConfig, UpstreamConfig } from "./config";
import type { Attempt, AttemptOutcome } from "./types";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface UpstreamResult {
  status: number;
  body: string;
  provider?: string;
  attempts: Attempt[];
}

export class BreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  constructor(private readonly opts: GatewayConfig["circuitBreaker"]) {}
  get(name: string): CircuitBreaker {
    let b = this.breakers.get(name);
    if (!b) this.breakers.set(name, (b = new CircuitBreaker(this.opts)));
    return b;
  }
}

const RETRYABLE: AttemptOutcome[] = ["5xx", "429", "timeout", "network"];

function classify(status: number): AttemptOutcome {
  if (status >= 500) return "5xx";
  if (status === 429) return "429";
  if (status >= 400) return "4xx";
  return "ok";
}

export interface CallOptions {
  fetchImpl: FetchLike;
  breakers: BreakerRegistry;
  now: () => number;
  fallbackEnabled: boolean;
  headersFor?: (u: UpstreamConfig) => Record<string, string>;
}

export async function callUpstreams(body: string, upstreams: UpstreamConfig[], opts: CallOptions): Promise<UpstreamResult> {
  const candidates = upstreams.filter((u) => u.enabled);
  const chain = opts.fallbackEnabled ? candidates : candidates.slice(0, 1);
  const attempts: Attempt[] = [];
  let last: { status: number; body: string } | undefined;

  for (const u of chain) {
    const breaker = opts.breakers.get(u.name);
    if (!breaker.canRequest(opts.now())) {
      attempts.push({ provider: u.name, outcome: "circuit_open", latency_ms: 0 });
      continue;
    }
    const started = opts.now();
    let outcome: AttemptOutcome;
    let status: number | undefined;
    let text = "";
    try {
      const res = await opts.fetchImpl(u.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(opts.headersFor?.(u) ?? {}) },
        body,
        signal: AbortSignal.timeout(u.timeoutMs),
      });
      status = res.status;
      text = await res.text();
      outcome = classify(res.status);
    } catch (err) {
      const name = (err as { name?: string })?.name;
      outcome = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
    }
    attempts.push({ provider: u.name, outcome, status, latency_ms: opts.now() - started });

    if (outcome === "ok" || outcome === "4xx") {
      breaker.onSuccess();
      return { status: status!, body: text, provider: u.name, attempts };
    }
    breaker.onFailure(opts.now());
    if (status !== undefined) last = { status, body: text };
    if (!RETRYABLE.includes(outcome)) break;
  }

  const allOpen = attempts.length > 0 && attempts.every((a) => a.outcome === "circuit_open");
  return {
    status: allOpen ? 503 : 502,
    body: JSON.stringify({
      error: {
        type: allOpen ? "circuit_open" : "upstream_unavailable",
        message: allOpen ? "All upstream circuits are open" : "All upstreams failed",
        upstream_status: last?.status,
      },
    }),
    attempts,
  };
}
