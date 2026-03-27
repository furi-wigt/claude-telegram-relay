/**
 * /reflect Command Handler
 *
 * Allows the user to provide explicit feedback about a session.
 * Stores the feedback as a learning with confidence 0.85 (highest non-pinned).
 *
 * Usage:
 *   /reflect Always use TDD for small utilities
 *   /reflect bad → Jarvis asks "What specifically went wrong?"
 */

import type { Bot, Context } from "grammy";
import { CONFIDENCE } from "../memory/learningExtractor";
import { insertMemoryRecord } from "../local/storageBackend";

export interface ReflectLearning {
  type: "learning";
  content: string;
  category: string;
  confidence: number;
  evidence: string;
  importance: number;
  stability: number;
}

/**
 * Build a learning entry from explicit /reflect feedback.
 * Pure function — no side effects.
 */
export function buildReflectLearning(
  content: string,
  chatId: number,
  threadId: number | null,
  agentId: string,
): ReflectLearning {
  return {
    type: "learning",
    content,
    category: "user_preference",
    confidence: CONFIDENCE.EXPLICIT_FEEDBACK,
    evidence: JSON.stringify({
      source_trigger: "explicit_feedback",
      chat_id: String(chatId),
      thread_id: threadId !== null ? String(threadId) : null,
      agent_id: agentId,
    }),
    importance: 0.90,
    stability: 0.80,
  };
}

/**
 * Register the /reflect command on the bot.
 * Called once at startup in relay.ts.
 */
export function registerReflectCommand(
  bot: Bot<Context>,
  agentResolver: (chatId: number) => string,
): void {
  bot.command("reflect", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const threadId = ctx.message?.message_thread_id ?? null;
    const text = ctx.match?.toString().trim();

    if (!text) {
      await ctx.reply(
        "Usage: `/reflect <your feedback>`\n\nExamples:\n" +
          "- `/reflect Always use TDD for utilities`\n" +
          "- `/reflect Don't restart PM2 ecosystem-wide`\n" +
          "- `/reflect I prefer code over prose in explanations`",
        { parse_mode: "Markdown" },
      );
      return;
    }

    const agentId = agentResolver(chatId);
    const learning = buildReflectLearning(text, chatId, threadId, agentId);

    try {
      await insertMemoryRecord({
        type: learning.type,
        content: learning.content,
        chat_id: chatId,
        thread_id: threadId,
        category: learning.category,
        confidence: learning.confidence,
        importance: learning.importance,
        stability: learning.stability,
      });

      await ctx.reply(
        `Noted with confidence ${learning.confidence}. This will appear in the next weekly retro for promotion.`,
      );
    } catch (err) {
      console.error("[reflect] Failed to store learning:", err);
      await ctx.reply("Failed to save reflection. Check logs.");
    }
  });

  console.log("[reflectCommand] Registered /reflect command");
}
