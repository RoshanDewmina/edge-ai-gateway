import type { LogEvent } from "../src/types";
import type { GatewayConfig } from "../src/config";
import type { Proposal } from "./proposal";
import {
  cacheKeyCardinality,
  cacheOverview,
  hitRatioWindows,
  providerHealth,
  rateLimitHotKeys,
  ttlChurn,
  type ToolContext,
} from "./tools";

export const ROOT_CAUSES = [
  "cache_key_field_busting",
  "ttl_too_short",
  "client_no_store",
  "nondeterministic_requests",
  "novel_traffic",
  "primary_provider_errors",
  "upstream_timeout_too_tight",
  "rate_limit_hot_key",
  "rate_limit_too_low",
  "healthy",
] as const;
export type RootCause = (typeof ROOT_CAUSES)[number];

export interface Finding {
  root_cause: RootCause;
  score: number;
  summary: string;
  evidence: string[];
  proposal: Proposal | null;
  client_action?: string;
}

export interface Diagnosis {
  question: string;
  mode: "deterministic" | "llm";
  plan: { tool: string; args: Record<string, unknown>; reason: string }[];
  root_cause: RootCause;
  summary: string;
  evidence: string[];
  proposal: Proposal | null;
  client_action?: string;
  other_findings: { root_cause: RootCause; score: number; summary: string }[];
  tool_outputs: Record<string, unknown>;
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : `${Math.round(x * 1000) / 10}%`);
const roundUp = (x: number, step: number) => Math.ceil(x / step) * step;

export function diagnose(question: string, logs: LogEvent[], config: GatewayConfig): Diagnosis {
  const ctx: ToolContext = { logs: [...logs].sort((a, b) => a.ts - b.ts), config };
  const plan: Diagnosis["plan"] = [];
  const outputs: Record<string, unknown> = {};
  const call = <A extends Record<string, unknown>, R>(tool: { name: string; run(c: ToolContext, a: A): R }, args: A, reason: string): R => {
    plan.push({ tool: tool.name, args, reason });
    const r = tool.run(ctx, args);
    outputs[tool.name] = r;
    return r;
  };

  const overview = call(cacheOverview, {}, "triage: traffic mix and cache status");
  const windows = call(hitRatioWindows, { windowSeconds: 60 }, "triage: did hit ratio change over time?");
  const providers = call(providerHealth, { windowSeconds: 60 }, "triage: upstream errors, timeouts, fallbacks");
  const limits = call(rateLimitHotKeys, { top: 5 }, "triage: 429s and which keys get them");

  const findings: Finding[] = [];
  const q = question.toLowerCase();
  const cacheQuestion = /cache|hit|miss|ttl|cost/.test(q);
  const hitDrop = windows.drop ?? 0;

  if (hitDrop >= 0.15 || (overview.hit_ratio ?? 1) < 0.5 || cacheQuestion) {
    const since = windows.change_point_ts ?? undefined;
    const why = since ? "hit ratio fell at the change point; inspect keys after it" : "cache question; inspect key structure";
    const card = call(cacheKeyCardinality, since ? { sinceTs: since } : {}, `drill-down: ${why}`);
    const churn = call(ttlChurn, since ? { sinceTs: since } : {}, "drill-down: are entries expiring and being refetched?");
    const impact = Math.max(hitDrop, 1 - (overview.hit_ratio ?? 1));

    if (card.offenders.length > 0) {
      const next = [...new Set([...config.cache.ignoreFields, ...card.offenders])];
      findings.push({
        root_cause: "cache_key_field_busting",
        score: impact,
        summary: `Field(s) ${card.offenders.join(", ")} vary on almost every request and are part of the cache key, so identical prompts stop sharing entries.`,
        evidence: [
          `hit ratio ${pct(windows.baseline)} -> ${pct(windows.recent)}`,
          `${card.keys_per_prompt} distinct cache keys per repeated prompt; ${card.offenders.map((f) => `${f}: ${card.fields.find((x) => x.field === f)?.values_per_prompt} values/prompt${card.fields.find((x) => x.field === f)?.new_since_change ? " (new field)" : ""}`).join(", ")}`,
        ],
        proposal: {
          changes: [{ path: "cache.ignoreFields", from: config.cache.ignoreFields, to: next }],
          rationale: `Exclude ${card.offenders.join(", ")} from the cache key. Safe only if the field does not change the model output (true for request ids / timestamps / session ids).`,
        },
      });
    } else if ((churn.re_miss_share_of_lookups ?? 0) >= 0.2) {
      const to = Math.min(3600, Math.max(300, config.cache.ttlSeconds * 10));
      findings.push({
        root_cause: "ttl_too_short",
        score: impact,
        summary: `Entries expire after ${config.cache.ttlSeconds}s and the same keys are refetched every ~${churn.median_re_miss_gap_s}s.`,
        evidence: [
          `hit ratio ${pct(windows.baseline)} -> ${pct(windows.recent)}`,
          `${churn.re_misses} re-misses = ${pct(churn.re_miss_share_of_lookups)} of lookups; median refetch gap ${churn.median_re_miss_gap_s}s vs TTL ${churn.ttl_s}s`,
        ],
        proposal: { changes: [{ path: "cache.ttlSeconds", from: config.cache.ttlSeconds, to }], rationale: `Raise TTL to ${to}s; responses are deterministic (temperature 0) so a longer TTL only risks serving answers older than a model/prompt change - bump cache.keyVersion on deploys instead.` },
      });
    } else if (hitDrop >= 0.15 && (card.distinct_prompt_ratio_after ?? 0) >= 1.5 * (card.distinct_prompt_ratio_before ?? 1)) {
      findings.push({
        root_cause: "novel_traffic",
        score: hitDrop * 0.8,
        summary: "Traffic shifted to prompts the cache has not seen; no single field or TTL explains it.",
        evidence: [`distinct prompt ratio ${pct(card.distinct_prompt_ratio_before)} -> ${pct(card.distinct_prompt_ratio_after)}`, `no field fan-out offenders, re-miss share ${pct(churn.re_miss_share_of_lookups)}`],
        proposal: null,
        client_action: "No config change; hit ratio should recover as the new prompts repeat. Consider semantic caching only if paraphrases dominate.",
      });
    }
  }

  const bypassRise = (overview.bypass_share_after ?? 0) - (overview.bypass_share_before ?? 0);
  if ((overview.bypass_share_after ?? 0) >= 0.25 && bypassRise >= 0.15) {
    const [reason] = Object.entries(overview.bypass_reasons_after).sort((a, b) => b[1] - a[1])[0] ?? [];
    if (reason === "no-store" || reason === "nondeterministic") {
      findings.push({
        root_cause: reason === "no-store" ? "client_no_store" : "nondeterministic_requests",
        score: bypassRise,
        summary:
          reason === "no-store"
            ? "Clients started sending Cache-Control: no-store, so the gateway (correctly) skips the cache."
            : "Clients started sending temperature > 0; non-deterministic requests are never cached by design.",
        evidence: [`BYPASS share ${pct(overview.bypass_share_before)} -> ${pct(overview.bypass_share_after)}`, `top bypass reason: ${reason}; one key accounts for ${pct(overview.top_bypass_tenant_share)} of bypasses`],
        proposal: null,
        client_action: reason === "no-store" ? "Ask the client team why they added no-store; the gateway should keep honouring it." : "Ask the client whether these calls need sampling; use temperature 0 for cacheable, repeatable prompts.",
      });
    }
  }

  const primary = config.upstreams[0];
  const ph = providers.providers[primary.name];
  if (ph && ph.attempts > 0) {
    const nonTimeoutErrors = (ph.outcomes["5xx"] ?? 0) + (ph.outcomes["429"] ?? 0) + (ph.outcomes["network"] ?? 0);
    const timeouts = ph.outcomes["timeout"] ?? 0;
    const nearTimeout = ph.success_p95_ms !== null && ph.timeout_ms !== null && ph.success_p95_ms >= 0.7 * ph.timeout_ms;
    if ((ph.timeout_rate ?? 0) >= 0.05 && timeouts >= nonTimeoutErrors && nearTimeout) {
      const to = Math.min(120_000, roundUp(ph.timeout_ms! * 2.5, 500));
      findings.push({
        root_cause: "upstream_timeout_too_tight",
        score: (ph.timeout_rate ?? 0) + 0.05,
        summary: `${primary.name} is slow but healthy: ${pct(ph.timeout_rate)} of calls hit the ${ph.timeout_ms}ms timeout while successful calls already take p95 ${ph.success_p95_ms}ms.`,
        evidence: [`${primary.name} outcomes ${JSON.stringify(ph.outcomes)}`, `success p50/p95 ${ph.success_p50_ms}/${ph.success_p95_ms}ms vs timeout ${ph.timeout_ms}ms (success latencies are truncated at the timeout)`],
        proposal: { changes: [{ path: "upstreams.0.timeoutMs", from: ph.timeout_ms, to }], rationale: `Raise the ${primary.name} timeout to ${to}ms so slow-but-successful calls are not abandoned and retried on the secondary (double cost).` },
      });
    } else if ((ph.error_rate ?? 0) >= 0.15 || ((ph.peak_window_error_rate ?? 0) >= 0.25 && nonTimeoutErrors >= 10)) {
      const secondary = config.upstreams[1];
      const sh = secondary ? providers.providers[secondary.name] : undefined;
      const secondaryHealthy = secondary?.enabled && (sh?.error_rate ?? 0) < 0.05;
      findings.push({
        root_cause: "primary_provider_errors",
        score: Math.max(ph.error_rate ?? 0, providers.fallback_share ?? 0) + 0.1,
        summary: `${primary.name} is failing (${pct(ph.error_rate)} errors overall, peak ${pct(ph.peak_window_error_rate)} per minute); requests are falling back to ${secondary?.name ?? "nothing"}.`,
        evidence: [
          `${primary.name} outcomes ${JSON.stringify(ph.outcomes)}`,
          `fallback on ${pct(providers.fallback_share)} of upstream requests; ${providers.failed_requests} requests failed outright`,
          `circuit breaker (threshold ${config.circuitBreaker.failureThreshold} consecutive) skipped ${primary.name} on ${ph.outcomes["circuit_open"] ?? 0} requests; the other ${nonTimeoutErrors} failed attempts each cost a full ${primary.name} round trip before falling back`,
        ],
        proposal: secondaryHealthy
          ? { changes: [{ path: "upstreams.0.enabled", from: true, to: false }], rationale: `Drain ${primary.name} until the provider recovers; ${secondary!.name} is healthy (${pct(sh?.error_rate ?? 0)} errors). Re-enable once its status page is green.` }
          : null,
      });
    }
  }

  if ((limits.rate_limited_share ?? 0) >= 0.03 && limits.rate_limited >= 20) {
    const top = limits.top_keys[0];
    if ((top?.share_of_429s ?? 0) >= 0.8) {
      findings.push({
        root_cause: "rate_limit_hot_key",
        score: limits.rate_limited_share ?? 0,
        summary: `One key (${top.key_hash}) receives ${pct(top.share_of_429s)} of all 429s at up to ${top.peak_rps} req/s; other tenants are unaffected. The limiter is doing its job.`,
        evidence: [`${limits.rate_limited} of ${limits.requests} requests limited; ${limits.keys_limited} of ${limits.active_keys} keys affected`, `bucket: capacity ${limits.config.capacity}, refill ${limits.config.refillPerSecond}/s`],
        proposal: null,
        client_action: `Contact the owner of key ${top.key_hash}: add client-side backoff on retry-after, or agree a dedicated quota. Raising the global limit would let one tenant crowd out the rest.`,
      });
    } else if (limits.keys_limited >= Math.max(2, 0.5 * limits.active_keys)) {
      const durationS = Math.max(1, (ctx.logs[ctx.logs.length - 1].ts - ctx.logs[0].ts) / 1000);
      const maxAvgRps = Math.max(...limits.top_keys.map((k) => k.requests / durationS));
      const refill = Math.max(config.rateLimit.refillPerSecond * 2, Math.ceil(maxAvgRps * 1.5 * 10) / 10);
      const capacity = Math.max(config.rateLimit.capacity * 2, Math.max(...limits.top_keys.map((k) => k.peak_rps)) * 5);
      findings.push({
        root_cause: "rate_limit_too_low",
        score: limits.rate_limited_share ?? 0,
        summary: `429s are spread across ${limits.keys_limited} of ${limits.active_keys} keys, so the limit is below normal per-tenant demand rather than one abusive client.`,
        evidence: [`${pct(limits.rate_limited_share)} of requests limited; top key holds only ${pct(top?.share_of_429s)} of 429s`, `busiest key averages ${Math.round(maxAvgRps * 100) / 100} req/s vs refill ${config.rateLimit.refillPerSecond}/s, capacity ${config.rateLimit.capacity}`],
        proposal: {
          changes: [
            { path: "rateLimit.refillPerSecond", from: config.rateLimit.refillPerSecond, to: refill },
            { path: "rateLimit.capacity", from: config.rateLimit.capacity, to: capacity },
          ],
          rationale: "Size the bucket to observed per-tenant demand with 1.5x headroom on the sustained rate and room for bursts.",
        },
      });
    }
  }

  findings.sort((a, b) => b.score - a.score);
  const top = findings[0];
  if (!top) {
    return {
      question,
      mode: "deterministic",
      plan,
      root_cause: "healthy",
      summary: "No incident detected: hit ratio stable, providers healthy, no rate-limit pressure.",
      evidence: [`hit ratio ${pct(overview.hit_ratio)} (${pct(windows.baseline)} -> ${pct(windows.recent)})`, `429 share ${pct(limits.rate_limited_share)}`, `fallback share ${pct(providers.fallback_share)}`],
      proposal: null,
      other_findings: [],
      tool_outputs: outputs,
    };
  }
  return {
    question,
    mode: "deterministic",
    plan,
    root_cause: top.root_cause,
    summary: top.summary,
    evidence: top.evidence,
    proposal: top.proposal,
    client_action: top.client_action,
    other_findings: findings.slice(1).map(({ root_cause, score, summary }) => ({ root_cause, score, summary })),
    tool_outputs: outputs,
  };
}
