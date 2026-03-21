/**
 * E2E / Integration tests for the claudeStream cancel flow.
 *
 * Covers the gap between the existing unit tests (cancel.ts handlers,
 * claudeStream AbortSignal) and full relay integration:
 *
 *   1. ProgressIndicator — Cancel button lifecycle
 *      • Sends inline [✖ Cancel] button with correct callback_data when cancelKey is set
 *      • Calls onMessageId(msgId) so relay can store it in activeStreams entry
 *      • Does NOT send Cancel button when cancelKey is absent
 *      • finish() edits the indicator message (removes button implicitly via text replace)
 *
 *   2. activeStreams lifecycle simulation (relay.ts callClaude pattern)
 *      • Entry registered before stream starts
 *      • Entry deleted in finally block on success
 *      • Entry deleted in finally block on abort
 *      • progressMessageId is updated via onMessageId callback
 *
 *   3. Cancel button callback_data format contract
 *      • "cancel:" + streamKey(chatId, threadId) matches relay.ts routing prefix
 *
 * Run: bun test src/cancel-e2e.test.ts
 */

import { describe, test, expect, mock, beforeEach, beforeAll, afterAll } from "bun:test";
import { streamKey, activeStreams, handleCancelCallback } from "./cancel.ts";
import { ProgressIndicator } from "./utils/progressIndicator.ts";

// ── Env config scoped to this file ────────────────────────────────────────────
// Set delay to 0 so sendInitialMessage fires immediately. Edit interval set very
// high so it never fires during a test. Restored in afterAll to prevent bleed.
const _savedDelay = process.env.PROGRESS_INDICATOR_DELAY_MS;
const _savedInterval = process.env.PROGRESS_UPDATE_INTERVAL_MS;
const _savedDebounce = process.env.PROGRESS_IMMEDIATE_DEBOUNCE_MS;

beforeAll(() => {
  process.env.PROGRESS_INDICATOR_DELAY_MS = "0";
  process.env.PROGRESS_UPDATE_INTERVAL_MS = "99999999";
  process.env.PROGRESS_IMMEDIATE_DEBOUNCE_MS = "0";
});

afterAll(() => {
  if (_savedDelay === undefined) delete process.env.PROGRESS_INDICATOR_DELAY_MS;
  else process.env.PROGRESS_INDICATOR_DELAY_MS = _savedDelay;

  if (_savedInterval === undefined) delete process.env.PROGRESS_UPDATE_INTERVAL_MS;
  else process.env.PROGRESS_UPDATE_INTERVAL_MS = _savedInterval;

  if (_savedDebounce === undefined) delete process.env.PROGRESS_IMMEDIATE_DEBOUNCE_MS;
  else process.env.PROGRESS_IMMEDIATE_DEBOUNCE_MS = _savedDebounce;
});

// ── Mock bot factory ──────────────────────────────────────────────────────────

function createMockBot(sendMessageReturn?: object) {
  return {
    api: {
      sendMessage: mock((_chatId: number, _text: string, _opts?: unknown) =>
        Promise.resolve(sendMessageReturn ?? { message_id: 42 })
      ),
      editMessageText: mock(
        (_chatId: number, _msgId: number, _text: string, _opts?: unknown) =>
          Promise.resolve({})
      ),
      deleteMessage: mock(
        (_chatId: number, _msgId: number) => Promise.resolve({})
      ),
      editMessageReplyMarkup: mock(
        (_chatId: number, _msgId: number, _opts: unknown) => Promise.resolve({})
      ),
    },
  };
}

function createMockCtx(chatId: number) {
  return {
    chat: { id: chatId },
    reply: mock((_text: string, _opts?: unknown) =>
      Promise.resolve({ message_id: 100 })
    ),
  };
}

/** Wait for pending microtasks and setTimeout(fn, 0) callbacks to run. */
async function tick(ms = 30): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

// ── Clear activeStreams between tests ─────────────────────────────────────────

beforeEach(() => {
  activeStreams.clear();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 1: ProgressIndicator — Cancel button
// ═══════════════════════════════════════════════════════════════════════════════

describe("ProgressIndicator — Cancel button", () => {
  test("sends initial message with inline Cancel button when cancelKey is set", async () => {
    const chatId = 111;
    const cancelKey = streamKey(chatId, null); // "111:"
    const bot = createMockBot({ message_id: 55 });

    const indicator = new ProgressIndicator();
    await indicator.start(chatId, bot as any, null, { cancelKey });

    await tick();

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);

    const callArgs = (bot.api.sendMessage as ReturnType<typeof mock>).mock.calls[0];
    const opts = callArgs[2] as { reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } };

    expect(opts?.reply_markup).toBeDefined();
    const buttons = opts!.reply_markup!.inline_keyboard;
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveLength(1);
    expect(buttons[0][0].callback_data).toBe(`cancel:${cancelKey}`);

    await indicator.finish(true);
  });

  test("callback_data starts with 'cancel:' — matches relay.ts routing prefix", async () => {
    const chatId = 222;
    const threadId = 7;
    const cancelKey = streamKey(chatId, threadId); // "222:7"
    const bot = createMockBot({ message_id: 10 });

    const indicator = new ProgressIndicator();
    await indicator.start(chatId, bot as any, threadId, { cancelKey });

    await tick();

    const callArgs = (bot.api.sendMessage as ReturnType<typeof mock>).mock.calls[0];
    const opts = callArgs[2] as { reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } };
    const callbackData = opts?.reply_markup?.inline_keyboard[0][0].callback_data ?? "";

    expect(callbackData.startsWith("cancel:")).toBe(true);

    await indicator.finish(true);
  });

  test("calls onMessageId with the message_id from sendMessage response", async () => {
    const chatId = 333;
    const cancelKey = streamKey(chatId, null);
    const bot = createMockBot({ message_id: 77 });
    const onMessageId = mock((id: number) => id);

    const indicator = new ProgressIndicator();
    await indicator.start(chatId, bot as any, null, { cancelKey, onMessageId });

    await tick();

    expect(onMessageId).toHaveBeenCalledTimes(1);
    expect((onMessageId as ReturnType<typeof mock>).mock.calls[0][0]).toBe(77);

    await indicator.finish(true);
  });

  test("does NOT send Cancel button when cancelKey is absent", async () => {
    const chatId = 444;
    const bot = createMockBot({ message_id: 20 });

    const indicator = new ProgressIndicator();
    await indicator.start(chatId, bot as any, null); // no cancelKey

    await tick();

    const callArgs = (bot.api.sendMessage as ReturnType<typeof mock>).mock.calls[0];
    const opts = callArgs?.[2] as { reply_markup?: unknown } | undefined;

    // reply_markup should be absent or have no inline_keyboard
    const hasButton = opts?.reply_markup != null;
    expect(hasButton).toBe(false);

    await indicator.finish(true);
  });

  test("sends message to the correct forum threadId", async () => {
    const chatId = 555;
    const threadId = 99;
    const cancelKey = streamKey(chatId, threadId);
    const bot = createMockBot({ message_id: 30 });

    const indicator = new ProgressIndicator();
    await indicator.start(chatId, bot as any, threadId, { cancelKey });

    await tick();

    const callArgs = (bot.api.sendMessage as ReturnType<typeof mock>).mock.calls[0];
    const opts = callArgs?.[2] as { message_thread_id?: number } | undefined;

    expect(opts?.message_thread_id).toBe(threadId);

    await indicator.finish(true);
  });

  test("finish(true) edits the message to a done state", async () => {
    const chatId = 666;
    const bot = createMockBot({ message_id: 40 });

    const indicator = new ProgressIndicator();
    await indicator.start(chatId, bot as any, null, { cancelKey: streamKey(chatId, null) });

    await tick();
    await indicator.finish(true);

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    const editText = (bot.api.editMessageText as ReturnType<typeof mock>).mock.calls[0][2] as string;
    expect(editText).toContain("Done");
  });

  test("fast response (finish before delay) → no sendMessage", async () => {
    // If finish() is called synchronously before the delay timer fires,
    // no initial message should be sent.
    const chatId = 777;
    const bot = createMockBot({ message_id: 50 });

    const indicator = new ProgressIndicator();
    await indicator.start(chatId, bot as any, null, { cancelKey: streamKey(chatId, null) });

    // Finish immediately, before tick() lets the timer fire
    await indicator.finish(true);

    // No message should have been sent
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(bot.api.editMessageText).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 2: activeStreams lifecycle (relay.ts callClaude pattern simulation)
// ═══════════════════════════════════════════════════════════════════════════════

describe("activeStreams lifecycle — relay.ts callClaude pattern", () => {
  test("entry registered before stream, deleted in finally (success)", async () => {
    const chatId = 1001;
    const threadId = null;
    const key = streamKey(chatId, threadId);

    const controller = new AbortController();
    activeStreams.set(key, { controller });
    expect(activeStreams.has(key)).toBe(true);

    // Simulate successful stream completion (finally block)
    try {
      // no-op — stream "succeeded"
    } finally {
      activeStreams.delete(key);
    }

    expect(activeStreams.has(key)).toBe(false);
  });

  test("entry deleted in finally even when error is thrown", async () => {
    const chatId = 1002;
    const key = streamKey(chatId, null);

    const controller = new AbortController();
    activeStreams.set(key, { controller });

    let caughtError: Error | undefined;
    try {
      throw new Error("simulated stream error");
    } catch (e) {
      caughtError = e as Error;
    } finally {
      activeStreams.delete(key);
    }

    expect(activeStreams.has(key)).toBe(false);
    expect(caughtError?.message).toBe("simulated stream error");
  });

  test("progressMessageId is updated via onMessageId callback pattern", async () => {
    const chatId = 1003;
    const key = streamKey(chatId, null);

    const controller = new AbortController();
    activeStreams.set(key, { controller });
    // progressMessageId starts undefined
    expect(activeStreams.get(key)?.progressMessageId).toBeUndefined();

    // Simulate ProgressIndicator calling onMessageId(msgId)
    const onMessageId = (msgId: number) => {
      const entry = activeStreams.get(key);
      if (entry) entry.progressMessageId = msgId;
    };

    onMessageId(9001);

    expect(activeStreams.get(key)?.progressMessageId).toBe(9001);

    // cleanup
    activeStreams.delete(key);
  });

  test("cancel during stream: handleCancelCallback aborts controller + cleans entry", async () => {
    const chatId = 1004;
    const key = streamKey(chatId, null);

    const controller = new AbortController();
    activeStreams.set(key, { controller, progressMessageId: 555 });

    const ctx = createMockCtx(chatId);
    const bot = createMockBot();

    await handleCancelCallback(chatId, null, ctx as any, bot as any);

    expect(controller.signal.aborted).toBe(true);
    expect(activeStreams.has(key)).toBe(false);
    expect(bot.api.editMessageReplyMarkup).toHaveBeenCalledTimes(1);
  });

  test("after handleCancelCallback, callClaude finally also tries delete (harmless double delete)", async () => {
    const chatId = 1005;
    const key = streamKey(chatId, null);

    const controller = new AbortController();
    activeStreams.set(key, { controller });

    const ctx = createMockCtx(chatId);
    const bot = createMockBot();

    // First delete from handleCancelCallback
    await handleCancelCallback(chatId, null, ctx as any, bot as any);
    expect(activeStreams.has(key)).toBe(false);

    // Second delete from callClaude's finally — Map.delete on missing key is a no-op
    activeStreams.delete(key); // must not throw
    expect(activeStreams.has(key)).toBe(false);
  });

  test("multiple chats can have concurrent active streams without interference", async () => {
    const chatA = 2001;
    const chatB = 2002;
    const keyA = streamKey(chatA, null);
    const keyB = streamKey(chatB, null);

    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    activeStreams.set(keyA, { controller: ctrlA });
    activeStreams.set(keyB, { controller: ctrlB });

    // Cancel chat A only
    const ctx = createMockCtx(chatA);
    const bot = createMockBot();
    await handleCancelCallback(chatA, null, ctx as any, bot as any);

    expect(ctrlA.signal.aborted).toBe(true);
    expect(activeStreams.has(keyA)).toBe(false);

    // Chat B unaffected
    expect(ctrlB.signal.aborted).toBe(false);
    expect(activeStreams.has(keyB)).toBe(true);

    // cleanup
    activeStreams.delete(keyB);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 3: Cancel button callback_data format contract
// ═══════════════════════════════════════════════════════════════════════════════

describe("Cancel button callback_data format contract", () => {
  test("streamKey(chatId, null) produces 'chatId:' key", () => {
    expect(streamKey(12345, null)).toBe("12345:");
  });

  test("streamKey(chatId, threadId) produces 'chatId:threadId' key", () => {
    expect(streamKey(12345, 7)).toBe("12345:7");
  });

  test("negative chatId (groups) is preserved correctly", () => {
    const groupId = -100123456789;
    const key = streamKey(groupId, null);
    expect(key).toBe(`${groupId}:`);
    expect(key.startsWith("-")).toBe(true);
  });

  test("callback_data 'cancel:' + streamKey starts with 'cancel:' — relay routing matches", () => {
    const cancelKey = streamKey(42, null);
    const callbackData = `cancel:${cancelKey}`;

    // relay.ts: data.startsWith("cancel:")
    expect(callbackData.startsWith("cancel:")).toBe(true);
  });

  test("callback_data for group forum thread", () => {
    const groupId = -100987654321;
    const threadId = 42;
    const cancelKey = streamKey(groupId, threadId);
    const callbackData = `cancel:${cancelKey}`;

    expect(callbackData).toBe(`cancel:${groupId}:${threadId}`);
    expect(callbackData.startsWith("cancel:")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 4: Cancel button persistence through edits
//
// Regression tests for the bug where editMessageText was called without
// reply_markup, causing Telegram to strip the Cancel button on every edit.
// ═══════════════════════════════════════════════════════════════════════════════

describe("Cancel button persistence through edits", () => {
  test("Cancel button survives an immediate progress update", async () => {
    // PROGRESS_IMMEDIATE_DEBOUNCE_MS=0 means the immediate edit fires right away.
    const chatId = 5001;
    const cancelKey = streamKey(chatId, null);
    const bot = createMockBot({ message_id: 200 });

    const indicator = new ProgressIndicator();
    await indicator.start(chatId, bot as any, null, { cancelKey });

    await tick(); // let initial sendMessage fire (PROGRESS_INDICATOR_DELAY_MS=0)

    // Trigger an immediate edit — this calls editMessage() internally
    await indicator.update("some progress", { immediate: true });

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    const editCall = (bot.api.editMessageText as ReturnType<typeof mock>).mock.calls[0];
    const opts = editCall[3] as { reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } } | undefined;
    expect(opts?.reply_markup?.inline_keyboard[0][0].callback_data).toBe(`cancel:${cancelKey}`);

    await indicator.finish(true);
  });

  test("editMessage has NO reply_markup when cancelKey is absent", async () => {
    const chatId = 5002;
    const bot = createMockBot({ message_id: 201 });

    const indicator = new ProgressIndicator();
    await indicator.start(chatId, bot as any, null); // no cancelKey

    await tick(); // let initial sendMessage fire

    await indicator.update("some progress", { immediate: true });

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    const editCall = (bot.api.editMessageText as ReturnType<typeof mock>).mock.calls[0];
    const opts = editCall[3] as { reply_markup?: unknown } | undefined;
    expect(opts?.reply_markup).toBeUndefined();

    await indicator.finish(true);
  });
});
