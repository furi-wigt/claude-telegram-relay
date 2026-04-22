/**
 * Attachment continuity — remembers the last attachment context per
 * (chatId, agentId) so follow-up replies via `rerouteToAgent` can
 * re-inject the same imageContext/documentContext/attachmentPaths the
 * original dispatch had. Without this, turn 2 loses all prior attachments.
 *
 * Design: in-memory only. Restart = empty. Acceptable because a typical
 * follow-up happens within seconds/minutes of the original dispatch.
 *
 * TTL: 30 minutes from set. Lazy eviction on read.
 * Capacity cap: 200 entries. When full, evict the entry with the
 * oldest `expiresAt` (coarsest substitute for LRU without a list).
 */

import type { AttachmentContext } from "./commandCenter.ts";

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 200;

interface Entry {
  context: AttachmentContext;
  expiresAt: number;
}

const store = new Map<string, Entry>();

function keyOf(chatId: number, agentId: string): string {
  return `${chatId}:${agentId}`;
}

/**
 * Evict the entry with the oldest (smallest) `expiresAt`. O(n) over the
 * store, but only invoked when the cap is hit — rare path.
 */
function evictOldest(): void {
  let oldestKey: string | null = null;
  let oldestExpiry = Infinity;
  for (const [k, v] of store) {
    if (v.expiresAt < oldestExpiry) {
      oldestExpiry = v.expiresAt;
      oldestKey = k;
    }
  }
  if (oldestKey) store.delete(oldestKey);
}

/**
 * Remember the attachment context attached to a dispatch bound for `agentId`
 * in chat `chatId`. Overwrites any prior entry for the same key.
 *
 * No-op if `context` has neither imageContext nor documentContext nor paths
 * — nothing useful to remember.
 */
export function rememberAttachment(
  chatId: number,
  agentId: string,
  context: AttachmentContext,
): void {
  if (!context.imageContext && !context.documentContext && (!context.attachmentPaths || context.attachmentPaths.length === 0)) {
    return;
  }
  if (store.size >= MAX_ENTRIES && !store.has(keyOf(chatId, agentId))) {
    evictOldest();
  }
  store.set(keyOf(chatId, agentId), {
    context,
    expiresAt: Date.now() + TTL_MS,
  });
}

/**
 * Recall the last attachment context for (chatId, agentId).
 * Returns null if no entry exists OR if the entry has expired
 * (lazy eviction — expired entry is removed on access).
 */
export function recallAttachment(
  chatId: number,
  agentId: string,
): AttachmentContext | null {
  const entry = store.get(keyOf(chatId, agentId));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(keyOf(chatId, agentId));
    return null;
  }
  return entry.context;
}

/**
 * Forget the remembered attachment for a chat. If `agentId` is omitted,
 * forgets all agents' entries for that chat (used by `/new`).
 */
export function forgetAttachment(chatId: number, agentId?: string): void {
  if (agentId) {
    store.delete(keyOf(chatId, agentId));
    return;
  }
  // Remove all entries for this chat
  const prefix = `${chatId}:`;
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}

/** Test helper — clears the entire store. */
export function _clearAll(): void {
  store.clear();
}

/** Test helper — returns current size. */
export function _size(): number {
  return store.size;
}
