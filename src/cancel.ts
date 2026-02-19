/**
 * claudeStream cancellation — shared state and handlers.
 *
 * Extracted from relay.ts so it can be imported in unit tests without
 * triggering relay.ts side effects (bot.start(), process listeners, etc.).
 *
 * Usage in relay.ts:
 *   import { activeStreams, streamKey, handleCancelCallback, handleCancelCommand }
 *     from "./cancel.ts";
 */

import type { Bot } from "grammy";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ActiveStream {
  controller: AbortController;
  /** message_id of the progress indicator message, used to remove Cancel button */
  progressMessageId?: number;
}

// ── Active stream registry ───────────────────────────────────────────────────

/**
 * Maps `${chatId}:${threadId ?? ""}` → the AbortController for the running stream.
 *
 * Populated in callClaude() before claudeStream starts.
 * Cleaned up in callClaude()'s finally block.
 * Consulted by handleCancelCallback and handleCancelCommand.
 */
export const activeStreams = new Map<string, ActiveStream>();

// ── Key helper ───────────────────────────────────────────────────────────────

/**
 * Returns the map key for a given chat/thread pair.
 * threadId null → empty string suffix (e.g. "42:").
 */
export function streamKey(chatId: number, threadId: number | null): string {
  return `${chatId}:${threadId ?? ""}`;
}

// ── Cancel handlers ──────────────────────────────────────────────────────────

/**
 * Handle a `cancel:` callback_query (user tapped inline Cancel button).
 *
 * Aborts the in-flight claudeStream for chatId/threadId, removes the Cancel
 * button from the progress message, and replies with a cancellation notice.
 *
 * @param chatId - Telegram chat ID
 * @param threadId - Forum topic thread ID, or null for non-forum chats
 * @param ctx - Grammy context (must have `.reply()`)
 * @param bot - Grammy Bot instance (must have `.api.editMessageReplyMarkup()`)
 */
export async function handleCancelCallback(
  chatId: number,
  threadId: number | null,
  ctx: { reply: (text: string, opts?: unknown) => Promise<unknown> },
  bot: { api: { editMessageReplyMarkup: (chatId: number, msgId: number, opts: unknown) => Promise<unknown> } }
): Promise<void> {
  const key = streamKey(chatId, threadId);
  const entry = activeStreams.get(key);

  if (!entry) {
    await ctx.reply("Nothing active to cancel — it may have already finished.").catch(() => {});
    return;
  }

  // Abort the stream subprocess
  entry.controller.abort();

  // Remove the Cancel inline button from the progress indicator message
  if (entry.progressMessageId != null) {
    await bot.api
      .editMessageReplyMarkup(chatId, entry.progressMessageId, {
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => {});
  }

  // Clean up — callClaude()'s finally will also delete this, but deleting here
  // prevents a second concurrent cancel from finding the entry.
  activeStreams.delete(key);

  await ctx.reply("Cancelled. Here is what was generated so far:").catch(() => {});
}

/**
 * Handle a `/cancel` text command.
 *
 * Identical effect to handleCancelCallback.
 */
export async function handleCancelCommand(
  chatId: number,
  threadId: number | null,
  ctx: { reply: (text: string, opts?: unknown) => Promise<unknown> },
  bot: { api: { editMessageReplyMarkup: (chatId: number, msgId: number, opts: unknown) => Promise<unknown> } }
): Promise<void> {
  return handleCancelCallback(chatId, threadId, ctx, bot);
}
