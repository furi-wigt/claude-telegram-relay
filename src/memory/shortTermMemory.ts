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

import type { SupabaseClient } from "@supabase/supabase-js";

const VERBATIM_LIMIT = 20;
const SUMMARIZE_CHUNK_SIZE = 20;

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
  supabase: SupabaseClient,
  chatId: number,
  limit: number = VERBATIM_LIMIT,
  threadId?: number | null
): Promise<ConversationMessage[]> {
  let query = supabase
    .from("messages")
    .select("id, role, content, created_at, metadata")
    .eq("chat_id", chatId);

  if (threadId != null) {
    query = query.eq("thread_id", threadId);
  } else {
    query = query.is("thread_id", null);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  // Return in chronological order (oldest first) for prompt display
  return (data as ConversationMessage[]).reverse();
}

/**
 * Fetch all conversation summaries for a chat, oldest first.
 */
export async function getConversationSummaries(
  supabase: SupabaseClient,
  chatId: number,
  threadId?: number | null
): Promise<ConversationSummary[]> {
  let query = supabase
    .from("conversation_summaries")
    .select("id, summary, message_count, from_timestamp, to_timestamp, created_at")
    .eq("chat_id", chatId);

  if (threadId != null) {
    query = query.eq("thread_id", threadId);
  } else {
    query = query.is("thread_id", null);
  }

  const { data, error } = await query
    .order("created_at", { ascending: true });

  if (error || !data) return [];
  return data as ConversationSummary[];
}

/**
 * Get the total count of messages for a chat.
 */
async function getTotalMessageCount(
  supabase: SupabaseClient,
  chatId: number,
  threadId?: number | null
): Promise<number> {
  let query = supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("chat_id", chatId);

  if (threadId != null) {
    query = query.eq("thread_id", threadId);
  } else {
    query = query.is("thread_id", null);
  }

  const { count, error } = await query;

  if (error) return 0;
  return count ?? 0;
}

/**
 * Check if we have enough new messages to trigger summarization.
 * Uses the get_unsummarized_message_count() SQL function.
 */
export async function shouldSummarize(
  supabase: SupabaseClient,
  chatId: number,
  threadId?: number | null
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("get_unsummarized_message_count", {
      p_chat_id: chatId,
      p_thread_id: threadId ?? null,
    });
    if (error) return false;
    return (data as number) > VERBATIM_LIMIT;
  } catch {
    return false;
  }
}

/**
 * Summarize the oldest chunk of messages using Ollama.
 * Stores result in conversation_summaries. Does NOT delete original messages.
 */
export async function summarizeOldMessages(
  supabase: SupabaseClient,
  chatId: number,
  threadId?: number | null
): Promise<void> {
  // Get the latest summary's to_timestamp to know where to start
  let summaryQuery = supabase
    .from("conversation_summaries")
    .select("to_timestamp, to_message_id")
    .eq("chat_id", chatId);

  if (threadId != null) {
    summaryQuery = summaryQuery.eq("thread_id", threadId);
  } else {
    summaryQuery = summaryQuery.is("thread_id", null);
  }

  const { data: latestSummary } = await summaryQuery
    .order("created_at", { ascending: false })
    .limit(1);

  const afterTimestamp = latestSummary?.[0]?.to_timestamp ?? null;

  // Fetch the oldest SUMMARIZE_CHUNK_SIZE messages after the last summary
  let query = supabase
    .from("messages")
    .select("id, role, content, created_at, metadata")
    .eq("chat_id", chatId);

  if (threadId != null) {
    query = query.eq("thread_id", threadId);
  } else {
    query = query.is("thread_id", null);
  }

  query = query
    .order("created_at", { ascending: true })
    .limit(SUMMARIZE_CHUNK_SIZE);

  if (afterTimestamp) {
    query = query.gt("created_at", afterTimestamp);
  }

  const { data: messages } = await query;
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
    // Read env vars per-call so tests that mock globalThis.fetch work correctly.
    // Avoids relying on the statically-imported callOllamaGenerate which can be
    // contaminated by mock.module in other test files (global beforeEach resets).
    const ollamaBaseUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
    const ollamaModel = process.env.OLLAMA_MODEL ?? "gemma3:4b";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${ollamaBaseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: ollamaModel, prompt: summaryPrompt, stream: false }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
      const data = await response.json() as { response?: unknown };
      if (typeof data.response === "string") summary = data.response.trim();
    } finally {
      clearTimeout(timer);
    }
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

  await supabase.from("conversation_summaries").insert({
    chat_id: chatId,
    thread_id: threadId ?? null,
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
  supabase: SupabaseClient,
  chatId: number,
  threadId?: number | null
): Promise<ShortTermContext> {
  const [verbatimMessages, summaries, totalMessages] = await Promise.all([
    getRecentMessages(supabase, chatId, VERBATIM_LIMIT, threadId),
    getConversationSummaries(supabase, chatId, threadId),
    getTotalMessageCount(supabase, chatId, threadId),
  ]);

  return { verbatimMessages, summaries, totalMessages };
}

// ─── Formatting ────────────────────────────────────────────────────────────

/**
 * Relative time string: "just now" / "3h ago" / "yesterday" / "N days ago"
 */
export function relativeTime(isoStr: string, _tz: string): string {
  const diffMs = Date.now() - new Date(isoStr).getTime();
  const diffH = diffMs / 3_600_000;
  if (diffH < 1) return "just now";
  if (diffH < 24) return `${Math.round(diffH)}h ago`;
  if (diffH < 48) return "yesterday";
  return `${Math.round(diffH / 24)} days ago`;
}

/**
 * Full date header: "Monday, 18 February 2026"
 */
export function formatDateHeader(isoStr: string, tz: string): string {
  return new Date(isoStr).toLocaleDateString("en-SG", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: tz,
  });
}

/**
 * Format a single message for prompt injection.
 * Routine messages use pre-computed summary. Regular messages show full content.
 */
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

/**
 * Format a summary entry with its date range.
 */
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

/**
 * Format the complete short-term context for prompt injection.
 *
 * Output structure:
 *   [Summary | Feb 15–16]: ...
 *   [Summary | Feb 17]: ...
 *
 *   ─── Monday, 18 February 2026 ───
 *   [morning-summary | 07:02 AM, 8h ago]: ...
 *   [09:15 AM] User: ...
 *   [09:17 AM] Assistant: ...
 */
export function formatShortTermContext(ctx: ShortTermContext, tz: string): string {
  if (ctx.verbatimMessages.length === 0 && ctx.summaries.length === 0) {
    return "";
  }

  const lines: string[] = [];

  // Older compressed summaries (oldest first)
  for (const s of ctx.summaries) {
    lines.push(formatSummaryEntry(s));
  }

  if (ctx.summaries.length > 0 && ctx.verbatimMessages.length > 0) {
    lines.push(""); // blank line separator
  }

  // Verbatim messages with day-boundary headers
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
