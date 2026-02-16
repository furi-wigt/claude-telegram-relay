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
  topicKeywords: string[];        // extracted keywords for context relevance
  messageCount: number;           // total messages in this session
  startedAt: string;              // ISO date when session started
  pendingContextSwitch: boolean;  // awaiting user's yes/no on context switch
  lastUserMessages: string[];     // last 3 user messages for context comparison
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
      topicKeywords: [],
      messageCount: 0,
      startedAt: new Date().toISOString(),
      pendingContextSwitch: false,
      lastUserMessages: [],
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
        const raw = JSON.parse(content);
        // Backwards compatibility: fill in missing fields with defaults
        const state: SessionState = {
          ...raw,
          topicKeywords: raw.topicKeywords ?? [],
          messageCount: raw.messageCount ?? 0,
          startedAt: raw.startedAt ?? raw.lastActivity ?? new Date().toISOString(),
          pendingContextSwitch: raw.pendingContextSwitch ?? false,
          lastUserMessages: raw.lastUserMessages ?? [],
        };
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

/**
 * Return a human-readable summary of the current session state for a chat.
 * Includes duration, message count, topic keywords, idle time, and
 * whether a Claude Code session is active.
 */
export function getSessionSummary(chatId: number): string {
  const session = sessions.get(chatId);
  if (!session) return "No active session";

  const started = new Date(session.startedAt);
  const duration = Math.round((Date.now() - started.getTime()) / 60000);
  const idle = Math.round((Date.now() - new Date(session.lastActivity).getTime()) / 60000);

  const parts = [
    `Session active for ${duration}m`,
    `Messages: ${session.messageCount}`,
    session.topicKeywords.length > 0
      ? `Topics: ${session.topicKeywords.slice(0, 5).join(', ')}`
      : 'No topic context yet',
    `Last activity: ${idle}m ago`,
    session.sessionId ? `Claude session: active` : `Claude session: not started`,
  ];

  return parts.join('\n');
}
