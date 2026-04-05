import type { CircuitBreakerConfig } from "./types.ts";

export class CircuitBreaker {
  private failures = 0;
  private openUntil: number | null = null;

  constructor(private config: CircuitBreakerConfig) {}

  /** Returns true if this provider should be skipped. */
  isOpen(): boolean {
    if (!this.config.enabled) return false;
    if (this.openUntil === null) return false;
    if (Date.now() < this.openUntil) return true;
    // Half-open: reset openUntil so the next call is a probe
    this.openUntil = null;
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openUntil = null;
  }

  recordFailure(): void {
    if (!this.config.enabled) return;
    this.failures += 1;
    if (this.failures >= this.config.failureThreshold) {
      this.openUntil = Date.now() + this.config.resetAfterMs;
    }
  }
}
