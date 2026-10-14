import type { GatewayConfig } from "./config";
import { canonicalJson, sha256Hex, shortHash } from "./hash";

export type ChatBody = Record<string, unknown> & {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown; [k: string]: unknown }>;
  temperature?: number;
  stream?: boolean;
};

export interface CacheKeyResult {
  key: string;
  promptHash: string;
  fieldHashes: Record<string, string>;
}

const PROVIDER_DEFAULT_TEMPERATURE = 1;

export function normalizeText(text: string, caseFold: boolean): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return caseFold ? collapsed.toLowerCase() : collapsed;
}

function normalizeContent(content: unknown, caseFold: boolean): unknown {
  if (typeof content === "string") return normalizeText(content, caseFold);
  if (Array.isArray(content)) {
    return content.map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"
        ? { ...(part as object), text: normalizeText((part as { text: string }).text, caseFold) }
        : part,
    );
  }
  return content;
}

export function removeField(obj: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur || typeof cur !== "object") return;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  if (cur && typeof cur === "object") delete (cur as Record<string, unknown>)[parts[parts.length - 1]];
}

/**
 * Denylist, not allowlist: every field except the configured ignoreFields is part of the key,
 * so an unknown parameter that changes the output (response_format, tools, ...) can never be
 * answered from a cache entry produced without it.
 */
export function normalizeBody(body: ChatBody, cfg: GatewayConfig["cache"]): Record<string, unknown> {
  const out = structuredClone(body) as Record<string, unknown>;
  for (const f of cfg.ignoreFields) removeField(out, f);
  delete out.stream;
  if (typeof out.model === "string") out.model = out.model.trim().toLowerCase();
  if (out.temperature === undefined) out.temperature = PROVIDER_DEFAULT_TEMPERATURE;
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m) => {
      const msg = { ...(m as Record<string, unknown>) };
      if (typeof msg.role === "string") msg.role = msg.role.trim().toLowerCase();
      msg.content = normalizeContent(msg.content, cfg.caseFold);
      return msg;
    });
  }
  return out;
}

export async function buildCacheKey(body: ChatBody, cfg: GatewayConfig["cache"], tenant: string): Promise<CacheKeyResult> {
  const normalized = normalizeBody(body, cfg);
  const scope = cfg.scope === "tenant" ? tenant : "*";
  const key = await sha256Hex(canonicalJson({ v: cfg.keyVersion, scope, body: normalized }));
  const fieldHashes: Record<string, string> = {};
  for (const [field, value] of Object.entries(normalized)) fieldHashes[field] = await shortHash(canonicalJson(value), 8);
  return { key, promptHash: fieldHashes.messages ?? "none", fieldHashes };
}

export type CacheDecision =
  | { cacheable: true; read: boolean; maxAgeSeconds?: number }
  | { cacheable: false; reason: "no-store" | "nondeterministic" | "disabled" };

export interface ClientCacheControl {
  noStore: boolean;
  noCache: boolean;
  maxAge?: number;
}

export function parseCacheControl(header: string | null): ClientCacheControl {
  const out: ClientCacheControl = { noStore: false, noCache: false };
  if (!header) return out;
  for (const raw of header.toLowerCase().split(",")) {
    const [name, value] = raw.trim().split("=");
    if (name === "no-store") out.noStore = true;
    else if (name === "no-cache") out.noCache = true;
    else if (name === "max-age" && value !== undefined && /^\d+$/.test(value)) out.maxAge = Number(value);
  }
  return out;
}

export function decideCaching(body: ChatBody, cc: ClientCacheControl, cfg: GatewayConfig["cache"]): CacheDecision {
  if (!cfg.enabled) return { cacheable: false, reason: "disabled" };
  if (cc.noStore) return { cacheable: false, reason: "no-store" };
  const temperature = typeof body.temperature === "number" ? body.temperature : PROVIDER_DEFAULT_TEMPERATURE;
  if (temperature > cfg.maxCacheableTemperature) return { cacheable: false, reason: "nondeterministic" };
  return { cacheable: true, read: !cc.noCache, maxAgeSeconds: cc.maxAge };
}
