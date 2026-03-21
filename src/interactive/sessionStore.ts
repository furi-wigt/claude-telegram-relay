/**
 * In-memory session store for active interactive Q&A sessions.
 *
 * One session per chatId. TTL: 30 minutes of inactivity.
 * Mirrors the pattern used in src/routines/pendingState.ts.
 */

import type { InteractiveSession } from "./types.ts";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const sessions = new Map<number, InteractiveSession>();

// M-5: Periodic sweep to evict expired sessions regardless of access pattern
setInterval(() => {
  const now = Date.now();
  for (const [chatId, session] of sessions) {
    if (now - session.lastActivityAt > SESSION_TTL_MS) sessions.delete(chatId);
  }
  // M-LEAK: Hard cap on concurrent interactive sessions
  if (sessions.size > 100) {
    const keys = [...sessions.keys()];
    // Sort by lastActivityAt ascending (oldest first)
    keys.sort((a, b) => (sessions.get(a)?.lastActivityAt ?? 0) - (sessions.get(b)?.lastActivityAt ?? 0));
    for (let i = 0; i < keys.length - 50; i++) sessions.delete(keys[i]);
  }
}, 5 * 60 * 1000).unref();  // M-LEAK: Sweep every 5min (was 10min)

export function setSession(chatId: number, session: InteractiveSession): void {
  sessions.set(chatId, session);
}

export function getSession(chatId: number): InteractiveSession | undefined {
  const session = sessions.get(chatId);
  if (!session) return undefined;

  if (Date.now() - session.lastActivityAt > SESSION_TTL_MS) {
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
  const updated = { ...session, ...patch, lastActivityAt: Date.now() };
  sessions.set(chatId, updated);
  return updated;
}

export function clearSession(chatId: number): void {
  sessions.delete(chatId);
}

export function hasSession(chatId: number): boolean {
  return getSession(chatId) !== undefined;
}
