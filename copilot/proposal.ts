import type { GatewayConfig } from "../src/config";

export interface ConfigChange {
  path: string;
  from: unknown;
  to: unknown;
}

export interface Proposal {
  changes: ConfigChange[];
  rationale: string;
}

const RULES: { pattern: RegExp; valid: (v: unknown) => boolean }[] = [
  { pattern: /^cache\.ttlSeconds$/, valid: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 86_400 },
  { pattern: /^cache\.staleWhileRevalidateSeconds$/, valid: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 86_400 },
  { pattern: /^cache\.ignoreFields$/, valid: (v) => Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "messages" && x !== "model") },
  { pattern: /^rateLimit\.(capacity|refillPerSecond)$/, valid: (v) => typeof v === "number" && v > 0 && v <= 100_000 },
  { pattern: /^upstreams\.\d+\.enabled$/, valid: (v) => typeof v === "boolean" },
  { pattern: /^upstreams\.\d+\.timeoutMs$/, valid: (v) => Number.isInteger(v) && (v as number) >= 100 && (v as number) <= 120_000 },
  { pattern: /^circuitBreaker\.(failureThreshold|cooldownMs)$/, valid: (v) => Number.isInteger(v) && (v as number) >= 1 },
];

export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined), obj);
}

/** Rejects anything outside a small allowlist, so neither the rules nor an LLM can propose arbitrary edits. */
export function validateProposal(config: GatewayConfig, p: Proposal): string[] {
  const errors: string[] = [];
  for (const c of p.changes) {
    const rule = RULES.find((r) => r.pattern.test(c.path));
    if (!rule) errors.push(`${c.path}: path is not tunable by the copilot`);
    else if (getPath(config, c.path) === undefined) errors.push(`${c.path}: does not exist in config`);
    else if (!rule.valid(c.to)) errors.push(`${c.path}: invalid value ${JSON.stringify(c.to)}`);
  }
  const enabledAfter = applyProposal(config, p).upstreams.filter((u) => u.enabled).length;
  if (enabledAfter === 0) errors.push("proposal would disable every upstream");
  return errors;
}

export function applyProposal(config: GatewayConfig, p: Proposal): GatewayConfig {
  const next = structuredClone(config);
  for (const c of p.changes) {
    const keys = c.path.split(".");
    const parent = keys.slice(0, -1).reduce<any>((cur, k) => cur?.[k], next);
    if (parent && typeof parent === "object") parent[keys[keys.length - 1]] = structuredClone(c.to);
  }
  return next;
}

export function renderDiff(beforeText: string, afterText: string, file = "gateway.config.json"): string {
  const a = beforeText.split("\n");
  const b = afterText.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [`--- a/${file}`, `+++ b/${file}`];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1])) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  const changed = out.map((l, idx) => (l.startsWith("+ ") || l.startsWith("- ") ? idx : -1)).filter((x) => x >= 0);
  return out.filter((_, idx) => idx < 2 || changed.some((c) => Math.abs(c - idx) <= 2)).join("\n");
}

export const formatConfig = (c: GatewayConfig) => JSON.stringify(c, null, 2) + "\n";
