/**
 * End-to-end integration tests for per-chat LTM extraction queue.
 *
 * Tests realistic scenarios: fast bursts, cross-chat concurrency,
 * error isolation between chats, and large queue processing.
 *
 * Run: bun test src/memory/extractionQueue.e2e.test.ts
 */

import { describe, test, expect } from "bun:test";
import { enqueueExtraction, _getQueueSize, _isWorkerRunning } from "./extractionQueue.ts";

// Helper: flush all pending setImmediate callbacks + async tasks
async function flushAsync(extraMs = 20): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((r) => setTimeout(r, extraMs));
}

describe("extractionQueue e2e", () => {
  test("fast burst: 5 messages in <100ms — all 5 extracted, no drops", async () => {
    const processed: string[] = [];
    const fn = async (item: any) => {
      await new Promise<void>((r) => setTimeout(r, 5)); // simulate extraction work
      processed.push(item.text);
    };

    const chatId = 1001;
    for (let i = 1; i <= 5; i++) {
      enqueueExtraction({ chatId, userId: 1, text: `burst-${i}` }, fn);
    }

    await flushAsync(100); // allow time for all 5 items

    expect(processed).toEqual(["burst-1", "burst-2", "burst-3", "burst-4", "burst-5"]);
    expect(_getQueueSize(chatId)).toBe(0);
    expect(_isWorkerRunning(chatId)).toBe(false);
  });

  test("cross-chat burst: 3 chats x 3 messages — all 9 processed correctly", async () => {
    const results: Record<number, string[]> = { 2001: [], 2002: [], 2003: [] };

    const fn = async (item: any) => {
      await new Promise<void>((r) => setTimeout(r, 3));
      results[item.chatId].push(item.text);
    };

    // Interleave messages from 3 chats
    enqueueExtraction({ chatId: 2001, userId: 10, text: "c1-a" }, fn);
    enqueueExtraction({ chatId: 2002, userId: 20, text: "c2-a" }, fn);
    enqueueExtraction({ chatId: 2003, userId: 30, text: "c3-a" }, fn);
    enqueueExtraction({ chatId: 2001, userId: 10, text: "c1-b" }, fn);
    enqueueExtraction({ chatId: 2002, userId: 20, text: "c2-b" }, fn);
    enqueueExtraction({ chatId: 2003, userId: 30, text: "c3-b" }, fn);
    enqueueExtraction({ chatId: 2001, userId: 10, text: "c1-c" }, fn);
    enqueueExtraction({ chatId: 2002, userId: 20, text: "c2-c" }, fn);
    enqueueExtraction({ chatId: 2003, userId: 30, text: "c3-c" }, fn);

    await flushAsync(100);

    // Each chat gets its own messages in order
    expect(results[2001]).toEqual(["c1-a", "c1-b", "c1-c"]);
    expect(results[2002]).toEqual(["c2-a", "c2-b", "c2-c"]);
    expect(results[2003]).toEqual(["c3-a", "c3-b", "c3-c"]);

    // All queues cleaned up
    for (const id of [2001, 2002, 2003]) {
      expect(_getQueueSize(id)).toBe(0);
      expect(_isWorkerRunning(id)).toBe(false);
    }
  });

  test("error in one chat doesn't affect other chats", async () => {
    const goodChat: string[] = [];
    const badChat: string[] = [];

    const goodFn = async (item: any) => {
      await new Promise<void>((r) => setTimeout(r, 2));
      goodChat.push(item.text);
    };

    const badFn = async (item: any) => {
      if (item.text === "explode") throw new Error("chat 3002 explosion");
      badChat.push(item.text);
    };

    // Good chat
    enqueueExtraction({ chatId: 3001, userId: 1, text: "ok-1" }, goodFn);
    enqueueExtraction({ chatId: 3001, userId: 1, text: "ok-2" }, goodFn);

    // Bad chat: second message throws
    enqueueExtraction({ chatId: 3002, userId: 2, text: "before" }, badFn);
    enqueueExtraction({ chatId: 3002, userId: 2, text: "explode" }, badFn);
    enqueueExtraction({ chatId: 3002, userId: 2, text: "after" }, badFn);

    // More good chat messages after the bad chat
    enqueueExtraction({ chatId: 3001, userId: 1, text: "ok-3" }, goodFn);

    await flushAsync(80);

    // Good chat unaffected
    expect(goodChat).toEqual(["ok-1", "ok-2", "ok-3"]);
    // Bad chat: error item skipped, rest processed
    expect(badChat).toEqual(["before", "after"]);
  });

  test("large queue: 20 items processed in order, none dropped", async () => {
    const processed: number[] = [];
    const fn = async (item: any) => {
      await new Promise<void>((r) => setTimeout(r, 1)); // minimal delay
      processed.push(Number(item.text));
    };

    const chatId = 4001;
    for (let i = 1; i <= 20; i++) {
      enqueueExtraction({ chatId, userId: 1, text: String(i) }, fn);
    }

    await flushAsync(200); // allow time for all 20 items

    const expected = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(processed).toEqual(expected);
    expect(_getQueueSize(chatId)).toBe(0);
    expect(_isWorkerRunning(chatId)).toBe(false);
  });

  test("threadId is preserved through queue processing", async () => {
    const receivedThreadIds: Array<number | null | undefined> = [];
    const fn = async (item: any) => {
      receivedThreadIds.push(item.threadId);
    };

    enqueueExtraction({ chatId: 5001, userId: 1, text: "t1", threadId: 42 }, fn);
    enqueueExtraction({ chatId: 5001, userId: 1, text: "t2", threadId: null }, fn);
    enqueueExtraction({ chatId: 5001, userId: 1, text: "t3" }, fn);

    await flushAsync();

    expect(receivedThreadIds[0]).toBe(42);
    expect(receivedThreadIds[1]).toBeNull();
    expect(receivedThreadIds[2]).toBeUndefined();
  });

  test("concurrent enqueue from different chats resolves independently", async () => {
    // Simulate one slow chat and one fast chat
    const slowChat: string[] = [];
    const fastChat: string[] = [];

    const slowFn = async (item: any) => {
      await new Promise<void>((r) => setTimeout(r, 30)); // slow extraction
      slowChat.push(item.text);
    };

    const fastFn = async (item: any) => {
      await new Promise<void>((r) => setTimeout(r, 1)); // fast extraction
      fastChat.push(item.text);
    };

    enqueueExtraction({ chatId: 6001, userId: 1, text: "slow-1" }, slowFn);
    enqueueExtraction({ chatId: 6001, userId: 1, text: "slow-2" }, slowFn);
    enqueueExtraction({ chatId: 6002, userId: 2, text: "fast-1" }, fastFn);
    enqueueExtraction({ chatId: 6002, userId: 2, text: "fast-2" }, fastFn);

    // After short wait, fast chat should be done while slow is still going
    await new Promise<void>((r) => setTimeout(r, 15));
    expect(fastChat.length).toBe(2); // fast chat done

    // Wait for slow chat to finish
    await flushAsync(100);
    expect(slowChat).toEqual(["slow-1", "slow-2"]);
    expect(fastChat).toEqual(["fast-1", "fast-2"]);
  });
});
