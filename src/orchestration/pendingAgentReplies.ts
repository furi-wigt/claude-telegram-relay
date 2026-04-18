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
const LAST_AGENT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

interface PendingReply {
  agentId: string;
  ccThreadId: number | null;
  expiresAt: number;
}

interface LastActiveAgent {
  agentId: string;
  expiresAt: number;
}

// Module-level Maps — zero global-scope leakage; process lifetime is fine for a bot
const pending = new Map<string, PendingReply>();
// Key: `${ccChatId}:${threadId ?? "root"}` — last agent to complete a task in this CC session
const lastActive = new Map<string, LastActiveAgent>();

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

/**
 * Record the last agent that completed a task in a CC session.
 * Used to route short continuation commands (e.g. "merge", "ok", "go ahead")
 * to the correct agent without re-running intent classification.
 */
export function trackLastActiveAgent(
  ccChatId: number,
  ccThreadId: number | null,
  agentId: string,
): void {
  lastActive.set(`${ccChatId}:${ccThreadId ?? "root"}`, {
    agentId,
    expiresAt: Date.now() + LAST_AGENT_TTL_MS,
  });
}

/**
 * Return the last agent that completed a task in this CC session, or null if
 * expired / never recorded.
 */
export function getLastActiveAgent(
  ccChatId: number,
  ccThreadId: number | null,
): string | null {
  const key = `${ccChatId}:${ccThreadId ?? "root"}`;
  const entry = lastActive.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    lastActive.delete(key);
    return null;
  }
  return entry.agentId;
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
  lastActive.clear();
}

export function _size(): number {
  return pending.size;
}
