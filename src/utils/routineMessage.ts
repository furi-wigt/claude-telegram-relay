/**
 * Routine Message Sender
 *
 * Wrapper around sendToGroup() that also persists routine messages to
 * the local storage backend so they appear in the short-term memory rolling window.
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

import { sendToGroup } from "./sendToGroup.ts";
import { markdownToHtml, splitMarkdown, decodeHtmlEntities } from "./htmlFormat.ts";
import { callRoutineModel } from "../routines/routineModel.ts";
import { ROUTINE_SOURCE } from "../memory/shortTermMemory.ts";
import { insertMessageRecord } from "../local/storageBackend";

export interface RoutineMessageOptions {
  parseMode?: "Markdown" | "HTML";
  routineName: string;  // e.g. 'smart-checkin', 'morning-summary'
  agentId?: string;     // e.g. 'general-assistant', 'aws-architect'
  topicId?: number | null;  // forum topic thread ID (message_thread_id)
  reply_markup?: unknown;   // Telegram InlineKeyboard JSON (attached to last chunk)
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
    const summary = await callRoutineModel(prompt, { label: "summarizeRoutine", timeoutMs: 30_000 });
    if (!summary) throw new Error("empty summary");
    return summary;
  } catch (err) {
    console.warn(
      `summarizeRoutineMessage: MLX/Ollama unavailable (${err}), using truncation fallback`
    );
    return content.slice(0, 300) + (content.length > 300 ? "..." : "");
  }
}

/**
 * Send a routine message to Telegram AND persist it to the local storage backend.
 *
 * The message is saved with role='assistant', metadata.source='routine'
 * so the short-term memory module can display it in the rolling window
 * using the pre-computed summary instead of the full content.
 *
 * parseMode defaults to "HTML" with automatic markdown→HTML conversion.
 * Callers that explicitly set parseMode:"HTML" must pre-format their content.
 * Callers that set parseMode:"Markdown" use Telegram's legacy Markdown mode.
 */
export async function sendAndRecord(
  chatId: number,
  message: string,
  options: RoutineMessageOptions
): Promise<void> {
  const sentAt = new Date();

  // Default: auto-convert markdown → HTML so LLM output renders correctly.
  // Explicit parseMode means caller is responsible for content format.
  //
  // IMPORTANT: split markdown BEFORE converting to HTML (mirrors sendResponse in relay.ts).
  // Converting first then chunking via chunkMessage() can split inside an HTML tag
  // (e.g. mid-<b>), causing Telegram to 400-reject the chunk and silently fall back to
  // plain text — which exposes raw HTML entities like &lt;slug&gt; literally.
  //
  // OVERFLOW GUARD: markdown → HTML expansion (### → <b><u>…</u></b>, **→<b>…</b>) can
  // push a 3800-char markdown chunk past Telegram's 4096-char HTML limit. When that
  // happens, sendToGroup→chunkMessage splits the HTML at newline boundaries which may
  // land inside a tag, producing malformed HTML that Telegram rejects. The rejected
  // message falls back to plain text and shows raw <b>…</b> tags literally.
  // Fix: after conversion, detect overflow and fall back to tag-stripped plain text
  // (identical to relay.ts sendResponse behaviour).
  const MARKDOWN_SPLIT_LEN = 3800;
  const TELEGRAM_MAX = 4096;

  // 1. Send to Telegram first (don't block on storage)
  if (!options.parseMode) {
    const chunks = splitMarkdown(message, MARKDOWN_SPLIT_LEN);
    for (let i = 0; i < chunks.length; i++) {
      const markup = i === chunks.length - 1 ? options.reply_markup : undefined;
      const html = markdownToHtml(chunks[i]);

      if (html.length > TELEGRAM_MAX) {
        // HTML expanded past 4096 — strip tags, decode entities, send as plain-text sub-chunks.
        const plain = decodeHtmlEntities(html.replace(/<[^>]+>/g, ""));
        const subChunks: string[] = [];
        for (let j = 0; j < plain.length; j += TELEGRAM_MAX) subChunks.push(plain.slice(j, j + TELEGRAM_MAX));
        for (let k = 0; k < subChunks.length; k++) {
          const isLastSub = k === subChunks.length - 1;
          await sendToGroup(chatId, subChunks[k], { topicId: options.topicId, reply_markup: isLastSub ? markup : undefined });
        }
      } else {
        await sendToGroup(chatId, html, { parseMode: "HTML", topicId: options.topicId, reply_markup: markup });
      }
    }
  } else {
    await sendToGroup(chatId, message, { parseMode: options.parseMode, topicId: options.topicId, reply_markup: options.reply_markup });
  }

  // 2. Generate summary at insert time (async — routine already fired)
  const summary = await summarizeRoutineMessage(message, options.routineName);

  // 3. Persist via storage backend (local SQLite + Qdrant)
  try {
    await insertMessageRecord({
      role: "assistant",
      content: message,
      chat_id: chatId,
      agent_id: options.agentId,
      thread_id: options.topicId,
      channel: "telegram",
      metadata: {
        source: ROUTINE_SOURCE,
        routine: options.routineName,
        summary,
        sentAt: sentAt.toISOString(),
      },
    });
    console.log(
      `sendAndRecord: Persisted [${options.routineName}] summary: ${summary.slice(0, 80)}...`
    );
  } catch (err) {
    console.error("sendAndRecord: Failed to persist routine message:", err);
  }
}
