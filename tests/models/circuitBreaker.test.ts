import { describe, test, expect } from "bun:test";
import { CircuitBreaker } from "../../src/models/circuitBreaker";

describe("CircuitBreaker", () => {
  test("starts closed — allows calls", () => {
    const cb = new CircuitBreaker({ enabled: true, failureThreshold: 3, resetAfterMs: 60_000 });
    expect(cb.isOpen()).toBe(false);
  });

  test("opens after failureThreshold consecutive failures", () => {
    const cb = new CircuitBreaker({ enabled: true, failureThreshold: 2, resetAfterMs: 60_000 });
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false);
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });

  test("success resets failure count", () => {
    const cb = new CircuitBreaker({ enabled: true, failureThreshold: 2, resetAfterMs: 60_000 });
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false); // reset to 0 then 1 failure — not open
  });

  test("half-open after resetAfterMs: allows one probe", () => {
    const cb = new CircuitBreaker({ enabled: true, failureThreshold: 1, resetAfterMs: 1 });
    cb.recordFailure(); // open
    // wait for resetAfterMs to pass
    const start = Date.now();
    while (Date.now() - start < 5) {} // busy-wait 5ms
    expect(cb.isOpen()).toBe(false); // half-open → allows probe
  });

  test("disabled circuit breaker never opens", () => {
    const cb = new CircuitBreaker({ enabled: false, failureThreshold: 1, resetAfterMs: 100 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false);
  });
});
