/**
 * Async batch queue for topic generation.
 * Enqueues messages after insert, drains in batches of 5 every 30s.
 * PM2-safe: interval is unref'd so it doesn't block process exit.
 */
import { getDb } from "../local/db.ts";
import { generateTopic } from "./topicGenerator.ts";

interface QueueEntry {
  messageId: string;
  content: string;
}

const queue: QueueEntry[] = [];
const BATCH_SIZE = 5;
const DRAIN_INTERVAL_MS = 30_000;

/**
 * Enqueue a message for async topic generation.
 * Non-blocking — returns immediately.
 */
export function enqueue(messageId: string, content: string): void {
  queue.push({ messageId, content });
}

/**
 * Process pending items in batches.
 */
async function drain(): Promise<void> {
  if (queue.length === 0) return;

  const batch = queue.splice(0, BATCH_SIZE);

  for (const entry of batch) {
    try {
      const topic = await generateTopic(entry.content);
      const db = getDb();
      db.run("UPDATE messages SET topic = ? WHERE id = ?", [topic, entry.messageId]);
    } catch (err) {
      console.error(`[topicQueue] Failed to generate topic for ${entry.messageId}:`, err);
      // Don't re-queue — topic will be generated on-demand via sync fallback
    }
  }
}

// Start the drain interval (PM2-safe)
const drainInterval = setInterval(drain, DRAIN_INTERVAL_MS);
drainInterval.unref();

/** Exposed for testing */
export { drain as _drain, queue as _queue };
