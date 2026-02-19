/**
 * Unit tests for per-chat LTM extraction queue.
 * Run: bun test src/memory/extractionQueue.test.ts
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { enqueueExtraction, _getQueueSize, _isWorkerRunning } from "./extractionQueue.ts";

// Helper: flush all pending setImmediate callbacks + async tasks
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((r) => setTimeout(r, 20)); // allow async drain
}

describe("extractionQueue", () => {
  test("processes all 3 items — no drops", async () => {
    const processed: string[] = [];
    const fn = async (item: any) => { processed.push(item.text); };

    enqueueExtraction({ chatId: 100, userId: 1, text: "msg1" }, fn);
    enqueueExtraction({ chatId: 100, userId: 1, text: "msg2" }, fn);
    enqueueExtraction({ chatId: 100, userId: 1, text: "msg3" }, fn);

    await flushAsync();

    expect(processed).toEqual(["msg1", "msg2", "msg3"]);
  });

  test("items added during drain are not dropped", async () => {
    const processed: string[] = [];
    let secondAdded = false;

    const fn = async (item: any) => {
      processed.push(item.text);
      // Add item 2 while item 1 is being processed
      if (item.text === "first" && !secondAdded) {
        secondAdded = true;
        enqueueExtraction({ chatId: 200, userId: 1, text: "second" }, fn);
      }
    };

    enqueueExtraction({ chatId: 200, userId: 1, text: "first" }, fn);

    await flushAsync();
    await flushAsync(); // extra flush for the second item

    expect(processed).toContain("first");
    expect(processed).toContain("second");
  });

  test("per-chat isolation: chat 1 and chat 2 process independently", async () => {
    const chat1: string[] = [];
    const chat2: string[] = [];

    enqueueExtraction({ chatId: 301, userId: 1, text: "c1m1" }, async (item) => { chat1.push(item.text); });
    enqueueExtraction({ chatId: 302, userId: 2, text: "c2m1" }, async (item) => { chat2.push(item.text); });
    enqueueExtraction({ chatId: 301, userId: 1, text: "c1m2" }, async (item) => { chat1.push(item.text); });

    await flushAsync();

    expect(chat1).toEqual(["c1m1", "c1m2"]);
    expect(chat2).toEqual(["c2m1"]);
  });

  test("memory cleanup: queue and worker removed after drain", async () => {
    const chatId = 400;
    enqueueExtraction({ chatId, userId: 1, text: "cleanup-test" }, async () => {});

    await flushAsync();

    expect(_getQueueSize(chatId)).toBe(0);
    expect(_isWorkerRunning(chatId)).toBe(false);
  });

  test("error resilience: failed item doesn't stop queue", async () => {
    const processed: string[] = [];
    const fn = async (item: any) => {
      if (item.text === "error") throw new Error("simulated failure");
      processed.push(item.text);
    };

    enqueueExtraction({ chatId: 500, userId: 1, text: "before" }, fn);
    enqueueExtraction({ chatId: 500, userId: 1, text: "error" }, fn);
    enqueueExtraction({ chatId: 500, userId: 1, text: "after" }, fn);

    await flushAsync();

    expect(processed).toContain("before");
    expect(processed).toContain("after");
    expect(processed).not.toContain("error");
  });

  test("single worker per chat: multiple drain calls don't create duplicate workers", async () => {
    const callCount = { value: 0 };
    const fn = async (item: any) => {
      callCount.value++;
      await new Promise<void>((r) => setTimeout(r, 5)); // simulate slow extraction
    };

    // Enqueue enough items to keep the worker busy
    enqueueExtraction({ chatId: 600, userId: 1, text: "a" }, fn);
    enqueueExtraction({ chatId: 600, userId: 1, text: "b" }, fn);
    enqueueExtraction({ chatId: 600, userId: 1, text: "c" }, fn);

    await flushAsync();
    await new Promise<void>((r) => setTimeout(r, 50));

    // Each item processed exactly once
    expect(callCount.value).toBe(3);
  });
});
