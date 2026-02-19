/**
 * Per-chat LTM extraction queue.
 *
 * **Why a queue instead of a mutex?**
 * The previous `extractionInFlight` boolean acted as a global mutex: if Ollama
 * was already processing one message, every subsequent message was silently
 * dropped. During fast bursts (e.g. the user sends 5 messages in a row), only
 * the first would get its memories extracted — the rest were lost forever.
 *
 * This module replaces that mutex with per-chat FIFO queues. Every message is
 * enqueued and processed in arrival order. Each chat gets its own independent
 * queue, so a slow extraction in one chat never blocks another.
 *
 * **Memory cleanup:** Queues and worker flags for a chat are deleted once the
 * queue drains to zero, preventing unbounded Map growth from idle chats.
 *
 * **Design:** The caller passes an `extractFn` callback so this module stays
 * decoupled from relay.ts internals (avoids circular dependency).
 */

export interface QueueItem {
  chatId: number;
  userId: number;
  text: string;
  /** Assistant's conversational reply. Excluded for bot command responses. */
  assistantResponse?: string;
  threadId?: number | null;
  /**
   * Snapshot of system context injected into Claude's actual prompt
   * (user profile + memory facts + relevant past conversations).
   * Passed to the LTM extractor so it can ignore already-known content
   * and avoid re-storing facts that were echoed back by the assistant.
   */
  injectedContext?: string;
}

type ExtractFn = (item: QueueItem) => Promise<void>;

// Per-chat queues: chatId → pending entries
const queues = new Map<number, Array<{ item: QueueItem; fn: ExtractFn }>>();
// Per-chat worker flag: chatId → currently draining
const workers = new Map<number, boolean>();

/**
 * Enqueue an extraction item for the given chat.
 * The provided fn will be called exactly once per item, in FIFO order.
 * Starts a drain worker for this chat if one isn't already running.
 */
export function enqueueExtraction(item: QueueItem, fn: ExtractFn): void {
  if (!queues.has(item.chatId)) queues.set(item.chatId, []);
  queues.get(item.chatId)!.push({ item, fn });
  setImmediate(() => drainQueue(item.chatId));
}

/**
 * Drain worker for a single chat's queue.
 *
 * At most one worker runs per chat at any time (guarded by the `workers` Map).
 * The worker processes entries sequentially in FIFO order. If an individual
 * extraction fails, the error is logged but the remaining items continue —
 * one bad message never blocks the rest of the queue.
 *
 * When the queue is fully drained, both the queue array and worker flag are
 * deleted from their Maps to free memory for idle chats.
 */
async function drainQueue(chatId: number): Promise<void> {
  if (workers.get(chatId)) return; // worker already running for this chat
  workers.set(chatId, true);

  const queue = queues.get(chatId) ?? [];
  while (queue.length > 0) {
    const entry = queue.shift()!;
    try {
      await entry.fn(entry.item);
    } catch (err) {
      console.error(`[extractionQueue] Failed for chat ${chatId}:`, err);
      // Continue processing remaining items — one failure doesn't block the queue
    }
  }

  workers.set(chatId, false);
  // Cleanup to prevent memory leak from idle chats
  if ((queues.get(chatId)?.length ?? 0) === 0) {
    queues.delete(chatId);
    workers.delete(chatId);
  }
}

/** For testing only — returns current queue depth for a chat. */
export function _getQueueSize(chatId: number): number {
  return queues.get(chatId)?.length ?? 0;
}

/** For testing only — returns whether a drain worker is active for a chat. */
export function _isWorkerRunning(chatId: number): boolean {
  return workers.get(chatId) ?? false;
}
