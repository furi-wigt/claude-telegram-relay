import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { initOrchestrationSchema } from "../../src/orchestration/schema";
import {
  executeBlackboardDispatch,
  setTopicCreator,
  setDispatchNotifier,
  _getSessionTopicCache,
} from "../../src/orchestration/dispatchEngine";
import type { DispatchPlan } from "../../src/orchestration/types";

function makePlan(overrides: Partial<DispatchPlan> = {}): DispatchPlan {
  return {
    dispatchId: `dyn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    userMessage: "Review Terraform for IM8 compliance",
    classification: {
      intent: "security-review",
      primaryAgent: "security-compliance",
      topicHint: null,
      isCompound: false,
      confidence: 0.9,
      reasoning: "test",
    },
    tasks: [{ seq: 1, agentId: "security-compliance", topicHint: null, taskDescription: "Review Terraform for IM8 compliance" }],
    ...overrides,
  };
}

describe("Dynamic Dispatch Topics", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    initOrchestrationSchema(db);
  });

  afterAll(() => {
    db.close();
    // Reset DI slots
    setTopicCreator(null as any);
    setDispatchNotifier(null as any);
  });

  beforeEach(() => {
    _getSessionTopicCache().clear();
  });

  test("getOrCreateTopic caches — second call reuses topic, no duplicate creation", async () => {
    const createCalls: number[] = []; // chatIds that got createForumTopic
    setTopicCreator(async (chatId: number, _title: string) => {
      createCalls.push(chatId);
      return 42;
    });

    const notifyCalls: Array<{ chatId: number; topicId: number | null; text: string }> = [];
    setDispatchNotifier(async (chatId, topicId, text) => {
      notifyCalls.push({ chatId, topicId, text });
    });

    // Multi-task plan: same agent dispatched twice — should cache the topic
    const plan = makePlan({
      dispatchId: "dyn-cache-1",
      tasks: [
        { seq: 1, agentId: "security-compliance", topicHint: null, taskDescription: "Task 1" },
        { seq: 2, agentId: "security-compliance", topicHint: null, taskDescription: "Task 2" },
      ],
      classification: { intent: "test", primaryAgent: "security-compliance", topicHint: null, isCompound: true, confidence: 0.9, reasoning: "test" },
    });

    const runner = mock(async () => "Done");
    await executeBlackboardDispatch(db, plan, runner);

    // The main agent's chatId should appear in createCalls only once (cached second time).
    // Reviewer (code-quality-coach) may create a separate topic in a different group — that's expected.
    const mainAgentChatId = createCalls[0];
    const mainAgentCreateCount = createCalls.filter(c => c === mainAgentChatId).length;
    expect(mainAgentCreateCount).toBe(1);

    // Both dispatch headers for the main agent group share the same topicId
    const mainNotifies = notifyCalls.filter(c => c.chatId === mainAgentChatId);
    expect(mainNotifies.length).toBeGreaterThanOrEqual(2);
    expect(mainNotifies.every(c => c.topicId === 42)).toBe(true);
  });

  test("getOrCreateTopic returns null when creator fails — graceful fallback", async () => {
    setTopicCreator(async () => {
      throw new Error("Bad Request: not enough rights to manage topics");
    });

    const notifyCalls: Array<{ topicId: number | null }> = [];
    setDispatchNotifier(async (_chatId, topicId) => {
      notifyCalls.push({ topicId });
    });

    const plan = makePlan({ dispatchId: "dyn-fail-1" });
    const runner = mock(async () => "Done");
    const result = await executeBlackboardDispatch(db, plan, runner);

    // Dispatch still succeeds despite topic creation failure
    expect(result.success).toBe(true);
    // Notifier called with null topicId (root chat fallback)
    expect(notifyCalls[0]?.topicId).toBeNull();
  });

  test("dispatch header sent before runner call", async () => {
    const callOrder: string[] = [];

    setTopicCreator(async () => {
      callOrder.push("createTopic");
      return 99;
    });
    setDispatchNotifier(async () => {
      callOrder.push("notifyHeader");
    });

    const runner = mock(async () => {
      callOrder.push("runner");
      return "Done";
    });

    const plan = makePlan({ dispatchId: "dyn-order-1" });
    await executeBlackboardDispatch(db, plan, runner);

    const topicIdx = callOrder.indexOf("createTopic");
    const headerIdx = callOrder.indexOf("notifyHeader");
    const runnerIdx = callOrder.indexOf("runner");

    expect(topicIdx).toBeLessThan(headerIdx);
    expect(headerIdx).toBeLessThan(runnerIdx);
  });

  test("runner receives dynamic topicId instead of static config", async () => {
    setTopicCreator(async () => 777);
    setDispatchNotifier(async () => {});

    const capturedTopicIds: Array<number | null> = [];
    const runner = mock(async (_chatId: number, topicId: number | null) => {
      capturedTopicIds.push(topicId);
      return "Done";
    });

    const plan = makePlan({ dispatchId: "dyn-topicid-1" });
    await executeBlackboardDispatch(db, plan, runner);

    // Runner received the dynamically created topicId, not null from config
    expect(capturedTopicIds[0]).toBe(777);
  });

  test("cache cleared on session completion", async () => {
    setTopicCreator(async () => 50);
    setDispatchNotifier(async () => {});

    const runner = mock(async () => "Done");
    const plan = makePlan({ dispatchId: "dyn-clear-1" });

    const cache = _getSessionTopicCache();
    const result = await executeBlackboardDispatch(db, plan, runner);

    // After dispatch completes, cache entries for this session should be cleared
    const remaining = [...cache.keys()].filter(k => k.startsWith(result.sessionId));
    expect(remaining).toHaveLength(0);
  });

  test("no topic creation when topicCreator not set", async () => {
    // Reset to null
    setTopicCreator(null as any);
    setDispatchNotifier(async () => {});

    const capturedTopicIds: Array<number | null> = [];
    const runner = mock(async (_chatId: number, topicId: number | null) => {
      capturedTopicIds.push(topicId);
      return "Done";
    });

    const plan = makePlan({ dispatchId: "dyn-nocreator-1" });
    await executeBlackboardDispatch(db, plan, runner);

    // Without creator, topicId should be null (root chat)
    expect(capturedTopicIds[0]).toBeNull();
  });
});
