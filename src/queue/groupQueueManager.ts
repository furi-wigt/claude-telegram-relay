/**
 * Per-Group Queue Manager
 *
 * Maintains independent MessageQueue instances for each Telegram chat.
 * Different groups process concurrently; same group maintains FIFO order.
 */

import { MessageQueue } from "./messageQueue.ts";
import type { QueueConfig, QueueStats, QueueManagerStats } from "./types.ts";

const DEFAULT_CONFIG: QueueConfig = {
  maxDepth: 50,
  idleTimeout: 24 * 60 * 60 * 1000, // 24 hours
  statsInterval: 5 * 60 * 1000, // 5 minutes
};

export class GroupQueueManager {
  private queues = new Map<number, MessageQueue>();
  private lastActivity = new Map<number, number>();
  private config: QueueConfig;
  private cleanupInterval?: Timer;
  private statsInterval?: Timer;

  constructor(config?: Partial<QueueConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupInterval();
    this.startStatsLogging();
  }

  /**
   * Get or create a queue for a chat ID.
   */
  getOrCreate(chatId: number): MessageQueue {
    if (!this.queues.has(chatId)) {
      this.queues.set(chatId, new MessageQueue());
      console.log(`[queue-manager] Created queue for chat ${chatId}`);
    }
    this.lastActivity.set(chatId, Date.now());
    return this.queues.get(chatId)!;
  }

  /**
   * Check if queue has capacity (backpressure control).
   */
  hasCapacity(chatId: number): boolean {
    const queue = this.queues.get(chatId);
    return !queue || queue.length < this.config.maxDepth;
  }

  /**
   * Remove empty queues that have been idle beyond the timeout.
   */
  cleanup(): void {
    const now = Date.now();
    let removed = 0;

    console.log(`[queue-manager] Cleanup started (active: ${this.queues.size})`);

    for (const [chatId, lastActive] of this.lastActivity) {
      const queue = this.queues.get(chatId);

      // Only clean up queues that are empty AND idle beyond timeout
      if (queue && queue.length === 0 && !queue.isProcessing && now - lastActive > this.config.idleTimeout) {
        this.queues.delete(chatId);
        this.lastActivity.delete(chatId);
        removed++;
        console.log(
          `[queue-manager] Removed idle queue ${chatId} (idle: ${((now - lastActive) / 3600000).toFixed(1)}h)`
        );
      }
    }

    console.log(`[queue-manager] Cleanup complete (active: ${this.queues.size}, removed: ${removed})`);
  }

  /**
   * Get statistics for all queues.
   */
  getStats(): QueueManagerStats {
    const queues: QueueStats[] = [];
    let totalDepth = 0;
    let activeQueues = 0;

    for (const [chatId, queue] of this.queues) {
      const depth = queue.length;
      const processing = queue.isProcessing;

      if (depth > 0 || processing) {
        activeQueues++;
      }

      totalDepth += depth;

      queues.push({
        chatId,
        depth,
        processing,
        lastActivity: this.lastActivity.get(chatId) || 0,
        consecutiveFailures: queue.getConsecutiveFailures(),
      });
    }

    return {
      timestamp: new Date().toISOString(),
      totalQueues: this.queues.size,
      activeQueues,
      totalDepth,
      queues: queues.filter((q) => q.depth > 0 || q.processing),
    };
  }

  /**
   * Gracefully shutdown: wait for all queues to drain or timeout.
   */
  async shutdown(timeoutMs: number = 30000): Promise<void> {
    console.log("[queue-manager] Graceful shutdown initiated");

    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.statsInterval) clearInterval(this.statsInterval);

    const start = Date.now();
    const pendingChats = Array.from(this.queues.entries())
      .filter(([_, queue]) => queue.length > 0 || queue.isProcessing)
      .map(([chatId]) => chatId);

    if (pendingChats.length === 0) {
      console.log("[queue-manager] No pending work, shutting down immediately");
      return;
    }

    console.log(`[queue-manager] Waiting for ${pendingChats.length} queues to drain...`);

    while (Date.now() - start < timeoutMs) {
      const stillPending = Array.from(this.queues.entries())
        .filter(([_, queue]) => queue.length > 0 || queue.isProcessing)
        .map(([chatId]) => chatId);

      if (stillPending.length === 0) {
        console.log("[queue-manager] All queues drained successfully");
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const remainingWork = Array.from(this.queues.entries())
      .filter(([_, queue]) => queue.length > 0 || queue.isProcessing)
      .map(([chatId, queue]) => ({ chatId, depth: queue.length }));

    console.warn(
      `[queue-manager] Shutdown timeout after ${timeoutMs}ms. Remaining work:`,
      remainingWork
    );
  }

  private startCleanupInterval(): void {
    const interval = this.config.idleTimeout / 24; // ~1 hour for 24h timeout
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, interval);
  }

  private startStatsLogging(): void {
    this.statsInterval = setInterval(() => {
      const stats = this.getStats();
      if (stats.activeQueues > 0) {
        console.log("[queue-stats]", JSON.stringify(stats, null, 2));
      }
    }, this.config.statsInterval);
  }
}
