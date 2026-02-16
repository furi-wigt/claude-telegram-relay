import { describe, test, expect, afterEach } from "bun:test";
import { GroupQueueManager } from "./groupQueueManager.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    await m.shutdown(2000);
  }
  managers.length = 0;
});

describe("Stress: High Concurrency", () => {
  test("handles 50 concurrent groups processing 5 messages each", async () => {
    const manager = createManager();

    const results = new Map<number, number[]>();
    const startTime = Date.now();

    for (let group = 0; group < 50; group++) {
      results.set(group, []);

      for (let msg = 0; msg < 5; msg++) {
        const g = group;
        const m = msg;
        manager.getOrCreate(g).enqueue({
          label: `group-${g}-msg-${m}`,
          run: async () => {
            await sleep(100);
            results.get(g)!.push(m);
          },
        });
      }
    }

    // Wait for all to complete - 5 tasks * 100ms each per group = 500ms + overhead
    while (manager.getStats().activeQueues > 0) {
      await sleep(100);
    }

    const duration = Date.now() - startTime;

    // Verify all completed
    expect(results.size).toBe(50);
    for (const [_group, messages] of results) {
      expect(messages).toEqual([0, 1, 2, 3, 4]);
    }

    // If sequential, 250 * 100ms = 25000ms. Parallel should be ~500ms + overhead
    expect(duration).toBeLessThan(1500);
    console.log(
      `Completed 250 tasks across 50 groups in ${duration}ms (parallel)`
    );
  });
});

describe("Stress: Long-Running Tasks", () => {
  test("one slow group does not block fast groups", async () => {
    const manager = createManager();

    let slowGroupDone = false;
    let fastGroupDone = false;

    manager.getOrCreate(111).enqueue({
      label: "slow",
      run: async () => {
        await sleep(5000);
        slowGroupDone = true;
      },
    });

    manager.getOrCreate(222).enqueue({
      label: "fast",
      run: async () => {
        await sleep(100);
        fastGroupDone = true;
      },
    });

    await sleep(300);

    expect(fastGroupDone).toBe(true);
    expect(slowGroupDone).toBe(false);
  });
});

describe("Stress: Timeout Handling", () => {
  test("timeout error does not stop queue processing", async () => {
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

    await sleep(500);

    expect(results).toContain("completed");
    expect(queue.getConsecutiveFailures()).toBe(0);
  });
});

describe("Stress: Memory Profiling", () => {
  test("memory usage remains bounded with cleanup", async () => {
    const manager = createManager({ idleTimeout: 500 });

    const initialMemory = process.memoryUsage().heapUsed;

    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 100; j++) {
        const chatId = i * 100 + j;
        manager.getOrCreate(chatId).enqueue({
          label: `task-${chatId}`,
          run: async () => {
            await sleep(10);
          },
        });
      }
      await sleep(600);
      manager.cleanup();
    }

    const finalMemory = process.memoryUsage().heapUsed;
    const growth = finalMemory - initialMemory;

    // Memory growth should be bounded (< 10MB)
    expect(growth).toBeLessThan(10 * 1024 * 1024);

    console.log(`Memory growth: ${(growth / 1024 / 1024).toFixed(2)}MB`);
  }, { timeout: 10000 });
});
