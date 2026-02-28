/**
 * Unit tests for src/utils/tracer.ts + config/observability.ts
 *
 * Tests the config-based setup (log path, retention, enabled flag)
 * and the observable behaviour of trace() and generateTraceId().
 *
 * Run: bun test src/utils/tracer.test.ts
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mock config to control what tracer reads ─────────────────────────────────

mock.module("../../config/observability.ts", () => ({
  getObservabilityConfig: () => ({
    logDir: "/tmp/test-relay-logs",
    retentionDays: 7,
    enabled: false,
  }),
}));

const { generateTraceId, trace } = await import("./tracer.ts");

// ── generateTraceId ───────────────────────────────────────────────────────────

describe("generateTraceId", () => {
  test("returns a UUID v4 format string", () => {
    const id = generateTraceId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  test("returns a unique ID on each call", () => {
    const ids = Array.from({ length: 10 }, generateTraceId);
    const unique = new Set(ids);
    expect(unique.size).toBe(10);
  });

  test("returns a string of exactly 36 characters", () => {
    expect(generateTraceId().length).toBe(36);
  });
});

// ── trace (disabled) ──────────────────────────────────────────────────────────

describe("trace (observability disabled)", () => {
  test("does not throw when called with an event payload", () => {
    expect(() =>
      trace({ event: "test_event", chatId: 123, data: "hello" })
    ).not.toThrow();
  });

  test("does not throw when called with an empty object", () => {
    expect(() => trace({})).not.toThrow();
  });

  test("does not throw when called repeatedly", () => {
    expect(() => {
      for (let i = 0; i < 5; i++) {
        trace({ event: "loop_event", i });
      }
    }).not.toThrow();
  });
});
