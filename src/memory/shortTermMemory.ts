/**
 * Short-Term Memory Module
 *
 * Implements a rolling window of recent conversation messages with
 * automatic summarization of older chunks.
 *
 * Strategy:
 * - Keep last VERBATIM_LIMIT messages verbatim (as full text)
 * - When message count exceeds threshold, summarize oldest chunk
 * - Inject both verbatim messages + summaries into prompt
 * - Routine messages (role='assistant', metadata.source='routine')
 *   are injected as pre-computed summaries to save token budget
 */

import { insertSummaryRecord, getRecentMessagesLocal, getConversationSummariesLocal, getMessageCountLocal } from "../local/storageBackend";
import { getDb } from "../local/db";

const VERBATIM_LIMIT = 20;
const SUMMARIZE_CHUNK_SIZE = 20;

/** Source tag for routine (proactive) assistant messages. */
export const ROUTINE_SOURCE = "routine";

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  metadata?: {
    source?: string;
    routine?: string;
    summary?: string;
    sentAt?: string;
  };
}

export interface ConversationSummary {
  id: string;
  summary: string;
  message_count: number;
  from_timestamp: string | null;
  to_timestamp: string | null;
  created_at: string;
}

export interface ShortTermContext {
  verbatimMessages: ConversationMessage[];
  summaries: ConversationSummary[];
  totalMessages: number;
}

/**
 * Fetch last N messages for a chat, ordered chronologically (oldest first).
 */
export async function getRecentMessages(
  chatId: number,
  limit: number = VERBATIM_LIMIT,
  threadId?: number | null,
  since?: string | null
): Promise<ConversationMessage[]> {
  return getRecentMessagesLocal(chatId, limit, threadId, since) as Promise<ConversationMessage[]>;
}

/**
 * Fetch recent conversation summaries for a chat, oldest first.
 */
export async function getConversationSummaries(
  chatId: number,
  threadId?: number | null,
  { limit = 10, maxAgeDays = 14, since }: { limit?: number; maxAgeDays?: number; since?: string | null } = {}
): Promise<ConversationSummary[]> {
  // Compute cutoff once — use the later of maxAgeDays cutoff or explicit since timestamp
  const ageCutoff = new Date();
  ageCutoff.setDate(ageCutoff.getDate() - maxAgeDays);
  const sinceDate = since ? new Date(since) : null;
  const effectiveCutoff = sinceDate && sinceDate > ageCutoff ? sinceDate : ageCutoff;

  // SQLite datetime('now') stores UTC without a timezone marker (e.g. '2026-03-18 13:09:22').
  // new Date() with a space-separated string parses it as LOCAL time, which is wrong.
  // Normalise to ISO 8601 UTC by replacing the space with 'T' and appending 'Z'.
  const parseSQLiteUtc = (ts: string | null | undefined): number => {
    if (!ts) return 0;
    const iso = ts.includes("T") ? ts : ts.replace(" ", "T") + "Z";
    return new Date(iso).getTime();
  };

  const all = (getConversationSummariesLocal(chatId, threadId) as ConversationSummary[])
    .filter((s) => !s.created_at || parseSQLiteUtc(s.created_at) >= effectiveCutoff.getTime())
    .sort((a, b) => parseSQLiteUtc(b.created_at) - parseSQLiteUtc(a.created_at))
    .slice(0, limit)
    .reverse();
  return all;
}

/**
 * Get the total count of messages for a chat.
 */
async function getTotalMessageCount(
  chatId: number,
  threadId?: number | null
): Promise<number> {
  return getMessageCountLocal(chatId, threadId);
}

/**
 * Check if we have enough new messages to trigger summarization.
 */
export async function shouldSummarize(
  chatId: number,
  threadId?: number | null
): Promise<boolean> {
  try {
    const db = getDb();
    const chatStr = chatId.toString();
    // Count messages after the latest summary's to_timestamp
    let sql = "SELECT MAX(created_at) as last_summary_ts FROM conversation_summaries WHERE chat_id = ?";
    const params: any[] = [chatStr];
    if (threadId != null) {
      sql += " AND thread_id = ?";
      params.push(threadId.toString());
    } else {
      sql += " AND thread_id IS NULL";
    }
    const summaryRow = db.query(sql).get(...params) as { last_summary_ts: string | null } | null;
    const lastTs = summaryRow?.last_summary_ts;

    let countSql = "SELECT COUNT(*) as count FROM messages WHERE chat_id = ?";
    const countParams: any[] = [chatStr];
    if (threadId != null) {
      countSql += " AND thread_id = ?";
      countParams.push(threadId.toString());
    } else {
      countSql += " AND thread_id IS NULL";
    }
    if (lastTs) {
      countSql += " AND created_at > ?";
      countParams.push(lastTs);
    }
    const countRow = db.query(countSql).get(...countParams) as { count: number };
    return countRow.count > VERBATIM_LIMIT;
  } catch {
    return false;
  }
}

/**
 * Summarize the oldest chunk of messages using Ollama.
 * Stores result in conversation_summaries. Does NOT delete original messages.
 */
export async function summarizeOldMessages(
  chatId: number,
  threadId?: number | null
): Promise<void> {
  let afterTimestamp: string | null = null;
  let messages: ConversationMessage[] | null = null;

  const db = getDb();
  const chatStr = chatId.toString();

  // Get latest summary timestamp
  let sumSql = "SELECT created_at FROM conversation_summaries WHERE chat_id = ?";
  const sumParams: any[] = [chatStr];
  if (threadId != null) {
    sumSql += " AND thread_id = ?";
    sumParams.push(threadId.toString());
  } else {
    sumSql += " AND thread_id IS NULL";
  }
  sumSql += " ORDER BY created_at DESC LIMIT 1";
  const sumRow = db.query(sumSql).get(...sumParams) as { created_at: string } | null;
  afterTimestamp = sumRow?.created_at ?? null;

  // Fetch messages after last summary
  let msgSql = "SELECT id, role, content, created_at FROM messages WHERE chat_id = ?";
  const msgParams: any[] = [chatStr];
  if (threadId != null) {
    msgSql += " AND thread_id = ?";
    msgParams.push(threadId.toString());
  } else {
    msgSql += " AND thread_id IS NULL";
  }
  if (afterTimestamp) {
    msgSql += " AND created_at > ?";
    msgParams.push(afterTimestamp);
  }
  msgSql += ` ORDER BY created_at ASC LIMIT ${SUMMARIZE_CHUNK_SIZE}`;
  messages = db.query(msgSql).all(...msgParams) as ConversationMessage[];

  if (!messages || messages.length === 0) return;

  // Format messages for summarization
  const conversation = (messages as ConversationMessage[])
    .map((m) => {
      if (m.metadata?.source === "routine") {
        return `[${m.metadata.routine ?? "routine"}]: ${m.content.slice(0, 500)}`;
      }
      return `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`;
    })
    .join("\n");

  const summaryPrompt =
    `Summarize this conversation excerpt concisely (3-5 sentences). ` +
    `Preserve key facts, decisions, goals mentioned, and action items. ` +
    `Plain text only, no markdown.\n\n${conversation}`;

  let summary = "";
  try {
    const { callRoutineModel } = await import("../routines/routineModel.ts");
    summary = await callRoutineModel(summaryPrompt, {
      label: "stm-summary",
      timeoutMs: 30_000,
    });
  } catch {
    // Fallback: simple concatenation
    summary = (messages as ConversationMessage[])
      .map((m) => m.content.slice(0, 100))
      .join(" | ")
      .slice(0, 500);
  }

  if (!summary) return;

  const firstMsg = (messages as ConversationMessage[])[0];
  const lastMsg = (messages as ConversationMessage[])[messages.length - 1];

  await insertSummaryRecord({
    chat_id: chatId,
    thread_id: threadId,
    summary,
    message_count: messages.length,
    from_message_id: firstMsg.id,
    to_message_id: lastMsg.id,
    from_timestamp: firstMsg.created_at,
    to_timestamp: lastMsg.created_at,
  });
}

/**
 * Load full short-term context: summaries + last 20 verbatim messages.
 */
export async function getShortTermContext(
  chatId: number,
  threadId?: number | null,
  { since }: { since?: string | null } = {}
): Promise<ShortTermContext> {
  const [verbatimMessages, summaries, totalMessages] = await Promise.all([
    getRecentMessages(chatId, VERBATIM_LIMIT, threadId, since),
    getConversationSummaries(chatId, threadId, { since }),
    getTotalMessageCount(chatId, threadId),
  ]);

  return { verbatimMessages, summaries, totalMessages };
}

// ─── Routine Context Queries ────────────────────────────────────────────────

/**
 * Returns the most recent routine assistant message for (chatId, threadId), or null.
 */
export async function getLastRoutineMessage(
  chatId: number,
  threadId?: number | null
): Promise<ConversationMessage | null> {
  const db = getDb();
  const chatStr = chatId.toString();
  let sql = "SELECT id, role, content, created_at, metadata FROM messages WHERE chat_id = ? AND role = 'assistant'";
  const params: any[] = [chatStr];
  if (threadId != null) {
    sql += " AND thread_id = ?";
    params.push(threadId.toString());
  } else {
    sql += " AND thread_id IS NULL";
  }
  sql += " ORDER BY created_at DESC LIMIT 10";
  const rows = db.query(sql).all(...params) as any[];
  for (const row of rows) {
    const meta = row.metadata ? (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) : {};
    if (meta?.source === ROUTINE_SOURCE) {
      return { ...row, metadata: meta } as ConversationMessage;
    }
  }
  return null;
}

/**
 * Returns the most recent non-routine assistant turn for (chatId, threadId), or null.
 */
export async function getLastRealAssistantTurn(
  chatId: number,
  threadId?: number | null
): Promise<ConversationMessage | null> {
  const db = getDb();
  const chatStr = chatId.toString();
  let sql = "SELECT id, role, content, created_at, metadata FROM messages WHERE chat_id = ? AND role = 'assistant'";
  const params: any[] = [chatStr];
  if (threadId != null) {
    sql += " AND thread_id = ?";
    params.push(threadId.toString());
  } else {
    sql += " AND thread_id IS NULL";
  }
  sql += " ORDER BY created_at DESC LIMIT 10";
  const rows = db.query(sql).all(...params) as any[];
  for (const row of rows) {
    const meta = row.metadata ? (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) : {};
    if (meta?.source !== ROUTINE_SOURCE) {
      return { ...row, metadata: meta } as ConversationMessage;
    }
  }
  return null;
}

// ─── Formatting ────────────────────────────────────────────────────────────

export function relativeTime(isoStr: string, _tz: string): string {
  const diffMs = Date.now() - new Date(isoStr).getTime();
  const diffH = diffMs / 3_600_000;
  if (diffH < 1) return "just now";
  if (diffH < 24) return `${Math.round(diffH)}h ago`;
  if (diffH < 48) return "yesterday";
  return `${Math.round(diffH / 24)} days ago`;
}

export function formatDateHeader(isoStr: string, tz: string): string {
  return new Date(isoStr).toLocaleDateString("en-SG", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: tz,
  });
}

export function formatMessage(msg: ConversationMessage, tz: string): string {
  const timeStr = new Date(msg.created_at).toLocaleTimeString("en-SG", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  });

  if (msg.metadata?.source === "routine") {
    const label = msg.metadata.routine ?? "routine";
    const rel = relativeTime(msg.created_at, tz);
    const summary =
      msg.metadata.summary ?? msg.content.slice(0, 300) + (msg.content.length > 300 ? "..." : "");
    return `[${label} | ${timeStr}, ${rel}]: ${summary}`;
  }

  const speaker = msg.role === "user" ? "User" : "Assistant";
  return `[${timeStr}] ${speaker}: ${msg.content}`;
}

function formatSummaryEntry(s: ConversationSummary): string {
  if (s.from_timestamp && s.to_timestamp) {
    const from = new Date(s.from_timestamp).toLocaleDateString("en-SG", {
      month: "short",
      day: "numeric",
    });
    const to = new Date(s.to_timestamp).toLocaleDateString("en-SG", {
      month: "short",
      day: "numeric",
    });
    const range = from === to ? from : `${from}\u2013${to}`;
    return `[Summary | ${range}]: ${s.summary}`;
  }
  return `[Summary]: ${s.summary}`;
}

export function formatShortTermContext(ctx: ShortTermContext, tz: string): string {
  if (ctx.verbatimMessages.length === 0 && ctx.summaries.length === 0) {
    return "";
  }

  const lines: string[] = [];

  for (const s of ctx.summaries) {
    lines.push(formatSummaryEntry(s));
  }

  if (ctx.summaries.length > 0 && ctx.verbatimMessages.length > 0) {
    lines.push("");
  }

  let currentDate = "";
  for (const msg of ctx.verbatimMessages) {
    const msgDate = formatDateHeader(msg.created_at, tz);
    if (msgDate !== currentDate) {
      lines.push(`\u2500\u2500\u2500 ${msgDate} \u2500\u2500\u2500`);
      currentDate = msgDate;
    }
    lines.push(formatMessage(msg, tz));
  }

  return lines.join("\n");
}
