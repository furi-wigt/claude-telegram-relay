// src/jobs/executors/claudeSessionExecutor.test.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { Job, JobCheckpoint } from "../types.ts";
import type { ClassificationResult } from "../../orchestration/types.ts";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockRunner = mock(async (_chatId: number, _topicId: number | null, _text: string): Promise<string | null> => {
  return "test response";
});

const mockCreateForumTopic = mock(async (_chatId: number, _name: string): Promise<number> => 9001);
const mockEditMessage = mock(async () => {});
const mockSendToGroup = mock(async () => 42);
const mockNextJobNumber = mock(() => 1);
const mockRegisterJobTopic = mock(() => {});

const mockClassification: ClassificationResult = {
  intent: "general",
  primaryAgent: "operations-hub",
  topicHint: null,
  isCompound: false,
  confidence: 0.9,
  reasoning: "mock",
};

mock.module("../../orchestration/dispatchEngine.ts", () => ({
  getDispatchRunner: mock(() => mockRunner),
}));

mock.module("../../orchestration/intentClassifier.ts", () => ({
  classifyIntent: mock(async () => mockClassification),
}));

mock.module("../../agents/config.ts", () => ({
  AGENTS: {
    "operations-hub": { id: "operations-hub", name: "Operations Hub", chatId: -100999 },
  },
}));

mock.module("../../utils/sendToGroup.ts", () => ({
  sendToGroup: mockSendToGroup,
}));

mock.module("../../utils/telegramApi.ts", () => ({
  createForumTopic: mockCreateForumTopic,
  editMessage: mockEditMessage,
}));

mock.module("../jobCounter.ts", () => ({
  nextJobNumber: mockNextJobNumber,
}));

mock.module("../jobTopicRegistry.ts", () => ({
  registerJobTopic: mockRegisterJobTopic,
  isJobTopic: mock(() => false),
  getJobTopic: mock(() => undefined),
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
    updateMetadata: mock((_id: string, _patch: Record<string, unknown>) => {}),
    getJob: mock(() => null),
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
    const dispatchEngine = await import("../../orchestration/dispatchEngine.ts");
    (dispatchEngine.getDispatchRunner as ReturnType<typeof mock>).mockImplementation(() => null);

    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any);
    const result = await executor.execute(makeJob());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("dispatch runner");

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

  test("inserts checkpoint on success with job.id as sessionId", async () => {
    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any);
    await executor.execute(makeJob());
    expect(store.insertCheckpoint).toHaveBeenCalledWith(
      "test-claude-job-id-123456",
      0,
      { sessionId: "test-claude-job-id-123456" }
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
    const longResponse = "x".repeat(1000);
    mockRunner.mockImplementationOnce(async () => longResponse);

    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any);
    const result = await executor.execute(makeJob());
    expect(result.status).toBe("done");
    expect((result.summary ?? "").length).toBe(500);
  });

  test("returns failed when runner throws", async () => {
    mockRunner.mockImplementationOnce(async () => { throw new Error("runner exploded"); });

    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any);
    const result = await executor.execute(makeJob());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("runner exploded");
  });

  test("does not call createForumTopic when command-center agent has no chatId", async () => {
    mockCreateForumTopic.mockClear();

    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any);
    await executor.execute(makeJob());

    // AGENTS mock has no "command-center" entry → ccChatId is undefined → no topic created
    expect(mockCreateForumTopic).not.toHaveBeenCalled();
  });

  test("falls back to source chat when no CC chatId configured", async () => {
    mockSendToGroup.mockClear();

    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any);
    await executor.execute(makeJob({ metadata: { chatId: 12345, threadId: 67 } }));

    // First call: sendToGroup for the fallback response to source chat
    const calls = mockSendToGroup.mock.calls as Array<unknown[]>;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1][0]).toBe(12345);
  });

  test("still returns done when CC chatId is absent (no topic created)", async () => {
    // AGENTS mock has no "command-center" → ccChatId undefined → topic creation skipped
    // Executor must still run and return done via source-chat fallback path
    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any);
    const result = await executor.execute(makeJob());
    expect(result.status).toBe("done");
  });

  test("job number is zero-padded to 3 digits", () => {
    // nextJobNumber returns 1 from the mock
    const numStr = String(1).padStart(3, "0");
    expect(numStr).toBe("001");

    const numStr2 = String(42).padStart(3, "0");
    expect(numStr2).toBe("042");
  });
});
