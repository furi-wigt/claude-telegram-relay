// src/jobs/jobQueue.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initJobSchema } from "./jobSchema.ts";
import { JobStore } from "./jobStore.ts";
import { ExecutorRegistry } from "./executors/registry.ts";
import { AutoApproveEngine } from "./autoApproveEngine.ts";
import { InterventionManager } from "./interventionManager.ts";
import { JobQueue } from "./jobQueue.ts";
import { createSubmitJob } from "./submitJob.ts";
import type { JobExecutor, ExecutorResult } from "./executors/types.ts";
import type { Job } from "./types.ts";

function makeExecutor(
  type: string,
  maxConcurrent: number,
  handler: (job: Job) => Promise<ExecutorResult>
): JobExecutor {
  return { type: type as any, maxConcurrent, execute: handler };
}

describe("JobQueue", () => {
  let db: Database;
  let store: JobStore;
  let registry: ExecutorRegistry;
  let queue: JobQueue;
  let submitJob: ReturnType<typeof createSubmitJob>;
  const execLog: string[] = [];

  beforeEach(() => {
    db = new Database(":memory:");
    initJobSchema(db);
    store = new JobStore(db);
    registry = new ExecutorRegistry();
    const autoApprove = new AutoApproveEngine([]);
    const intervention = new InterventionManager(store, autoApprove, {
      notify: async () => {},
      reminderMinutes: 30,
      t3Minutes: 60,
    });
    queue = new JobQueue(store, registry, intervention);
    submitJob = createSubmitJob(store, () => queue.wake());
    execLog.length = 0;
  });

  afterEach(async () => {
    await queue.stop();
    db.close();
  });

  test("dispatches a pending job to registered executor", async () => {
    registry.register("test-exec", makeExecutor("routine", 3, async (job) => {
      execLog.push(job.title);
      return { status: "done", summary: "ok" };
    }));

    submitJob({ type: "routine", executor: "test-exec", title: "Job A" });

    // Run one dispatch cycle manually
    await queue.tick();

    expect(execLog).toEqual(["Job A"]);
    const job = store.listJobs()[0];
    expect(job.status).toBe("done");
  });

  test("respects per-type concurrency cap", async () => {
    let running = 0;
    let maxSeen = 0;

    registry.register("slow", makeExecutor("routine", 2, async () => {
      running++;
      maxSeen = Math.max(maxSeen, running);
      await new Promise((r) => setTimeout(r, 50));
      running--;
      return { status: "done" };
    }));

    submitJob({ type: "routine", executor: "slow", title: "A" });
    submitJob({ type: "routine", executor: "slow", title: "B" });
    submitJob({ type: "routine", executor: "slow", title: "C" });

    // Run tick — should start up to 2 (maxConcurrent for this executor)
    const tickPromise = queue.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(maxSeen).toBeLessThanOrEqual(2);
    await tickPromise;
  });

  test("urgent jobs dispatched before normal", async () => {
    registry.register("test", makeExecutor("routine", 10, async (job) => {
      execLog.push(job.title);
      return { status: "done" };
    }));

    // Submit normal first, then urgent
    submitJob({ type: "routine", executor: "test", title: "Normal", priority: "normal" });
    submitJob({ type: "routine", executor: "test", title: "Urgent", priority: "urgent" });

    await queue.tick();
    // Urgent should run first despite being submitted second
    expect(execLog[0]).toBe("Urgent");
  });

  test("failed job with retry_count < 3 is re-queued", async () => {
    let callCount = 0;
    registry.register("flaky", makeExecutor("routine", 3, async () => {
      callCount++;
      return { status: "failed", error: "flaky" };
    }));

    submitJob({ type: "routine", executor: "flaky", title: "Flaky" });
    await queue.tick();

    const job = store.listJobs()[0];
    // Should be re-queued as pending with retry_count incremented
    expect(job.status).toBe("pending");
    expect(job.retry_count).toBe(1);
  });

  test("failed job at retry_count >= 3 is permanently failed", async () => {
    registry.register("broken", makeExecutor("routine", 3, async () => {
      return { status: "failed", error: "broken" };
    }));

    const job = store.insertJob({
      source: "cli",
      type: "routine",
      executor: "broken",
      title: "Broken",
    });
    // Simulate 3 prior retries
    store.incrementRetry(job.id);
    store.incrementRetry(job.id);
    store.incrementRetry(job.id);

    await queue.tick();

    const updated = store.getJob(job.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.retry_count).toBe(3);
  });

  test("skips job when executor not registered", async () => {
    submitJob({ type: "routine", executor: "unknown", title: "Mystery" });
    await queue.tick();
    const job = store.listJobs()[0];
    expect(job.status).toBe("failed");
    expect(job.error).toContain("no executor registered");
  });
});
