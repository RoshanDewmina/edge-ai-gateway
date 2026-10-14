/**
 * Optional LLM planner. The model chooses which typed tools to run and writes the diagnosis; the
 * tools themselves stay deterministic, and any proposed change goes through the same allowlist
 * validation and is never applied without --apply. Not exercised by tests or evals (no API key).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { GatewayConfig } from "../src/config";
import type { LogEvent } from "../src/types";
import { ROOT_CAUSES, type Diagnosis, type RootCause } from "./planner";
import { getPath, validateProposal, type Proposal } from "./proposal";
import { TOOLS, type ToolContext } from "./tools";

interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface Submission {
  root_cause: RootCause;
  summary: string;
  evidence: string[];
  changes: { path: string; to: unknown }[];
  rationale: string;
  client_action: string;
}

export interface LlmBackend {
  /** Runs a tool loop until the model calls submit_diagnosis; returns its arguments. */
  run(system: string, user: string, tools: ToolSpec[], exec: (name: string, input: unknown) => string): Promise<Submission>;
}

const SUBMIT: ToolSpec = {
  name: "submit_diagnosis",
  description: "Submit the final diagnosis. Call exactly once, after gathering evidence with the other tools.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["root_cause", "summary", "evidence", "changes", "rationale", "client_action"],
    properties: {
      root_cause: { type: "string", enum: [...ROOT_CAUSES] },
      summary: { type: "string" },
      evidence: { type: "array", items: { type: "string" } },
      changes: {
        type: "array",
        description: "Config changes as dotted paths into gateway.config.json, e.g. cache.ttlSeconds. Empty if the fix is not a gateway config change.",
        items: { type: "object", additionalProperties: false, required: ["path", "to"], properties: { path: { type: "string" }, to: {} } },
      },
      rationale: { type: "string" },
      client_action: { type: "string", description: "What to tell the client team, or empty." },
    },
  },
};

const SYSTEM = `You are the on-call copilot for an edge LLM gateway (response cache, per-key rate limiter, multi-provider fallback).
Diagnose the operator's question using only the provided tools; every claim must cite numbers from tool output.
Start with cache_overview, provider_health and rate_limit_hot_keys, then drill down. Prefer "healthy" when evidence is weak.
Propose a config change only when the gateway config is the cause; client-side causes get client_action instead.
Finish by calling submit_diagnosis. Changes are reviewed by a human and are never applied automatically.`;

export class AnthropicBackend implements LlmBackend {
  private client = new Anthropic();
  constructor(private model = process.env.COPILOT_MODEL ?? "claude-opus-5-5") {}

  async run(system: string, user: string, tools: ToolSpec[], exec: (name: string, input: unknown) => string): Promise<Submission> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
    for (let turn = 0; turn < 12; turn++) {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 16000,
        system,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        tools: tools.map((t) => ({ ...t, input_schema: t.input_schema as Anthropic.Tool.InputSchema })),
        messages,
      });
      if (res.stop_reason === "refusal") throw new Error("model declined the request");
      messages.push({ role: "assistant", content: res.content });
      const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const submit = calls.find((c) => c.name === SUBMIT.name);
      if (submit) return submit.input as Submission;
      if (calls.length === 0) {
        messages.push({ role: "user", content: "Call submit_diagnosis with your conclusion." });
        continue;
      }
      messages.push({
        role: "user",
        content: calls.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, content: exec(c.name, c.input) })),
      });
    }
    throw new Error("LLM did not submit a diagnosis within 12 turns");
  }
}

/** Any OpenAI-compatible /chat/completions endpoint (OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL). */
export class OpenAICompatibleBackend implements LlmBackend {
  constructor(
    private baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    private apiKey = process.env.OPENAI_API_KEY,
    private model = process.env.OPENAI_MODEL,
  ) {
    if (!apiKey || !model) throw new Error("set OPENAI_API_KEY and OPENAI_MODEL (and OPENAI_BASE_URL for non-OpenAI hosts)");
  }

  async run(system: string, user: string, tools: ToolSpec[], exec: (name: string, input: unknown) => string): Promise<Submission> {
    const messages: Record<string, unknown>[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    for (let turn = 0; turn < 12; turn++) {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        }),
      });
      if (!res.ok) throw new Error(`LLM endpoint returned ${res.status}`);
      const msg = ((await res.json()) as { choices: { message: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] }).choices[0].message;
      messages.push(msg as Record<string, unknown>);
      const calls = msg.tool_calls ?? [];
      const submit = calls.find((c) => c.function.name === SUBMIT.name);
      if (submit) return JSON.parse(submit.function.arguments) as Submission;
      if (calls.length === 0) {
        messages.push({ role: "user", content: "Call submit_diagnosis with your conclusion." });
        continue;
      }
      for (const c of calls) messages.push({ role: "tool", tool_call_id: c.id, content: exec(c.function.name, JSON.parse(c.function.arguments || "{}")) });
    }
    throw new Error("LLM did not submit a diagnosis within 12 turns");
  }
}

export async function llmDiagnose(question: string, logs: LogEvent[], config: GatewayConfig, backend: LlmBackend): Promise<Diagnosis> {
  const ctx: ToolContext = { logs: [...logs].sort((a, b) => a.ts - b.ts), config };
  const plan: Diagnosis["plan"] = [];
  const outputs: Record<string, unknown> = {};
  const exec = (name: string, input: unknown) => {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return JSON.stringify({ error: `unknown tool ${name}` });
    const args = (input ?? {}) as Record<string, unknown>;
    plan.push({ tool: name, args, reason: "chosen by LLM" });
    const out = tool.run(ctx, args);
    outputs[name] = out;
    return JSON.stringify(out);
  };
  const specs: ToolSpec[] = [...TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })), SUBMIT];
  const user = `Question: ${question}\nLog lines: ${logs.length}\nCurrent config:\n${JSON.stringify(config, null, 2)}`;
  const s = await backend.run(SYSTEM, user, specs, exec);

  let proposal: Proposal | null = s.changes.length
    ? { changes: s.changes.map((c) => ({ path: c.path, from: getPath(config, c.path), to: c.to })), rationale: s.rationale }
    : null;
  const evidence = [...s.evidence];
  if (proposal) {
    const errors = validateProposal(config, proposal);
    if (errors.length) {
      evidence.push(`LLM proposal rejected by validator: ${errors.join("; ")}`);
      proposal = null;
    }
  }
  return {
    question,
    mode: "llm",
    plan,
    root_cause: ROOT_CAUSES.includes(s.root_cause) ? s.root_cause : "healthy",
    summary: s.summary,
    evidence,
    proposal,
    client_action: s.client_action || undefined,
    other_findings: [],
    tool_outputs: outputs,
  };
}
