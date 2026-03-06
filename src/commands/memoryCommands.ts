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
import { saveCommandInteraction } from "../utils/saveMessage.ts";
import { checkSemanticDuplicate } from "../utils/semanticDuplicateChecker.ts";
import { findPotentialDuplicates } from "../utils/duplicateDetector.ts";
import { ingestText, resolveUniqueTitle } from "../documents/documentProcessor.ts";
import { chunkMessage } from "../utils/sendToGroup.ts";

export interface MemoryCommandOptions {
  supabase: SupabaseClient | null;
  userId: number;  // Telegram user ID for profile operations
}

// FM-9: Route long content to documents table for searchable KB
const REMEMBER_KB_THRESHOLD = 200; // chars; above this → documents table

// FM-9: Pending KB saves for /remember routing (title conflict resolution)
const pendingRememberSaves = new Map<string, { text: string; title: string }>();

function encodeKBPayload(text: string, title: string): string {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  pendingRememberSaves.set(id, { text, title });
  setTimeout(() => pendingRememberSaves.delete(id), 600_000);
  return id;
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

    // FM-9: Route long content to documents table for searchable KB
    if (fact.length > REMEMBER_KB_THRESHOLD) {
      const title = `Note: ${fact.slice(0, 60).trim()}…`;
      try {
        const result = await ingestText(supabase, fact, title, { source: "telegram-remember" });

        if (result.duplicate) {
          await ctx.reply(`ℹ️ This is already in your knowledge base as "${result.title}". Nothing was changed.`);
          return;
        }

        if (result.conflict === "title") {
          const keyboard = new InlineKeyboard()
            .text("🔄 Replace existing", `remember_replace:${encodeKBPayload(fact, title)}`)
            .text("➕ Save as new version", `remember_new_version:${encodeKBPayload(fact, title)}`)
            .row()
            .text("❌ Cancel", "remember_cancel");

          await ctx.reply(
            `⚠️ A document named "${title}" already exists.\n\nWhat would you like to do?`,
            { reply_markup: keyboard }
          );
          return;
        }

        await ctx.reply(
          `📚 Saved to knowledge base as "${title}" — ${result.chunksInserted} chunk${result.chunksInserted !== 1 ? "s" : ""}.\n\nUse /doc query to search it.\n\n_Tip: /remember is for short facts (≤200 chars). For longer content, paste directly and I'll offer to save it._`
        );
      } catch (err) {
        await ctx.reply(`❌ Save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    const category = detectCategory(fact);
    const type = category === "goal" ? "goal" : "fact";

    try {
      // Fast-path: word-level containment check (catches paraphrases like
      // "I prefer AWS" vs "prefers AWS cloud services for development").
      // Provenance model: search globally for facts/goals; reminders scoped to current chat.
      let existingQuery = supabase
        .from("memory")
        .select("id, content")
        .eq("type", type);
      if (category === "date") {
        existingQuery = (existingQuery as any).or(`chat_id.eq.${chatId},chat_id.is.null`);
      }
      const { data: existingMemories } = await existingQuery;

      console.log(`[remember] dedup: fetched ${existingMemories?.length ?? 0} existing ${type}s for chat ${chatId}`);
      if (existingMemories?.length) {
        console.log(`[remember] dedup: existing items: ${existingMemories.map(m => JSON.stringify(m.content)).join(", ")}`);
      }

      const wordMatches = await findPotentialDuplicates(existingMemories ?? [], fact);
      console.log(`[remember] dedup: wordMatches=${wordMatches.length} for "${fact}"`);
      if (wordMatches.length > 0) {
        const existing = wordMatches[0].content;
        await ctx.reply(`⚠️ Similar memory already exists:\n• ${existing}\n\nNot added to avoid duplicates.`);
        return;
      }

      // Semantic duplicate check (embedding similarity, threshold 0.80)
      const dupCheck = await checkSemanticDuplicate(supabase, fact, type, chatId);
      console.log(`[remember] dedup: semantic isDuplicate=${dupCheck.isDuplicate} similarity=${dupCheck.match?.similarity ?? "n/a"}`);
      if (dupCheck.isDuplicate) {
        const existing = dupCheck.match?.content ?? "(unknown)";
        await ctx.reply(`⚠️ Similar memory already exists:\n• ${existing}\n\nNot added to avoid duplicates.`);
        return;
      }

      const { error } = await supabase.from("memory").insert({
        type,
        content: fact,
        chat_id: chatId,
        category,
        extracted_from_exchange: false,
        confidence: 1.0,
      });

      if (error) throw error;

      const replyText = `✓ Remembered: ${fact}`;
      await ctx.reply(replyText);
      await saveCommandInteraction(supabase, chatId, `/remember ${fact}`, replyText);
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

    // Index-based: purely numeric like "/forget 2"
    if (/^\d+$/.test(topic)) {
      try {
        const idx = parseInt(topic, 10) - 1;
        const { data } = await supabase
          .from("memory")
          .select("id, type, content")
          .eq("chat_id", chatId)
          .not("type", "eq", "completed_goal")
          .order("created_at", { ascending: true })
          .limit(100);

        const items = data ?? [];
        if (idx < 0 || idx >= items.length) {
          await ctx.reply(`No memory item #${topic}. You have ${items.length} item(s). Use /memory to view them.`);
          return;
        }

        const item = items[idx];
        const typeEmoji = item.type === "goal" ? "🎯" : "📌";
        const keyboard = new InlineKeyboard()
          .text("🗑️ Forget this", `forget_item:${item.id}`)
          .text("✅ Keep", `forget_keep:${item.id}`);

        await ctx.reply(
          `${typeEmoji} #${topic}: ${item.content.slice(0, 200)}\n(use /memory to browse all items)`,
          { reply_markup: keyboard }
        );
        return;
      } catch (err) {
        console.error("/forget index error:", err);
        await ctx.reply("Failed to look up memory by index. Please try again.");
        return;
      }
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

      for (const chunk of chunkMessage(lines.join("\n"))) {
        await ctx.reply(chunk);
      }
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
      const editText = "✓ All memories for this chat have been deleted.";
      await ctx.editMessageText(editText);
      await ctx.answerCallbackQuery("Done");
      await saveCommandInteraction(supabase, chatId, "/forget (all)", editText);
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
    const chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id;
    const itemId = ctx.callbackQuery.data.replace("forget_item:", "");
    try {
      await supabase.from("memory").delete().eq("id", itemId);
      await ctx.editMessageText("✓ Forgotten.");
      await ctx.answerCallbackQuery("Forgotten");
      if (chatId) {
        await saveCommandInteraction(supabase, chatId, `/forget item:${itemId}`, "✓ Forgotten.");
      }
    } catch {
      await ctx.answerCallbackQuery("Failed");
    }
  });

  bot.callbackQuery(/^forget_keep:/, async (ctx) => {
    await ctx.editMessageText("✅ Kept.");
    await ctx.answerCallbackQuery("Kept");
  });

  // FM-9: /remember large content conflict resolution callbacks
  bot.callbackQuery(/^remember_replace:/, async (ctx) => {
    if (!supabase) { await ctx.answerCallbackQuery("Not configured"); return; }
    const id = ctx.callbackQuery.data.replace("remember_replace:", "");
    const pending = pendingRememberSaves.get(id);
    if (!pending) { await ctx.editMessageText("Session expired — please resend /remember command."); await ctx.answerCallbackQuery(); return; }
    pendingRememberSaves.delete(id);

    try {
      await supabase.from("documents").delete().eq("title", pending.title);
      const result = await ingestText(supabase, pending.text, pending.title, { source: "telegram-remember" });
      await ctx.editMessageText(`✅ Replaced "${pending.title}" — ${result.chunksInserted} chunks updated.`);
      await ctx.answerCallbackQuery();
    } catch (err) {
      await ctx.editMessageText(`❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
      await ctx.answerCallbackQuery();
    }
  });

  bot.callbackQuery(/^remember_new_version:/, async (ctx) => {
    if (!supabase) { await ctx.answerCallbackQuery("Not configured"); return; }
    const id = ctx.callbackQuery.data.replace("remember_new_version:", "");
    const pending = pendingRememberSaves.get(id);
    if (!pending) { await ctx.editMessageText("Session expired."); await ctx.answerCallbackQuery(); return; }
    pendingRememberSaves.delete(id);

    try {
      const versionTitle = await resolveUniqueTitle(supabase, pending.title);
      const result = await ingestText(supabase, pending.text, versionTitle, { source: "telegram-remember" });
      await ctx.editMessageText(`✅ Saved as "${versionTitle}" — ${result.chunksInserted} chunks.`);
      await ctx.answerCallbackQuery();
    } catch (err) {
      await ctx.editMessageText(`❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
      await ctx.answerCallbackQuery();
    }
  });

  bot.callbackQuery("remember_cancel", async (ctx) => {
    await ctx.editMessageText("❌ Cancelled — no changes made.");
    await ctx.answerCallbackQuery();
  });
}
