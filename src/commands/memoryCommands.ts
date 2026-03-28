/**
 * Memory Commands
 *
 * Telegram commands for user-facing memory management:
 *   /remember [fact] — explicitly store a fact
 *   /forget [topic]  — delete matching memories (with confirmation)
 *   /summary         — show conversation summaries
 */

import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { saveCommandInteraction } from "../utils/saveMessage.ts";
import { checkSemanticDuplicate } from "../utils/semanticDuplicateChecker.ts";
import { findPotentialDuplicates } from "../utils/duplicateDetector.ts";
import { getMemoryScores } from "../memory/longTermExtractor.ts";
import { ingestText, resolveUniqueTitle } from "../documents/documentProcessor.ts";
import { chunkMessage } from "../utils/sendToGroup.ts";
import {
  insertMemoryRecord,
  deleteMemoryRecord,
  deleteAllMemoriesForChat,
  getExistingMemories,
  getMemoryByIndex,
  searchMemoryBySubstring,
  semanticSearchMemory,
} from "../local/storageBackend";

export interface MemoryCommandOptions {
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

import { detectMemoryCategory } from "../memory";

/** Detect category from fact text — delegates to shared classifier */
const detectCategory = detectMemoryCategory;

/**
 * Register memory management commands on the bot.
 */
export function registerMemoryCommands(
  bot: Bot,
  options: MemoryCommandOptions
): void {
  const { userId } = options;

  // /remember [fact] — explicitly store a fact
  bot.command("remember", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.reply("Memory is not configured.");
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
        const result = await ingestText(fact, title, { source: "telegram-remember" });

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
      // Fast-path: word-level containment check
      const existingMemories = await getExistingMemories(type, {
        chatId,
        category: category === "date" ? "date" : undefined,
      });

      console.log(`[remember] dedup: fetched ${existingMemories.length} existing ${type}s for chat ${chatId}`);

      const wordMatches = await findPotentialDuplicates(existingMemories, fact);
      console.log(`[remember] dedup: wordMatches=${wordMatches.length} for "${fact}"`);
      if (wordMatches.length > 0) {
        const existing = wordMatches[0].content;
        await ctx.reply(`⚠️ Similar memory already exists:\n• ${existing}\n\nNot added to avoid duplicates.`);
        return;
      }

      // Semantic duplicate check (embedding similarity, threshold 0.80)
      const dupCheck = await checkSemanticDuplicate(fact, type, chatId);
      console.log(`[remember] dedup: semantic isDuplicate=${dupCheck.isDuplicate} similarity=${dupCheck.match?.similarity ?? "n/a"}`);
      if (dupCheck.isDuplicate) {
        const existing = dupCheck.match?.content ?? "(unknown)";
        await ctx.reply(`⚠️ Similar memory already exists:\n• ${existing}\n\nNot added to avoid duplicates.`);
        return;
      }

      const threadId = ctx.message?.message_thread_id ?? null;
      const scores = getMemoryScores(type, category);
      const { error } = await insertMemoryRecord({
        type,
        content: fact,
        chat_id: chatId,
        thread_id: threadId,
        category,
        extracted_from_exchange: false,
        confidence: 1.0,
        ...scores,
      });

      if (error) throw error;

      const replyText = `✓ Remembered: ${fact}`;
      await ctx.reply(replyText);
      await saveCommandInteraction(chatId, `/remember ${fact}`, replyText);
    } catch (err) {
      console.error("/remember error:", err);
      await ctx.reply("Failed to save memory. Please try again.");
    }
  });

  // /forget [topic] — delete memories matching topic
  bot.command("forget", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.reply("Memory is not configured.");
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
        const item = await getMemoryByIndex(idx, chatId);

        if (!item) {
          await ctx.reply(`No memory item #${topic}. Use /memory to view items.`);
          return;
        }

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

    // Topic given: search for matching memories globally
    try {
      let matches: Array<{ id: string; type: string; content: string }> = [];

      // 1. Fast path: substring match
      matches = await searchMemoryBySubstring(topic, 5, chatId);

      // 2. Semantic fallback when substring match finds nothing
      let usedSemanticFallback = false;
      if (matches.length === 0) {
        const semResults = await semanticSearchMemory(topic, {
          matchCount: 5,
          threshold: 0.75,
          chatId: chatId.toString(),
        });
        if (semResults.length > 0) {
          matches = semResults.map((r) => ({
            id: r.id,
            type: r.type ?? "fact",
            content: r.content,
          }));
          usedSemanticFallback = true;
        }
      }

      if (matches.length === 0) {
        await ctx.reply(`No memories found matching "${topic}".`);
        return;
      }

      // Transparency: tell user these are approximate matches
      if (usedSemanticFallback) {
        await ctx.reply(`No exact matches for "${topic}". Showing similar memories:`);
      }

      // Show matches with inline [Forget this] / [Keep] buttons
      for (const item of matches) {
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
    if (!chatId) {
      await ctx.reply("Memory is not configured.");
      return;
    }

    try {
      const { getConversationSummariesLocal, getMessageCountLocal } = await import("../local/storageBackend");
      const summaries = getConversationSummariesLocal(chatId);
      const totalCount = await getMessageCountLocal(chatId);

      const summarizedCount = summaries.reduce((sum: number, s: any) => sum + (s.message_count ?? 0), 0);
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
    if (!chatId) {
      await ctx.answerCallbackQuery("Not configured");
      return;
    }
    try {
      await deleteAllMemoriesForChat(chatId);
      const editText = "✓ All memories for this chat have been deleted.";
      await ctx.editMessageText(editText);
      await ctx.answerCallbackQuery("Done");
      await saveCommandInteraction(chatId, "/forget (all)", editText);
    } catch {
      await ctx.answerCallbackQuery("Failed");
    }
  });

  bot.callbackQuery(/^forget_cancel:/, async (ctx) => {
    await ctx.editMessageText("Cancelled. Your memories are safe.");
    await ctx.answerCallbackQuery("Cancelled");
  });

  bot.callbackQuery(/^forget_item:/, async (ctx) => {
    const chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id;
    const itemId = ctx.callbackQuery.data.replace("forget_item:", "");
    try {
      await deleteMemoryRecord(itemId);
      await ctx.editMessageText("✓ Forgotten.");
      await ctx.answerCallbackQuery("Forgotten");
      if (chatId) {
        await saveCommandInteraction(chatId, `/forget item:${itemId}`, "✓ Forgotten.");
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
    // Local storage always available
    const id = ctx.callbackQuery.data.replace("remember_replace:", "");
    const pending = pendingRememberSaves.get(id);
    if (!pending) { await ctx.editMessageText("Session expired — please resend /remember command."); await ctx.answerCallbackQuery(); return; }
    pendingRememberSaves.delete(id);

    try {
      const { deleteDocumentRecords } = await import("../local/storageBackend");
      await deleteDocumentRecords(pending.title);
      const result = await ingestText(pending.text, pending.title, { source: "telegram-remember" });
      await ctx.editMessageText(`✅ Replaced "${pending.title}" — ${result.chunksInserted} chunks updated.`);
      await ctx.answerCallbackQuery();
    } catch (err) {
      await ctx.editMessageText(`❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
      await ctx.answerCallbackQuery();
    }
  });

  bot.callbackQuery(/^remember_new_version:/, async (ctx) => {
    // Local storage always available
    const id = ctx.callbackQuery.data.replace("remember_new_version:", "");
    const pending = pendingRememberSaves.get(id);
    if (!pending) { await ctx.editMessageText("Session expired."); await ctx.answerCallbackQuery(); return; }
    pendingRememberSaves.delete(id);

    try {
      const versionTitle = await resolveUniqueTitle(pending.title);
      const result = await ingestText(pending.text, versionTitle, { source: "telegram-remember" });
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
