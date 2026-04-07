/**
 * Send messages to specific Telegram groups.
 *
 * Used by proactive routines to deliver scheduled messages
 * to the correct agent group. The bot processes these messages
 * through the group router, so each group's specialized agent
 * handles the response.
 */

import { loadEnv } from "../config/envLoader.ts";
import { smartSplit } from "./smartBoundary";
import { decodeHtmlEntities } from "./htmlFormat.ts";

loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Split a message into chunks that respect Telegram's 4096 character limit.
 * Uses QMD-style scored break-point detection to split at natural boundaries
 * (headings > code fences > paragraphs > lines). Code fences are never split.
 */
export function chunkMessage(message: string, maxLength: number = TELEGRAM_MAX_LENGTH): string[] {
  return smartSplit(message, maxLength);
}

/**
 * Send a single raw chunk to Telegram (no chunking logic here).
 */
async function sendChunk(
  chatId: number,
  text: string,
  options?: { parseMode?: "Markdown" | "HTML"; topicId?: number | null; reply_markup?: unknown }
): Promise<number | undefined> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (options?.parseMode) body.parse_mode = options.parseMode;
  if (options?.topicId) body.message_thread_id = options.topicId;
  if (options?.reply_markup) body.reply_markup = options.reply_markup;

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const errorData = await response.text();
    // If Telegram can't parse the Markdown/HTML, strip tags, decode HTML entities,
    // and retry as plain text so &lt; / &gt; / &amp; don't appear literally.
    if (response.status === 400 && errorData.includes("can't parse entities") && options?.parseMode) {
      console.warn(`[sendChunk] Telegram rejected ${options.parseMode} (400 can't parse entities) — falling back to plain text. Chat: ${chatId}. First 200 chars: ${text.slice(0, 200)}`);
      const plain = decodeHtmlEntities(text.replace(/<[^>]+>/g, ""));
      return sendChunk(chatId, plain, { ...options, parseMode: undefined });
    }
    throw new Error(`Telegram API error (${response.status}): ${errorData}`);
  }

  // Return the message_id so callers can reference it for inline keyboards
  const result = await response.json() as { result?: { message_id?: number } };
  return result?.result?.message_id;
}

/**
 * Send a message to a specific Telegram group chat.
 *
 * The message is sent via the Telegram Bot API. When the bot's relay
 * is running, it will pick up the message in that group and route it
 * to the appropriate agent based on chat_id.
 *
 * Messages exceeding Telegram's 4096 character limit are automatically
 * chunked and sent as sequential messages.
 */
export async function sendToGroup(
  chatId: number,
  message: string,
  options?: { parseMode?: "Markdown" | "HTML"; topicId?: number | null; reply_markup?: unknown }
): Promise<number | undefined> {
  if (!BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN not set");
  }

  if (chatId === 0) {
    throw new Error("Invalid chat_id: 0 — group not configured in .env");
  }

  try {
    const chunks = chunkMessage(message);
    let lastMessageId: number | undefined;

    for (let i = 0; i < chunks.length; i++) {
      // Only attach reply_markup to the last chunk
      const chunkOpts = i === chunks.length - 1 ? options : { ...options, reply_markup: undefined };
      lastMessageId = await sendChunk(chatId, chunks[i], chunkOpts);
    }

    const topicSuffix = options?.topicId ? ` (topic ${options.topicId})` : "";
    const chunkInfo = chunks.length > 1 ? ` [${chunks.length} chunks]` : "";
    console.log(`Sent routine message to chat ${chatId}${chunkInfo}${topicSuffix}`);
    return lastMessageId;
  } catch (error) {
    console.error(`Failed to send to chat ${chatId}:`, error);
    throw error;
  }
}

/**
 * Send a message with a typing indicator first (feels more natural).
 */
export async function sendToGroupWithTyping(
  chatId: number,
  message: string,
  typingDuration: number = 2000
): Promise<void> {
  if (!BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN not set");
  }

  // Send typing action
  await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        action: "typing",
      }),
    }
  );

  // Wait for typing duration
  await new Promise((resolve) => setTimeout(resolve, typingDuration));

  // Send the actual message
  await sendToGroup(chatId, message);
}
