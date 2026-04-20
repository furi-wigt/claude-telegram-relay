/**
 * Unit tests for the stream cancellation module (src/cancel.ts).
 *
 * Tests the cancellation logic in isolation from relay.ts side effects.
 * All Telegram API calls are mocked.
 *
 * Run: bun test src/cancel.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { streamKey, parseCancelKey, handleCancelCallback, handleCancelCommand, activeStreams, abortStreamsForDispatch } from "./cancel.ts";

// ── Mock Telegram API ─────────────────────────────────────────────────────────

function createMockCtx(chatId: number) {
  return {
    chat: { id: chatId },
    message: { message_thread_id: undefined as number | undefined },
    answerCallbackQuery: mock((_opts?: unknown) => Promise.resolve()),
    reply: mock((_text: string, _opts?: unknown) => Promise.resolve({ message_id: 100 })),
  };
}

function createMockBot() {
  return {
    api: {
      editMessageReplyMarkup: mock(
        (_chatId: number, _msgId: number, _opts: unknown) => Promise.resolve({})
      ),
    },
  };
}

beforeEach(() => {
  activeStreams.clear();
});

// ═══════════════════════════════════════════════════════════════
// Suite A: streamKey / parseCancelKey
// ═══════════════════════════════════════════════════════════════

describe("streamKey()", () => {
  test("chatId + null threadId → 'chatId:'", () => {
    expect(streamKey(12345, null)).toBe("12345:");
  });

  test("chatId + numeric threadId → 'chatId:threadId'", () => {
    expect(streamKey(12345, 7)).toBe("12345:7");
  });

  test("different chatIds → different keys", () => {
    expect(streamKey(1, null)).not.toBe(streamKey(2, null));
  });

  test("same chatId different threadIds → different keys", () => {
    expect(streamKey(100, 1)).not.toBe(streamKey(100, 2));
  });

  test("threadId null vs 0 → different keys", () => {
    expect(streamKey(1, null)).not.toBe(streamKey(1, 0));
  });
});

describe("parseCancelKey()", () => {
  test("no thread → chatId extracted, threadId null", () => {
    const result = parseCancelKey("cancel:12345:");
    expect(result.chatId).toBe(12345);
    expect(result.threadId).toBeNull();
  });

  test("with thread → both extracted correctly", () => {
    const result = parseCancelKey("cancel:12345:7");
    expect(result.chatId).toBe(12345);
    expect(result.threadId).toBe(7);
  });

  test("negative chatId (groups) → parsed correctly", () => {
    const result = parseCancelKey("cancel:-100123456789:");
    expect(result.chatId).toBe(-100123456789);
    expect(result.threadId).toBeNull();
  });

  test("negative chatId + thread → both extracted", () => {
    const result = parseCancelKey("cancel:-100123456789:42");
    expect(result.chatId).toBe(-100123456789);
    expect(result.threadId).toBe(42);
  });

  test("round-trips with streamKey (no thread)", () => {
    const chatId = 99999;
    const data = `cancel:${streamKey(chatId, null)}`;
    const result = parseCancelKey(data);
    expect(result.chatId).toBe(chatId);
    expect(result.threadId).toBeNull();
  });

  test("round-trips with streamKey (with thread)", () => {
    const chatId = 99999;
    const threadId = 5;
    const data = `cancel:${streamKey(chatId, threadId)}`;
    const result = parseCancelKey(data);
    expect(result.chatId).toBe(chatId);
    expect(result.threadId).toBe(threadId);
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite B: handleCancelCallback — active stream
// ═══════════════════════════════════════════════════════════════

describe("handleCancelCallback() — active stream present", () => {
  test("aborts the AbortController", async () => {
    const chatId = 42;
    const controller = new AbortController();
    activeStreams.set(streamKey(chatId, null), {
      controller,
      progressMessageId: undefined,
    });

    const ctx = createMockCtx(chatId);
    const bot = createMockBot();

    await handleCancelCallback(chatId, null, ctx as any, bot as any);

    expect(controller.signal.aborted).toBe(true);
  });

  test("sends a reply to the user mentioning cancellation", async () => {
    const chatId = 42;
    const controller = new AbortController();
    activeStreams.set(streamKey(chatId, null), { controller });

    const ctx = createMockCtx(chatId);
    const bot = createMockBot();

    await handleCancelCallback(chatId, null, ctx as any, bot as any);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText.toLowerCase()).toContain("cancel");
  });

  test("removes Cancel button when progressMessageId is present", async () => {
    const chatId = 42;
    const controller = new AbortController();
    const progressMessageId = 9999;
    activeStreams.set(streamKey(chatId, null), { controller, progressMessageId });

    const ctx = createMockCtx(chatId);
    const bot = createMockBot();

    await handleCancelCallback(chatId, null, ctx as any, bot as any);

    expect(bot.api.editMessageReplyMarkup).toHaveBeenCalledTimes(1);
    const args = (bot.api.editMessageReplyMarkup as ReturnType<typeof mock>).mock.calls[0];
    expect(args[0]).toBe(chatId);
    expect(args[1]).toBe(progressMessageId);
    // Inline keyboard cleared
    const markup = args[2] as { reply_markup: { inline_keyboard: unknown[] } };
    expect(markup.reply_markup.inline_keyboard).toHaveLength(0);
  });

  test("skips editMessageReplyMarkup when no progressMessageId", async () => {
    const chatId = 42;
    const controller = new AbortController();
    activeStreams.set(streamKey(chatId, null), { controller });

    const ctx = createMockCtx(chatId);
    const bot = createMockBot();

    await handleCancelCallback(chatId, null, ctx as any, bot as any);

    expect(bot.api.editMessageReplyMarkup).not.toHaveBeenCalled();
  });

  test("deletes the activeStreams entry", async () => {
    const chatId = 42;
    const controller = new AbortController();
    const key = streamKey(chatId, null);
    activeStreams.set(key, { controller });

    const ctx = createMockCtx(chatId);
    const bot = createMockBot();

    await handleCancelCallback(chatId, null, ctx as any, bot as any);

    expect(activeStreams.has(key)).toBe(false);
  });

  test("forum thread cancel only affects the correct thread", async () => {
    const chatId = 777;
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    activeStreams.set(streamKey(chatId, null), { controller: ctrl1 });
    activeStreams.set(streamKey(chatId, 5), { controller: ctrl2 });

    const ctx = createMockCtx(chatId);
    const bot = createMockBot();

    await handleCancelCallback(chatId, 5, ctx as any, bot as any);

    expect(ctrl2.signal.aborted).toBe(true);
    expect(ctrl1.signal.aborted).toBe(false);
    expect(activeStreams.has(streamKey(chatId, 5))).toBe(false);
    expect(activeStreams.has(streamKey(chatId, null))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite C: handleCancelCallback — no active stream
// ═══════════════════════════════════════════════════════════════

describe("handleCancelCallback() — no active stream", () => {
  test("replies with 'nothing to cancel' (no crash)", async () => {
    const ctx = createMockCtx(55);
    const bot = createMockBot();

    await handleCancelCallback(55, null, ctx as any, bot as any);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const text = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(text.toLowerCase()).toMatch(/nothing|no.*active|already/);
  });

  test("does not call editMessageReplyMarkup", async () => {
    const ctx = createMockCtx(55);
    const bot = createMockBot();

    await handleCancelCallback(55, null, ctx as any, bot as any);

    expect(bot.api.editMessageReplyMarkup).not.toHaveBeenCalled();
  });

  test("resolves without throwing", async () => {
    const ctx = createMockCtx(99);
    const bot = createMockBot();

    await expect(
      handleCancelCallback(99, null, ctx as any, bot as any)
    ).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite D: handleCancelCommand — active stream
// ═══════════════════════════════════════════════════════════════

describe("handleCancelCommand() — active stream present", () => {
  test("aborts the controller", async () => {
    const chatId = 300;
    const controller = new AbortController();
    activeStreams.set(streamKey(chatId, null), { controller });

    const ctx = createMockCtx(chatId);
    const bot = createMockBot();

    await handleCancelCommand(chatId, null, ctx as any, bot as any);

    expect(controller.signal.aborted).toBe(true);
  });

  test("sends confirmation reply", async () => {
    const chatId = 300;
    const controller = new AbortController();
    activeStreams.set(streamKey(chatId, null), { controller });

    const ctx = createMockCtx(chatId);
    const bot = createMockBot();

    await handleCancelCommand(chatId, null, ctx as any, bot as any);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const text = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(text.toLowerCase()).toContain("cancel");
  });

  test("deletes activeStreams entry", async () => {
    const chatId = 300;
    const controller = new AbortController();
    const key = streamKey(chatId, null);
    activeStreams.set(key, { controller });

    const ctx = createMockCtx(chatId);
    const bot = createMockBot();

    await handleCancelCommand(chatId, null, ctx as any, bot as any);

    expect(activeStreams.has(key)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite E: handleCancelCommand — no active stream
// ═══════════════════════════════════════════════════════════════

describe("handleCancelCommand() — no active stream", () => {
  test("replies with graceful no-op message", async () => {
    const ctx = createMockCtx(500);
    const bot = createMockBot();

    await handleCancelCommand(500, null, ctx as any, bot as any);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const text = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(text.toLowerCase()).toMatch(/nothing|no.*active|already/);
  });

  test("resolves without throwing", async () => {
    const ctx = createMockCtx(500);
    const bot = createMockBot();

    await expect(
      handleCancelCommand(500, null, ctx as any, bot as any)
    ).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite F: Idempotency — double cancel
// ═══════════════════════════════════════════════════════════════

describe("Double cancel — idempotency", () => {
  test("second callback cancel → 'nothing to cancel' (entry already deleted by first)", async () => {
    const chatId = 700;
    const controller = new AbortController();
    activeStreams.set(streamKey(chatId, null), { controller });

    const ctx = createMockCtx(chatId);
    const bot = createMockBot();

    // First cancel
    await handleCancelCallback(chatId, null, ctx as any, bot as any);
    // Second cancel — entry already gone
    await handleCancelCallback(chatId, null, ctx as any, bot as any);

    expect(controller.signal.aborted).toBe(true);
    expect(ctx.reply).toHaveBeenCalledTimes(2);

    const secondReply = (ctx.reply as ReturnType<typeof mock>).mock.calls[1][0] as string;
    expect(secondReply.toLowerCase()).toMatch(/nothing|no.*active|already/);
  });

  test("AbortController.abort() called twice is inherently idempotent", () => {
    const controller = new AbortController();
    controller.abort();
    controller.abort(); // Must not throw

    expect(controller.signal.aborted).toBe(true);
  });

  test("command then callback for same stream → second sees no entry", async () => {
    const chatId = 800;
    const controller = new AbortController();
    activeStreams.set(streamKey(chatId, null), { controller });

    const ctx = createMockCtx(chatId);
    const bot = createMockBot();

    await handleCancelCommand(chatId, null, ctx as any, bot as any);
    await handleCancelCallback(chatId, null, ctx as any, bot as any);

    expect(controller.signal.aborted).toBe(true);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite I: abortStreamsForDispatch — mid-stream cancel from harness
// ═══════════════════════════════════════════════════════════════

describe("abortStreamsForDispatch()", () => {
  test("aborts only the stream tagged with the matching dispatchId", () => {
    const cA = new AbortController();
    const cB = new AbortController();
    const cUntagged = new AbortController();

    activeStreams.set("agent-A:0", { controller: cA, dispatchId: "dispatch-1" });
    activeStreams.set("agent-B:0", { controller: cB, dispatchId: "dispatch-2" });
    activeStreams.set("user-direct:0", { controller: cUntagged }); // no dispatchId

    abortStreamsForDispatch("dispatch-1");

    expect(cA.signal.aborted).toBe(true);
    expect(cB.signal.aborted).toBe(false);
    expect(cUntagged.signal.aborted).toBe(false);
  });

  test("removes aborted entries from activeStreams (no leak)", () => {
    const c = new AbortController();
    activeStreams.set("agent-A:0", { controller: c, dispatchId: "dispatch-1" });

    abortStreamsForDispatch("dispatch-1");

    expect(activeStreams.has("agent-A:0")).toBe(false);
  });

  test("leaves untagged direct-user streams untouched", () => {
    const c = new AbortController();
    activeStreams.set("user-direct:0", { controller: c }); // no dispatchId

    abortStreamsForDispatch("dispatch-1");

    expect(c.signal.aborted).toBe(false);
    expect(activeStreams.has("user-direct:0")).toBe(true);
  });

  test("unknown dispatchId is a no-op (does not throw, does not mutate)", () => {
    const c = new AbortController();
    activeStreams.set("agent-A:0", { controller: c, dispatchId: "dispatch-1" });

    expect(() => abortStreamsForDispatch("nonexistent")).not.toThrow();
    expect(c.signal.aborted).toBe(false);
    expect(activeStreams.has("agent-A:0")).toBe(true);
  });

  test("aborts multiple streams sharing the same dispatchId", () => {
    // Edge case: a single dispatch could (in theory) own multiple streams
    // if a step triggers parallel sub-calls — guard against that.
    const c1 = new AbortController();
    const c2 = new AbortController();
    activeStreams.set("agent-A:0", { controller: c1, dispatchId: "dispatch-1" });
    activeStreams.set("agent-B:0", { controller: c2, dispatchId: "dispatch-1" });

    abortStreamsForDispatch("dispatch-1");

    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
    expect(activeStreams.size).toBe(0);
  });
});
