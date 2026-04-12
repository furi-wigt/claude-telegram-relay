// src/jobs/integration.test.ts
/**
 * Integration test — verifies the full job lifecycle:
 * submit → dispatch → execute → done/intervention → resolve
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initJobSchema } from "./jobSchema.ts";
import { JobStore } from "./jobStore.ts";
import { JobQueue } from "./jobQueue.ts";
import { ExecutorRegistry } from "./executors/registry.ts";
import { AutoApproveEngine } from "./autoApproveEngine.ts";
import { InterventionManager } from "./interventionManager.ts";
import { createSubmitJob } from "./submitJob.ts";

describe("Job Queue Integration", () => {
  let db: Database;
  let store: JobStore;
  let queue: JobQueue;
  let registry: ExecutorRegistry;
  let intervention: InterventionManager;
  let submitJob: ReturnType<typeof createSubmitJob>;
  const notifications: string[] = [];

  beforeEach(() => {
    db = new Database(":memory:");
    initJobSchema(db);
    store = new JobStore(db);
    registry = new ExecutorRegistry();
    const autoApprove = new AutoApproveEngine([
      { executor: "safe-routine", intervention_types: ["approval"], action: "confirm" },
    ]);
    notifications.length = 0;
    intervention = new InterventionManager(store, autoApprove, {
      notify: async (job) => {
        notifications.push(job.title);
      },
      reminderMinutes: 30,
      t3Minutes: 60,
    });
    queue = new JobQueue(store, registry, intervention);
    submitJob = createSubmitJob(store, () => queue.wake());
  });

  afterEach(async () => {
    await queue.stop();
    db.close();
  });

  test("full lifecycle: submit → run → done", async () => {
    registry.register("test-routine", {
      type: "routine",
      maxConcurrent: 3,
      async execute(_job) {
        return { status: "done" as const };
      },
    });

    const job = submitJob({
      type: "routine",
      executor: "test-routine",
      title: "Test Routine",
      source: "cli",
    })!;

    expect(job.status).toBe("pending");

    await queue.tick();

    const result = store.getJob(job.id)!;
    expect(result.status).toBe("done");
  });

  test("intervention with auto-approve: no notification", async () => {
    registry.register("safe-routine", {
      type: "routine",
      maxConcurrent: 3,
      async execute(_job) {
        return {
          status: "awaiting-intervention" as const,
          intervention: {
            type: "approval" as const,
            prompt: "Clean up?",
            dueInMs: 1800000,
          },
        };
      },
    });

    submitJob({
      type: "routine",
      executor: "safe-routine",
      title: "Safe Cleanup",
      source: "cron",
    });

    await queue.tick();

    // Auto-approved — no notification, job resumed (cleared intervention)
    expect(notifications).toHaveLength(0);
  });

  test("intervention without auto-approve: notification sent", async () => {
    registry.register("deploy", {
      type: "claude-session",
      maxConcurrent: 1,
      async execute(_job) {
        return {
          status: "awaiting-intervention" as const,
          intervention: {
            type: "approval" as const,
            prompt: "Deploy to prod?",
            dueInMs: 1800000,
          },
        };
      },
    });

    const job = submitJob({
      type: "claude-session",
      executor: "deploy",
      title: "Deploy to Prod",
      source: "telegram",
      metadata: { chatId: 12345 },
    })!;

    await queue.tick();

    const updated = store.getJob(job.id)!;
    expect(updated.status).toBe("awaiting-intervention");
    expect(notifications).toEqual(["Deploy to Prod"]);

    // Resolve it
    intervention.resolveIntervention(job.id, "confirm");
    const resolved = store.getJob(job.id)!;
    expect(resolved.status).toBe("running");
  });

  test("dedup: same dedup_key rejected", () => {
    const first = submitJob({
      type: "routine",
      executor: "test",
      title: "First",
      dedup_key: "routine:test:today",
    });
    const second = submitJob({
      type: "routine",
      executor: "test",
      title: "Second",
      dedup_key: "routine:test:today",
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("priority ordering: urgent runs before normal", async () => {
    const order: string[] = [];
    registry.register("ordered", {
      type: "routine",
      maxConcurrent: 1, // force sequential
      async execute(job) {
        order.push(job.title);
        return { status: "done" as const };
      },
    });

    submitJob({ type: "routine", executor: "ordered", title: "Normal", priority: "normal" });
    submitJob({ type: "routine", executor: "ordered", title: "Urgent", priority: "urgent" });

    await queue.tick();
    // Only one dispatched per tick (maxConcurrent=1), should be the urgent one
    expect(order[0]).toBe("Urgent");
  });
});
