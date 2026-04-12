// src/jobs/executors/routineContext.test.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock heavy dependencies before any local imports
mock.module("../../config/groups.ts", () => ({
  GROUPS: {
    OPERATIONS: { chatId: 111, topicId: null },
    ENGINEERING: { chatId: 222, topicId: 5 },
  },
}));

const mockSendAndRecord = mock(async () => {});
mock.module("../../utils/routineMessage.ts", () => ({
  sendAndRecord: mockSendAndRecord,
}));

const mockCallRoutineModel = mock(async (_prompt: string) => "llm-response");
mock.module("../../routines/routineModel.ts", () => ({
  callRoutineModel: mockCallRoutineModel,
}));

mock.module("../../routines/runOnceGuard.ts", () => ({
  shouldSkipRecently: (_file: string, _h: number) => false,
  markRanToday: (_file: string) => {},
}));

mock.module("../../../config/observability.ts", () => ({
  getPm2LogsDir: () => "/tmp/test-pm2-logs",
}));

// Import after mocks are set up
import { createRoutineContext } from "./routineContext.ts";
import type { RoutineConfig } from "../../routines/routineConfig.ts";

function makeConfig(overrides: Partial<RoutineConfig> = {}): RoutineConfig {
  return {
    name: "test-routine",
    type: "handler",
    schedule: "0 7 * * *",
    group: "OPERATIONS",
    enabled: true,
    ...overrides,
  };
}

describe("createRoutineContext", () => {
  beforeEach(() => {
    mockSendAndRecord.mockClear();
    mockCallRoutineModel.mockClear();
  });

  test("ctx.name matches config.name", () => {
    const ctx = createRoutineContext(makeConfig({ name: "my-routine" }));
    expect(ctx.name).toBe("my-routine");
  });

  test("ctx.params defaults to empty object when config.params is undefined", () => {
    const ctx = createRoutineContext(makeConfig());
    expect(ctx.params).toEqual({});
  });

  test("ctx.params uses config.params when provided", () => {
    const ctx = createRoutineContext(makeConfig({ params: { foo: "bar" } }));
    expect(ctx.params).toEqual({ foo: "bar" });
  });

  test("ctx.config is the original config object", () => {
    const config = makeConfig();
    const ctx = createRoutineContext(config);
    expect(ctx.config).toBe(config);
  });

  test("ctx.send() calls sendAndRecord with correct chatId and routineName", async () => {
    const ctx = createRoutineContext(makeConfig({ name: "morning-summary", group: "OPERATIONS" }));
    await ctx.send("Hello world");

    expect(mockSendAndRecord).toHaveBeenCalledTimes(1);
    const [chatId, message, opts] = mockSendAndRecord.mock.calls[0] as [number, string, unknown];
    expect(chatId).toBe(111);
    expect(message).toBe("Hello world");
    expect((opts as { routineName: string }).routineName).toBe("morning-summary");
  });

  test("ctx.send() uses agentId 'engineering' for ENGINEERING group", async () => {
    const ctx = createRoutineContext(makeConfig({ group: "ENGINEERING" }));
    await ctx.send("test");

    const [, , opts] = mockSendAndRecord.mock.calls[0] as [number, string, { agentId?: string }];
    expect(opts.agentId).toBe("engineering");
  });

  test("ctx.send() uses agentId 'general-assistant' for OPERATIONS group", async () => {
    const ctx = createRoutineContext(makeConfig({ group: "OPERATIONS" }));
    await ctx.send("test");

    const [, , opts] = mockSendAndRecord.mock.calls[0] as [number, string, { agentId?: string }];
    expect(opts.agentId).toBe("general-assistant");
  });

  test("ctx.send() uses config.topicId when set", async () => {
    const ctx = createRoutineContext(makeConfig({ group: "OPERATIONS", topicId: 99 }));
    await ctx.send("test");

    const [, , opts] = mockSendAndRecord.mock.calls[0] as [number, string, { topicId?: number | null }];
    expect(opts.topicId).toBe(99);
  });

  test("ctx.send() falls back to group topicId when config.topicId not set", async () => {
    const ctx = createRoutineContext(makeConfig({ group: "ENGINEERING" }));
    await ctx.send("test");

    const [, , opts] = mockSendAndRecord.mock.calls[0] as [number, string, { topicId?: number | null }];
    expect(opts.topicId).toBe(5); // ENGINEERING group topicId
  });

  test("ctx.llm() calls callRoutineModel and returns result", async () => {
    const ctx = createRoutineContext(makeConfig({ name: "test-llm" }));
    const result = await ctx.llm("some prompt");

    expect(mockCallRoutineModel).toHaveBeenCalledTimes(1);
    const [prompt, opts] = mockCallRoutineModel.mock.calls[0] as [string, { label: string; timeoutMs: number }];
    expect(prompt).toBe("some prompt");
    expect(opts.label).toBe("test-llm");
    expect(opts.timeoutMs).toBe(30_000);
    expect(result).toBe("llm-response");
  });

  test("ctx.llm() passes custom timeoutMs", async () => {
    const ctx = createRoutineContext(makeConfig());
    await ctx.llm("prompt", { timeoutMs: 60_000 });

    const [, opts] = mockCallRoutineModel.mock.calls[0] as [string, { timeoutMs: number }];
    expect(opts.timeoutMs).toBe(60_000);
  });

  test("ctx.skipIfRanWithin() returns false and does not skip when guard says no", async () => {
    const ctx = createRoutineContext(makeConfig());
    const skip = await ctx.skipIfRanWithin(2);
    expect(skip).toBe(false);
  });
});

describe("createRoutineContext — fallback group", () => {
  test("falls back to first valid group when config.group has chatId === 0", async () => {
    // Override groups mock to simulate zero chatId for OPERATIONS
    mock.module("../../config/groups.ts", () => ({
      GROUPS: {
        OPERATIONS: { chatId: 0, topicId: null },
        ENGINEERING: { chatId: 333, topicId: null },
      },
    }));

    // Re-import to get fresh module with updated mock
    const { createRoutineContext: freshCtx } = await import("./routineContext.ts?fallback-test");
    mockSendAndRecord.mockClear();

    const ctx = freshCtx(makeConfig({ group: "OPERATIONS" }));
    await ctx.send("fallback test");

    // Should have called sendAndRecord with ENGINEERING's chatId (333)
    expect(mockSendAndRecord).toHaveBeenCalledTimes(1);
    const [chatId] = mockSendAndRecord.mock.calls[0] as [number, ...unknown[]];
    expect(chatId).toBe(333);
  });
});
