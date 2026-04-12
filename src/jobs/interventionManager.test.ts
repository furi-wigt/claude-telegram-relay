// src/jobs/interventionManager.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initJobSchema } from "./jobSchema.ts";
import { JobStore } from "./jobStore.ts";
import { AutoApproveEngine } from "./autoApproveEngine.ts";
import { InterventionManager } from "./interventionManager.ts";
import type { ExecutorResult } from "./executors/types.ts";

describe("InterventionManager", () => {
  let db: Database;
  let store: JobStore;
  let engine: AutoApproveEngine;
  let notifications: Array<{ jobId: string; prompt: string }>;
  let manager: InterventionManager;

  beforeEach(() => {
    db = new Database(":memory:");
    initJobSchema(db);
    store = new JobStore(db);
    engine = new AutoApproveEngine([
      { executor: "log-cleanup", intervention_types: ["approval"], action: "confirm" },
    ]);
    notifications = [];
    manager = new InterventionManager(store, engine, {
      notify: async (job) => {
        notifications.push({ jobId: job.id, prompt: job.intervention_prompt! });
      },
      reminderMinutes: 30,
      t3Minutes: 60,
    });
  });

  afterEach(() => {
    db.close();
  });

  test("auto-approve rule match → auto-resolves without notification", async () => {
    const job = store.insertJob({
      source: "cron",
      type: "routine",
      executor: "log-cleanup",
      title: "Log Cleanup",
    });
    store.updateStatus(job.id, "running");

    const result: ExecutorResult = {
      status: "awaiting-intervention",
      intervention: { type: "approval", prompt: "Clean logs?", dueInMs: 1800000 },
    };

    const resolution = await manager.handleIntervention(job.id, result);
    expect(resolution).toBe("auto-approved");

    const updated = store.getJob(job.id)!;
    expect(updated.status).toBe("running");
    expect(notifications).toHaveLength(0);
  });

  test("confidence >= 0.85 → auto-proceeds", async () => {
    const job = store.insertJob({
      source: "cli",
      type: "claude-session",
      executor: "claude-session",
      title: "Code Review",
    });
    store.updateStatus(job.id, "running");

    const result: ExecutorResult = {
      status: "awaiting-intervention",
      intervention: {
        type: "clarification",
        prompt: "Which branch?",
        dueInMs: 1800000,
        autoProceedConfidence: 0.92,
      },
    };

    const resolution = await manager.handleIntervention(job.id, result);
    expect(resolution).toBe("auto-proceeded");

    const updated = store.getJob(job.id)!;
    expect(updated.status).toBe("running");
  });

  test("confidence < 0.85 → falls through to notification", async () => {
    const job = store.insertJob({
      source: "cli",
      type: "claude-session",
      executor: "claude-session",
      title: "Code Review",
    });
    store.updateStatus(job.id, "running");

    const result: ExecutorResult = {
      status: "awaiting-intervention",
      intervention: {
        type: "clarification",
        prompt: "Which branch?",
        dueInMs: 1800000,
        autoProceedConfidence: 0.5,
      },
    };

    const resolution = await manager.handleIntervention(job.id, result);
    expect(resolution).toBe("notified");

    const updated = store.getJob(job.id)!;
    expect(updated.status).toBe("awaiting-intervention");
    expect(notifications).toHaveLength(1);
  });

  test("no auto-resolve path → notifies human", async () => {
    const job = store.insertJob({
      source: "telegram",
      type: "claude-session",
      executor: "claude-session",
      title: "Deploy",
    });
    store.updateStatus(job.id, "running");

    const result: ExecutorResult = {
      status: "awaiting-intervention",
      intervention: { type: "approval", prompt: "Deploy to prod?", dueInMs: 1800000 },
    };

    const resolution = await manager.handleIntervention(job.id, result);
    expect(resolution).toBe("notified");

    const updated = store.getJob(job.id)!;
    expect(updated.status).toBe("awaiting-intervention");
    expect(updated.intervention_type).toBe("approval");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].prompt).toBe("Deploy to prod?");
  });

  test("resolveIntervention confirms and resumes job", () => {
    const job = store.insertJob({
      source: "cli",
      type: "routine",
      executor: "test",
      title: "Test",
    });
    store.updateStatus(job.id, "running");
    store.setIntervention(job.id, { type: "approval", prompt: "Confirm?" });

    manager.resolveIntervention(job.id, "confirm");
    const updated = store.getJob(job.id)!;
    expect(updated.status).toBe("running");
    expect(updated.intervention_type).toBeNull();
  });

  test("resolveIntervention skip marks done", () => {
    const job = store.insertJob({
      source: "cli",
      type: "routine",
      executor: "test",
      title: "Test",
    });
    store.updateStatus(job.id, "running");
    store.setIntervention(job.id, { type: "approval", prompt: "Confirm?" });

    manager.resolveIntervention(job.id, "skip");
    const updated = store.getJob(job.id)!;
    expect(updated.status).toBe("done");
  });

  test("resolveIntervention abort marks cancelled", () => {
    const job = store.insertJob({
      source: "cli",
      type: "routine",
      executor: "test",
      title: "Test",
    });
    store.updateStatus(job.id, "running");
    store.setIntervention(job.id, { type: "approval", prompt: "Confirm?" });

    manager.resolveIntervention(job.id, "abort");
    const updated = store.getJob(job.id)!;
    expect(updated.status).toBe("cancelled");
  });
});
