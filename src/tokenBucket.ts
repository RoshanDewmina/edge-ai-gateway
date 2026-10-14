export interface BucketConfig {
  capacity: number;
  refillPerSecond: number;
}

export interface BucketState {
  tokens: number;
  updatedAt: number;
}

export interface TakeResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  state: BucketState;
}

export function takeToken(prev: BucketState | undefined, nowMs: number, cfg: BucketConfig, cost = 1): TakeResult {
  const start = prev ?? { tokens: cfg.capacity, updatedAt: nowMs };
  const elapsed = Math.max(0, nowMs - start.updatedAt) / 1000;
  const tokens = Math.min(cfg.capacity, start.tokens + elapsed * cfg.refillPerSecond);
  if (tokens >= cost) {
    const state = { tokens: tokens - cost, updatedAt: nowMs };
    return { allowed: true, remaining: Math.floor(state.tokens), retryAfterSeconds: 0, state };
  }
  const deficit = cost - tokens;
  const retryAfterSeconds = cfg.refillPerSecond > 0 ? Math.ceil(deficit / cfg.refillPerSecond) : 3600;
  return { allowed: false, remaining: 0, retryAfterSeconds, state: { tokens, updatedAt: nowMs } };
}
