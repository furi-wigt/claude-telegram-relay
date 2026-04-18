/**
 * Pending State
 *
 * In-memory stores for multi-turn flows:
 * - PendingRoutine: awaiting target-group selection after NL creation
 * - PendingEdit: awaiting new value after /routines edit
 *
 * Both expire after 5 minutes.
 */

import type { PendingRoutine, PendingEdit } from "./types.ts";

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================
// Routine creation (awaiting target selection)
// ============================================================

const pending = new Map<number, PendingRoutine>();

export function setPending(chatId: number, routine: PendingRoutine): void {
  pending.set(chatId, routine);
}

export function getPending(chatId: number): PendingRoutine | undefined {
  const entry = pending.get(chatId);
  if (!entry) return undefined;
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

// ============================================================
// Edit flow (awaiting prompt or schedule input)
// ============================================================

const pendingEdits = new Map<number, PendingEdit>();

export function setPendingEdit(chatId: number, edit: PendingEdit): void {
  pendingEdits.set(chatId, edit);
}

export function getPendingEdit(chatId: number): PendingEdit | undefined {
  const entry = pendingEdits.get(chatId);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    pendingEdits.delete(chatId);
    return undefined;
  }
  return entry;
}

export function clearPendingEdit(chatId: number): void {
  pendingEdits.delete(chatId);
}
