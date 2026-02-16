/**
 * Per-Group Session Management
 *
 * Manages independent Claude Code sessions for each Telegram group/chat.
 * Each chat ID gets its own session file on disk and in-memory cache,
 * replacing the single global session.json approach.
 *
 * Session files are stored at: {RELAY_DIR}/sessions/{chatId}.json
 */

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";

const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const SESSIONS_DIR = join(RELAY_DIR, "sessions");

export interface SessionState {
  chatId: number;
  agentId: string;
  sessionId: string | null;
  lastActivity: string;
}

/** In-memory cache of active sessions keyed by chat ID */
const sessions = new Map<number, SessionState>();

/**
 * Create the sessions directory if it does not exist.
 * Call once at startup before any session operations.
 */
export async function initSessions(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

/**
 * Load session for a specific chat/group.
 * Checks in-memory cache first, then falls back to disk.
 * Creates a new session state if none exists.
 */
export async function loadSession(chatId: number, agentId: string): Promise<SessionState> {
  const cached = sessions.get(chatId);
  if (cached) {
    return cached;
  }

  const sessionFile = join(SESSIONS_DIR, `${chatId}.json`);
  try {
    const content = await readFile(sessionFile, "utf-8");
    const state: SessionState = JSON.parse(content);
    sessions.set(chatId, state);
    return state;
  } catch {
    // No existing session file -- create a fresh state
    const state: SessionState = {
      chatId,
      agentId,
      sessionId: null,
      lastActivity: new Date().toISOString(),
    };
    sessions.set(chatId, state);
    return state;
  }
}

/**
 * Persist session state to disk and update the in-memory cache.
 */
export async function saveSession(state: SessionState): Promise<void> {
  const sessionFile = join(SESSIONS_DIR, `${state.chatId}.json`);
  await writeFile(sessionFile, JSON.stringify(state, null, 2));
  sessions.set(state.chatId, state);
}

/**
 * Update the Claude Code session ID for a given chat.
 * Called after parsing a session ID from Claude CLI output.
 */
export async function updateSessionId(chatId: number, sessionId: string): Promise<void> {
  const session = sessions.get(chatId);
  if (session) {
    session.sessionId = sessionId;
    session.lastActivity = new Date().toISOString();
    await saveSession(session);
  }
}

/**
 * Touch the session's lastActivity timestamp without changing the session ID.
 */
export async function touchSession(chatId: number): Promise<void> {
  const session = sessions.get(chatId);
  if (session) {
    session.lastActivity = new Date().toISOString();
    await saveSession(session);
  }
}

/**
 * Get the cached session for a chat without hitting disk.
 * Returns undefined if the session has not been loaded yet.
 */
export function getSession(chatId: number): SessionState | undefined {
  return sessions.get(chatId);
}

/**
 * List all known sessions (from cache).
 */
export function listSessions(): SessionState[] {
  return Array.from(sessions.values());
}

/**
 * Load all persisted sessions from disk into the in-memory cache.
 * Useful at startup to restore state after a restart.
 */
export async function loadAllSessions(): Promise<number> {
  let loaded = 0;
  try {
    const files = await readdir(SESSIONS_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await readFile(join(SESSIONS_DIR, file), "utf-8");
        const state: SessionState = JSON.parse(content);
        if (state.chatId) {
          sessions.set(state.chatId, state);
          loaded++;
        }
      } catch {
        // Skip corrupt session files
      }
    }
  } catch {
    // Sessions directory may not exist yet
  }
  return loaded;
}

/**
 * Clear the session ID for a chat, forcing a new Claude Code session
 * on the next message. Does not delete the session file.
 */
export async function resetSession(chatId: number): Promise<void> {
  const session = sessions.get(chatId);
  if (session) {
    session.sessionId = null;
    session.lastActivity = new Date().toISOString();
    await saveSession(session);
  }
}
