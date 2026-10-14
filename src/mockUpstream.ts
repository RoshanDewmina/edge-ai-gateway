import { shortHash } from "./hash";

export interface MockOptions {
  latencyMs: number;
  failureRate: number;
  jitter?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simulated OpenAI-compatible provider. Never calls a real model. */
export async function mockCompletion(bodyText: string, opts: MockOptions, provider: string, rand: () => number = Math.random): Promise<Response> {
  const jitter = opts.jitter ?? 0.1;
  await sleep(Math.max(0, opts.latencyMs * (1 + (rand() * 2 - 1) * jitter)));
  if (rand() < opts.failureRate) {
    return Response.json({ error: { message: `${provider} simulated failure`, type: "server_error" } }, { status: 503 });
  }
  let body: { model?: string; messages?: Array<{ content?: unknown }> };
  try {
    body = JSON.parse(bodyText);
  } catch {
    return Response.json({ error: { message: "invalid JSON", type: "invalid_request_error" } }, { status: 400 });
  }
  const prompt = JSON.stringify(body.messages ?? []);
  const h = await shortHash(prompt, 8);
  return Response.json({
    id: `chatcmpl-mock-${h}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? "mock-model",
    choices: [{ index: 0, message: { role: "assistant", content: `Mock answer ${h} from ${provider}.` }, finish_reason: "stop" }],
    usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: 8, total_tokens: Math.ceil(prompt.length / 4) + 8 },
  });
}

/** Handles `mock://<provider>?latencyMs=..&failureRate=..` URLs in-process (dev + tests). */
export function mockFetchFromUrl(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url);
  const provider = u.host || u.pathname.replace(/^\/+/, "");
  const opts: MockOptions = {
    latencyMs: Number(u.searchParams.get("latencyMs") ?? 50),
    failureRate: Number(u.searchParams.get("failureRate") ?? 0),
  };
  return withAbort(mockCompletion(String(init.body ?? ""), opts, provider), init.signal ?? undefined);
}

function withAbort(p: Promise<Response>, signal?: AbortSignal): Promise<Response> {
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    p.then(resolve, reject);
  });
}
