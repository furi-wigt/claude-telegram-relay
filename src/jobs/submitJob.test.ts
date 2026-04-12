// src/jobs/submitJob.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initJobSchema } from "./jobSchema.ts";
import { JobStore } from "./jobStore.ts";
import { createSubmitJob } from "./submitJob.ts";

describe("submitJob", () => {
  let db: Database;
  let store: JobStore;
  let submitJob: ReturnType<typeof createSubmitJob>;
  const wakeEvents: string[] = [];

  beforeEach(() => {
    db = new Database(":memory:");
    initJobSchema(db);
    store = new JobStore(db);
    wakeEvents.length = 0;
    submitJob = createSubmitJob(store, () => wakeEvents.push("wake"));
  });

  afterEach(() => {
    db.close();
  });

  test("creates a job and returns it", () => {
    const job = submitJob({
      type: "routine",
      executor: "morning-summary",
      title: "Morning Summary",
      source: "cron",
      dedup_key: "routine:morning-summary:2026-04-12",
    });
    expect(job).not.toBeNull();
    expect(job!.id).toBeDefined();
    expect(job!.status).toBe("pending");
    expect(job!.source).toBe("cron");
    expect(job!.dedup_key).toBe("routine:morning-summary:2026-04-12");
  });

  test("applies default priority and source", () => {
    const job = submitJob({
      type: "routine",
      executor: "test",
      title: "Test",
    });
    expect(job!.priority).toBe("normal");
    expect(job!.source).toBe("cli");
  });

  test("triggers wake callback", () => {
    submitJob({ type: "routine", executor: "test", title: "Test" });
    expect(wakeEvents).toHaveLength(1);
  });

  test("rejects duplicate dedup_key and returns null", () => {
    const first = submitJob({
      type: "routine",
      executor: "test",
      title: "Test",
      dedup_key: "dup-key",
    });
    expect(first).not.toBeNull();

    const second = submitJob({
      type: "routine",
      executor: "test",
      title: "Test",
      dedup_key: "dup-key",
    });
    expect(second).toBeNull();
  });

  test("applies default timeout_ms from type", () => {
    const job = submitJob({
      type: "routine",
      executor: "test",
      title: "Test",
    });
    expect(job!.timeout_ms).toBe(5 * 60 * 1000);
  });

  test("respects explicit timeout_ms override", () => {
    const job = submitJob({
      type: "routine",
      executor: "test",
      title: "Test",
      timeout_ms: 999,
    });
    expect(job!.timeout_ms).toBe(999);
  });
});
