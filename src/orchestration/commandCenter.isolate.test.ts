/**
 * Unit tests for isolated-dispatch topic name generation in commandCenter.
 *
 * Covers buildIsolatedTopicName: happy-path LLM summary, stripping of
 * trailing punctuation / surrounding quotes, truncation, and fallback
 * when the routine model fails or returns empty output.
 */

import { describe, it, expect, mock } from "bun:test";

// Mock routineModel before importing commandCenter (ESM hoisting).
let mockRoutineFn: (prompt: string) => Promise<string> =
  async () => { throw new Error("not stubbed"); };

mock.module("../routines/routineModel.ts", () => ({
  callRoutineModel: async (prompt: string) => mockRoutineFn(prompt),
}));

// Dependencies pulled in transitively by commandCenter — stub just enough
// to let the module import without side-effects.
mock.module("../agents/config.ts", () => ({
  AGENTS: {},
  DEFAULT_AGENT: { id: "operations-hub" },
}));

mock.module("./intentClassifier.ts", () => ({
  classifyIntent: async () => ({ intent: "coding", primaryAgent: "engineering", topicHint: null, isCompound: false, confidence: 0.9, reasoning: "" }),
  AUTO_DISPATCH_THRESHOLD: 0.8,
}));

mock.module("./interruptProtocol.ts", () => ({
  buildPlanKeyboard: () => ({}),
  buildPausedKeyboard: () => ({}),
  startCountdown: async () => "dispatched",
  handleInterrupt: () => null,
  parseOrchCallback: () => null,
  ORCH_CB_PREFIX: "op:",
}));

mock.module("./harness.ts", () => ({
  runHarness: async () => ({ outcome: "done" }),
}));

mock.module("./harnessRegistry.ts", () => ({
  requestCancel: () => false,
  lookupByCcChat: () => null,
}));

mock.module("./contractLoader.ts", () => ({
  loadContract: async () => null,
}));

mock.module("./pendingAgentReplies.ts", () => ({
  trackAgentReply: () => {},
}));

mock.module("../jobs/jobTopicRegistry.ts", () => ({
  isJobTopic: () => false,
  getJobTopic: () => null,
}));

mock.module("../jobs/jobBridge.ts", () => ({
  getBridgeJob: () => null,
  resumeJobWithAnswer: () => false,
}));

mock.module("../session/groupSessions.ts", () => ({
  getSession: () => null,
}));

const { buildIsolatedTopicName } = await import("./commandCenter.ts");

describe("buildIsolatedTopicName", () => {
  it("uses LLM summary prefixed with 🛠", async () => {
    mockRoutineFn = async () => "Implement Health Check Endpoint";
    const name = await buildIsolatedTopicName("coding", "can you add a health check endpoint?");
    expect(name).toBe("🛠 Implement Health Check Endpoint");
  });

  it("strips surrounding quotes and trailing punctuation", async () => {
    mockRoutineFn = async () => `"Refactor User Service!"`;
    const name = await buildIsolatedTopicName("coding", "please refactor the user service");
    expect(name).toBe("🛠 Refactor User Service");
  });

  it("truncates overly long LLM output", async () => {
    mockRoutineFn = async () =>
      "This Is A Very Very Long Summary That Should Definitely Exceed Max Length";
    const name = await buildIsolatedTopicName("coding", "long request");
    expect(name.startsWith("🛠 ")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(60);
  });

  it("falls back to truncated user message when LLM throws", async () => {
    mockRoutineFn = async () => { throw new Error("model offline"); };
    const name = await buildIsolatedTopicName("coding", "implement a sleek, fast cache");
    expect(name).toBe("🛠 implement a sleek, fast cache");
  });

  it("falls back when LLM returns empty string", async () => {
    mockRoutineFn = async () => "   ";
    const name = await buildIsolatedTopicName("coding", "do the thing");
    expect(name).toBe("🛠 do the thing");
  });
});
