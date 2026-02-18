/**
 * Memory Commands
 *
 * Telegram commands for user-facing memory management:
 *   /remember [fact] — explicitly store a fact
 *   /forget [topic]  — delete matching memories (with confirmation)
 *   /summary         — show conversation summaries
 */

import type { Bot, Context } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InlineKeyboard } from "grammy";

export interface MemoryCommandOptions {
  supabase: SupabaseClient | null;
  userId: number;  // Telegram user ID for profile operations
}

const TELEGRAM_MAX_LENGTH = 4096;

async function sendLong(ctx: Context, text: string): Promise<void> {
  if (text.length <= TELEGRAM_MAX_LENGTH) {
    await ctx.reply(text);
    return;
  }
  const lines = text.split("\n");
  let chunk = "";
  for (const line of lines) {
    const addition = chunk ? "\n" + line : line;
    if (chunk.length + addition.length > TELEGRAM_MAX_LENGTH) {
      if (chunk) { await ctx.reply(chunk); chunk = line; }
      else {
        for (let i = 0; i < line.length; i += TELEGRAM_MAX_LENGTH) {
          await ctx.reply(line.substring(i, i + TELEGRAM_MAX_LENGTH));
        }
        chunk = "";
      }
    } else { chunk = chunk ? chunk + "\n" + line : line; }
  }
  if (chunk) await ctx.reply(chunk);
}

/** Detect category from fact text */
function detectCategory(fact: string): string {
  const lower = fact.toLowerCase();
  if (/\b(prefer|like|hate|always|never|style|format|concise|brief|formal|casual)\b/.test(lower)) {
    return "preference";
  }
  if (/\b(goal|want to|need to|plan to|by |deadline|launch|complete|finish)\b/.test(lower)) {
    return "goal";
  }
  if (/\b(on |jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|\d{1,2}\/\d{1,2}|\d{4})\b/.test(lower)) {
    return "date";
  }
  return "personal";
}

/**
 * Register memory management commands on the bot.
 */
export function registerMemoryCommands(
  bot: Bot,
  options: MemoryCommandOptions
): void {
  const { supabase, userId } = options;

  // /remember [fact] — explicitly store a fact
  bot.command("remember", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !supabase) {
      await ctx.reply("Memory is not configured (Supabase not set up).");
      return;
    }

    const fact = (ctx.match ?? "").trim();
    if (!fact) {
      await ctx.reply(
        "Usage: /remember [fact]\n\nExample: /remember My AWS account is 123456789012"
      );
      return;
    }

    const category = detectCategory(fact);
    const type = category === "goal" ? "goal" : "fact";

    try {
      const { error } = await supabase.from("memory").insert({
        type,
        content: fact,
        chat_id: chatId,
        category,
        extracted_from_exchange: false,
        confidence: 1.0,
      });

      if (error) throw error;

      await ctx.reply(`✓ Remembered: ${fact}`);
    } catch (err) {
      console.error("/remember error:", err);
      await ctx.reply("Failed to save memory. Please try again.");
    }
  });

  // /forget [topic] — delete memories matching topic
  bot.command("forget", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !supabase) {
      await ctx.reply("Memory is not configured (Supabase not set up).");
      return;
    }

    const topic = (ctx.match ?? "").trim();

    if (!topic) {
      // No topic: confirm before wiping all
      const keyboard = new InlineKeyboard()
        .text("🗑️ Yes, forget everything", `forget_all:${chatId}`)
        .row()
        .text("❌ Cancel", `forget_cancel:${chatId}`);

      await ctx.reply(
        "⚠️ This will delete ALL memories for this chat.\n\nAre you sure?",
        { reply_markup: keyboard }
      );
      return;
    }

    // Topic given: search for matching memories
    try {
      const { data, error } = await supabase
        .from("memory")
        .select("id, type, content")
        .eq("chat_id", chatId)
        .ilike("content", `%${topic}%`)
        .limit(5);

      if (error) throw error;

      if (!data || data.length === 0) {
        await ctx.reply(`No memories found matching "${topic}".`);
        return;
      }

      // Show matches with inline [Forget this] / [Keep] buttons
      for (const item of data) {
        const keyboard = new InlineKeyboard()
          .text("🗑️ Forget this", `forget_item:${item.id}`)
          .text("✅ Keep", `forget_keep:${item.id}`);

        const typeEmoji = item.type === "goal" ? "🎯" : "📌";
        await ctx.reply(
          `${typeEmoji} ${item.content.slice(0, 200)}`,
          { reply_markup: keyboard }
        );
      }
    } catch (err) {
      console.error("/forget error:", err);
      await ctx.reply("Failed to search memories. Please try again.");
    }
  });

  // /summary — show conversation summaries
  bot.command("summary", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !supabase) {
      await ctx.reply("Memory is not configured (Supabase not set up).");
      return;
    }

    try {
      const [summariesResult, messageCountResult] = await Promise.all([
        supabase
          .from("conversation_summaries")
          .select("summary, message_count, from_timestamp, to_timestamp, created_at")
          .eq("chat_id", chatId)
          .order("created_at", { ascending: true }),
        supabase
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("chat_id", chatId),
      ]);

      const summaries = summariesResult.data ?? [];
      const totalCount = messageCountResult.count ?? 0;
      const summarizedCount = summaries.reduce((sum, s: any) => sum + (s.message_count ?? 0), 0);
      const currentSessionCount = Math.max(0, totalCount - summarizedCount);

      if (summaries.length === 0 && currentSessionCount === 0) {
        await ctx.reply("No conversation history yet.");
        return;
      }

      const lines = ["📜 CONVERSATION SUMMARY\n" + "═".repeat(24)];

      for (const s of summaries as any[]) {
        const from = s.from_timestamp
          ? new Date(s.from_timestamp).toLocaleDateString("en-SG", { month: "short", day: "numeric" })
          : "?";
        const to = s.to_timestamp
          ? new Date(s.to_timestamp).toLocaleDateString("en-SG", { month: "short", day: "numeric" })
          : "?";
        const range = from === to ? from : `${from}–${to}`;
        lines.push(`\n📅 ${range} (${s.message_count} messages):\n  ${s.summary}`);
      }

      if (currentSessionCount > 0) {
        lines.push(`\n💬 Current session (${currentSessionCount} messages, ongoing)`);
      }

      await sendLong(ctx, lines.join("\n"));
    } catch (err) {
      console.error("/summary error:", err);
      await ctx.reply("Failed to load conversation summary. Please try again.");
    }
  });

  // Callback handlers for forget inline keyboard
  bot.callbackQuery(/^forget_all:/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId || !supabase) {
      await ctx.answerCallbackQuery("Not configured");
      return;
    }
    try {
      await supabase.from("memory").delete().eq("chat_id", chatId);
      await ctx.editMessageText("✓ All memories for this chat have been deleted.");
      await ctx.answerCallbackQuery("Done");
    } catch {
      await ctx.answerCallbackQuery("Failed");
    }
  });

  bot.callbackQuery(/^forget_cancel:/, async (ctx) => {
    await ctx.editMessageText("Cancelled. Your memories are safe.");
    await ctx.answerCallbackQuery("Cancelled");
  });

  bot.callbackQuery(/^forget_item:/, async (ctx) => {
    if (!supabase) { await ctx.answerCallbackQuery("Not configured"); return; }
    const itemId = ctx.callbackQuery.data.replace("forget_item:", "");
    try {
      await supabase.from("memory").delete().eq("id", itemId);
      await ctx.editMessageText("✓ Forgotten.");
      await ctx.answerCallbackQuery("Forgotten");
    } catch {
      await ctx.answerCallbackQuery("Failed");
    }
  });

  bot.callbackQuery(/^forget_keep:/, async (ctx) => {
    await ctx.editMessageText("✅ Kept.");
    await ctx.answerCallbackQuery("Kept");
  });
}
