/**
 * Pending Routine State
 *
 * In-memory store for routines awaiting user confirmation.
 * TTL: 5 minutes — expired entries are auto-cleaned.
 */

import type { PendingRoutine } from "./types.ts";

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes

const pending = new Map<number, PendingRoutine>();

export function setPending(chatId: number, routine: PendingRoutine): void {
  pending.set(chatId, routine);
}

export function getPending(chatId: number): PendingRoutine | undefined {
  const entry = pending.get(chatId);
  if (!entry) return undefined;

  // Expire stale entries
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    pending.delete(chatId);
    return undefined;
  }

  return entry;
}

export function clearPending(chatId: number): void {
  pending.delete(chatId);
}

export function hasPending(chatId: number): boolean {
  return getPending(chatId) !== undefined;
}
