/**
 * Pending Agent Replies
 *
 * Tracks the message IDs of agent responses posted to the CC thread so that
 * a user's explicit reply to one of those messages can be routed back to the
 * same agent without re-running intent classification.
 *
 * Key:   `${ccChatId}:${messageId}`
 * Value: agentId + ccThreadId + expiry
 * TTL:   30 minutes (configurable via PENDING_REPLY_TTL_MS)
 */

const TTL_MS = 30 * 60 * 1000; // 30 minutes

interface PendingReply {
  agentId: string;
  ccThreadId: number | null;
  expiresAt: number;
}

// Module-level Map — zero global-scope leakage; process lifetime is fine for a bot
const pending = new Map<string, PendingReply>();

/** Register a CC message as an agent reply that the user may respond to. */
export function trackAgentReply(
  ccChatId: number,
  messageId: number,
  agentId: string,
  ccThreadId: number | null,
): void {
  _prune();
  pending.set(`${ccChatId}:${messageId}`, {
    agentId,
    ccThreadId,
    expiresAt: Date.now() + TTL_MS,
  });
}

/**
 * Look up whether a message was an agent reply we're tracking.
 * Returns null if not found or expired.
 */
export function lookupAgentReply(
  ccChatId: number,
  replyToMessageId: number,
): { agentId: string; ccThreadId: number | null } | null {
  const key = `${ccChatId}:${replyToMessageId}`;
  const entry = pending.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    pending.delete(key);
    return null;
  }
  return { agentId: entry.agentId, ccThreadId: entry.ccThreadId };
}

/** Remove all expired entries — called on every write to cap Map size. */
function _prune(): void {
  const now = Date.now();
  for (const [key, entry] of pending) {
    if (now > entry.expiresAt) pending.delete(key);
  }
}

/** Exposed for tests only. */
export function _clearAll(): void {
  pending.clear();
}

export function _size(): number {
  return pending.size;
}
