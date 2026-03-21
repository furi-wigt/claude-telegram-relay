/**
 * Shared utility for saving bot command interactions to the messages table.
 *
 * Bot command interactions are stored as user/assistant message pairs so they
 * appear in short-term memory context for Claude.
 */

import { insertMessageRecord } from "../local/storageBackend";

/**
 * Save a command interaction as a user/assistant message pair.
 *
 * @param chatId     Telegram chat ID
 * @param userText   The command text sent by the user (e.g. "/status")
 * @param assistantText  The bot's reply text
 */
export async function saveCommandInteraction(
  chatId: number,
  userText: string,
  assistantText: string
): Promise<void> {
  try {
    await insertMessageRecord({
      role: "user",
      content: userText,
      chat_id: chatId,
      metadata: { source: "command" },
    });
    await insertMessageRecord({
      role: "assistant",
      content: assistantText,
      chat_id: chatId,
      metadata: { source: "command" },
    });
  } catch (err) {
    // Non-fatal — command still executed
    console.error("[saveCommandInteraction] error:", err);
  }
}
