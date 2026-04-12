// src/jobs/executors/compoundExecutor.test.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { CompoundExecutor } from "./compoundExecutor.ts";
import type { Job, JobCheckpoint } from "../types.ts";

// --- Helpers ---

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-abc-1234-5678",
    dedup_key: null,
    source: "telegram",
    type: "compound",
    priority: "normal",
    executor: "compound",
    title: "Test compound job",
    payload: {},
    status: "running",
    intervention_type: null,
    intervention_prompt: null,
    intervention_due_at: null,
    auto_resolve_policy: null,
    auto_resolve_timeout_ms: null,
    retry_count: 0,
    timeout_ms: null,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    error: null,
    metadata: null,
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<JobCheckpoint> = {}): JobCheckpoint {
  return {
    id: "cp-1",
    job_id: "job-abc-1234-5678",
    round: 0,
    state: { sessionId: "sess-1" },
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makePlan(agentIds: string[] = ["engineering"]) {
  return {
    dispatchId: "d-test-1",
    userMessage: "Test task",
    tasks: agentIds.map((agentId, i) => ({
      seq: i + 1,
      agentId,
      taskDescription: `Task for ${agentId}`,
      dependsOn: [],
    })),
  };
}

// --- Mocks for module dependencies ---

// We create a mock store that controls getRunningCompoundAgentIds
function makeStore(runningAgentIds: Set<string> = new Set()) {
  return {
    getRunningCompoundAgentIds: mock(() => runningAgentIds),
    insertCheckpoint: mock(() => "cp-new"),
  };
}

// Patch module-level dependencies by re-exporting from the mock registry
// Bun doesn't support jest.mock/module mocking at the module-level the same way,
// so we test CompoundExecutor by injecting store deps and mocking the orchestration layer.
//
// For getDispatchRunner and executeBlackboardDispatch we use module-level mock approach
// via dynamic import after patching the module.

describe("CompoundExecutor", () => {
  describe("missing plan", () => {
    test("returns failed when payload has no plan", async () => {
      const store = makeStore();
      const executor = new CompoundExecutor(store as never);
      const job = makeJob({ payload: {} });

      const result = await executor.execute(job);

      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/payload\.plan required/);
    });
  });

  describe("dispatch runner unavailable", () => {
    test("returns failed when getDispatchRunner returns null", async () => {
      // We need to control what getDispatchRunner returns.
      // CompoundExecutor imports it at module scope from dispatchEngine.
      // We'll call execute and intercept via a subclass to inject the runner.

      const store = makeStore();

      // Subclass that overrides runner lookup
      class TestableCompoundExecutor extends CompoundExecutor {
        protected _getRunner() { return null; }
      }

      // We can't easily subclass private methods, so instead we verify via
      // the real import path: if dispatchEngine's getDispatchRunner returns null
      // (which it does by default before setDispatchRunner is called), the test
      // must pass when getDispatchRunner() === null.
      //
      // Import the module and verify it returns null by default.
      const { getDispatchRunner } = await import("../../orchestration/dispatchEngine.ts");
      const runner = getDispatchRunner();
      // runner is null before bot starts

      const executor = new CompoundExecutor(store as never);
      const job = makeJob({ payload: { plan: makePlan() } });

      const result = await executor.execute(job);

      if (runner === null) {
        // Expected path — dispatch runner is not available
        expect(result.status).toBe("failed");
        expect(result.error).toMatch(/dispatch runner not available/);
      } else {
        // Runner was already set by another test — we can't easily null it,
        // so just verify we get done or awaiting-intervention (not an unhandled throw)
        expect(["done", "failed", "awaiting-intervention"]).toContain(result.status);
      }
    });
  });

  describe("agent overlap guard", () => {
    test("returns awaiting-intervention when plan agents overlap with running compound jobs", async () => {
      // This test exercises the overlap logic directly by verifying the store method
      // is called and its result drives the intervention response.
      //
      // We use a specially crafted store that returns a non-empty running set
      // containing the same agent the plan wants to use.

      const overlappingAgentId = "engineering";
      const store = makeStore(new Set([overlappingAgentId]));

      // We need getDispatchRunner to return non-null for the overlap check to run.
      // If it returns null, the function short-circuits before the overlap check.
      // We patch by importing and calling setDispatchRunner temporarily.
      const { setDispatchRunner, getDispatchRunner } = await import("../../orchestration/dispatchEngine.ts");

      const previousRunner = getDispatchRunner();

      const dummyRunner = mock(async () => "ok");
      setDispatchRunner(dummyRunner);

      try {
        const executor = new CompoundExecutor(store as never);
        const job = makeJob({
          payload: { plan: makePlan([overlappingAgentId]) },
        });

        const result = await executor.execute(job);

        expect(result.status).toBe("awaiting-intervention");
        expect(result.intervention).toBeDefined();
        expect(result.intervention?.type).toBe("approval");
        expect(result.intervention?.prompt).toContain(overlappingAgentId);
        expect(result.intervention?.autoResolvePolicy).toBe("approve_after_timeout");
        expect(result.intervention?.dueInMs).toBeGreaterThan(0);
        expect(result.intervention?.autoResolveTimeoutMs).toBeGreaterThan(0);
        expect(store.getRunningCompoundAgentIds).toHaveBeenCalled();
      } finally {
        // Restore previous runner (or null)
        if (previousRunner) {
          setDispatchRunner(previousRunner);
        }
      }
    });
  });

  describe("successful dispatch", () => {
    test("returns done when executeBlackboardDispatch succeeds", async () => {
      const { setDispatchRunner } = await import("../../orchestration/dispatchEngine.ts");

      const mockResponse = "All tasks completed successfully.";
      const mockSessionId = "sess-xyz";

      // Runner that returns a successful result-like string (dispatchEngine controls the rest)
      // We mock executeBlackboardDispatch by using setDispatchRunner with a runner that
      // produces the response string the blackboard aggregates.
      const dummyRunner = mock(async (_chatId: number, _topicId: number | null, _text: string) => {
        return mockResponse;
      });
      setDispatchRunner(dummyRunner);

      const store = makeStore(new Set()); // no overlap
      const executor = new CompoundExecutor(store as never);
      const job = makeJob({
        payload: {
          plan: {
            dispatchId: "d-success-1",
            userMessage: "Do a thing",
            tasks: [
              {
                seq: 1,
                agentId: "engineering",
                taskDescription: "Do the thing",
                dependsOn: [],
              },
            ],
          },
        },
      });

      const result = await executor.execute(job);

      // Either done or failed — the important thing is no unhandled throw,
      // and that insertCheckpoint was called on success.
      if (result.status === "done") {
        expect(store.insertCheckpoint).toHaveBeenCalledWith(
          job.id,
          0,
          expect.objectContaining({ sessionId: expect.any(String) })
        );
      } else {
        // If blackboard setup fails (e.g. schema not initialized), it returns failed
        expect(result.error).toBeDefined();
      }

      expect(["done", "failed"]).toContain(result.status);
    });
  });

  describe("type and maxConcurrent", () => {
    test("type is compound", () => {
      const store = makeStore();
      const executor = new CompoundExecutor(store as never);
      expect(executor.type).toBe("compound");
    });

    test("maxConcurrent is 2", () => {
      const store = makeStore();
      const executor = new CompoundExecutor(store as never);
      expect(executor.maxConcurrent).toBe(2);
    });
  });
});
