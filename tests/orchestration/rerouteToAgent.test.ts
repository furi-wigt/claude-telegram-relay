/**
 * Phase 3 — `rerouteToAgent` unified via `runHarness`.
 *
 * Before unification, follow-up replies bypassed the harness and called
 * `executeSingleDispatch` directly — so [REDIRECT:] tags emitted by the
 * agent leaked into CC chunks instead of triggering re-routing.
 *
 * After unification, `rerouteToAgent` builds a 1-step `DispatchPlan` and
 * delegates to `runHarness`, which:
 *   - strips [REDIRECT:] / [CLARIFY:] tags from posted text
 *   - executes the redirected agent in a 2nd step
 *   - posts a synthesis line for multi-step dispatches
 *   - registers each chunk via trackAgentReply
 */

import { describe, test, expect, mock, beforeEach, afterAll, beforeAll } from "bun:test";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const CONTRACTS_DIR = join(homedir(), ".claude-relay", "contracts");

// "follow-up" intent has no contract → harness falls back to single-step
// using plan.classification.primaryAgent. We don't need to write a contract
// file for this test — that fallback path is exercised.

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

function makeMockCtx() {
  const replies: string[] = [];
  return {
    _replies: replies,
    reply: async (text: string, _opts?: unknown) => {
      replies.push(text);
      return { message_id: 1 };
    },
  } as any;
}

describe("rerouteToAgent — unified via runHarness", () => {
  beforeAll(async () => {
    await mkdir(CONTRACTS_DIR, { recursive: true });
  });

  beforeEach(() => {
    // Re-import below per test forces re-evaluation; nothing to clear here.
  });

  afterAll(async () => {
    // No fixtures to remove (no contract written).
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
            response: "I think this is an engineering question. [REDIRECT: engineering]",
            durationMs: 100,
          };
        }
        return { success: true, response: "Engineering's answer.", durationMs: 200 };
      },
    }));

    const { rerouteToAgent } = await import("../../src/orchestration/commandCenter");
    const bot = makeMockBot() as any;
    const ctx = makeMockCtx();

    await rerouteToAgent(bot, ctx, "the original follow-up", -300100, null, "operations-hub");

    // Both ops-hub AND engineering ran (redirect honoured)
    expect(dispatched).toEqual(["operations-hub", "engineering"]);

    // The posted result text must NOT contain the [REDIRECT:] tag
    const postedTexts = bot._sent.map((m: any) => m.text).join("\n---\n");
    expect(postedTexts).not.toMatch(/\[REDIRECT:/i);

    // First-step body should be present (tag stripped)
    expect(postedTexts).toContain("I think this is an engineering question.");
    // Second-step body should be present
    expect(postedTexts).toContain("Engineering's answer.");
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

    const { rerouteToAgent } = await import("../../src/orchestration/commandCenter");
    const bot = makeMockBot() as any;
    const ctx = makeMockCtx();

    await rerouteToAgent(bot, ctx, "the original follow-up", -300101, null, "operations-hub");

    // Synthesis line is the multi-step summary posted by harness
    const allText = bot._sent.map((m: any) => m.text).join("\n");
    expect(allText).toMatch(/Dispatch complete/i);
  });

  test("each result message is registered in pendingAgentReplies", async () => {
    mock.module("../../src/orchestration/dispatchEngine", () => ({
      executeSingleDispatch: async (_bot: unknown, plan: any) => {
        return {
          success: true,
          response: `Reply from ${plan.tasks[0].agentId}.`,
          durationMs: 50,
        };
      },
    }));

    const { rerouteToAgent } = await import("../../src/orchestration/commandCenter");
    const { lookupAgentReply, _clearAll } = await import("../../src/orchestration/pendingAgentReplies");
    _clearAll();

    const bot = makeMockBot() as any;
    const ctx = makeMockCtx();

    await rerouteToAgent(bot, ctx, "follow-up text", -300102, null, "engineering");

    // Find result chunk message_ids — those are sent to ccChatId by the harness
    // (the `↩️ Follow-up → ...` notice is posted via ctx.reply, not bot.api).
    const resultMsgs = bot._sent.filter((m: any) => m.chatId === -300102);
    // At least one result message
    expect(resultMsgs.length).toBeGreaterThan(0);

    // The first result message is the one tagged via trackAgentReply.
    // We can't easily inspect message_id (random), but we can verify
    // pendingAgentReplies has at least one entry by trying to lookup any
    // posted message_id. Iterate over what we know was sent.
    let foundTracked = false;
    for (const sent of resultMsgs) {
      const opts: any = sent.opts ?? {};
      // Synthesis msg ("Dispatch complete") is single-step here so absent;
      // the actual sendMessage spies don't capture message_id back into _sent.
      // Use a different approach: track _size via the module API.
      void opts;
    }
    // Use pendingAgentReplies internal _size to confirm at least 1 tracked
    const { _size } = await import("../../src/orchestration/pendingAgentReplies");
    expect(_size()).toBeGreaterThan(0);
    foundTracked = _size() > 0;
    expect(foundTracked).toBe(true);

    // Last-active agent is also recorded
    const { getLastActiveAgent } = await import("../../src/orchestration/pendingAgentReplies");
    expect(getLastActiveAgent(-300102, null)).toBe("engineering");
  });
});
