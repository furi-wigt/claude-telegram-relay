// src/jobs/telegramJobCommands.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initJobSchema } from "./jobSchema.ts";
import { JobStore } from "./jobStore.ts";
import { formatJobList, formatJobDetail, buildInterventionKeyboard } from "./telegramJobCommands.ts";

describe("telegramJobCommands", () => {
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

  test("formatJobList renders empty state", () => {
    const text = formatJobList([]);
    expect(text).toContain("No jobs");
  });

  test("formatJobList renders job rows with emoji status", () => {
    store.insertJob({ source: "cron", type: "routine", executor: "test", title: "Morning Summary" });
    const jobs = store.listJobs();
    const text = formatJobList(jobs);
    expect(text).toContain("Morning Summary");
    expect(text).toContain("⏳"); // pending
  });

  test("formatJobDetail shows all fields", () => {
    const job = store.insertJob({
      source: "cron",
      type: "routine",
      executor: "morning-summary",
      title: "Morning Summary",
    });
    const text = formatJobDetail(job);
    expect(text).toContain("Morning Summary");
    expect(text).toContain("routine");
    expect(text).toContain("morning-summary");
    expect(text).toContain("cron");
  });

  test("buildInterventionKeyboard creates correct callback data", () => {
    const keyboard = buildInterventionKeyboard("abc-123");
    const buttons = keyboard.inline_keyboard.flat();
    const callbackData = buttons.map((b: { text: string; callback_data: string }) => b.callback_data);
    expect(callbackData).toContain("job:confirm:abc-123");
    expect(callbackData).toContain("job:skip:abc-123");
    expect(callbackData).toContain("job:abort:abc-123");
  });
});
