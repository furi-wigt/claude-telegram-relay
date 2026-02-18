/**
 * Routine Message Sender
 *
 * Wrapper around sendToGroup() that also persists routine messages to
 * Supabase so they appear in the short-term memory rolling window.
 *
 * All proactive bot messages (morning briefings, check-ins, etc.) MUST
 * use sendAndRecord() instead of sendToGroup() directly.
 *
 * Storage strategy:
 * - Full content saved to messages.content (for embeddings + semantic search)
 * - 2-3 sentence summary stored in messages.metadata.summary (for rolling window)
 * - Summary generated via Ollama at insert time (free, local, ~1-2s)
 * - Falls back to 300-char truncation if Ollama is unavailable
 */

import { supabase } from "./supabase.ts";
import { sendToGroup } from "./sendToGroup.ts";
import { callOllamaGenerate } from "../ollama.ts";

export interface RoutineMessageOptions {
  parseMode?: "Markdown" | "HTML";
  routineName: string;  // e.g. 'smart-checkin', 'morning-summary'
  agentId?: string;     // e.g. 'general-assistant', 'aws-architect'
}

/**
 * Summarize a long routine message into 2-3 sentences using Ollama.
 * Falls back to 300-character truncation if Ollama is unavailable.
 */
export async function summarizeRoutineMessage(
  content: string,
  routineName: string
): Promise<string> {
  const prompt =
    `Summarize this ${routineName} message in 2-3 concise sentences. ` +
    `Preserve key facts, numbers, and action items. Plain text only, no markdown.\n\n` +
    content;

  try {
    const summary = await callOllamaGenerate(prompt, { timeoutMs: 8_000 });
    if (!summary) throw new Error("empty summary");
    return summary;
  } catch (err) {
    console.warn(
      `summarizeRoutineMessage: Ollama unavailable (${err}), using truncation fallback`
    );
    return content.slice(0, 300) + (content.length > 300 ? "..." : "");
  }
}

/**
 * Send a routine message to Telegram AND persist it to Supabase.
 *
 * The message is saved with role='assistant', metadata.source='routine'
 * so the short-term memory module can display it in the rolling window
 * using the pre-computed summary instead of the full content.
 */
export async function sendAndRecord(
  chatId: number,
  message: string,
  options: RoutineMessageOptions
): Promise<void> {
  const sentAt = new Date();

  // 1. Send to Telegram first (don't block on Supabase)
  await sendToGroup(chatId, message, { parseMode: options.parseMode });

  // 2. Generate summary at insert time (async — routine already fired)
  const summary = await summarizeRoutineMessage(message, options.routineName);

  // 3. Persist to Supabase (skip gracefully if not configured)
  if (!supabase) {
    console.warn("sendAndRecord: Supabase not configured — message not persisted");
    return;
  }

  try {
    const { error } = await supabase.from("messages").insert({
      role: "assistant",
      content: message,        // Full content — embedded by webhook for semantic search
      channel: "telegram",
      chat_id: chatId,
      agent_id: options.agentId ?? null,
      metadata: {
        source: "routine",
        routine: options.routineName,
        summary,               // Pre-computed — injected into rolling window
        sentAt: sentAt.toISOString(),
      },
    });

    if (error) {
      console.error("sendAndRecord: Supabase insert error:", error);
    } else {
      console.log(
        `sendAndRecord: Persisted [${options.routineName}] summary: ${summary.slice(0, 80)}...`
      );
    }
  } catch (err) {
    console.error("sendAndRecord: Failed to persist routine message:", err);
  }
}
