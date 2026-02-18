/**
 * Shared utility for saving bot command interactions to the messages table.
 *
 * Bot command interactions are stored as user/assistant message pairs so they
 * appear in short-term memory context for Claude.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Save a command interaction as a user/assistant message pair.
 *
 * @param supabase   Supabase client (no-op if null)
 * @param chatId     Telegram chat ID
 * @param userText   The command text sent by the user (e.g. "/status")
 * @param assistantText  The bot's reply text
 */
export async function saveCommandInteraction(
  supabase: SupabaseClient | null,
  chatId: number,
  userText: string,
  assistantText: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert([
      {
        role: "user",
        content: userText,
        channel: "telegram",
        chat_id: chatId,
        metadata: { source: "command" },
      },
      {
        role: "assistant",
        content: assistantText,
        channel: "telegram",
        chat_id: chatId,
        metadata: { source: "command" },
      },
    ]);
  } catch (err) {
    // Non-fatal — command still executed
    console.error("[saveCommandInteraction] error:", err);
  }
}
