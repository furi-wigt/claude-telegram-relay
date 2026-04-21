/**
 * Tests: cwd propagation through dispatchEngine
 *
 * Verifies that executeSingleDispatch passes plan.cwd as cwdOverride
 * to the registered dispatch runner.
 */
import { describe, test, expect, mock } from "bun:test";

function makeAgent() {
  return {
    "engineering": {
      id: "engineering",
      name: "Engineering & Quality",
      chatId: -100999,
      topicId: null,
      meshTopicId: null,
      capabilities: [],
      isDefault: false,
    },
  };
}

function makePlan(cwd?: string): import("../../src/orchestration/types").DispatchPlan {
  return {
    dispatchId: crypto.randomUUID(),
    userMessage: "review this",
    classification: {
      intent: "code-review",
      primaryAgent: "engineering",
      topicHint: null,
      isCompound: false,
      confidence: 0.95,
      reasoning: "test",
    },
    tasks: [{ seq: 1, agentId: "engineering", topicHint: null, taskDescription: "review this" }],
    cwd,
  };
}

describe("dispatchEngine cwd propagation", () => {
  test("plan.cwd is passed as cwdOverride to dispatch runner", async () => {
    const capturedOpts: any[] = [];

    // Mock dependencies before importing the module
    mock.module("../../src/agents/config", () => ({ AGENTS: makeAgent() }));
    mock.module("../../src/local/db", () => ({
      getDb: () => ({
        run: () => {},
        query: () => ({ all: () => [] }),
      }),
    }));

    const { executeSingleDispatch, setDispatchRunner } = await import("../../src/orchestration/dispatchEngine");

    setDispatchRunner(async (_chatId, _topicId, _text, _dispatchId, opts) => {
      capturedOpts.push(opts);
      return "agent response";
    });

    const mockBot = {
      api: {
        sendMessage: async () => ({ message_id: 42 }),
      },
    };

    const plan = makePlan("/my/cwd");
    await executeSingleDispatch(mockBot as any, plan, -100001, null);

    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0].cwdOverride).toBe("/my/cwd");
    expect(capturedOpts[0].dangerouslySkipPermissions).toBe(true);
  });

  test("plan.cwd=undefined: cwdOverride is undefined in runner opts", async () => {
    const capturedOpts: any[] = [];

    mock.module("../../src/agents/config", () => ({ AGENTS: makeAgent() }));
    mock.module("../../src/local/db", () => ({
      getDb: () => ({
        run: () => {},
        query: () => ({ all: () => [] }),
      }),
    }));

    const { executeSingleDispatch, setDispatchRunner } = await import("../../src/orchestration/dispatchEngine");

    setDispatchRunner(async (_chatId, _topicId, _text, _dispatchId, opts) => {
      capturedOpts.push(opts);
      return "agent response";
    });

    const mockBot = {
      api: {
        sendMessage: async () => ({ message_id: 43 }),
      },
    };

    const plan = makePlan(undefined);
    await executeSingleDispatch(mockBot as any, plan, -100002, null);

    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0].cwdOverride).toBeUndefined();
  });
});
