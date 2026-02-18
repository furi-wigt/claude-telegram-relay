/**
 * In-memory session store for active interactive Q&A sessions.
 *
 * One session per chatId. TTL: 30 minutes of inactivity.
 * Mirrors the pattern used in src/routines/pendingState.ts.
 */

import type { InteractiveSession } from "./types.ts";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const sessions = new Map<number, InteractiveSession>();

export function setSession(chatId: number, session: InteractiveSession): void {
  sessions.set(chatId, session);
}

export function getSession(chatId: number): InteractiveSession | undefined {
  const session = sessions.get(chatId);
  if (!session) return undefined;

  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(chatId);
    return undefined;
  }

  return session;
}

export function updateSession(
  chatId: number,
  patch: Partial<InteractiveSession>
): InteractiveSession | undefined {
  const session = getSession(chatId);
  if (!session) return undefined;
  const updated = { ...session, ...patch };
  sessions.set(chatId, updated);
  return updated;
}

export function clearSession(chatId: number): void {
  sessions.delete(chatId);
}

export function hasSession(chatId: number): boolean {
  return getSession(chatId) !== undefined;
}
