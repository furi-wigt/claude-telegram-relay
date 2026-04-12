// src/jobs/scheduleCommand.test.ts
import { describe, test, expect } from "bun:test";
import { handleScheduleCommand } from "./scheduleCommand.ts";
import type { Job } from "./types.ts";

/** Minimal Job stub — only the fields handleScheduleCommand reads */
function makeJob(id: string): Job {
  return {
    id,
    type: "claude-session",
    executor: "claude-session",
    title: "test",
    source: "telegram",
    priority: "normal",
    status: "pending",
    payload: {},
    metadata: {},
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    error: null,
    timeout_ms: 300000,
    dedup_key: null,
    auto_resolve_policy: null,
    auto_resolve_timeout_ms: null,
    intervention_type: null,
    intervention_prompt: null,
    intervention_due_at: null,
    retry_count: 0,
  } satisfies Job;
}

describe("handleScheduleCommand", () => {
  test("returns no-prompt when prompt is empty", () => {
    const submitJob = (_input: unknown) => makeJob("job-id-1");
    const result = handleScheduleCommand(
      { submitJob },
      { chatId: 100, threadId: undefined, prompt: "" }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no-prompt");
    }
  });

  test("calls submitJob with correct type, executor, payload, and metadata", () => {
    const calls: Parameters<typeof handleScheduleCommand>[0]["submitJob"] extends (i: infer I) => unknown ? I[] : never[] = [];
    const submitJob = (input: Parameters<typeof handleScheduleCommand>[0]["submitJob"] extends (i: infer I) => unknown ? I : never) => {
      calls.push(input);
      return makeJob("abc-12345678");
    };

    const result = handleScheduleCommand(
      { submitJob },
      { chatId: 777, threadId: 42, prompt: "Summarise my goals" }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.jobId).toBe("abc-12345678");
    }

    expect(calls).toHaveLength(1);
    const input = calls[0];
    expect(input.type).toBe("claude-session");
    expect(input.executor).toBe("claude-session");
    expect(input.source).toBe("telegram");
    expect(input.priority).toBe("normal");
    expect((input.payload as Record<string, unknown>).prompt).toBe("Summarise my goals");
    expect((input.metadata as Record<string, unknown>).chatId).toBe(777);
    expect((input.metadata as Record<string, unknown>).threadId).toBe(42);
  });

  test("truncates title to 80 characters", () => {
    const calls: Array<{ title: string }> = [];
    const submitJob = (input: { title: string } & Record<string, unknown>) => {
      calls.push({ title: input.title });
      return makeJob("trunc-id");
    };

    const longPrompt = "A".repeat(120);
    handleScheduleCommand(
      { submitJob: submitJob as Parameters<typeof handleScheduleCommand>[0]["submitJob"] },
      { chatId: 1, threadId: undefined, prompt: longPrompt }
    );

    expect(calls[0].title).toHaveLength(80);
  });

  test("returns submit-failed when submitJob returns null", () => {
    const submitJob = (_input: unknown) => null;
    const result = handleScheduleCommand(
      { submitJob: submitJob as Parameters<typeof handleScheduleCommand>[0]["submitJob"] },
      { chatId: 100, threadId: undefined, prompt: "do something" }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("submit-failed");
    }
  });

  test("passes undefined threadId when not in a thread", () => {
    const calls: Array<{ metadata: unknown }> = [];
    const submitJob = (input: { metadata: unknown } & Record<string, unknown>) => {
      calls.push({ metadata: input.metadata });
      return makeJob("no-thread-id");
    };

    handleScheduleCommand(
      { submitJob: submitJob as Parameters<typeof handleScheduleCommand>[0]["submitJob"] },
      { chatId: 55, threadId: undefined, prompt: "some prompt" }
    );

    expect((calls[0].metadata as Record<string, unknown>).threadId).toBeUndefined();
    expect((calls[0].metadata as Record<string, unknown>).chatId).toBe(55);
  });
});
