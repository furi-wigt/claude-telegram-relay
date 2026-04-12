// src/jobs/jobStore.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { JobStore } from "./jobStore.ts";
import { initJobSchema } from "./jobSchema.ts";
import type { JobStatus } from "./types.ts";

describe("JobStore", () => {
  let db: Database;
  let store: JobStore;

  beforeEach(() => {
    db = new Database(":memory:");
    initJobSchema(db);
    store = new JobStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("insertJob creates a job and returns it", () => {
    const job = store.insertJob({
      source: "cli",
      type: "routine",
      priority: "normal",
      executor: "morning-summary",
      title: "Morning Summary",
      payload: { config: { name: "morning-summary" } },
    });
    expect(job.id).toBeDefined();
    expect(job.status).toBe("pending");
    expect(job.retry_count).toBe(0);
    expect(job.title).toBe("Morning Summary");
  });

  test("insertJob rejects duplicate dedup_key", () => {
    store.insertJob({
      source: "cron",
      type: "routine",
      executor: "test",
      title: "Test",
      dedup_key: "routine:test:2026-04-12",
    });
    expect(() =>
      store.insertJob({
        source: "cron",
        type: "routine",
        executor: "test",
        title: "Test",
        dedup_key: "routine:test:2026-04-12",
      })
    ).toThrow();
  });

  test("getJob returns job by id", () => {
    const created = store.insertJob({
      source: "cli",
      type: "routine",
      executor: "test",
      title: "Test",
    });
    const fetched = store.getJob(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
  });

  test("getJob returns null for unknown id", () => {
    expect(store.getJob("nonexistent")).toBeNull();
  });

  test("updateStatus transitions job status", () => {
    const job = store.insertJob({
      source: "cli",
      type: "routine",
      executor: "test",
      title: "Test",
    });
    store.updateStatus(job.id, "running");
    const updated = store.getJob(job.id)!;
    expect(updated.status).toBe("running");
    expect(updated.started_at).toBeDefined();
  });

  test("updateStatus sets completed_at for terminal states", () => {
    const job = store.insertJob({
      source: "cli",
      type: "routine",
      executor: "test",
      title: "Test",
    });
    store.updateStatus(job.id, "running");
    store.updateStatus(job.id, "done");
    const updated = store.getJob(job.id)!;
    expect(updated.status).toBe("done");
    expect(updated.completed_at).toBeDefined();
  });

  test("listJobs filters by status", () => {
    store.insertJob({ source: "cli", type: "routine", executor: "a", title: "A" });
    const b = store.insertJob({ source: "cli", type: "routine", executor: "b", title: "B" });
    store.updateStatus(b.id, "running");

    const pending = store.listJobs({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].title).toBe("A");

    const running = store.listJobs({ status: "running" });
    expect(running).toHaveLength(1);
    expect(running[0].title).toBe("B");
  });

  test("listJobs filters by type", () => {
    store.insertJob({ source: "cli", type: "routine", executor: "a", title: "A" });
    store.insertJob({ source: "cli", type: "api-call", executor: "b", title: "B" });
    const routines = store.listJobs({ type: "routine" });
    expect(routines).toHaveLength(1);
    expect(routines[0].title).toBe("A");
  });

  test("countRunningByType returns correct count", () => {
    const a = store.insertJob({ source: "cli", type: "routine", executor: "a", title: "A" });
    const b = store.insertJob({ source: "cli", type: "routine", executor: "b", title: "B" });
    store.updateStatus(a.id, "running");
    store.updateStatus(b.id, "running");
    expect(store.countRunningByType("routine")).toBe(2);
    expect(store.countRunningByType("api-call")).toBe(0);
  });

  test("setIntervention sets intervention fields", () => {
    const job = store.insertJob({ source: "cli", type: "routine", executor: "a", title: "A" });
    store.updateStatus(job.id, "running");
    store.setIntervention(job.id, {
      type: "approval",
      prompt: "Confirm deploy?",
      due_at: "2026-04-12T10:00:00Z",
      auto_resolve_policy: "approve_after_timeout",
      auto_resolve_timeout_ms: 7200000,
    });
    const updated = store.getJob(job.id)!;
    expect(updated.status).toBe("awaiting-intervention");
    expect(updated.intervention_type).toBe("approval");
    expect(updated.intervention_prompt).toBe("Confirm deploy?");
    expect(updated.auto_resolve_policy).toBe("approve_after_timeout");
  });

  test("clearIntervention clears intervention fields and resumes", () => {
    const job = store.insertJob({ source: "cli", type: "routine", executor: "a", title: "A" });
    store.updateStatus(job.id, "running");
    store.setIntervention(job.id, { type: "approval", prompt: "Confirm?" });
    store.clearIntervention(job.id, "running");
    const updated = store.getJob(job.id)!;
    expect(updated.status).toBe("running");
    expect(updated.intervention_type).toBeNull();
    expect(updated.intervention_prompt).toBeNull();
  });

  test("insertCheckpoint and getLatestCheckpoint", () => {
    const job = store.insertJob({ source: "cli", type: "routine", executor: "a", title: "A" });
    store.insertCheckpoint(job.id, 1, { step: "init" });
    store.insertCheckpoint(job.id, 2, { step: "done" });
    const latest = store.getLatestCheckpoint(job.id);
    expect(latest).toBeDefined();
    expect(latest!.round).toBe(2);
    expect(latest!.state).toEqual({ step: "done" });
  });

  test("incrementRetry increments retry_count", () => {
    const job = store.insertJob({ source: "cli", type: "routine", executor: "a", title: "A" });
    store.incrementRetry(job.id);
    store.incrementRetry(job.id);
    const updated = store.getJob(job.id)!;
    expect(updated.retry_count).toBe(2);
  });

  test("setError stores error message", () => {
    const job = store.insertJob({ source: "cli", type: "routine", executor: "a", title: "A" });
    store.setError(job.id, "Something broke");
    const updated = store.getJob(job.id)!;
    expect(updated.error).toBe("Something broke");
  });

  test("getAwaitingIntervention returns only awaiting jobs", () => {
    const a = store.insertJob({ source: "cli", type: "routine", executor: "a", title: "A" });
    store.insertJob({ source: "cli", type: "routine", executor: "b", title: "B" });
    store.updateStatus(a.id, "running");
    store.setIntervention(a.id, { type: "approval", prompt: "Confirm?" });
    const awaiting = store.getAwaitingIntervention();
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0].id).toBe(a.id);
  });

  test("getTimedOutJobs returns running jobs past timeout", () => {
    const job = store.insertJob({
      source: "cli",
      type: "routine",
      executor: "a",
      title: "A",
      timeout_ms: 1, // 1ms timeout — already expired
    });
    store.updateStatus(job.id, "running");
    // Need to wait a tick for the timeout to be past
    const timedOut = store.getTimedOutJobs();
    expect(timedOut.length).toBeGreaterThanOrEqual(1);
  });
});
