import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { diagnose, type Diagnosis } from "../copilot/planner";
import { getPath, validateProposal } from "../copilot/proposal";
import type { GatewayConfig } from "../src/config";
import { simulate, type ExpectedFix, type Scenario } from "./simulate";

const DIR = new URL("./scenarios/", import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function loadScenarios(): Scenario[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(DIR + f, "utf8")));
}

function fixCorrect(expected: ExpectedFix | null, d: Diagnosis, config: GatewayConfig): { ok: boolean; why: string } {
  if (expected === null) return d.proposal === null ? { ok: true, why: "correctly proposed no config change" } : { ok: false, why: "proposed a config change where none is warranted" };
  if (!d.proposal) return { ok: false, why: "no proposal" };
  const errors = validateProposal(config, d.proposal);
  if (errors.length) return { ok: false, why: `invalid proposal: ${errors.join("; ")}` };
  const c = d.proposal.changes.find((x) => x.path === expected.path);
  if (!c) return { ok: false, why: `did not change ${expected.path}` };
  const current = getPath(config, expected.path);
  if (expected.contains !== undefined && !(Array.isArray(c.to) && c.to.includes(expected.contains))) return { ok: false, why: `${expected.path} lacks ${expected.contains}` };
  if (expected.equals !== undefined && c.to !== expected.equals) return { ok: false, why: `${expected.path} = ${JSON.stringify(c.to)}` };
  if (expected.gte !== undefined && !(typeof c.to === "number" && c.to >= expected.gte)) return { ok: false, why: `${expected.path} = ${c.to} < ${expected.gte}` };
  if (expected.gtCurrent && !(typeof c.to === "number" && typeof current === "number" && c.to > current)) return { ok: false, why: `${expected.path} not increased` };
  return { ok: true, why: `${expected.path}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}` };
}

const scenarios = loadScenarios();
const emit = flag("emit");
if (emit) {
  const s = scenarios.find((x) => x.id === emit);
  if (!s) throw new Error(`unknown scenario ${emit}; known: ${scenarios.map((x) => x.id).join(", ")}`);
  const { logs, finalConfig } = await simulate(s);
  const out = flag("out") ?? `${s.id}.ndjson`;
  writeFileSync(out, logs.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(out.replace(/\.ndjson$/, "") + ".config.json", JSON.stringify(finalConfig, null, 2) + "\n");
  console.log(`wrote ${logs.length} log lines to ${out} and the scenario's live config to ${out.replace(/\.ndjson$/, "")}.config.json`);
  process.exit(0);
}

const rows = [];
for (const s of scenarios) {
  const { logs, finalConfig } = await simulate(s);
  const d = diagnose(s.question, logs, finalConfig);
  const rootOk = d.root_cause === s.expected.root_cause;
  const fix = fixCorrect(s.expected.fix, d, finalConfig);
  rows.push({
    id: s.id,
    question: s.question,
    log_lines: logs.length,
    expected_root_cause: s.expected.root_cause,
    predicted_root_cause: d.root_cause,
    root_cause_correct: rootOk,
    fix_correct: fix.ok,
    fix_detail: fix.why,
    tools_called: d.plan.map((p) => p.tool),
    other_findings: d.other_findings.map((f) => f.root_cause),
    summary: d.summary,
  });
}

const sweepSeeds = Number(flag("seeds") ?? 10);
const sweep = { seeds_per_scenario: sweepSeeds, runs: 0, root_cause_correct: 0, fix_correct: 0, failures: [] as { id: string; seed: number; predicted: string; fix: string }[] };
for (const s of scenarios) {
  for (let k = 1; k <= sweepSeeds; k++) {
    const variant = { ...s, traffic: { ...s.traffic, seed: s.traffic.seed * 1000 + k } };
    const { logs, finalConfig } = await simulate(variant);
    const d = diagnose(s.question, logs, finalConfig);
    const fix = fixCorrect(s.expected.fix, d, finalConfig);
    sweep.runs++;
    if (d.root_cause === s.expected.root_cause) sweep.root_cause_correct++;
    if (fix.ok) sweep.fix_correct++;
    if (d.root_cause !== s.expected.root_cause || !fix.ok) sweep.failures.push({ id: s.id, seed: variant.traffic.seed, predicted: d.root_cause, fix: fix.why });
  }
}

const n = rows.length;
const rootAcc = rows.filter((r) => r.root_cause_correct).length;
const fixAcc = rows.filter((r) => r.fix_correct).length;
const result = {
  run_at: new Date().toISOString(),
  mode: "deterministic (no LLM, no API key)",
  scenarios: n,
  root_cause_accuracy: `${rootAcc}/${n}`,
  fix_accuracy: `${fixAcc}/${n}`,
  caveat: "Scenarios and diagnostic rules were written by the same author; this is a regression suite for the copilot, not an independent benchmark of diagnostic skill.",
  results: rows,
  seed_sweep: sweep,
};
writeFileSync(new URL("./results.json", import.meta.url).pathname, JSON.stringify(result, null, 2) + "\n");

console.log(`| Scenario | Expected root cause | Predicted | Root cause | Fix |`);
console.log(`|---|---|---|---|---|`);
for (const r of rows)
  console.log(`| ${r.id} | ${r.expected_root_cause} | ${r.predicted_root_cause} | ${r.root_cause_correct ? "pass" : "FAIL"} | ${r.fix_correct ? "pass" : "FAIL"} (${r.fix_detail}) |`);
console.log(`\nroot cause accuracy ${rootAcc}/${n}, fix accuracy ${fixAcc}/${n}`);
console.log(`seed sweep (${sweep.runs} runs, ${sweepSeeds} extra seeds per scenario): root cause ${sweep.root_cause_correct}/${sweep.runs}, fix ${sweep.fix_correct}/${sweep.runs}`);
for (const f of sweep.failures) console.log(`  miss: ${f.id} seed ${f.seed} -> ${f.predicted} (${f.fix})`);
if (rootAcc !== n || fixAcc !== n) process.exitCode = 1;
