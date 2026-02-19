/**
 * Per-Group Session Management
 *
 * Manages independent Claude Code sessions for each Telegram group/chat.
 * Each chat ID gets its own session file on disk and in-memory cache,
 * replacing the single global session.json approach.
 *
 * Session files are stored at: {RELAY_DIR}/sessions/{chatId}_{threadId}.json
 */

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";

const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const SESSIONS_DIR = join(RELAY_DIR, "sessions");

export interface SessionState {
  chatId: number;
  agentId: string;
  threadId: number | null;
  sessionId: string | null;
  lastActivity: string;
  /** @deprecated Retained for JSON backward compat; no longer populated */
  topicKeywords: string[];
  messageCount: number;           // total messages in this session
  startedAt: string;              // ISO date when session started
  /** @deprecated Retained for JSON backward compat; no longer populated */
  pendingContextSwitch: boolean;
  /** @deprecated Retained for JSON backward compat; no longer populated */
  pendingMessage: string;
  /** @deprecated Retained for JSON backward compat; no longer populated */
  lastUserMessages: string[];
}

/** Build a unique map key from chatId and optional threadId */
function sessionKey(chatId: number, threadId?: number | null): string {
  return `${chatId}_${threadId ?? ''}`;
}

/** In-memory cache of active sessions keyed by chatId_threadId */
const sessions = new Map<string, SessionState>();

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
export async function loadSession(chatId: number, agentId: string, threadId?: number | null): Promise<SessionState> {
  const key = sessionKey(chatId, threadId);
  const cached = sessions.get(key);
  if (cached) {
    return cached;
  }

  const sessionFile = join(SESSIONS_DIR, `${key}.json`);
  try {
    const content = await readFile(sessionFile, "utf-8");
    const state: SessionState = JSON.parse(content);
    sessions.set(key, state);
    return state;
  } catch {
    // No existing session file -- create a fresh state
    const state: SessionState = {
      chatId,
      agentId,
      threadId: threadId ?? null,
      sessionId: null,
      lastActivity: new Date().toISOString(),
      topicKeywords: [],
      messageCount: 0,
      startedAt: new Date().toISOString(),
      pendingContextSwitch: false,
      pendingMessage: "",
      lastUserMessages: [],
    };
    sessions.set(key, state);
    return state;
  }
}

/**
 * Persist session state to disk and update the in-memory cache.
 */
export async function saveSession(state: SessionState): Promise<void> {
  const key = sessionKey(state.chatId, state.threadId);
  const sessionFile = join(SESSIONS_DIR, `${key}.json`);
  await writeFile(sessionFile, JSON.stringify(state, null, 2));
  sessions.set(key, state);
}

/**
 * Update the Claude Code session ID for a given chat.
 * Called after parsing a session ID from Claude CLI output.
 */
export async function updateSessionId(chatId: number, sessionId: string, threadId?: number | null): Promise<void> {
  const session = sessions.get(sessionKey(chatId, threadId));
  if (session) {
    session.sessionId = sessionId;
    session.lastActivity = new Date().toISOString();
    await saveSession(session);
  }
}

/**
 * Touch the session's lastActivity timestamp without changing the session ID.
 */
export async function touchSession(chatId: number, threadId?: number | null): Promise<void> {
  const session = sessions.get(sessionKey(chatId, threadId));
  if (session) {
    session.lastActivity = new Date().toISOString();
    await saveSession(session);
  }
}

/**
 * Get the cached session for a chat without hitting disk.
 * Returns undefined if the session has not been loaded yet.
 */
export function getSession(chatId: number, threadId?: number | null): SessionState | undefined {
  return sessions.get(sessionKey(chatId, threadId));
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

        // Parse chatId and threadId from filename: {chatId}_{threadId}.json
        // chatId can be negative (e.g. -1001234), so split on last underscore
        const lastUnderscore = file.lastIndexOf('_');
        const chatPart = file.slice(0, lastUnderscore);
        const threadPart = file.slice(lastUnderscore + 1, -5); // strip .json

        const parsedChatId = parseInt(chatPart, 10);
        const parsedThreadId = threadPart === '' ? null : parseInt(threadPart, 10);

        // Backwards compatibility: fill in missing fields with defaults
        const state: SessionState = {
          ...raw,
          chatId: raw.chatId ?? parsedChatId,
          threadId: raw.threadId ?? parsedThreadId,
          topicKeywords: raw.topicKeywords ?? [],
          messageCount: raw.messageCount ?? 0,
          startedAt: raw.startedAt ?? raw.lastActivity ?? new Date().toISOString(),
          pendingContextSwitch: raw.pendingContextSwitch ?? false,
          pendingMessage: raw.pendingMessage ?? "",
          lastUserMessages: raw.lastUserMessages ?? [],
        };
        if (state.chatId) {
          sessions.set(sessionKey(state.chatId, state.threadId), state);
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
export async function resetSession(chatId: number, threadId?: number | null): Promise<void> {
  const session = sessions.get(sessionKey(chatId, threadId));
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
export function getSessionSummary(chatId: number, threadId?: number | null): string {
  const session = sessions.get(sessionKey(chatId, threadId));
  if (!session) return "No active session";

  const started = new Date(session.startedAt);
  const duration = Math.round((Date.now() - started.getTime()) / 60000);
  const idle = Math.round((Date.now() - new Date(session.lastActivity).getTime()) / 60000);

  const parts = [
    `Session active for ${duration}m`,
    `Messages: ${session.messageCount}`,
    `Last activity: ${idle}m ago`,
    session.sessionId ? `Claude session: active` : `Claude session: not started`,
  ];

  return parts.join('\n');
}
