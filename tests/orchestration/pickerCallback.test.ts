/**
 * Phase 4 — `executePickerDispatch` unified via `runHarness`.
 *
 * Before unification, the picker callback (low-confidence intent → user picks
 * agent from inline keyboard) called `executeSingleDispatch` directly and then
 * manually chunked the result via sendMessage + trackAgentReply. So
 * [REDIRECT:] tags emitted by the user-selected agent leaked into the posted
 * text instead of triggering re-routing.
 *
 * After unification, `executePickerDispatch` delegates to `runHarness`, which:
 *   - strips [REDIRECT:] / [CLARIFY:] tags from posted text
 *   - executes the redirected agent in a 2nd step
 *   - posts a synthesis line for multi-step dispatches
 *   - registers each chunk via trackAgentReply
 *   - records last-active agent
 */

import { describe, test, expect, mock, beforeAll } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const CONTRACTS_DIR = join(homedir(), ".claude-relay", "contracts");

function makeMockBot() {
  const sent: Array<{ chatId: number; text: string; opts?: unknown }> = [];
  const bot = {
    api: {
      sendMessage: async (chatId: number, text: string, opts?: unknown) => {
        sent.push({ chatId, text, opts });
        return { message_id: Math.floor(Math.random() * 100000) };
      },
    },
    _sent: sent,
  };
  return bot;
}

function makePlan(agentId: string, userMessage: string, dispatchId: string) {
  return {
    dispatchId,
    userMessage,
    classification: {
      intent: "user-selected",
      primaryAgent: agentId,
      topicHint: null,
      isCompound: false,
      confidence: 1.0,
      reasoning: `User selected ${agentId}`,
    },
    tasks: [{ seq: 1, agentId, topicHint: null, taskDescription: userMessage }],
  };
}

describe("executePickerDispatch — unified via runHarness", () => {
  beforeAll(async () => {
    await mkdir(CONTRACTS_DIR, { recursive: true });
  });

  test("redirect tag triggers 2nd dispatch and tag is stripped from posted text", async () => {
    const dispatched: string[] = [];

    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async (_bot: unknown, plan: any) => {
        const agentId = plan.tasks[0].agentId;
        dispatched.push(agentId);
        if (agentId === "operations-hub") {
          return {
            success: true,
            response: "Better routed to engineering. [REDIRECT: engineering]",
            durationMs: 100,
          };
        }
        return { success: true, response: "Engineering's reply.", durationMs: 200 };
      },
    }));

    const { executePickerDispatch } = await import("../../src/orchestration/commandCenter");
    const bot = makeMockBot() as any;
    const plan = makePlan("operations-hub", "the picker-selected query", crypto.randomUUID());

    await executePickerDispatch(bot, plan, -400100, null);

    // Both ops-hub AND engineering ran (redirect honoured)
    expect(dispatched).toEqual(["operations-hub", "engineering"]);

    // The posted result text must NOT contain the [REDIRECT:] tag
    const postedTexts = bot._sent.map((m: any) => m.text).join("\n---\n");
    expect(postedTexts).not.toMatch(/\[REDIRECT:/i);

    // First-step body should be present (tag stripped)
    expect(postedTexts).toContain("Better routed to engineering.");
    // Second-step body should be present
    expect(postedTexts).toContain("Engineering's reply.");
  });

  test("synthesis block is posted when redirect fires (2-step dispatch)", async () => {
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async (_bot: unknown, plan: any) => {
        const agentId = plan.tasks[0].agentId;
        if (agentId === "operations-hub") {
          return { success: true, response: "Try eng. [REDIRECT: engineering]", durationMs: 100 };
        }
        return { success: true, response: "Done.", durationMs: 200 };
      },
    }));

    const { executePickerDispatch } = await import("../../src/orchestration/commandCenter");
    const bot = makeMockBot() as any;
    const plan = makePlan("operations-hub", "another query", crypto.randomUUID());

    await executePickerDispatch(bot, plan, -400101, null);

    const allText = bot._sent.map((m: any) => m.text).join("\n");
    expect(allText).toMatch(/Dispatch complete/i);
  });

  test("each result message is registered in pendingAgentReplies and last-active agent tracked", async () => {
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async (_bot: unknown, plan: any) => {
        return {
          success: true,
          response: `Reply from ${plan.tasks[0].agentId}.`,
          durationMs: 50,
        };
      },
    }));

    const { executePickerDispatch } = await import("../../src/orchestration/commandCenter");
    const { _clearAll, _size, getLastActiveAgent } = await import(
      "../../src/orchestration/pendingAgentReplies"
    );
    _clearAll();

    const bot = makeMockBot() as any;
    const plan = makePlan("engineering", "tracked picker query", crypto.randomUUID());

    await executePickerDispatch(bot, plan, -400102, null);

    // At least one tracked reply
    expect(_size()).toBeGreaterThan(0);

    // Last-active agent recorded
    expect(getLastActiveAgent(-400102, null)).toBe("engineering");
  });
});
