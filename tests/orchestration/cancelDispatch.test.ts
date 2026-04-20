/**
 * Phase 5 — cancel-dispatch callback, slash command, and CC `/cancel` reroute.
 *
 * Behaviour under test:
 *  1. `handleCancelDispatchCallback(ctx, bot, dispatchId)` flips the
 *     harnessRegistry cancel flag, removes the inline keyboard, and answers
 *     the callback query with a "🛑 Cancelled" popup.
 *  2. The same callback on an unknown / already-completed dispatchId answers
 *     with "already completed or expired".
 *  3. `handleCancelDispatchCommand(ctx, bot)` in CC with an active harness
 *     flips the registry and replies with confirmation.
 *  4. In CC with no active harness → replies "Nothing to cancel".
 *  5. Outside CC → replies "only works in Command Center".
 *  6. `handleCancelInCommandCenter(chatId, threadId, ctx, bot)`:
 *     - active harness → returns `true` AND flips registry (does NOT call
 *       the existing `/cancel` flow which would delete CC's own activeStream)
 *     - no active harness → returns `false` so caller falls through to the
 *       existing `handleCancelCommand` behaviour.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  registerHarness,
  cancelled,
  _resetRegistryForTests,
} from "../../src/orchestration/harnessRegistry";
import { activeStreams } from "../../src/cancel";

const CC_CHAT_ID = -100990001;
const NON_CC_CHAT_ID = -100990002;

function makeCallbackCtx(chatId: number, threadId: number | null = null) {
  const answers: Array<{ text?: string }> = [];
  return {
    callbackQuery: {
      data: "",
      message: {
        chat: { id: chatId },
        message_id: 4242,
        message_thread_id: threadId,
      },
    },
    answerCallbackQuery: async (opts?: { text?: string }) => {
      answers.push(opts ?? {});
      return undefined;
    },
    _answers: answers,
  };
}

function makeCommandCtx(chatId: number, threadId: number | null = null) {
  const replies: string[] = [];
  return {
    chat: { id: chatId },
    message: { text: "/cancel-dispatch", message_thread_id: threadId },
    reply: async (t: string) => {
      replies.push(t);
      return { message_id: 77 };
    },
    _replies: replies,
  };
}

function makeBot() {
  const edits: Array<{ chatId: number; msgId: number; markup: unknown }> = [];
  return {
    api: {
      editMessageReplyMarkup: async (chatId: number, msgId: number, opts: unknown) => {
        edits.push({ chatId, msgId, markup: opts });
        return true;
      },
    },
    _edits: edits,
  };
}

// Stub AGENTS so the CC check works without touching real env
// (isCommandCenter depends on AGENTS["command-center"].chatId)
beforeEach(() => {
  _resetRegistryForTests();
  activeStreams.clear();
});

describe("handleCancelDispatchCallback", () => {
  test("flips registry, removes keyboard, answers with cancel popup", async () => {
    const { handleCancelDispatchCallback } = await import(
      "../../src/orchestration/commandCenter"
    );
    const dispatchId = crypto.randomUUID();
    registerHarness(dispatchId, { ccChatId: CC_CHAT_ID, ccThreadId: null });
    expect(cancelled(dispatchId)).toBe(false);

    const ctx = makeCallbackCtx(CC_CHAT_ID);
    const bot = makeBot();

    await handleCancelDispatchCallback(ctx as any, bot as any, dispatchId);

    expect(cancelled(dispatchId)).toBe(true);
    expect(bot._edits.length).toBe(1);
    expect(bot._edits[0].chatId).toBe(CC_CHAT_ID);
    expect(bot._edits[0].msgId).toBe(4242);
    expect(ctx._answers[0]?.text ?? "").toMatch(/cancelled/i);
  });

  test("unknown dispatchId answers 'already completed or expired'", async () => {
    const { handleCancelDispatchCallback } = await import(
      "../../src/orchestration/commandCenter"
    );
    const ctx = makeCallbackCtx(CC_CHAT_ID);
    const bot = makeBot();

    await handleCancelDispatchCallback(ctx as any, bot as any, "does-not-exist");

    expect(ctx._answers[0]?.text ?? "").toMatch(/already completed|expired/i);
    expect(bot._edits.length).toBe(0);
  });
});

describe("handleCancelDispatchCommand", () => {
  test("in CC with active harness: flips registry + confirmation reply", async () => {
    const { handleCancelDispatchCommand } = await import(
      "../../src/orchestration/commandCenter"
    );
    const { AGENTS } = await import("../../src/agents/config");
    const ccChatId = AGENTS["command-center"]?.chatId;
    expect(ccChatId).toBeTruthy(); // guard: test requires configured CC

    const dispatchId = crypto.randomUUID();
    registerHarness(dispatchId, { ccChatId: ccChatId!, ccThreadId: null });

    const ctx = makeCommandCtx(ccChatId!, null);
    const bot = makeBot();

    await handleCancelDispatchCommand(ctx as any, bot as any);

    expect(cancelled(dispatchId)).toBe(true);
    expect(ctx._replies.join("\n")).toMatch(/cancelled|cancelling/i);
  });

  test("in CC with no active harness: replies 'Nothing to cancel'", async () => {
    const { handleCancelDispatchCommand } = await import(
      "../../src/orchestration/commandCenter"
    );
    const { AGENTS } = await import("../../src/agents/config");
    const ccChatId = AGENTS["command-center"]?.chatId;
    const ctx = makeCommandCtx(ccChatId!, null);
    const bot = makeBot();

    await handleCancelDispatchCommand(ctx as any, bot as any);

    expect(ctx._replies.join("\n")).toMatch(/nothing to cancel/i);
  });

  test("outside CC: replies 'only works in Command Center'", async () => {
    const { handleCancelDispatchCommand } = await import(
      "../../src/orchestration/commandCenter"
    );
    const ctx = makeCommandCtx(NON_CC_CHAT_ID, null);
    const bot = makeBot();

    await handleCancelDispatchCommand(ctx as any, bot as any);

    expect(ctx._replies.join("\n")).toMatch(/only works in command center/i);
  });
});

describe("handleCancelInCommandCenter — /cancel reroute", () => {
  test("active harness → returns true AND flips registry (does NOT touch activeStreams)", async () => {
    const { handleCancelInCommandCenter } = await import(
      "../../src/orchestration/commandCenter"
    );
    const { AGENTS } = await import("../../src/agents/config");
    const ccChatId = AGENTS["command-center"]?.chatId;
    const dispatchId = crypto.randomUUID();
    registerHarness(dispatchId, { ccChatId: ccChatId!, ccThreadId: null });

    // Seed an entry in activeStreams for CC to prove we do NOT delete it
    const ccKey = `${ccChatId}:`;
    activeStreams.set(ccKey, {
      controller: new AbortController(),
    } as any);

    const ctx = makeCommandCtx(ccChatId!, null);
    const bot = makeBot();

    const handled = await handleCancelInCommandCenter(ccChatId!, null, ctx as any, bot as any);

    expect(handled).toBe(true);
    expect(cancelled(dispatchId)).toBe(true);
    // CC's own activeStream entry must remain — we only flipped the registry flag
    expect(activeStreams.has(ccKey)).toBe(true);
  });

  test("no active harness → returns false (caller falls through)", async () => {
    const { handleCancelInCommandCenter } = await import(
      "../../src/orchestration/commandCenter"
    );
    const { AGENTS } = await import("../../src/agents/config");
    const ccChatId = AGENTS["command-center"]?.chatId;
    const ctx = makeCommandCtx(ccChatId!, null);
    const bot = makeBot();

    const handled = await handleCancelInCommandCenter(ccChatId!, null, ctx as any, bot as any);

    expect(handled).toBe(false);
  });
});
