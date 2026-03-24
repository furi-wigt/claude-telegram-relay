/**
 * In-memory session store for Report QA sessions.
 *
 * One QA session per chatId. TTL: 30 minutes → auto-pause (not delete).
 * On pause/submit, state is checkpointed to disk for cross-session resume.
 *
 * Mirrors pattern from src/interactive/sessionStore.ts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { ReportQASession } from "./types.ts";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const sessions = new Map<number, ReportQASession>();

// Periodic sweep: auto-pause expired sessions every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [chatId, session] of sessions) {
    if (now - session.lastActivityAt > SESSION_TTL_MS && session.phase !== "paused" && session.phase !== "done") {
      session.phase = "paused";
      session.pausedAt = new Date().toISOString();
      saveCheckpoint(session);
      sessions.delete(chatId);
    }
  }
  // Hard cap: 50 concurrent sessions
  if (sessions.size > 50) {
    const keys = [...sessions.keys()];
    keys.sort((a, b) => (sessions.get(a)?.lastActivityAt ?? 0) - (sessions.get(b)?.lastActivityAt ?? 0));
    for (let i = 0; i < keys.length - 25; i++) sessions.delete(keys[i]);
  }
}, 5 * 60 * 1000).unref();

// ── Public API ───────────────────────────────────────────────────────────────

export function setReportQASession(chatId: number, session: ReportQASession): void {
  sessions.set(chatId, session);
}

export function getReportQASession(chatId: number): ReportQASession | undefined {
  const session = sessions.get(chatId);
  if (!session) return undefined;
  if (Date.now() - session.lastActivityAt > SESSION_TTL_MS) {
    // TTL expired but don't delete — pause gracefully
    if (session.phase !== "paused" && session.phase !== "done") {
      session.phase = "paused";
      session.pausedAt = new Date().toISOString();
      saveCheckpoint(session);
    }
    sessions.delete(chatId);
    return undefined;
  }
  return session;
}

export function updateReportQASession(
  chatId: number,
  patch: Partial<ReportQASession>
): ReportQASession | undefined {
  const session = getReportQASession(chatId);
  if (!session) return undefined;
  const updated = { ...session, ...patch, lastActivityAt: Date.now() };
  sessions.set(chatId, updated);
  return updated;
}

export function clearReportQASession(chatId: number): void {
  sessions.delete(chatId);
}

export function hasReportQASession(chatId: number): boolean {
  return getReportQASession(chatId) !== undefined;
}

/**
 * Check if a chat has an active (non-paused, non-done) QA session.
 * Used by the message router to intercept free-text as QA answers.
 */
export function hasActiveReportQA(chatId: number): boolean {
  const session = getReportQASession(chatId);
  if (!session) return false;
  return session.phase === "active" || session.phase === "collecting";
}

// ── Disk Checkpoint ──────────────────────────────────────────────────────────

export function saveCheckpoint(session: ReportQASession): void {
  try {
    const dir = dirname(session.checkpointPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(session.checkpointPath, JSON.stringify(session, null, 2));
  } catch (err) {
    console.error("[report-qa] Failed to save checkpoint:", err);
  }
}

export function loadCheckpoint(checkpointPath: string): ReportQASession | null {
  try {
    if (!existsSync(checkpointPath)) return null;
    const raw = readFileSync(checkpointPath, "utf-8");
    return JSON.parse(raw) as ReportQASession;
  } catch {
    return null;
  }
}
