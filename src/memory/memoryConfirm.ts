/**
 * Memory Confirmation Module
 *
 * Handles the flow for uncertain memory candidates:
 *   1. After extraction, uncertain items are stored in pending state
 *   2. A Telegram message is sent asking the user to confirm
 *   3. On [Save all] / [Skip all] callback, items are stored or discarded
 *
 * Callback data format: "memconf:save:{chatId}" or "memconf:skip:{chatId}"
 */

import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { storeExtractedMemories, type ExtractedMemories, hasMemoryItems } from "./longTermExtractor.ts";

// ============================================================
// Pending Confirmation State
// ============================================================

/** Pending uncertain items awaiting user confirmation, keyed by chatId. */
const pendingConfirmations = new Map<number, ExtractedMemories>();

export function setPendingConfirmation(chatId: number, memories: ExtractedMemories): void {
  pendingConfirmations.set(chatId, memories);
}

export function hasPendingConfirmation(chatId: number): boolean {
  return pendingConfirmations.has(chatId);
}

export function clearPendingConfirmation(chatId: number): void {
  pendingConfirmations.delete(chatId);
}

export function getPendingConfirmation(chatId: number): ExtractedMemories | undefined {
  return pendingConfirmations.get(chatId);
}

// ============================================================
// Message & Keyboard Builders
// ============================================================

/**
 * Format uncertain memory items into a human-readable confirmation message.
 * Returns empty string if there are no items to confirm.
 */
export function buildMemoryConfirmMessage(memories: ExtractedMemories): string {
  const items: string[] = [];

  for (const fact of memories.facts ?? []) items.push(`• ${fact}`);
  for (const pref of memories.preferences ?? []) items.push(`• ${pref}`);
  for (const goal of memories.goals ?? []) items.push(`• ${goal}`);
  for (const date of memories.dates ?? []) items.push(`• ${date}`);

  if (items.length === 0) return "";

  return (
    `I noticed a few things you might want me to remember:\n\n` +
    `${items.join("\n")}\n\n` +
    `Save these?`
  );
}

/**
 * Build inline keyboard for memory confirmation.
 * Callback data embeds the chatId so we can look up the pending state.
 */
export function buildMemoryConfirmKeyboard(chatId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✓ Save all", `memconf:save:${chatId}`)
    .text("✗ Skip all", `memconf:skip:${chatId}`);
}

// ============================================================
// Callback Handler
// ============================================================

/**
 * Handle a memconf callback query.
 * Returns "saved", "skipped", or "unknown" (non-memconf data or no pending state).
 */
export async function handleMemoryConfirmCallback(
  data: string,
  supabase: SupabaseClient,
  chatId: number
): Promise<"saved" | "skipped" | "unknown"> {
  if (!data.startsWith("memconf:")) return "unknown";

  const parts = data.split(":");
  const action = parts[1]; // "save" or "skip"

  const pending = pendingConfirmations.get(chatId);
  if (!pending) return "unknown";

  clearPendingConfirmation(chatId);

  if (action === "save") {
    await storeExtractedMemories(supabase, chatId, pending);
    return "saved";
  }

  return "skipped";
}

// ============================================================
// Bot Handler Registration
// ============================================================

/**
 * Register the inline keyboard callback handler for memory confirmations.
 * Must be called once at bot startup after the bot is created.
 */
export function registerMemoryConfirmHandler(
  bot: Bot,
  supabase: SupabaseClient | null
): void {
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("memconf:")) return next();

    await ctx.answerCallbackQuery();

    const chatId = ctx.chat?.id;
    if (!chatId || !supabase) {
      await ctx.editMessageText("Memory confirmation unavailable.");
      return;
    }

    const result = await handleMemoryConfirmCallback(data, supabase, chatId);

    if (result === "saved") {
      await ctx.editMessageText("Memories saved.");
    } else if (result === "skipped") {
      await ctx.editMessageText("Skipped — nothing saved.");
    } else {
      // No pending state (e.g. bot restarted); silently dismiss
      await ctx.editMessageText("Session expired.");
    }
  });
}

// ============================================================
// Helper: Send Confirmation Message
// ============================================================

/**
 * Send a confirmation message for uncertain memory items.
 * Stores items in pending state and sends the inline keyboard to the user.
 * Returns false if there are no uncertain items or bot is unavailable.
 */
export async function sendMemoryConfirmation(
  bot: Bot,
  chatId: number,
  uncertain: ExtractedMemories,
  threadId?: number | null
): Promise<boolean> {
  if (!hasMemoryItems(uncertain)) return false;

  const text = buildMemoryConfirmMessage(uncertain);
  if (!text) return false;

  setPendingConfirmation(chatId, uncertain);

  const opts: Parameters<typeof bot.api.sendMessage>[2] = {
    reply_markup: buildMemoryConfirmKeyboard(chatId),
  };
  if (threadId) {
    (opts as Record<string, unknown>).message_thread_id = threadId;
  }

  await bot.api.sendMessage(chatId, text, opts);
  return true;
}
