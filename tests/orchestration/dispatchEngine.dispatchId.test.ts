/**
 * Phase 2 (cont.): verify the dispatch engine threads `dispatchId` through to
 * the registered DispatchRunner so callers (relay.ts) can tag the resulting
 * `ActiveStream` entry. Without this, `abortStreamsForDispatch(dispatchId)`
 * has nothing to match against and mid-stream cancel is a no-op in production.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

describe("dispatchEngine — dispatchId threading", () => {
  beforeEach(() => {
    // Force a fresh import each test so module state (`_dispatchRunner`) is reset.
    delete (globalThis as any).__bunInternalModuleCache__; // best-effort no-op
  });

  test("executeSingleDispatch passes plan.dispatchId as 4th arg to the runner", async () => {
    const { setDispatchRunner, executeSingleDispatch } = await import(
      "../../src/orchestration/dispatchEngine"
    );

    let capturedArgs: unknown[] | null = null;
    setDispatchRunner((async (...args: unknown[]) => {
      capturedArgs = args;
      return "ok";
    }) as any);

    // Use a real configured agent so the dispatch path doesn't bail early.
    const { AGENTS } = await import("../../src/agents/config.ts");
    const realAgent = Object.values(AGENTS).find((a) => a.chatId != null);
    if (!realAgent) {
      // No configured agents in this env — skip rather than fail the suite.
      console.warn("[test] no configured agent in AGENTS — skipping");
      return;
    }

    const plan = {
      dispatchId: crypto.randomUUID(),
      userMessage: "test",
      classification: {
        intent: "general",
        primaryAgent: realAgent.id,
        topicHint: null,
        isCompound: false,
        confidence: 0.9,
        reasoning: "test",
      },
      tasks: [
        { seq: 1, agentId: realAgent.id, topicHint: null, taskDescription: "test message" },
      ],
    };

    const bot = {
      api: {
        sendMessage: async () => ({ message_id: 1 }),
      },
    } as any;

    await executeSingleDispatch(bot, plan as any, -100999, null);

    expect(capturedArgs).not.toBeNull();
    // Signature: (chatId, topicId, text, dispatchId)
    expect(capturedArgs![3]).toBe(plan.dispatchId);
  });
});
