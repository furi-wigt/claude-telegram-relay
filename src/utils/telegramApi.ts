// src/utils/telegramApi.ts
// Raw Telegram Bot API helpers for operations not covered by sendToGroup.
// Uses the same BOT_TOKEN environment variable.

import { loadEnv } from "../config/envLoader.ts";

loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

/**
 * Create a forum topic in a supergroup.
 * Returns the message_thread_id of the created topic.
 */
export async function createForumTopic(chatId: number, name: string): Promise<number> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, name }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`createForumTopic failed (${res.status}): ${err}`);
  }
  const json = await res.json() as { result?: { message_thread_id?: number } };
  const topicId = json.result?.message_thread_id;
  if (!topicId) throw new Error("createForumTopic: no message_thread_id in response");
  return topicId;
}

/**
 * Edit an existing message's text. Swallows errors (non-fatal — job card
 * updates are best-effort).
 */
export async function editMessage(chatId: number, messageId: number, text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn(`[telegramApi] editMessage (${chatId}/${messageId}) failed: ${err.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[telegramApi] editMessage error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
