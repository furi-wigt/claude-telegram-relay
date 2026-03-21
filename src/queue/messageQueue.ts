/**
 * FIFO Queue for Sequential Task Processing
 *
 * Processes tasks one at a time in order. Each Telegram chat gets its own
 * MessageQueue instance so different groups can process concurrently while
 * maintaining FIFO order within each group.
 */

import type { QueueTask } from "./types.ts";

export class MessageQueue {
  private queue: QueueTask[] = [];
  private processing = false;
  private consecutiveFailures = 0;

  get length(): number {
    return this.queue.length;
  }

  get isProcessing(): boolean {
    return this.processing;
  }

  enqueue(task: QueueTask): void {
    this.queue.push(task);
    console.log(`[queue] +${task.label} (depth: ${this.queue.length})`);
    if (!this.processing) {
      this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      const start = Date.now();
      try {
        console.log(`[queue] processing: ${task.label} (remaining: ${this.queue.length})`);
        await task.run();
        this.consecutiveFailures = 0;
      } catch (error) {
        console.error(`[queue] task failed (${task.label}):`, error);
        this.consecutiveFailures++;
      } finally {
        console.log(`[queue] done: ${task.label} (${Date.now() - start}ms)`);
      }
    }
    this.processing = false;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  resetFailureCount(): void {
    this.consecutiveFailures = 0;
  }
}
