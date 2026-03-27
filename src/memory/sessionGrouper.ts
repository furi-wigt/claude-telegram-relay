/**
 * Session Grouper — Read Session State Files + Query Messages
 *
 * Reads session state files from ~/.claude-relay/sessions/ to get
 * precise session boundaries. Queries the messages table for messages
 * within each session's time window.
 *
 * Pure functions exported for testing. I/O functions kept private.
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { SessionMessage } from "./correctionDetector";

const RELAY_DIR = process.env.RELAY_DIR || join(homedir(), ".claude-relay");
const SESSIONS_DIR = join(RELAY_DIR, "sessions");

const MIN_MESSAGES = 3;

export interface SessionInfo {
  chatId: number;
  threadId: number | null;
  agentId: string;
  sessionId: string | null;
  startedAt: string;
  lastActivity: string;
  messageCount: number;
  cwd?: string;
}

export interface SessionQueryParams {
  chatId: string;
  threadId: string | null;
  startedAt: string;
  lastActivity: string;
}

export interface SessionWithMessages {
  session: SessionInfo;
  messages: SessionMessage[];
}

/**
 * Filter sessions to only those active today with enough messages.
 * Pure function — no side effects.
 *
 * @param sessions  All parsed session infos
 * @param today     Optional override for today's date (YYYY-MM-DD). Defaults to now.
 */
export function filterTodaySessions(
  sessions: SessionInfo[],
  today?: string,
): SessionInfo[] {
  const todayStr = today ?? new Date().toISOString().slice(0, 10);

  return sessions.filter((s) => {
    // Must have been active today
    const activityDate = s.lastActivity.slice(0, 10);
    if (activityDate !== todayStr) return false;

    // Must have enough messages to be worth analyzing
    if (s.messageCount < MIN_MESSAGES) return false;

    return true;
  });
}

/**
 * Build query parameters for fetching messages within a session's time window.
 * Pure function — no side effects.
 */
export function buildSessionQuery(session: SessionInfo): SessionQueryParams {
  return {
    chatId: String(session.chatId),
    threadId: session.threadId !== null ? String(session.threadId) : null,
    startedAt: session.startedAt,
    lastActivity: session.lastActivity,
  };
}

/**
 * Read all session state files from disk and parse into SessionInfo[].
 * Skips corrupt files silently.
 */
export async function readSessionFiles(): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  try {
    const files = await readdir(SESSIONS_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await readFile(join(SESSIONS_DIR, file), "utf-8");
        const raw = JSON.parse(content);
        if (!raw.chatId || !raw.startedAt) continue;
        sessions.push({
          chatId: raw.chatId,
          threadId: raw.threadId ?? null,
          agentId: raw.agentId ?? "unknown",
          sessionId: raw.sessionId ?? null,
          startedAt: raw.startedAt,
          lastActivity: raw.lastActivity ?? raw.startedAt,
          messageCount: raw.messageCount ?? 0,
          cwd: raw.activeCwd ?? raw.cwd,
        });
      } catch {
        // Skip corrupt session files
      }
    }
  } catch {
    // Sessions directory may not exist
  }
  return sessions;
}

/**
 * Query messages from SQLite for a single session's time window.
 * Returns messages ordered by created_at ASC.
 */
export async function querySessionMessages(
  params: SessionQueryParams,
): Promise<SessionMessage[]> {
  try {
    const { getDb } = await import("../local/db");
    const db = getDb();

    let sql = `
      SELECT id, role, content, created_at
      FROM messages
      WHERE chat_id = ?
        AND created_at >= ?
        AND created_at <= ?
    `;
    const binds: any[] = [params.chatId, params.startedAt, params.lastActivity];

    if (params.threadId !== null) {
      sql += " AND thread_id = ?";
      binds.push(params.threadId);
    }

    sql += " ORDER BY created_at ASC";

    return db.query(sql).all(...binds) as SessionMessage[];
  } catch (err) {
    console.error("[sessionGrouper] Error querying messages:", err);
    return [];
  }
}

/**
 * Main entry point: read today's sessions, fetch messages for each.
 * Returns session + message pairs ready for correction detection.
 */
export async function getTodaySessionsWithMessages(): Promise<SessionWithMessages[]> {
  const allSessions = await readSessionFiles();
  const todaySessions = filterTodaySessions(allSessions);

  const results: SessionWithMessages[] = [];
  for (const session of todaySessions) {
    const params = buildSessionQuery(session);
    const messages = await querySessionMessages(params);
    if (messages.length >= MIN_MESSAGES) {
      results.push({ session, messages });
    }
  }
  return results;
}
