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

describe("Integration: Concurrent Group Processing", () => {
  test("different groups process messages concurrently", async () => {
    const manager = createManager();

    const group1Start = Date.now();
    const group2Start = Date.now();
    let group1End = 0;
    let group2End = 0;

    manager.getOrCreate(111).enqueue({
      label: "group1-task",
      run: async () => {
        await sleep(500);
        group1End = Date.now();
      },
    });

    manager.getOrCreate(222).enqueue({
      label: "group2-task",
      run: async () => {
        await sleep(500);
        group2End = Date.now();
      },
    });

    await sleep(700);

    const group1Duration = group1End - group1Start;
    const group2Duration = group2End - group2Start;

    // Both should complete in ~500ms (parallel), not ~1000ms (sequential)
    expect(group1Duration).toBeLessThan(650);
    expect(group2Duration).toBeLessThan(650);

    const totalTime =
      Math.max(group1End, group2End) - Math.min(group1Start, group2Start);
    expect(totalTime).toBeLessThan(700);
  });

  test("same group maintains FIFO order", async () => {
    const manager = createManager();
    const queue = manager.getOrCreate(12345);

    const results: number[] = [];

    queue.enqueue({
      label: "task-1",
      run: async () => {
        await sleep(50);
        results.push(1);
      },
    });

    queue.enqueue({
      label: "task-2",
      run: async () => {
        await sleep(50);
        results.push(2);
      },
    });

    queue.enqueue({
      label: "task-3",
      run: async () => {
        await sleep(50);
        results.push(3);
      },
    });

    await waitForQueueEmpty(queue);

    expect(results).toEqual([1, 2, 3]);
  });
});

describe("Integration: DM vs Group Handling", () => {
  test("DM messages get independent queue from groups", () => {
    const manager = createManager();

    const dmQueue = manager.getOrCreate(123456);
    const groupQueue = manager.getOrCreate(-789012);

    expect(dmQueue).not.toBe(groupQueue);
    expect(manager.getStats().totalQueues).toBe(2);
  });
});

describe("Integration: Mixed Message Types", () => {
  test("all message types for same chat use same queue", async () => {
    const manager = createManager();
    const results: string[] = [];

    const queue = manager.getOrCreate(12345);

    queue.enqueue({
      label: "text",
      run: async () => {
        results.push("text");
      },
    });

    queue.enqueue({
      label: "voice",
      run: async () => {
        results.push("voice");
      },
    });

    queue.enqueue({
      label: "photo",
      run: async () => {
        results.push("photo");
      },
    });

    queue.enqueue({
      label: "document",
      run: async () => {
        results.push("document");
      },
    });

    await waitForQueueEmpty(queue);

    expect(results).toEqual(["text", "voice", "photo", "document"]);
  });
});

describe("Integration: Multi-group FIFO Isolation", () => {
  test("FIFO order maintained independently per group", async () => {
    const manager = createManager();

    const group1Results: number[] = [];
    const group2Results: number[] = [];

    const queue1 = manager.getOrCreate(111);
    const queue2 = manager.getOrCreate(222);

    // Group 1: slow tasks
    for (let i = 1; i <= 3; i++) {
      const val = i;
      queue1.enqueue({
        label: `g1-${val}`,
        run: async () => {
          await sleep(100);
          group1Results.push(val);
        },
      });
    }

    // Group 2: fast tasks
    for (let i = 1; i <= 3; i++) {
      const val = i;
      queue2.enqueue({
        label: `g2-${val}`,
        run: async () => {
          await sleep(10);
          group2Results.push(val);
        },
      });
    }

    await Promise.all([waitForQueueEmpty(queue1), waitForQueueEmpty(queue2)]);

    // Both groups maintain their own FIFO order
    expect(group1Results).toEqual([1, 2, 3]);
    expect(group2Results).toEqual([1, 2, 3]);
  });

  test("auto-discovered group gets independent queue", () => {
    const manager = createManager();

    const newGroupId = -999888777;

    const queue = manager.getOrCreate(newGroupId);

    queue.enqueue({
      label: "first-message",
      run: async () => {},
    });

    expect(manager.getStats().totalQueues).toBeGreaterThan(0);
  });
});
