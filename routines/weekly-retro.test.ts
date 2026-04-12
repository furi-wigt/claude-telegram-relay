import { describe, test, expect, mock } from "bun:test";
import type { RoutineContext } from "../src/jobs/executors/routineContext.ts";
import type { RoutineConfig } from "../src/routines/routineConfig.ts";

mock.module("../src/utils/routineMessage.ts", () => ({
  sendAndRecord: async () => {},
}));

mock.module("../src/utils/sendToGroup.ts", () => ({
  sendToGroup: async () => {},
}));

mock.module("../src/config/groups.ts", () => ({
  GROUPS: {},
  validateGroup: () => false,
}));

mock.module("../src/config/userConfig.ts", () => ({
  USER_NAME: "Test",
  USER_TIMEZONE: "Asia/Singapore",
}));

mock.module("../src/callbacks/learningRetroCallbackHandler.ts", () => ({
  storeLearningSession: () => "session-001",
  buildRetroKeyboard: () => ({ inline_keyboard: [] }),
}));

mock.module("../src/local/db", () => ({
  getDb: () => ({
    query: () => ({ all: () => [], get: () => ({ c: 0 }) }),
  }),
}));

function makeCtx(overrides?: Partial<RoutineContext>): RoutineContext {
  const cfg: RoutineConfig = {
    name: "weekly-retro",
    group: "OPERATIONS",
    schedule: "0 9 * * 0",
    params: {},
  };
  return {
    name: "weekly-retro",
    params: {},
    config: cfg,
    send: async () => {},
    llm: async () => "",
    log: () => {},
    skipIfRanWithin: async () => false,
    ...overrides,
  };
}

describe("weekly-retro — pure functions", () => {
  test("formatEvidenceSummary formats inline_correction evidence", async () => {
    const { formatEvidenceSummary } = await import("./handlers/weekly-retro.ts");
    const evidence = JSON.stringify({
      source_trigger: "inline_correction",
      correction_pair: { assistant_msg_id: "msg-1", user_correction_id: "msg-2" },
      agent_id: "code-quality-coach",
    });
    const result = formatEvidenceSummary(evidence);
    expect(result).toContain("inline_correction");
    expect(result).toContain("code-quality-coach");
  });

  test("formatEvidenceSummary handles malformed evidence gracefully", async () => {
    const { formatEvidenceSummary } = await import("./handlers/weekly-retro.ts");
    expect(formatEvidenceSummary("not json")).toBe("No evidence details");
  });

  test("buildRetroMessage builds message with candidate details", async () => {
    const { buildRetroMessage } = await import("./handlers/weekly-retro.ts");
    const msg = buildRetroMessage(
      "Always use TDD for utilities",
      "user_preference",
      0.75,
      "Source: inline_correction in code-quality-coach",
      1,
      5,
    );
    expect(msg).toContain("Always use TDD");
    expect(msg).toContain("user_preference");
    expect(msg).toContain("0.75");
    expect(msg).toContain("1 of 5");
  });
});

describe("weekly-retro run() — ctx contract", () => {
  test("run() exits silently (no ctx.send) when skipIfRanWithin returns true", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      skipIfRanWithin: async () => true,
      send: async (msg: string) => { calls.push(msg); },
    });

    const { run } = await import("./handlers/weekly-retro.ts");
    await run(ctx);

    expect(calls).toHaveLength(0);
  });

  test("run() sends a summary when no candidates are available", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      skipIfRanWithin: async () => false,
      send: async (msg: string) => { calls.push(msg); },
    });

    const { run } = await import("./handlers/weekly-retro.ts");
    await run(ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("No learnings ready");
  });
});
