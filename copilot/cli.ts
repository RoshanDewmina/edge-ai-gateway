import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { GatewayConfig } from "../src/config";
import type { LogEvent } from "../src/types";
import { AnthropicBackend, llmDiagnose, OpenAICompatibleBackend } from "./llm";
import { diagnose, type Diagnosis } from "./planner";
import { applyProposal, formatConfig, renderDiff, validateProposal } from "./proposal";

const USAGE = `usage: bun run copilot -- "<question>" [--logs file.ndjson | --gateway http://127.0.0.1:8787]
                      [--config gateway.config.json] [--llm anthropic|openai] [--json] [--apply]

Deterministic by default (no API key, no network beyond --gateway). --llm opts into an LLM planner.
Proposed config changes are printed as a diff and only written when you pass --apply.`;

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const valued = new Set(["logs", "gateway", "config", "llm"]);
const question = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && valued.has(argv[i - 1].replace(/^--/, ""))));
if (!question || has("help")) {
  console.log(USAGE);
  process.exit(question ? 0 : 1);
}

const configPath = opt("config") ?? "gateway.config.json";
const configText = readFileSync(configPath, "utf8");
const config = JSON.parse(configText) as GatewayConfig;

async function loadLogs(): Promise<LogEvent[]> {
  const file = opt("logs");
  const text = file
    ? readFileSync(file, "utf8")
    : await (async () => {
        const base = opt("gateway") ?? "http://127.0.0.1:8787";
        const res = await fetch(`${base}/admin/logs?limit=5000`).catch(() => null);
        if (!res?.ok) throw new Error(`could not read logs from ${base}/admin/logs; pass --logs <file.ndjson>`);
        return res.text();
      })();
  return text
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l) as LogEvent);
}

const logs = await loadLogs();
const llm = opt("llm");
const d: Diagnosis = llm
  ? await llmDiagnose(question, logs, config, llm === "openai" ? new OpenAICompatibleBackend() : new AnthropicBackend())
  : diagnose(question, logs, config);

if (has("json")) {
  console.log(JSON.stringify(d, null, 2));
} else {
  console.log(`Question: ${d.question}`);
  console.log(`Mode: ${d.mode}${d.mode === "deterministic" ? " (rule-based planner, no LLM)" : ""}   Logs: ${logs.length} lines`);
  console.log(`\nPlan:`);
  d.plan.forEach((p, i) => console.log(`  ${i + 1}. ${p.tool}(${Object.keys(p.args).length ? JSON.stringify(p.args) : ""})  - ${p.reason}`));
  console.log(`\nRoot cause: ${d.root_cause}`);
  console.log(`  ${d.summary}`);
  console.log(`Evidence:`);
  d.evidence.forEach((e) => console.log(`  - ${e}`));
  if (d.other_findings.length) console.log(`Also seen: ${d.other_findings.map((f) => f.root_cause).join(", ")}`);
  if (d.client_action) console.log(`\nRecommended action (outside the gateway): ${d.client_action}`);
}

if (!d.proposal) {
  if (!has("json")) console.log(`\nNo gateway config change proposed.`);
  process.exit(0);
}

const errors = validateProposal(config, d.proposal);
if (errors.length) {
  console.error(`Proposal rejected by validator: ${errors.join("; ")}`);
  process.exit(2);
}
const next = applyProposal(config, d.proposal);
if (!has("json")) {
  console.log(`\nProposed config change (${d.proposal.rationale})`);
  console.log(renderDiff(formatConfig(config), formatConfig(next), configPath.split("/").pop()));
}
if (has("apply")) {
  if (!existsSync(configPath)) throw new Error(`${configPath} not found`);
  writeFileSync(configPath, formatConfig(next));
  console.error(`\nApplied to ${configPath}. Redeploy (or restart wrangler dev) to take effect.`);
} else if (!has("json")) {
  console.log(`\nNot applied. Re-run with --apply to write ${configPath}.`);
}
