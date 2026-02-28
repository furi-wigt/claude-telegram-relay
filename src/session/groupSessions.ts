/**
 * Per-Group Session Management
 *
 * Manages independent Claude Code sessions for each Telegram group/chat.
 * Each chat ID gets its own session file on disk and in-memory cache,
 * replacing the single global session.json approach.
 *
 * Session files are stored at: {RELAY_DIR}/sessions/{chatId}_{threadId}.json
 */

import { readFile, writeFile, mkdir, readdir, access } from "fs/promises";
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
  /**
   * When true, the next Claude call should inject shortTermContext even if
   * isResumeReliable() would otherwise skip it. Set by the user tapping
   * "Inject context" after a resume failure. Cleared after injection.
   */
  pendingContextInjection: boolean;
  /**
   * When true, the next Claude call must NOT inject shortTermContext even
   * though isResumeReliable() returns false (sessionId=null after /new).
   * Set by resetSession() when the user explicitly requests a fresh start.
   * Cleared after being consumed on the first post-reset message.
   */
  suppressContextInjection?: boolean;
  /**
   * Monotonic counter incremented each time resetSession() is called.
   * Used by updateSessionIdGuarded() to detect stale onSessionId callbacks:
   * if a Claude response arrives AFTER /new reset the session, the captured
   * generation won't match the current one and the update is discarded,
   * preventing the old session ID from overwriting the fresh null state.
   */
  resetGen: number;
  /**
   * Configured working directory for this topic.
   * Updated by /cwd. Used as the source when a new Claude session starts.
   * When undefined, falls back to PROJECT_DIR or relay working directory.
   */
  cwd?: string;
  /**
   * Locked working directory for the current active Claude session.
   * Set once from `cwd` (or projectDir fallback) when sessionId transitions
   * from null → active. Never changed while sessionId is non-null, ensuring
   * --resume always uses the same CLAUDE.md context as the original spawn.
   */
  activeCwd?: string;
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
      pendingContextInjection: false,
      suppressContextInjection: false,
      resetGen: 0,
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
 * Update the Claude Code session ID only if the session's resetGen matches the
 * captured generation. This prevents a stale onSessionId callback (from a Claude
 * response that was already in-flight when /new was tapped) from overwriting the
 * null sessionId that resetSession() just set.
 *
 * Usage in relay.ts:
 *   const gen = session.resetGen;   // capture BEFORE calling Claude
 *   onSessionId: (id) => void updateSessionIdGuarded(chatId, id, gen, threadId)
 */
export async function updateSessionIdGuarded(
  chatId: number,
  sessionId: string,
  gen: number,
  threadId?: number | null,
): Promise<void> {
  const session = sessions.get(sessionKey(chatId, threadId));
  if (session && session.resetGen === gen) {
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
          pendingContextInjection: raw.pendingContextInjection ?? false,
          suppressContextInjection: raw.suppressContextInjection ?? false,
          resetGen: raw.resetGen ?? 0,
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
 * Clear the session for a chat, forcing a new Claude Code session on the next
 * message. Resets the turn counter and start time so the footer shows #1 on
 * the first post-reset reply. Does not delete the session file.
 */
export async function resetSession(chatId: number, threadId?: number | null): Promise<void> {
  const session = sessions.get(sessionKey(chatId, threadId));
  if (session) {
    const now = new Date().toISOString();
    session.sessionId = null;
    session.messageCount = 0;
    session.startedAt = now;
    session.lastActivity = now;
    session.pendingContextInjection = false;
    session.suppressContextInjection = true;
    session.resetGen = (session.resetGen ?? 0) + 1;
    await saveSession(session);
  }
}

/**
 * Detect whether a --resume attempt silently created a new session instead of
 * continuing the old one. Claude CLI does not signal failure explicitly — we
 * infer it by comparing session IDs before and after the call.
 *
 * @param triedResume  True when isResumeReliable() was true before the call
 * @param prevId       session.sessionId captured BEFORE callClaude()
 * @param newId        session.sessionId after callClaude() (updated by onSessionId)
 * @returns true when a resume was attempted but Claude returned a different ID
 */
export function didResumeFail(
  triedResume: boolean,
  prevId: string | null,
  newId: string | null,
): boolean {
  if (!triedResume) return false;
  if (!prevId || !newId) return false;
  return prevId !== newId;
}

/**
 * Default TTL in hours for Claude session resume reliability.
 * After this period, we assume the server-side session has expired and
 * inject shortTermContext even if a sessionId exists on disk.
 *
 * Override with SESSION_RESUME_TTL_HOURS in .env.
 */
const DEFAULT_RESUME_TTL_HOURS = Number(process.env.SESSION_RESUME_TTL_HOURS) || 4;

/**
 * Return true when a --resume call is likely to succeed:
 *   - sessionId is present (we have a Claude session UUID to resume)
 *   - lastActivity is within the TTL window (session probably still active server-side)
 *
 * When false, shortTermContext should be injected into the prompt so Claude
 * has conversation history even if resume fails silently.
 *
 * @param ttlHours  Optional override for the TTL (default: SESSION_RESUME_TTL_HOURS or 4h)
 */
export function isResumeReliable(session: SessionState, ttlHours: number = DEFAULT_RESUME_TTL_HOURS): boolean {
  if (!session.sessionId) return false;

  const lastActivity = new Date(session.lastActivity).getTime();
  if (isNaN(lastActivity)) return false;

  const hoursSinceActivity = (Date.now() - lastActivity) / 3_600_000;
  return hoursSinceActivity < ttlHours;
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

// ── Per-Topic CWD Helpers ────────────────────────────────────────────────────

/**
 * Set or clear the configured working directory for a topic.
 *
 * @param chatId    Telegram chat ID
 * @param threadId  Forum topic thread ID (null for root chat)
 * @param cwd       Absolute path to use, or undefined to clear (revert to default)
 *
 * @throws {Error}  If cwd is a non-empty string that does not exist on disk.
 */
export async function setTopicCwd(
  chatId: number,
  threadId: number | null | undefined,
  cwd: string | undefined
): Promise<void> {
  if (cwd !== undefined && cwd !== "") {
    try {
      await access(cwd);
    } catch {
      throw new Error(`Path does not exist: ${cwd}`);
    }
  }

  const key = sessionKey(chatId, threadId ?? null);
  const session = sessions.get(key);
  if (!session) return;

  session.cwd = cwd !== "" ? cwd : undefined;
  await saveSession(session);
}

/**
 * Lock the active working directory for the current Claude session.
 *
 * Called once per new session (when sessionId transitions null → active).
 * Skipped when the session already has an active sessionId so that
 * --resume calls always use the same cwd as the original spawn.
 *
 * Resolution order: session.cwd → projectDir → undefined
 *
 * @param chatId      Telegram chat ID
 * @param threadId    Forum topic thread ID (null for root chat)
 * @param projectDir  Fallback directory (from PROJECT_DIR env or empty string)
 */
export async function lockActiveCwd(
  chatId: number,
  threadId: number | null | undefined,
  projectDir: string | undefined
): Promise<void> {
  const key = sessionKey(chatId, threadId ?? null);
  const session = sessions.get(key);
  if (!session) return;

  // Only lock when starting a fresh session — never overwrite an active one.
  if (session.sessionId) return;

  const resolved = session.cwd || projectDir || undefined;
  session.activeCwd = resolved;
  await saveSession(session);
}
