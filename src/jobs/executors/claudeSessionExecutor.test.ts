// src/jobs/executors/claudeSessionExecutor.test.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { Job, JobCheckpoint } from "../types.ts";
import type { ClassificationResult } from "../../orchestration/types.ts";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockRunner = mock(async (_chatId: number, _topicId: number | null, _text: string): Promise<string | null> => {
  return "test response";
});

const mockClassification: ClassificationResult = {
  intent: "general",
  primaryAgent: "operations-hub",
  topicHint: null,
  isCompound: false,
  confidence: 0.9,
  reasoning: "mock",
};

const mockDispatchResult = {
  success: true,
  response: "test response",
  durationMs: 100,
  sessionId: "sess-123",
};

// Mock the orchestration dispatch engine
mock.module("../../orchestration/dispatchEngine.ts", () => ({
  getDispatchRunner: mock(() => mockRunner),
  executeBlackboardDispatch: mock(async () => mockDispatchResult),
}));

// Mock the intent classifier
mock.module("../../orchestration/intentClassifier.ts", () => ({
  classifyIntent: mock(async () => mockClassification),
}));

// Mock the database
mock.module("../../local/db.ts", () => ({
  getDb: mock(() => ({})),
}));

// Mock sendToGroup
mock.module("../../utils/sendToGroup.ts", () => ({
  sendToGroup: mock(async () => {}),
}));

// ── Test Helpers ──────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "test-claude-job-id-123456",
    dedup_key: null,
    source: "telegram",
    type: "claude-session",
    priority: "normal",
    executor: "claude-session",
    title: "Claude Session",
    payload: { prompt: "hello world" },
    status: "running",
    intervention_type: null,
    intervention_prompt: null,
    intervention_due_at: null,
    auto_resolve_policy: null,
    auto_resolve_timeout_ms: null,
    retry_count: 0,
    timeout_ms: 600000,
    created_at: "2026-04-12T00:00:00Z",
    started_at: "2026-04-12T00:01:00Z",
    completed_at: null,
    error: null,
    metadata: { chatId: 12345, threadId: 67 },
    ...overrides,
  };
}

function makeCheckpoint(state: Record<string, unknown> = {}): JobCheckpoint {
  return {
    id: "checkpoint-id",
    job_id: "test-claude-job-id-123456",
    round: 0,
    state,
    created_at: "2026-04-12T00:00:00Z",
  };
}

function makeStore() {
  return {
    insertCheckpoint: mock((_jobId: string, _round: number, _state: Record<string, unknown>) => "cp-id"),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ClaudeSessionExecutor", () => {
  test("has correct type and maxConcurrent", async () => {
    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any);
    expect(executor.type).toBe("claude-session");
    expect(executor.maxConcurrent).toBe(1);
  });

  test("returns failed when payload.prompt is missing", async () => {
    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any);
    const result = await executor.execute(makeJob({ payload: {} }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("payload.prompt");
  });

  test("returns failed when dispatch runner is null", async () => {
    // Override getDispatchRunner to return null for this test
    const dispatchEngine = await import("../../orchestration/dispatchEngine.ts");
    const original = (dispatchEngine.getDispatchRunner as ReturnType<typeof mock>).mock;
    (dispatchEngine.getDispatchRunner as ReturnType<typeof mock>).mockImplementation(() => null);

    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any);
    const result = await executor.execute(makeJob());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("dispatch runner");

    // Restore
    (dispatchEngine.getDispatchRunner as ReturnType<typeof mock>).mockImplementation(() => mockRunner);
  });

  test("execute with valid prompt returns done with summary containing response text", async () => {
    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any);
    const result = await executor.execute(makeJob());
    expect(result.status).toBe("done");
    expect(result.summary).toContain("test response");
  });

  test("inserts checkpoint on success", async () => {
    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any);
    await executor.execute(makeJob());
    expect(store.insertCheckpoint).toHaveBeenCalledWith(
      "test-claude-job-id-123456",
      0,
      { sessionId: "sess-123" }
    );
  });

  test("logs warning when checkpoint is present (v1 re-run)", async () => {
    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any);
    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    const result = await executor.execute(makeJob(), makeCheckpoint({ sessionId: "old-sess" }));
    console.warn = originalWarn;

    expect(result.status).toBe("done");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg = (warnSpy.mock.calls[0] as string[])[0];
    expect(warnArg).toContain("re-running from scratch");
  });

  test("truncates summary to 500 chars for very long responses", async () => {
    const dispatchEngine = await import("../../orchestration/dispatchEngine.ts");
    const longResponse = "x".repeat(1000);
    (dispatchEngine.executeBlackboardDispatch as ReturnType<typeof mock>).mockImplementationOnce(
      async () => ({ ...mockDispatchResult, response: longResponse })
    );

    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any);
    const result = await executor.execute(makeJob());
    expect(result.status).toBe("done");
    expect((result.summary ?? "").length).toBe(500);
  });

  test("returns failed when executeBlackboardDispatch throws", async () => {
    const dispatchEngine = await import("../../orchestration/dispatchEngine.ts");
    (dispatchEngine.executeBlackboardDispatch as ReturnType<typeof mock>).mockImplementationOnce(
      async () => { throw new Error("dispatch exploded"); }
    );

    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any);
    const result = await executor.execute(makeJob());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("dispatch exploded");
  });

  // TODO: integration test — end-to-end with real DB, running bot, and live runner
});
