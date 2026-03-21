/**
 * Chat & topic name resolution for display purposes.
 *
 * Groups are resolved from agents.json (loaded once at startup).
 * Topic names are learned dynamically from incoming Telegram messages
 * and persisted to disk so they survive restarts.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { AGENTS } from "../agents/config.ts";

// ── Topic name cache ────────────────────────────────────────────────────────

const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const TOPIC_CACHE_PATH = join(RELAY_DIR, "sessions", "topic-names.json");
const CHAT_NAMES_CACHE_PATH = join(RELAY_DIR, "sessions", "chat-names.json");

/** threadId → topicName */
const topicNames = new Map<number, string>();

/** Load persisted topic names from disk. Safe to call at startup. */
export function loadTopicNames(): void {
  try {
    const raw = readFileSync(TOPIC_CACHE_PATH, "utf-8");
    const entries: Record<string, string> = JSON.parse(raw);
    for (const [k, v] of Object.entries(entries)) {
      topicNames.set(Number(k), v);
    }
  } catch {
    // File doesn't exist yet or is invalid — start fresh
  }
}

/** Persist current topic names to disk. */
function saveTopicNames(): void {
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of topicNames) obj[String(k)] = v;
    mkdirSync(join(RELAY_DIR, "sessions"), { recursive: true });
    writeFileSync(TOPIC_CACHE_PATH, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error("[chatNames] Failed to persist topic names:", err);
  }
}

// ── Dynamic chat name cache (non-agent groups) ──────────────────────────────

/** chatId → chat title (learned from incoming messages) */
const chatNames = new Map<number, string>();

/** Load persisted chat names from disk. Safe to call at startup. */
export function loadChatNames(): void {
  try {
    const raw = readFileSync(CHAT_NAMES_CACHE_PATH, "utf-8");
    const entries: Record<string, string> = JSON.parse(raw);
    for (const [k, v] of Object.entries(entries)) {
      chatNames.set(Number(k), v);
    }
  } catch {
    // File doesn't exist yet — start fresh
  }
}

/** Persist current chat names to disk. */
function saveChatNames(): void {
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of chatNames) obj[String(k)] = v;
    mkdirSync(join(RELAY_DIR, "sessions"), { recursive: true });
    writeFileSync(CHAT_NAMES_CACHE_PATH, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error("[chatNames] Failed to persist chat names:", err);
  }
}

/**
 * Learn a group name from an incoming message.
 * Called from Grammy middleware on each group message.
 */
export function learnChatName(chatId: number, title: string): void {
  if (!chatId || !title) return;
  const existing = chatNames.get(chatId);
  if (existing === title) return; // no change
  chatNames.set(chatId, title);
  saveChatNames();
}

/** Get a dynamically-learned chat name if known, or undefined. */
export function getChatName(chatId: number): string | undefined {
  return chatNames.get(chatId);
}

/** Expose for tests only — reset the cache. */
export function _resetChatNames(): void {
  chatNames.clear();
}

/**
 * Learn a topic name from an incoming message.
 * Called from Grammy middleware when a forum_topic_created event is seen.
 */
export function learnTopicName(threadId: number, name: string): void {
  if (!threadId || !name) return;
  const existing = topicNames.get(threadId);
  if (existing === name) return; // no change
  topicNames.set(threadId, name);
  saveTopicNames();
}

/** Get a topic name if known, or undefined. */
export function getTopicName(threadId: number): string | undefined {
  return topicNames.get(threadId);
}

/** Expose for tests only — reset the cache. */
export function _resetTopicNames(): void {
  topicNames.clear();
}

// ── Chat ID → agent group name ──────────────────────────────────────────────

/** chatId → short group name (built once from AGENTS) */
const chatIdToGroupName = new Map<number, string>();

for (const agent of Object.values(AGENTS)) {
  if (agent.chatId) {
    // shortName takes priority for display; groupName is preserved for auto-discovery
    chatIdToGroupName.set(agent.chatId, agent.shortName ?? agent.groupName);
  }
}

/** The bot owner's Telegram user ID — DMs from this user show as "[DM]" */
const ownerUserId = parseInt(process.env.TELEGRAM_USER_ID || "0", 10);

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve a (chatId, threadId) pair to a human-readable source label.
 *
 * Accepts string or number inputs — SQLite stores IDs as TEXT, so callers
 * may pass strings. Both are coerced to numbers before Map lookup.
 *
 * Resolution order for group name:
 *   1. null / owner user ID   → "[DM]"
 *   2. agents.json chatId     → short agent group name (e.g. "Code Quality")
 *   3. dynamically-learned    → chat title from incoming messages (e.g. "EDEN")
 *   4. fallback               → raw chatId string
 *
 * Topic suffix appended when threadId resolves to a known topic name.
 */
export function resolveSourceLabel(
  chatId: number | string | null | undefined,
  threadId: number | string | null | undefined
): string {
  // Coerce to number — SQLite returns strings, agents.json keys are numbers
  const numChatId = chatId != null ? Number(chatId) : null;
  const numThreadId = threadId != null ? Number(threadId) : null;

  // Group part
  let label: string;
  if (numChatId == null || isNaN(numChatId) || numChatId === ownerUserId) {
    label = "[DM]";
  } else {
    label =
      chatIdToGroupName.get(numChatId) ??  // agents.json (known agent groups)
      chatNames.get(numChatId) ??           // dynamically learned (e.g. EDEN)
      String(chatId);                       // last resort: raw ID
  }

  // Topic suffix
  if (numThreadId != null && !isNaN(numThreadId)) {
    const topicName = topicNames.get(numThreadId);
    label += ` › ${topicName ?? `#${numThreadId}`}`;
  } else if (label !== "[DM]") {
    // null threadId in a group → root General topic
    label += ` › #General`;
  }

  return label;
}

// Load on import
loadTopicNames();
loadChatNames();
