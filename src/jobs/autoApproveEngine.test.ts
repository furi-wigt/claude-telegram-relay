import { describe, test, expect } from "bun:test";
import { AutoApproveEngine, type AutoApproveRule } from "./autoApproveEngine.ts";
import type { Job } from "./types.ts";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "test-id",
    dedup_key: null,
    source: "cron",
    type: "routine",
    priority: "normal",
    executor: "log-cleanup",
    title: "Log Cleanup",
    payload: {},
    status: "awaiting-intervention",
    intervention_type: "approval",
    intervention_prompt: "Confirm?",
    intervention_due_at: null,
    auto_resolve_policy: null,
    auto_resolve_timeout_ms: null,
    retry_count: 0,
    timeout_ms: 300000,
    created_at: "2026-04-12T00:00:00Z",
    started_at: "2026-04-12T00:01:00Z",
    completed_at: null,
    error: null,
    metadata: null,
    ...overrides,
  };
}

describe("AutoApproveEngine", () => {
  test("matches by executor + intervention_type", () => {
    const rules: AutoApproveRule[] = [
      { executor: "log-cleanup", intervention_types: ["approval"], action: "confirm" },
    ];
    const engine = new AutoApproveEngine(rules);
    const result = engine.evaluate(makeJob());
    expect(result).toBe("confirm");
  });

  test("returns null when no rules match", () => {
    const rules: AutoApproveRule[] = [
      { executor: "orphan-gc", intervention_types: ["approval"], action: "confirm" },
    ];
    const engine = new AutoApproveEngine(rules);
    const result = engine.evaluate(makeJob({ executor: "log-cleanup" }));
    expect(result).toBeNull();
  });

  test("matches by source", () => {
    const rules: AutoApproveRule[] = [
      { source: "cron", intervention_types: ["budget"], action: "confirm" },
    ];
    const engine = new AutoApproveEngine(rules);
    const result = engine.evaluate(makeJob({ intervention_type: "budget" }));
    expect(result).toBe("confirm");
  });

  test("does not match when intervention_type is wrong", () => {
    const rules: AutoApproveRule[] = [
      { executor: "log-cleanup", intervention_types: ["approval"], action: "confirm" },
    ];
    const engine = new AutoApproveEngine(rules);
    const result = engine.evaluate(makeJob({ intervention_type: "clarification" }));
    expect(result).toBeNull();
  });

  test("returns null when rules are empty", () => {
    const engine = new AutoApproveEngine([]);
    expect(engine.evaluate(makeJob())).toBeNull();
  });

  test("first matching rule wins", () => {
    const rules: AutoApproveRule[] = [
      { executor: "log-cleanup", intervention_types: ["approval"], action: "skip" },
      { executor: "log-cleanup", intervention_types: ["approval"], action: "confirm" },
    ];
    const engine = new AutoApproveEngine(rules);
    expect(engine.evaluate(makeJob())).toBe("skip");
  });
});
