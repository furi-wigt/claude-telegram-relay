import { describe, test, expect, afterEach } from "bun:test";
import { GroupQueueManager } from "./groupQueueManager.ts";
import { MessageQueue } from "./messageQueue.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQueueEmpty(
  queue: MessageQueue,
  timeoutMs = 5000
): Promise<void> {
  const start = Date.now();
  while (queue.length > 0 || queue.isProcessing) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timeout waiting for queue to empty");
    }
    await sleep(50);
  }
}

const managers: GroupQueueManager[] = [];

function createManager(
  config?: Partial<ConstructorParameters<typeof GroupQueueManager>[0] & Record<string, unknown>>
): GroupQueueManager {
  const manager = new GroupQueueManager(config);
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  for (const m of managers) {
    await m.shutdown(100);
  }
  managers.length = 0;
});

describe("Edge Cases: Backpressure", () => {
  test("backpressure prevents queue overflow", () => {
    const manager = createManager({ maxDepth: 5 });

    const queue = manager.getOrCreate(12345);

    for (let i = 0; i < 5; i++) {
      queue.enqueue({
        label: `task-${i}`,
        run: async () => {
          await sleep(500);
        },
      });
    }

    // After 5 enqueues: 1 processing + 4 in queue = length 4
    // But the first task starts processing immediately.
    // hasCapacity checks queue.length < maxDepth
    // With maxDepth=5 and tasks still in queue, check capacity
    expect(manager.hasCapacity(12345)).toBe(true); // 4 < 5

    // Add one more to reach the limit
    queue.enqueue({
      label: "task-5",
      run: async () => {
        await sleep(500);
      },
    });

    expect(manager.hasCapacity(12345)).toBe(false); // 5 >= 5
  });

  test("hasCapacity returns true for unknown chat ID", () => {
    const manager = createManager({ maxDepth: 5 });

    expect(manager.hasCapacity(99999)).toBe(true);
  });
});

describe("Edge Cases: Graceful Shutdown", () => {
  test("empty queues shut down immediately", async () => {
    const manager = createManager();

    manager.getOrCreate(12345);

    const start = Date.now();
    await manager.shutdown(30000);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(100);
    managers.pop();
  });

  test("pending work completes before shutdown", async () => {
    const manager = createManager();

    const queue = manager.getOrCreate(12345);
    let taskCompleted = false;

    queue.enqueue({
      label: "long-task",
      run: async () => {
        await sleep(1000);
        taskCompleted = true;
      },
    });

    await manager.shutdown(5000);

    expect(taskCompleted).toBe(true);
    managers.pop();
  });

  test("shutdown respects timeout", async () => {
    const manager = createManager();

    const queue = manager.getOrCreate(12345);

    queue.enqueue({
      label: "infinite-task",
      run: async () => {
        await sleep(10000);
      },
    });

    const start = Date.now();
    await manager.shutdown(500);
    const duration = Date.now() - start;

    expect(duration).toBeGreaterThanOrEqual(490);
    expect(duration).toBeLessThan(700);
    managers.pop();
  });
});

describe("Edge Cases: Memory Management", () => {
  test("periodic cleanup prevents unbounded growth", async () => {
    const manager = createManager({ idleTimeout: 100 });

    for (let i = 0; i < 1000; i++) {
      manager.getOrCreate(i);
    }

    expect(manager.getStats().totalQueues).toBe(1000);

    await sleep(150);

    manager.cleanup();

    expect(manager.getStats().totalQueues).toBe(0);
  });

  test("cleanup skips queues with pending work", async () => {
    const manager = createManager({ idleTimeout: 100 });

    for (let i = 0; i < 10; i++) {
      const queue = manager.getOrCreate(i);
      if (i < 5) {
        queue.enqueue({
          label: `task-${i}`,
          run: async () => {
            await sleep(2000);
          },
        });
      }
    }

    await sleep(150);

    manager.cleanup();

    // Only the 5 queues with active work should remain
    expect(manager.getStats().totalQueues).toBe(5);
  });

  test("recently accessed queues are preserved", async () => {
    const manager = createManager({ idleTimeout: 200 });

    manager.getOrCreate(12345);

    await sleep(100);

    manager.cleanup();

    expect(manager.getStats().totalQueues).toBe(1);
  });
});

describe("Edge Cases: Error Resilience", () => {
  test("Claude timeout error does not block queue processing", async () => {
    const manager = createManager();
    const results: string[] = [];

    const queue = manager.getOrCreate(12345);

    queue.enqueue({
      label: "timeout-task",
      run: async () => {
        throw new Error("Claude timeout after 180s");
      },
    });

    queue.enqueue({
      label: "normal-task",
      run: async () => {
        results.push("completed");
      },
    });

    await waitForQueueEmpty(queue);

    expect(results).toContain("completed");
    expect(queue.getConsecutiveFailures()).toBe(0);
  });

  test("multiple consecutive errors do not crash the queue", async () => {
    const manager = createManager();
    const results: string[] = [];

    const queue = manager.getOrCreate(12345);

    for (let i = 0; i < 5; i++) {
      queue.enqueue({
        label: `fail-${i}`,
        run: async () => {
          throw new Error(`Error ${i}`);
        },
      });
    }

    queue.enqueue({
      label: "recovery",
      run: async () => {
        results.push("recovered");
      },
    });

    await waitForQueueEmpty(queue);

    expect(results).toEqual(["recovered"]);
    expect(queue.getConsecutiveFailures()).toBe(0);
  });
});

describe("Edge Cases: Concurrent Enqueue", () => {
  test("rapid enqueue from multiple groups does not corrupt state", async () => {
    const manager = createManager();
    const groupCount = 20;
    const messagesPerGroup = 3;
    const results = new Map<number, number[]>();

    for (let g = 0; g < groupCount; g++) {
      results.set(g, []);
      for (let m = 0; m < messagesPerGroup; m++) {
        const group = g;
        const msg = m;
        manager.getOrCreate(group).enqueue({
          label: `g${group}-m${msg}`,
          run: async () => {
            await sleep(10);
            results.get(group)!.push(msg);
          },
        });
      }
    }

    // Wait for all to complete
    await sleep(2000);

    for (const [group, messages] of results) {
      expect(messages).toEqual([0, 1, 2]);
    }

    expect(results.size).toBe(groupCount);
  });
});
