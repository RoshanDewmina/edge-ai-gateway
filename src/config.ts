import defaults from "../gateway.config.json";

export interface UpstreamConfig {
  name: string;
  url: string;
  timeoutMs: number;
  enabled: boolean;
  apiKeyEnv?: string;
}

export interface GatewayConfig {
  cache: {
    enabled: boolean;
    ttlSeconds: number;
    staleWhileRevalidateSeconds: number;
    maxCacheableTemperature: number;
    scope: "tenant" | "global";
    keyVersion: number;
    caseFold: boolean;
    ignoreFields: string[];
  };
  rateLimit: { capacity: number; refillPerSecond: number };
  upstreams: UpstreamConfig[];
  fallback: { enabled: boolean };
  circuitBreaker: { failureThreshold: number; cooldownMs: number };
}

export const DEFAULT_CONFIG = defaults as GatewayConfig;

export type EnvOverrides = Partial<
  Record<
    | "PRIMARY_URL"
    | "SECONDARY_URL"
    | "RATE_LIMIT_CAPACITY"
    | "RATE_LIMIT_REFILL_PER_SEC"
    | "FALLBACK_ENABLED"
    | "CACHE_TTL_SECONDS"
    | "UPSTREAM_TIMEOUT_MS"
    | "CIRCUIT_FAILURE_THRESHOLD",
    string
  >
>;

export function resolveConfig(env: EnvOverrides, base: GatewayConfig = DEFAULT_CONFIG): GatewayConfig {
  const cfg: GatewayConfig = structuredClone(base);
  const num = (v: string | undefined) => (v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined);
  const byName = (n: string) => cfg.upstreams.find((u) => u.name === n);

  if (env.PRIMARY_URL && byName("primary")) byName("primary")!.url = env.PRIMARY_URL;
  if (env.SECONDARY_URL && byName("secondary")) byName("secondary")!.url = env.SECONDARY_URL;
  const timeout = num(env.UPSTREAM_TIMEOUT_MS);
  if (timeout !== undefined) cfg.upstreams.forEach((u) => (u.timeoutMs = timeout));
  cfg.rateLimit.capacity = num(env.RATE_LIMIT_CAPACITY) ?? cfg.rateLimit.capacity;
  cfg.rateLimit.refillPerSecond = num(env.RATE_LIMIT_REFILL_PER_SEC) ?? cfg.rateLimit.refillPerSecond;
  cfg.cache.ttlSeconds = num(env.CACHE_TTL_SECONDS) ?? cfg.cache.ttlSeconds;
  cfg.circuitBreaker.failureThreshold = num(env.CIRCUIT_FAILURE_THRESHOLD) ?? cfg.circuitBreaker.failureThreshold;
  if (env.FALLBACK_ENABLED !== undefined) cfg.fallback.enabled = env.FALLBACK_ENABLED !== "false";
  return cfg;
}
