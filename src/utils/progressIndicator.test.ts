import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { ProgressIndicator } from "./progressIndicator.ts";

// ---------------------------------------------------------------------------
// Mock bot factory
// ---------------------------------------------------------------------------

function createMockBot() {
  return {
    api: {
      sendMessage: mock(() => Promise.resolve({ message_id: 42 })),
      editMessageText: mock(() => Promise.resolve({})),
      deleteMessage: mock(() => Promise.resolve({})),
    },
  };
}

// ---------------------------------------------------------------------------
// Timer helpers
//
// Bun does not yet support jest-style useFakeTimers. Instead we override
// the global setTimeout / setInterval / clearTimeout / clearInterval with
// manual implementations that let us advance time deterministically.
// ---------------------------------------------------------------------------

type TimerEntry = {
  id: number;
  callback: () => void;
  fireAt: number;
  interval?: number;
};

let fakeNow = 0;
let timers: TimerEntry[] = [];
let nextTimerId = 1;

const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realClearTimeout = globalThis.clearTimeout;
const realClearInterval = globalThis.clearInterval;
const realDateNow = Date.now;

function installFakeTimers() {
  fakeNow = 1000; // Start at 1s so elapsed calculations produce non-zero values
  timers = [];
  nextTimerId = 1;

  Date.now = () => fakeNow;

  (globalThis as any).setTimeout = (cb: () => void, ms: number) => {
    const id = nextTimerId++;
    timers.push({ id, callback: cb, fireAt: fakeNow + ms });
    return id;
  };

  (globalThis as any).setInterval = (cb: () => void, ms: number) => {
    const id = nextTimerId++;
    timers.push({ id, callback: cb, fireAt: fakeNow + ms, interval: ms });
    return id;
  };

  (globalThis as any).clearTimeout = (id: number) => {
    timers = timers.filter((t) => t.id !== id);
  };

  (globalThis as any).clearInterval = (id: number) => {
    timers = timers.filter((t) => t.id !== id);
  };
}

function restoreFakeTimers() {
  globalThis.setTimeout = realSetTimeout;
  globalThis.setInterval = realSetInterval;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.clearInterval = realClearInterval;
  Date.now = realDateNow;
}

/** Advance fake time by `ms` and fire any timers that are due. */
async function advanceTime(ms: number) {
  const target = fakeNow + ms;
  while (true) {
    // Find the next timer that fires at or before `target`
    const due = timers
      .filter((t) => t.fireAt <= target)
      .sort((a, b) => a.fireAt - b.fireAt)[0];

    if (!due) {
      fakeNow = target;
      break;
    }

    fakeNow = due.fireAt;

    if (due.interval) {
      // Reschedule interval timer
      due.fireAt = fakeNow + due.interval;
    } else {
      // Remove one-shot timer
      timers = timers.filter((t) => t.id !== due.id);
    }

    // Execute the callback and let microtasks flush (for async callbacks)
    due.callback();
    await new Promise<void>((r) => realSetTimeout(r, 0));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProgressIndicator", () => {
  let indicator: ProgressIndicator;
  let mockBot: ReturnType<typeof createMockBot>;
  const CHAT_ID = 12345;

  beforeEach(() => {
    installFakeTimers();
    indicator = new ProgressIndicator();
    mockBot = createMockBot();
  });

  afterEach(async () => {
    // Ensure timers are cleaned up even if a test forgot to finish()
    try {
      await indicator.finish();
    } catch {
      // Ignore — may already be finished
    }
    restoreFakeTimers();
  });

  // -----------------------------------------------------------------------
  // 1. No message sent for fast responses
  // -----------------------------------------------------------------------

  test("no message sent when finish() is called before delay fires", async () => {
    await indicator.start(CHAT_ID, mockBot as any);

    // Finish immediately — well before the 8000ms default delay
    await indicator.finish(true);

    expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
  });

  test("no message sent when finish() is called 1s into delay", async () => {
    await indicator.start(CHAT_ID, mockBot as any);

    await advanceTime(1000); // 1 second — still within delay
    await indicator.finish(true);

    expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 2. Message sent after delay
  // -----------------------------------------------------------------------

  test("sendMessage called after PROGRESS_INDICATOR_DELAY_MS elapses", async () => {
    await indicator.start(CHAT_ID, mockBot as any);

    // Advance past the default 8000ms delay
    await advanceTime(8001);

    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(1);
    const call = (mockBot.api.sendMessage as any).mock.calls[0];
    expect(call[0]).toBe(CHAT_ID);
    // The message text should contain "working..."
    expect(call[1]).toContain("working...");
  });

  // -----------------------------------------------------------------------
  // 3. Message edited on timer tick
  // -----------------------------------------------------------------------

  test("editMessageText called after edit interval elapses", async () => {
    await indicator.start(CHAT_ID, mockBot as any);

    // Fire the initial delay
    await advanceTime(8001);
    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(1);

    // Advance past the default 60000ms edit interval
    await advanceTime(60001);

    expect(mockBot.api.editMessageText).toHaveBeenCalledTimes(1);
    const call = (mockBot.api.editMessageText as any).mock.calls[0];
    expect(call[0]).toBe(CHAT_ID);
    expect(call[1]).toBe(42); // message_id from sendMessage mock
    expect(call[2]).toContain("working...");
  });

  // -----------------------------------------------------------------------
  // 4. finish(true) edits to Done
  // -----------------------------------------------------------------------

  test("finish(true) edits message to Done icon", async () => {
    await indicator.start(CHAT_ID, mockBot as any);

    // Let the initial message send
    await advanceTime(8001);

    await indicator.finish(true);

    // The finish edit call
    expect(mockBot.api.editMessageText).toHaveBeenCalled();
    const calls = (mockBot.api.editMessageText as any).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[2]).toContain("\u2705"); // checkmark
    expect(lastCall[2]).toContain("Done");
  });

  // -----------------------------------------------------------------------
  // 5. finish(false) edits to Failed
  // -----------------------------------------------------------------------

  test("finish(false) edits message to Failed icon", async () => {
    await indicator.start(CHAT_ID, mockBot as any);

    // Let the initial message send
    await advanceTime(8001);

    await indicator.finish(false);

    expect(mockBot.api.editMessageText).toHaveBeenCalled();
    const calls = (mockBot.api.editMessageText as any).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[2]).toContain("\u274C"); // cross mark
    expect(lastCall[2]).toContain("Failed");
  });

  // -----------------------------------------------------------------------
  // 6. Timer cleanup — calling finish() multiple times
  // -----------------------------------------------------------------------

  test("calling finish() multiple times does not throw or cause duplicate API calls", async () => {
    await indicator.start(CHAT_ID, mockBot as any);
    await advanceTime(8001); // send initial message

    // First finish
    await indicator.finish(true);
    const editCountAfterFirst = (mockBot.api.editMessageText as any).mock.calls.length;

    // Second finish — should be a no-op (early return because finished flag is true)
    await indicator.finish(true);
    const editCountAfterSecond = (mockBot.api.editMessageText as any).mock.calls.length;

    expect(editCountAfterSecond).toBe(editCountAfterFirst);
  });

  test("calling finish() before delay does not throw on second call", async () => {
    await indicator.start(CHAT_ID, mockBot as any);

    await indicator.finish(true);
    // Should not throw
    await indicator.finish(false);

    expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 7. Graceful API failure
  // -----------------------------------------------------------------------

  test("editMessageText failure does not cause unhandled rejection", async () => {
    mockBot.api.editMessageText = mock(() => Promise.reject(new Error("Message deleted")));

    await indicator.start(CHAT_ID, mockBot as any);
    await advanceTime(8001); // send initial message

    // Should not throw despite the edit rejection
    await indicator.finish(true);
  });

  test("sendMessage failure does not cause unhandled rejection", async () => {
    mockBot.api.sendMessage = mock(() => Promise.reject(new Error("Chat not found")));

    await indicator.start(CHAT_ID, mockBot as any);

    // Advance past delay — sendMessage will fail silently
    await advanceTime(8001);

    // Should not throw — messageId remains null, so finish is a no-op
    await indicator.finish(true);

    // No editMessageText should be called since messageId was never set
    expect(mockBot.api.editMessageText).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Additional coverage: update() changes the summary text
  // -----------------------------------------------------------------------

  test("update() changes the summary shown in the next edit", async () => {
    await indicator.start(CHAT_ID, mockBot as any);
    await advanceTime(8001); // send initial message

    await indicator.update("Compiling...");

    // Advance to trigger an edit tick
    await advanceTime(120001);

    const calls = (mockBot.api.editMessageText as any).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[2]).toContain("Compiling...");
  });

  // -----------------------------------------------------------------------
  // Auto-delete after finish
  // -----------------------------------------------------------------------

  test("finish() schedules a deleteMessage call after 5 seconds", async () => {
    await indicator.start(CHAT_ID, mockBot as any);
    await advanceTime(8001); // send initial message

    await indicator.finish(true);

    // deleteMessage should not be called yet
    expect(mockBot.api.deleteMessage).not.toHaveBeenCalled();

    // Advance past the 5-second auto-delete delay
    await advanceTime(5001);

    expect(mockBot.api.deleteMessage).toHaveBeenCalledTimes(1);
    const call = (mockBot.api.deleteMessage as any).mock.calls[0];
    expect(call[0]).toBe(CHAT_ID);
    expect(call[1]).toBe(42); // message_id
  });

  // -----------------------------------------------------------------------
  // 10. threadId forwarded to sendMessage
  // -----------------------------------------------------------------------

  test("sendMessage includes message_thread_id when threadId is provided", async () => {
    const THREAD_ID = 99;
    await indicator.start(CHAT_ID, mockBot as any, THREAD_ID);

    await advanceTime(8001); // fire delay

    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(1);
    const call = (mockBot.api.sendMessage as any).mock.calls[0];
    expect(call[2]).toEqual({ message_thread_id: THREAD_ID });
  });

  test("sendMessage has no message_thread_id when threadId is omitted", async () => {
    await indicator.start(CHAT_ID, mockBot as any);

    await advanceTime(8001); // fire delay

    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(1);
    const call = (mockBot.api.sendMessage as any).mock.calls[0];
    // options object should be empty (no message_thread_id key)
    expect(call[2]).toEqual({});
  });

  // -----------------------------------------------------------------------
  // 11. Immediate update — event-based edit
  // -----------------------------------------------------------------------

  test("update with immediate:true triggers editMessageText right away", async () => {
    await indicator.start(CHAT_ID, mockBot as any);
    await advanceTime(8001); // fire initial send

    expect(mockBot.api.editMessageText).not.toHaveBeenCalled();

    // Trigger an immediate update (simulating an onProgress event from Claude subprocess)
    await indicator.update("bash: npm test", { immediate: true });

    expect(mockBot.api.editMessageText).toHaveBeenCalledTimes(1);
    const call = (mockBot.api.editMessageText as any).mock.calls[0];
    expect(call[2]).toContain("bash: npm test");
  });

  test("update with immediate:true is debounced — edit skipped but buffer still accumulates", async () => {
    await indicator.start(CHAT_ID, mockBot as any);
    await advanceTime(8001); // fire initial send

    await indicator.update("event one", { immediate: true });
    // Immediately call again within debounce window — edit skipped but buffered
    await indicator.update("event two", { immediate: true });

    // Only one immediate edit should have fired
    expect(mockBot.api.editMessageText).toHaveBeenCalledTimes(1);
    // Advance past debounce window — heartbeat fires and shows both events
    await advanceTime(120001);
    const calls = (mockBot.api.editMessageText as any).mock.calls;
    const heartbeatCall = calls[calls.length - 1];
    // Buffer accumulated both events; both visible in heartbeat edit
    expect(heartbeatCall[2]).toContain("event one");
    expect(heartbeatCall[2]).toContain("event two");
  });

  test("update without immediate flag does not trigger editMessageText", async () => {
    await indicator.start(CHAT_ID, mockBot as any);
    await advanceTime(8001); // fire initial send

    await indicator.update("queued update");

    // No edit yet — should wait for next interval
    expect(mockBot.api.editMessageText).not.toHaveBeenCalled();

    // Advance to next interval — now it fires
    await advanceTime(60001);
    expect(mockBot.api.editMessageText).toHaveBeenCalledTimes(1);
  });

  test("update with immediate:true before message is sent does not edit", async () => {
    await indicator.start(CHAT_ID, mockBot as any);
    // Don't advance time — message not sent yet (still within delay window)

    await indicator.update("early event", { immediate: true });

    // No send, no edit — messageId is null
    expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
    expect(mockBot.api.editMessageText).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 12. Event buffer — 5-line rolling window with dedup
  // -----------------------------------------------------------------------

  test("consecutive duplicate events are not added to the buffer", async () => {
    await indicator.start(CHAT_ID, mockBot as any);
    await advanceTime(8001);

    await indicator.update("same event", { immediate: true });
    // Advance past debounce so second immediate fires
    fakeNow += 4000;
    await indicator.update("same event", { immediate: true }); // duplicate — skipped

    // Two immediate edits attempted; both edits should only show one event line
    const calls = (mockBot.api.editMessageText as any).mock.calls;
    // Second edit text should still only show "same event" once (not doubled)
    const secondEdit = calls[calls.length - 1][2] as string;
    const occurrences = (secondEdit.match(/same event/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  test("buffer caps at 10 entries, evicting oldest", async () => {
    await indicator.start(CHAT_ID, mockBot as any);
    await advanceTime(8001);

    // Push 11 distinct events without immediate to avoid debounce interference
    for (let i = 1; i <= 11; i++) {
      await indicator.update(`event ${i}`);
    }

    // Trigger an edit via heartbeat
    await advanceTime(60001);
    const calls = (mockBot.api.editMessageText as any).mock.calls;
    const lastCall = calls[calls.length - 1][2] as string;

    // Buffer capped at 10: should show events 2-11, not event 1
    // Use a pattern that doesn't accidentally match "event 10" or "event 11"
    expect(lastCall).not.toMatch(/^event 1$/m);
    expect(lastCall).toContain("event 2");
    expect(lastCall).toContain("event 11");
  });

  test("message shows all buffered events as separate lines", async () => {
    await indicator.start(CHAT_ID, mockBot as any);
    await advanceTime(8001);

    await indicator.update("line alpha");
    await indicator.update("line beta");
    await indicator.update("line gamma");

    await advanceTime(120001);
    const calls = (mockBot.api.editMessageText as any).mock.calls;
    const text = calls[calls.length - 1][2] as string;

    expect(text).toContain("line alpha");
    expect(text).toContain("line beta");
    expect(text).toContain("line gamma");
  });

  test("long event lines are truncated to 80 chars", async () => {
    await indicator.start(CHAT_ID, mockBot as any);
    await advanceTime(8001);

    const longLine = "x".repeat(100);
    await indicator.update(longLine, { immediate: true });

    const calls = (mockBot.api.editMessageText as any).mock.calls;
    const text = calls[calls.length - 1][2] as string;
    const lines = text.split("\n");
    // Find the line containing the truncated event (not the header).
    // Each event line is prefixed with "[HH:MM:SS] " (11 chars) so we match on "x" content.
    const eventLine = lines.find((l) => l.includes("x"));
    expect(eventLine).toBeDefined();
    // Truncation limit is 80 chars and applies to the full stored string (timestamp + text).
    expect(eventLine!.length).toBeLessThanOrEqual(80);
    expect(eventLine!.endsWith("\u2026")).toBe(true); // ends with ellipsis
  });

  test("initial message shows 'Thinking...' when no events buffered", async () => {
    await indicator.start(CHAT_ID, mockBot as any);
    await advanceTime(8001);

    const call = (mockBot.api.sendMessage as any).mock.calls[0];
    expect(call[1]).toContain("Thinking...");
  });

  // -----------------------------------------------------------------------
  // 13. Cancel button persistence — regression for interval/immediate edits
  // -----------------------------------------------------------------------

  test("editMessageText preserves Cancel button on interval tick when cancelKey is set", async () => {
    await indicator.start(CHAT_ID, mockBot as any, null, { cancelKey: "123:" });

    await advanceTime(8001);  // fire initial sendMessage
    await advanceTime(60001); // fire edit interval

    expect(mockBot.api.editMessageText).toHaveBeenCalled();
    const calls = (mockBot.api.editMessageText as any).mock.calls;
    const lastCall = calls[calls.length - 1];
    const opts = lastCall[3] as { reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } } | undefined;
    expect(opts?.reply_markup?.inline_keyboard[0][0].callback_data).toBe("cancel:123:");
  });

  test("editMessageText preserves Cancel button on immediate update when cancelKey is set", async () => {
    await indicator.start(CHAT_ID, mockBot as any, null, { cancelKey: "999:" });

    await advanceTime(8001); // fire initial sendMessage

    await indicator.update("progress text", { immediate: true });

    expect(mockBot.api.editMessageText).toHaveBeenCalledTimes(1);
    const call = (mockBot.api.editMessageText as any).mock.calls[0];
    const opts = call[3] as { reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } } | undefined;
    expect(opts?.reply_markup?.inline_keyboard[0][0].callback_data).toBe("cancel:999:");
  });

  test("editMessageText has NO reply_markup on interval tick when cancelKey is absent", async () => {
    await indicator.start(CHAT_ID, mockBot as any); // no cancelKey

    await advanceTime(8001);  // fire initial sendMessage
    await advanceTime(60001); // fire edit interval

    expect(mockBot.api.editMessageText).toHaveBeenCalled();
    const calls = (mockBot.api.editMessageText as any).mock.calls;
    const lastCall = calls[calls.length - 1];
    const opts = lastCall[3] as { reply_markup?: unknown } | undefined;
    // No cancelKey → options is {} → no reply_markup
    expect(opts?.reply_markup).toBeUndefined();
  });

  test("finish() calls editMessageText without reply_markup — button removed on stream end", async () => {
    await indicator.start(CHAT_ID, mockBot as any, null, { cancelKey: "123:" });

    await advanceTime(8001); // fire initial sendMessage

    await indicator.finish(true);

    // finish() calls editMessageText with just (chatId, msgId, text) — no 4th arg
    const calls = (mockBot.api.editMessageText as any).mock.calls;
    const finishCall = calls[calls.length - 1];
    expect(finishCall[3]).toBeUndefined();
  });
});
