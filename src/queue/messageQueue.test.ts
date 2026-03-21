import { describe, test, expect } from "bun:test";
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

describe("MessageQueue", () => {
  test("initializes empty", () => {
    const queue = new MessageQueue();
    expect(queue.length).toBe(0);
    expect(queue.isProcessing).toBe(false);
  });

  test("processes tasks in FIFO order", async () => {
    const queue = new MessageQueue();
    const results: number[] = [];

    queue.enqueue({
      label: "task-1",
      run: async () => {
        results.push(1);
      },
    });
    queue.enqueue({
      label: "task-2",
      run: async () => {
        results.push(2);
      },
    });
    queue.enqueue({
      label: "task-3",
      run: async () => {
        results.push(3);
      },
    });

    await waitForQueueEmpty(queue);

    expect(results).toEqual([1, 2, 3]);
  });

  test("processes one task at a time", async () => {
    const queue = new MessageQueue();
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeTask = (i: number) => ({
      label: `concurrent-check-${i}`,
      run: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(50);
        concurrent--;
      },
    });

    for (let i = 0; i < 5; i++) {
      queue.enqueue(makeTask(i));
    }

    await waitForQueueEmpty(queue);

    expect(maxConcurrent).toBe(1);
  });

  test("continues processing after task failure", async () => {
    const queue = new MessageQueue();
    const results: string[] = [];

    queue.enqueue({
      label: "task-1",
      run: async () => {
        results.push("task-1");
      },
    });

    queue.enqueue({
      label: "task-2-fail",
      run: async () => {
        throw new Error("Task 2 failed");
      },
    });

    queue.enqueue({
      label: "task-3",
      run: async () => {
        results.push("task-3");
      },
    });

    await waitForQueueEmpty(queue);

    expect(results).toEqual(["task-1", "task-3"]);
    expect(queue.getConsecutiveFailures()).toBe(0); // Reset after task-3 success
  });

  test("tracks consecutive failures", async () => {
    const queue = new MessageQueue();

    queue.enqueue({
      label: "fail-1",
      run: async () => {
        throw new Error("Fail");
      },
    });

    queue.enqueue({
      label: "fail-2",
      run: async () => {
        throw new Error("Fail");
      },
    });

    queue.enqueue({
      label: "fail-3",
      run: async () => {
        throw new Error("Fail");
      },
    });

    await waitForQueueEmpty(queue);

    expect(queue.getConsecutiveFailures()).toBe(3);
  });

  test("resets consecutive failures on success", async () => {
    const queue = new MessageQueue();

    queue.enqueue({
      label: "fail-1",
      run: async () => {
        throw new Error("Fail");
      },
    });

    queue.enqueue({
      label: "fail-2",
      run: async () => {
        throw new Error("Fail");
      },
    });

    queue.enqueue({
      label: "success",
      run: async () => {
        // succeeds
      },
    });

    await waitForQueueEmpty(queue);

    expect(queue.getConsecutiveFailures()).toBe(0);
  });

  test("resetFailureCount manually resets counter", async () => {
    const queue = new MessageQueue();

    queue.enqueue({
      label: "fail-1",
      run: async () => {
        throw new Error("Fail");
      },
    });

    await waitForQueueEmpty(queue);
    expect(queue.getConsecutiveFailures()).toBe(1);

    queue.resetFailureCount();
    expect(queue.getConsecutiveFailures()).toBe(0);
  });

  test("isProcessing is true during task execution", async () => {
    const queue = new MessageQueue();
    let wasProcessing = false;

    queue.enqueue({
      label: "check-processing",
      run: async () => {
        wasProcessing = queue.isProcessing;
        await sleep(50);
      },
    });

    // Immediately after enqueue, processing should start
    expect(queue.isProcessing).toBe(true);

    await waitForQueueEmpty(queue);

    expect(wasProcessing).toBe(true);
    expect(queue.isProcessing).toBe(false);
  });

  test("length decreases as tasks are processed", async () => {
    const queue = new MessageQueue();
    const lengths: number[] = [];

    // Use a slow first task so all 3 get enqueued before processing continues
    queue.enqueue({
      label: "task-0",
      run: async () => {
        await sleep(100);
        lengths.push(queue.length);
      },
    });
    queue.enqueue({
      label: "task-1",
      run: async () => {
        lengths.push(queue.length);
      },
    });
    queue.enqueue({
      label: "task-2",
      run: async () => {
        lengths.push(queue.length);
      },
    });

    await waitForQueueEmpty(queue);

    // After task-0 finishes (slow), 2 remain. task-1 sees 1, task-2 sees 0.
    expect(lengths).toEqual([2, 1, 0]);
  });
});
