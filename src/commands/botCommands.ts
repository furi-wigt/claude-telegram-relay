/**
 * Bot Commands
 *
 * Registers Telegram bot commands for session management and status tracking.
 *
 * Available commands:
 *   /status   - Show current session status
 *   /new      - Force start a new session (clear current)
 *   /memory   - Show stored facts and goals
 *   /history  - Show recent messages in session
 *   /help     - Show all available commands
 */

import type { Bot, Context } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSession, getSessionSummary, resetSession } from "../session/groupSessions.ts";
import { getMemoryContext, getMemoryContextRaw } from "../memory.ts";
import { summarizeMemoryItem } from "../ollama.ts";
import { handleRoutinesCommand } from "../routines/routineHandler.ts";

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Send a potentially long message by splitting it into ≤4096-character chunks.
 * Splits on newline boundaries where possible to preserve readability.
 */
async function sendLongMessage(ctx: Context, text: string): Promise<void> {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    await ctx.reply(text);
    return;
  }

  const lines = text.split("\n");
  let chunk = "";

  for (const line of lines) {
    const addition = chunk ? "\n" + line : line;
    if (chunk.length + addition.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
      if (chunk) {
        await ctx.reply(chunk);
        chunk = line;
      } else {
        // Single line exceeds limit — force-split it
        for (let i = 0; i < line.length; i += TELEGRAM_MAX_MESSAGE_LENGTH) {
          await ctx.reply(line.substring(i, i + TELEGRAM_MAX_MESSAGE_LENGTH));
        }
        chunk = "";
      }
    } else {
      chunk = chunk ? chunk + "\n" + line : line;
    }
  }

  if (chunk) {
    await ctx.reply(chunk);
  }
}

export interface CommandOptions {
  supabase: SupabaseClient | null;
}

/**
 * Register all bot commands.
 * Call once at startup after the bot is created.
 */
export function registerCommands(bot: Bot, options: CommandOptions): void {
  const { supabase } = options;

  // /help - show available commands
  bot.command("help", async (ctx) => {
    const help = [
      "Available commands:",
      "",
      "/status - Show current session status",
      "/new - Start a fresh conversation (clears session)",
      "/memory - Show summarized memory (Ollama)",
      "/memory long - Show full memory details",
      "/history - Show recent conversation messages",
      "/routines list - List your scheduled routines",
      "/routines delete <name> - Delete a routine",
      "/code list - List coding sessions",
      "/code new <path> <task> - Start agentic coding session",
      "/code status - Show current coding session",
      "/help - Show this help",
      "",
      "Create routines by describing them:",
      '"Create a daily routine at 9am that checks my goals"',
      "",
      "During long sessions, I'll show progress updates automatically.",
    ].join("\n");
    await ctx.reply(help);
  });

  // /routines - manage user-created scheduled routines
  bot.command("routines", async (ctx) => {
    const args = ctx.match || "";
    await handleRoutinesCommand(ctx, args);
  });

  // /status - show session status
  bot.command("status", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const summary = getSessionSummary(chatId);
    await ctx.reply(`Session Status\n\n${summary}`);
  });

  // /new - reset session (force new conversation)
  bot.command("new", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    await resetSession(chatId);
    await ctx.reply(
      "Starting a fresh conversation! Your previous session has been cleared.\n" +
      "What would you like to talk about?"
    );
  });

  // /memory        — summarized view (Ollama per-item)
  // /memory long   — full view (existing sendLongMessage behavior)
  bot.command("memory", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    if (!supabase) {
      await ctx.reply("Memory is not configured (Supabase not set up).");
      return;
    }

    const arg = (ctx.match ?? "").trim().toLowerCase();

    if (arg === "long") {
      // Full view — same as original behavior
      const memoryContext = await getMemoryContext(supabase, chatId);

      if (!memoryContext) {
        await ctx.reply(
          "No memories stored yet.\n\n" +
          "I'll remember things when you tell me something important, " +
          "or when you set goals. I'll tag them automatically."
        );
        return;
      }

      await sendLongMessage(ctx, `🧠 Memory\n${"═".repeat(24)}\n\n${memoryContext}`);
      return;
    }

    // Summarized view — Ollama per-item, parallel
    const raw = await getMemoryContextRaw(supabase, chatId);

    if (raw.facts.length === 0 && raw.goals.length === 0) {
      await ctx.reply(
        "No memories stored yet.\n\n" +
        "I'll remember things when you tell me something important, " +
        "or when you set goals. I'll tag them automatically."
      );
      return;
    }

    const [summarizedFacts, summarizedGoals] = await Promise.all([
      Promise.all(raw.facts.map((f) => summarizeMemoryItem(f.content))),
      Promise.all(raw.goals.map((g) => summarizeMemoryItem(g.content))),
    ]);

    const parts: string[] = [];

    if (summarizedFacts.length > 0) {
      const lines = summarizedFacts.map((s) => `  • ${s}`).join("\n");
      parts.push(`📌 FACTS\n${"─".repeat(24)}\n${lines}`);
    }

    if (summarizedGoals.length > 0) {
      const lines = raw.goals
        .map((g, i) => {
          const deadline = g.deadline
            ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
            : "";
          return `  • ${summarizedGoals[i]}${deadline}`;
        })
        .join("\n");
      parts.push(`🎯 GOALS\n${"─".repeat(24)}\n${lines}`);
    }

    const body = parts.join("\n\n");
    const footer = "\n\nType /memory long for full details.";
    await sendLongMessage(ctx, `🧠 Memory (summarized)\n${"═".repeat(24)}\n\n${body}${footer}`);
  });

  // /history - show recent messages from session
  bot.command("history", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const session = getSession(chatId);

    if (!session || !session.lastUserMessages?.length) {
      await ctx.reply("No recent messages in current session.");
      return;
    }

    const messages = session.lastUserMessages
      .map((msg, i) => `${i + 1}. ${msg.substring(0, 100)}${msg.length > 100 ? "..." : ""}`)
      .join("\n");

    await ctx.reply(`Recent messages in this session:\n\n${messages}`);
  });
}

/**
 * Build a session progress footer for long responses.
 * Appended to Claude responses when processing took longer than threshold.
 */
export function buildProgressFooter(
  chatId: number,
  processingTimeMs: number,
  thresholdMs = 30000
): string | null {
  if (processingTimeMs < thresholdMs) return null;

  const session = getSession(chatId);
  if (!session) return null;

  const seconds = Math.round(processingTimeMs / 1000);
  const msgCount = session.messageCount || 0;

  return `_(${seconds}s · msg ${msgCount} · /status for session info)_`;
}

/**
 * Generate a context switch confirmation message.
 * Sent when we detect the user may be starting a new topic.
 */
export function buildContextSwitchPrompt(currentTopics: string[]): string {
  const topicStr = currentTopics.length > 0
    ? `Current topic: ${currentTopics.slice(0, 3).join(", ")}`
    : "Current session is active";

  return (
    `I notice this might be a different topic. ${topicStr}.\n\n` +
    `Should I:\n` +
    `• Continue the current conversation (just reply normally)\n` +
    `• Start fresh: /new`
  );
}
