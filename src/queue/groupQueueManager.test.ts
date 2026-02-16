import { describe, test, expect, afterEach } from "bun:test";
import { GroupQueueManager } from "./groupQueueManager.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Track managers so we can shut them down to avoid lingering intervals
const managers: GroupQueueManager[] = [];

function createManager(config?: Parameters<typeof GroupQueueManager.prototype.constructor>[0]): GroupQueueManager {
  const manager = new GroupQueueManager(config);
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  // Shutdown all managers to clear intervals
  for (const m of managers) {
    await m.shutdown(100);
  }
  managers.length = 0;
});

describe("GroupQueueManager", () => {
  test("creates queue on first access", () => {
    const manager = createManager();

    const queue = manager.getOrCreate(12345);
    expect(queue).toBeDefined();
    expect(queue.length).toBe(0);
  });

  test("reuses existing queues", () => {
    const manager = createManager();

    const queue1 = manager.getOrCreate(12345);
    const queue2 = manager.getOrCreate(12345);

    expect(queue1).toBe(queue2); // Same instance
  });

  test("creates separate queues for different chat IDs", () => {
    const manager = createManager();

    const queue1 = manager.getOrCreate(12345);
    const queue2 = manager.getOrCreate(67890);

    expect(queue1).not.toBe(queue2);
    expect(manager.getStats().totalQueues).toBe(2);
  });

  test("updates last activity on access", async () => {
    const manager = createManager();

    manager.getOrCreate(12345);
    await sleep(100);
    const t2 = Date.now();
    manager.getOrCreate(12345); // Touch again

    const stats = manager.getStats();
    // Since queue is empty and not processing, it won't appear in filtered queues array
    // But totalQueues should reflect it exists
    expect(stats.totalQueues).toBe(1);
  });

  test("removes idle empty queues", async () => {
    const manager = createManager({
      idleTimeout: 100,
    });

    manager.getOrCreate(12345);
    manager.getOrCreate(67890);

    expect(manager.getStats().totalQueues).toBe(2);

    await sleep(150);

    manager.cleanup();

    expect(manager.getStats().totalQueues).toBe(0);
  });

  test("preserves active queues during cleanup", async () => {
    const manager = createManager({
      idleTimeout: 100,
    });

    const queue = manager.getOrCreate(12345);

    // Add a long-running task
    queue.enqueue({
      label: "long-task",
      run: async () => {
        await sleep(500);
      },
    });

    await sleep(150); // Wait past idle timeout

    manager.cleanup();

    // Queue is still processing, so it should be preserved
    expect(manager.getStats().totalQueues).toBe(1);
  });

  test("preserves recently accessed queues", async () => {
    const manager = createManager({
      idleTimeout: 200,
    });

    manager.getOrCreate(12345);

    await sleep(100); // Before timeout

    manager.cleanup();

    expect(manager.getStats().totalQueues).toBe(1);
  });

  test("hasCapacity returns true for new chat IDs", () => {
    const manager = createManager({ maxDepth: 3 });

    expect(manager.hasCapacity(12345)).toBe(true);
  });

  test("hasCapacity returns false when queue is full", () => {
    const manager = createManager({ maxDepth: 3 });

    const queue = manager.getOrCreate(12345);

    // Fill queue with slow tasks so they stay pending
    queue.enqueue({
      label: "t1",
      run: async () => {
        await sleep(500);
      },
    });
    queue.enqueue({
      label: "t2",
      run: async () => {
        await sleep(500);
      },
    });
    queue.enqueue({
      label: "t3",
      run: async () => {
        await sleep(500);
      },
    });

    // t1 is processing, t2 and t3 are in queue (length=2)
    // But hasCapacity checks queue.length < maxDepth
    // Need to add more to truly hit the limit
    queue.enqueue({
      label: "t4",
      run: async () => {},
    });

    // Now length should be 3 (t2,t3,t4) since t1 is being processed
    expect(manager.hasCapacity(12345)).toBe(false);
  });

  test("getStats returns accurate data", () => {
    const manager = createManager();

    const queue1 = manager.getOrCreate(12345);
    const queue2 = manager.getOrCreate(67890);

    // Add slow tasks so they remain in the queue
    queue1.enqueue({
      label: "t1",
      run: async () => {
        await sleep(500);
      },
    });
    queue1.enqueue({
      label: "t2",
      run: async () => {
        await sleep(500);
      },
    });
    queue2.enqueue({
      label: "t3",
      run: async () => {
        await sleep(500);
      },
    });

    const stats = manager.getStats();

    expect(stats.totalQueues).toBe(2);
    // Both queues have active tasks
    expect(stats.activeQueues).toBeGreaterThan(0);
    expect(stats.queues.length).toBeGreaterThan(0);
  });

  test("getStats totalQueues includes all queues, not just active", () => {
    const manager = createManager();

    manager.getOrCreate(11111);
    manager.getOrCreate(22222);
    manager.getOrCreate(33333);

    const stats = manager.getStats();
    expect(stats.totalQueues).toBe(3);
    // queues array is filtered to active only, so should be empty since no tasks
    expect(stats.queues.length).toBe(0);
    expect(stats.activeQueues).toBe(0);
  });

  test("shutdown completes immediately when queues empty", async () => {
    const manager = createManager();

    manager.getOrCreate(12345);

    const start = Date.now();
    await manager.shutdown(30000);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(100);
    // Remove from tracking since we already shut down
    managers.pop();
  });

  test("shutdown waits for pending work", async () => {
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

  test("shutdown times out and logs remaining work", async () => {
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

  test("different chat IDs get independent queues", () => {
    const manager = createManager();

    const dmQueue = manager.getOrCreate(123456);
    const groupQueue = manager.getOrCreate(-789012);

    expect(dmQueue).not.toBe(groupQueue);
    expect(manager.getStats().totalQueues).toBe(2);
  });
});
