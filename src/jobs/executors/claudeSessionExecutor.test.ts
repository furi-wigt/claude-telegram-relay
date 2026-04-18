// src/jobs/executors/claudeSessionExecutor.test.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { Job, JobCheckpoint } from "../types.ts";
import type { ClassificationResult } from "../../orchestration/types.ts";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockRunHarness = mock(async () => ({ outcome: "done" as const }));
const mockLoadHarnessState = mock(async () => null);
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

mock.module("../../orchestration/harness.ts", () => ({
  runHarness: mockRunHarness,
  loadHarnessState: mockLoadHarnessState,
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
  chunkMessage: (msg: string) => [msg],
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
    round: 1,
    state,
    created_at: "2026-04-12T00:00:00Z",
  };
}

function makeStore() {
  return {
    insertCheckpoint: mock((_jobId: string, _round: number, _state: Record<string, unknown>) => "cp-id"),
    updateMetadata: mock((_id: string, _patch: Record<string, unknown>) => {}),
    getJob: mock(() => null),
    getLatestCheckpoint: mock(() => null),
  };
}

/** Minimal mock Bot — harness is fully mocked so bot is unused */
function makeBot() {
  return { api: { sendMessage: mock(async () => ({ message_id: 1 })) } };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("ClaudeSessionExecutor", () => {
  beforeEach(() => {
    mockRunHarness.mockImplementation(async () => ({ outcome: "done" as const }));
    mockLoadHarnessState.mockImplementation(async () => null);
  });

  test("has correct type and maxConcurrent", async () => {
    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const executor = new ClaudeSessionExecutor(makeStore() as any, makeBot() as any);
    expect(executor.type).toBe("claude-session");
    expect(executor.maxConcurrent).toBe(1);
  });

  test("returns failed when payload.prompt is missing", async () => {
    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const executor = new ClaudeSessionExecutor(makeStore() as any, makeBot() as any);
    const result = await executor.execute(makeJob({ payload: {} }));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("payload.prompt");
  });

  test("execute with valid prompt calls runHarness and returns done", async () => {
    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const executor = new ClaudeSessionExecutor(makeStore() as any, makeBot() as any);
    mockRunHarness.mockClear();

    const result = await executor.execute(makeJob());

    expect(result.status).toBe("done");
    expect(mockRunHarness).toHaveBeenCalled();
    const [_bot, plan] = mockRunHarness.mock.calls.at(-1) as any[];
    expect(plan.userMessage).toBe("hello world");
  });

  test("inserts checkpoint on success with job.id as sessionId", async () => {
    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const store = makeStore();
    const executor = new ClaudeSessionExecutor(store as any, makeBot() as any);
    await executor.execute(makeJob());
    expect(store.insertCheckpoint).toHaveBeenCalledWith(
      "test-claude-job-id-123456",
      0,
      { sessionId: "test-claude-job-id-123456" }
    );
  });

  test("logs warning when stale (non-clarification) checkpoint present", async () => {
    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const executor = new ClaudeSessionExecutor(makeStore() as any, makeBot() as any);
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

  test("returns failed when harness throws", async () => {
    mockRunHarness.mockImplementationOnce(async () => { throw new Error("harness exploded"); });

    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const executor = new ClaudeSessionExecutor(makeStore() as any, makeBot() as any);
    const result = await executor.execute(makeJob());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("harness exploded");
  });

  test("returns failed when harness returns failed outcome", async () => {
    mockRunHarness.mockImplementationOnce(async () => ({ outcome: "failed" as const }));

    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const executor = new ClaudeSessionExecutor(makeStore() as any, makeBot() as any);
    const result = await executor.execute(makeJob());
    expect(result.status).toBe("failed");
  });

  test("returns awaiting-intervention when harness returns suspended", async () => {
    mockRunHarness.mockImplementationOnce(async () => ({
      outcome: "suspended" as const,
      question: "Which auth method — JWT or session?",
      agentId: "engineering",
    }));

    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const executor = new ClaudeSessionExecutor(makeStore() as any, makeBot() as any);
    const result = await executor.execute(makeJob());

    expect(result.status).toBe("awaiting-intervention");
    expect(result.intervention?.type).toBe("clarification");
    expect(result.intervention?.prompt).toBe("Which auth method — JWT or session?");
  });

  test("resume: enriches prompt with Q&A when clarificationAnswer in checkpoint", async () => {
    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const executor = new ClaudeSessionExecutor(makeStore() as any, makeBot() as any);
    mockRunHarness.mockClear();

    const checkpoint = makeCheckpoint({
      clarificationAnswer: "JWT",
      clarificationQuestion: "Which auth method?",
    });

    const result = await executor.execute(makeJob(), checkpoint);

    expect(result.status).toBe("done");
    expect(mockRunHarness).toHaveBeenCalled();
    const [_bot, plan] = mockRunHarness.mock.calls.at(-1) as any[];
    expect(plan.userMessage).toContain("JWT");
    expect(plan.userMessage).toContain("Which auth method?");
  });

  test("does not call createForumTopic when command-center agent has no chatId", async () => {
    mockCreateForumTopic.mockClear();

    const { ClaudeSessionExecutor } = await import("./claudeSessionExecutor.ts");
    const executor = new ClaudeSessionExecutor(makeStore() as any, makeBot() as any);
    await executor.execute(makeJob());

    // AGENTS mock has no "command-center" → ccChatId undefined → no topic created
    expect(mockCreateForumTopic).not.toHaveBeenCalled();
  });

  test("job number is zero-padded to 3 digits", () => {
    expect(String(1).padStart(3, "0")).toBe("001");
    expect(String(42).padStart(3, "0")).toBe("042");
    expect(String(100).padStart(3, "0")).toBe("100");
  });
});
