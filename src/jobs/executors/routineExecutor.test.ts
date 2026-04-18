// src/jobs/executors/routineExecutor.test.ts
import { describe, test, expect } from "bun:test";
import { RoutineExecutor, resolveHandlerPath } from "./routineExecutor.ts";
import type { Job } from "../types.ts";

function makeJob(executor: string, payload: Record<string, unknown> = {}): Job {
  return {
    id: "test-job",
    dedup_key: null,
    source: "cron",
    type: "routine",
    priority: "normal",
    executor,
    title: executor,
    payload,
    status: "running",
    intervention_type: null,
    intervention_prompt: null,
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
  };
}

describe("RoutineExecutor", () => {
  test("has correct type and maxConcurrent", () => {
    const executor = new RoutineExecutor();
    expect(executor.type).toBe("routine");
    expect(executor.maxConcurrent).toBe(3);
  });

  test("executes inline handler function", async () => {
    const executor = new RoutineExecutor();
    executor.registerHandler("test-handler", async () => {
      return "handler ran";
    });

    const result = await executor.execute(makeJob("test-handler"));
    expect(result.status).toBe("done");
  });

  test("returns failed when handler throws", async () => {
    const executor = new RoutineExecutor();
    executor.registerHandler("fail-handler", async () => {
      throw new Error("boom");
    });

    const result = await executor.execute(makeJob("fail-handler"));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("boom");
  });

  test("returns failed when handler not found", async () => {
    const executor = new RoutineExecutor();
    const result = await executor.execute(makeJob("nonexistent"));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("no handler registered");
  });
});

describe("resolveHandlerPath", () => {
  test("resolves core handler from routines/handlers/", () => {
    const result = resolveHandlerPath("watchdog");
    expect(result).not.toBeNull();
    expect(result!.source).toBe("core");
  });

  test("rejects names with path traversal", () => {
    expect(resolveHandlerPath("../../../etc/passwd")).toBeNull();
    expect(resolveHandlerPath("foo/bar")).toBeNull();
    expect(resolveHandlerPath("foo\\bar")).toBeNull();
  });

  test("returns null for nonexistent handler", () => {
    expect(resolveHandlerPath("does-not-exist-xyz")).toBeNull();
  });
});
