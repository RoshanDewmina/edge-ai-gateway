export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
}

/** Consecutive-failure breaker. State lives per isolate (see README limitations). */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  state: BreakerState = "closed";

  constructor(private readonly opts: BreakerOptions) {}

  canRequest(now: number): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open" && now - this.openedAt >= this.opts.cooldownMs) {
      this.state = "half-open";
      this.trialInFlight = false;
    }
    if (this.state === "half-open" && !this.trialInFlight) {
      this.trialInFlight = true;
      return true;
    }
    return false;
  }

  onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
    this.trialInFlight = false;
  }

  onFailure(now: number): void {
    this.failures++;
    if (this.state === "half-open" || this.failures >= this.opts.failureThreshold) {
      this.state = "open";
      this.openedAt = now;
      this.trialInFlight = false;
    }
  }
}
