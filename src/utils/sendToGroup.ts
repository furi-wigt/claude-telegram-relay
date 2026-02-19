/**
 * Send messages to specific Telegram groups.
 *
 * Used by proactive routines to deliver scheduled messages
 * to the correct agent group. The bot processes these messages
 * through the group router, so each group's specialized agent
 * handles the response.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";

const PROJECT_ROOT = join(dirname(dirname(dirname(import.meta.path))));

// Load .env for standalone script usage (routines run as separate processes)
function loadEnv(): void {
  try {
    const envPath = join(PROJECT_ROOT, ".env");
    const envFile = readFileSync(envPath, "utf-8");
    for (const line of envFile.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        const value = valueParts.join("=").trim();
        if (!process.env[key.trim()]) {
          process.env[key.trim()] = value;
        }
      }
    }
  } catch {
    // .env might not exist — continue
  }
}

loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

/**
 * Send a message to a specific Telegram group chat.
 *
 * The message is sent via the Telegram Bot API. When the bot's relay
 * is running, it will pick up the message in that group and route it
 * to the appropriate agent based on chat_id.
 */
export async function sendToGroup(
  chatId: number,
  message: string,
  options?: { parseMode?: "Markdown" | "HTML"; topicId?: number | null }
): Promise<void> {
  if (!BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN not set");
  }

  if (chatId === 0) {
    throw new Error("Invalid chat_id: 0 — group not configured in .env");
  }

  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: message,
    };

    if (options?.parseMode) {
      body.parse_mode = options.parseMode;
    }

    if (options?.topicId) {
      body.message_thread_id = options.topicId;
    }

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
      throw new Error(`Telegram API error (${response.status}): ${errorData}`);
    }

    const topicSuffix = options?.topicId ? ` (topic ${options.topicId})` : "";
    console.log(`Sent routine message to chat ${chatId}${topicSuffix}`);
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
