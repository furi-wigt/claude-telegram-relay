/**
 * Bot Commands
 *
 * Registers Telegram bot commands for session management and status tracking.
 *
 * Available commands:
 *   /status         - Show current session status
 *   /new            - Force start a new session (clear current)
 *   /memory         - Show all memory (goals, prefs, facts, dates)
 *   /memory goals   - Active goals only
 *   /memory done    - Completed goals
 *   /memory prefs   - Preferences
 *   /memory facts   - Facts
 *   /memory dates   - Dates & reminders
 *   /history        - Show recent messages in session
 *   /help           - Show all available commands
 */

import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSession, getSessionSummary, resetSession, saveSession } from "../session/groupSessions.ts";
import { getMemoryFull, type FullMemory } from "../memory.ts";
import { handleRoutinesCommand } from "../routines/routineHandler.ts";
import { registerMemoryCommands } from "./memoryCommands.ts";
import { registerDirectMemoryCommands } from "./directMemoryCommands.ts";
import { saveCommandInteraction } from "../utils/saveMessage.ts";
import { searchDocumentsByTitles, type DocumentSearchResult } from "../rag/documentSearch.ts";
import { listDocuments, deleteDocument } from "../documents/documentProcessor.ts";

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
  userId?: number;
  /** Called by /new <prompt> to process the follow-up text as a user message */
  onMessage?: (chatId: number, text: string, ctx: Context) => Promise<void>;
}

// ── Memory formatting helpers ────────────────────────────────────────────────

function formatGoalLine(g: FullMemory["goals"][0]): string {
  const deadline = g.deadline
    ? ` · due ${new Date(g.deadline).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" })}`
    : "";
  return `  • ${g.content}${deadline}`;
}

function formatCompletedLine(g: FullMemory["completedGoals"][0]): string {
  const when = g.completed_at
    ? ` · ${new Date(g.completed_at).toLocaleDateString("en-SG", { day: "numeric", month: "short" })}`
    : "";
  return `  • ${g.content}${when}`;
}

/** Returns a formatted section string, or empty string if items is empty. */
function formatSection(
  header: string,
  items: { content: string }[],
  lineFormatter: (item: any) => string
): string {
  if (items.length === 0) return "";
  const lines = items.map(lineFormatter).join("\n");
  return `${header}\n${"─".repeat(24)}\n${lines}`;
}

function buildMemoryOverview(mem: FullMemory): string {
  const parts: string[] = [`🧠 Memory\n${"═".repeat(24)}`];

  const goalsSection = formatSection("🎯 Goals", mem.goals, formatGoalLine);
  if (goalsSection) parts.push(goalsSection);

  const prefsSection = formatSection("⚙️ Preferences", mem.preferences, (p) => `  • ${p.content}`);
  if (prefsSection) parts.push(prefsSection);

  const factsSection = formatSection("📌 Facts", mem.facts, (f) => `  • ${f.content}`);
  if (factsSection) parts.push(factsSection);

  const datesSection = formatSection("📅 Dates & Reminders", mem.dates, (d) => `  • ${d.content}`);
  if (datesSection) parts.push(datesSection);

  if (mem.completedGoals.length > 0) {
    parts.push(`✅ Completed: ${mem.completedGoals.length} goal${mem.completedGoals.length === 1 ? "" : "s"} · /memory done`);
  }

  const tips = [
    "/memory goals · /memory prefs · /memory facts · /memory dates · /memory done",
  ];
  parts.push(tips.join("\n"));

  return parts.join("\n\n");
}

/**
 * Pure handler logic for the /doc command.
 * Accepts injectable list/delete functions for testability.
 * Returns the reply string; the caller is responsible for sending it.
 */
export async function handleDocCommand(
  args: string,
  supabase: SupabaseClient | null,
  listFn: (sb: SupabaseClient) => ReturnType<typeof listDocuments> = listDocuments,
  deleteFn: (sb: SupabaseClient, title: string) => ReturnType<typeof deleteDocument> = deleteDocument,
  searchFn: (sb: SupabaseClient, question: string, titles: string[]) => Promise<DocumentSearchResult> = searchDocumentsByTitles
): Promise<string> {
  if (!supabase) {
    return "Document management requires Supabase. Please configure your database first.";
  }

  const [subcmd, ...rest] = args.trim().split(/\s+/);

  if (subcmd === "query") {
    const remaining = rest.join(" ").trim();
    if (!remaining) {
      return (
        "Usage: /doc query <question>\n\n" +
        "Examples:\n" +
        "  /doc query What is my deductible?\n" +
        "  /doc query What is my deductible? | NTUC Income\n" +
        "  /doc query What is my deductible? | NTUC Income | AIA Shield"
      );
    }
    const parts = remaining.split("|").map((s) => s.trim());
    const question = parts[0];
    const titles = parts.slice(1).filter(Boolean);

    const result = await searchFn(supabase, question, titles);

    if (!result.hasResults) {
      const scope = titles.length === 0
        ? "across all documents"
        : `in ${titles.map((t) => `"${t}"`).join(", ")}`;
      return (
        `No relevant content found for "${question}" ${scope}.\n\n` +
        "Make sure your documents are indexed:\n" +
        "  /doc list"
      );
    }

    const scopeLabel = titles.length === 0 ? "all documents" : titles.join(", ");
    const lines: string[] = [
      `🔍 "${question}" — ${scopeLabel}`,
      `Found ${result.chunks.length} relevant excerpt(s):`,
      "",
    ];
    for (const chunk of result.chunks) {
      const pct = (chunk.similarity * 100).toFixed(0);
      lines.push(`📄 ${chunk.title} — ${chunk.source} (relevance ${pct}%)`);
      lines.push(chunk.content.substring(0, 400) + (chunk.content.length > 400 ? "…" : ""));
      lines.push("");
    }
    lines.push("💡 Ask me anything about these excerpts for a fuller answer.");
    return lines.join("\n");
  }

  if (!subcmd || subcmd === "list") {
    const docs = await listFn(supabase);
    if (!docs.length) {
      return (
        "No documents indexed yet.\n\n" +
        "Send any PDF, TXT, or MD file to index it automatically.\n" +
        "Use the file caption as the document title."
      );
    }
    const lines = ["📚 Indexed Documents\n"];
    for (const doc of docs) {
      lines.push(`📄 "${doc.title}"`);
      lines.push(`   Sources : ${doc.sources.join(", ")}`);
      lines.push(`   Chunks  : ${doc.chunks}`);
      lines.push("");
    }
    lines.push(`Total: ${docs.length} document${docs.length === 1 ? "" : "s"}`);
    return lines.join("\n");
  }

  if (subcmd === "delete" || subcmd === "forget") {
    const title = rest.join(" ").trim();
    if (!title) {
      return `Usage: /doc ${subcmd} <document title>\n\nExample: /doc ${subcmd} "My Policy"`;
    }
    const result = await deleteFn(supabase, title);
    if (result.deleted === 0) {
      return `No document found with title "${title}".`;
    }
    return `🗑️ Deleted "${title}" (${result.deleted} chunk${result.deleted === 1 ? "" : "s"} removed).`;
  }

  return (
    "Usage:\n" +
    "  /doc list — list all indexed documents\n" +
    "  /doc query <question> — search all documents\n" +
    "  /doc query <question> | <title> — search specific document(s)\n" +
    "  /doc delete <title> — remove a document\n" +
    "  /doc forget <title> — remove a document (alias for delete)\n\n" +
    "Use | to separate multiple document titles:\n" +
    "  /doc query What is my premium? | NTUC Income | AIA Shield\n\n" +
    "To index a document, send a PDF, TXT, or MD file. The caption becomes the title."
  );
}

/**
 * Register all bot commands.
 * Call once at startup after the bot is created.
 */
export function registerCommands(bot: Bot, options: CommandOptions): void {
  const { supabase, onMessage } = options;

  // /help - show available commands (excluded from short-term memory)
  bot.command("help", async (ctx) => {
    const help = [
      "Available commands:",
      "",
      "/new [prompt] - Start a fresh conversation (optionally with first message)",
      "/memory - Show all memory (goals, prefs, facts, dates)",
      "/memory goals - Active goals only",
      "/memory done - Completed goals",
      "/memory prefs - Preferences",
      "/memory facts - Facts",
      "/memory dates - Dates & reminders",
      "/goals +goal - Add a goal (checks for similar existing goals)",
      "/goals -N or -text - Remove goal by index or fuzzy match",
      "/goals *N or *text - Mark goal as done (toggle)",
      "/goals * - View completed/archived goals",
      "/facts +fact - Add a fact (checks for duplicates)",
      "/facts -N or -text - Remove fact by index or fuzzy match",
      "/prefs +pref - Add a preference (checks for duplicates)",
      "/prefs -N or -text - Remove preference by index or fuzzy match",
      "/reminders +reminder - Add a reminder (checks for duplicates)",
      "/reminders -N or -text - Remove reminder by index or fuzzy match",
      "/remember [fact] - Explicitly store a fact or preference",
      "/forget N - Delete memory by index (chronological order)",
      "/forget [topic] - Delete memories matching topic (or all if no topic)",
      "/summary - Show compressed conversation history",
      "/history - Show recent conversation messages",
      "/routines list - List your scheduled routines",
      "/routines delete <name> - Delete a routine",
      "/code list - List coding sessions",
      "/code new <path> <task> - Start agentic coding session",
      "/code status - Show current coding session",
      "/plan <task> - Plan a coding task with guided Q&A before running Claude",
      "/doc list - List all indexed documents",
      "/doc query <question> - Search all indexed documents",
      "/doc query <question> | <title> - Search specific document(s)",
      "/doc delete <title> - Remove a document from the index",
      "/doc forget <title> - Remove a document (alias for delete)",
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
    await handleRoutinesCommand(ctx, args, supabase);
  });

  // /new [prompt] - reset session; if prompt given, immediately process it
  bot.command("new", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const prompt = (ctx.match ?? "").trim();

    await resetSession(chatId);

    if (prompt && onMessage) {
      await ctx.reply("Starting a fresh conversation! Processing your message...");
      await onMessage(chatId, prompt, ctx);
    } else {
      await ctx.reply(
        "Starting a fresh conversation! Your previous session has been cleared.\n" +
        "What would you like to talk about?"
      );
    }
  });

  // /memory [subcommand] — included in short-term memory
  // Subcommands: goals | done | prefs | facts | dates | (none = all)
  bot.command("memory", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    if (!supabase) {
      await ctx.reply("Memory is not configured (Supabase not set up).");
      return;
    }

    const arg = (ctx.match ?? "").trim().toLowerCase();
    const userCmd = arg ? `/memory ${arg}` : "/memory";
    const mem = await getMemoryFull(supabase, chatId);
    const total = mem.goals.length + mem.preferences.length + mem.facts.length + mem.dates.length + mem.completedGoals.length;

    if (total === 0 && arg !== "done") {
      const noMemText =
        "No memories stored yet.\n\n" +
        "Tell me something to remember, set a goal, or share your preferences. " +
        "I'll tag them automatically.";
      await ctx.reply(noMemText);
      await saveCommandInteraction(supabase, chatId, userCmd, noMemText);
      return;
    }

    let replyText: string;

    switch (arg) {
      case "goals":
        replyText = formatSection("🎯 Goals", mem.goals, formatGoalLine) ||
          "No active goals.\n\nSet one by telling me what you want to achieve, " +
          "or /remember My goal is to...";
        break;

      case "done":
        replyText = formatSection("✅ Completed Goals", mem.completedGoals, formatCompletedLine) ||
          "No completed goals yet.";
        break;

      case "prefs":
      case "preferences":
        replyText = formatSection("⚙️ Preferences", mem.preferences, (p) => `  • ${p.content}`) ||
          "No preferences stored yet.\n\nTell me how you like things done.";
        break;

      case "facts":
        replyText = formatSection("📌 Facts", mem.facts, (f) => `  • ${f.content}`) ||
          "No facts stored yet.";
        break;

      case "dates":
      case "reminders":
        replyText = formatSection("📅 Dates & Reminders", mem.dates, (d) => `  • ${d.content}`) ||
          "No dates or reminders stored yet.";
        break;

      default:
        replyText = buildMemoryOverview(mem);
    }

    await sendLongMessage(ctx, replyText);
    await saveCommandInteraction(supabase, chatId, userCmd, replyText);
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

  // Register memory management commands (/remember, /forget, /summary)
  registerMemoryCommands(bot, { supabase, userId: options.userId ?? 0 });

  // Register direct memory mutation commands (/goals, /facts, /prefs, /reminders)
  registerDirectMemoryCommands(bot, { supabase });

  // /doc list|query|delete|forget - manage and search indexed RAG documents
  bot.command("doc", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const args = (ctx.match ?? "").trim();
    const result = await handleDocCommand(args, supabase);
    await sendLongMessage(ctx, result);
  });
}

/**
 * Generate a context switch confirmation message.
 * Sent when we detect the user may be starting a new topic.
 */
export function buildContextSwitchPrompt(currentTopics: string[]): string {
  const topicStr = currentTopics.length > 0
    ? `Current topic: ${currentTopics.slice(0, 3).join(", ")}`
    : "Current session is active";

  return `I notice this might be a different topic. ${topicStr}.`;
}

/**
 * Build inline keyboard for context switch confirmation.
 * Callback data embeds the chatId so the handler can look up the pending message.
 */
export function buildContextSwitchKeyboard(chatId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🆕 New topic", `ctxswitch:new:${chatId}`)
    .text("▶ Continue", `ctxswitch:continue:${chatId}`);
}

/**
 * Register the inline keyboard callback handler for context switch prompts.
 * On "New": resets the session and processes the stored pending message.
 * On "Continue": leaves pendingContextSwitch=true so processTextMessage's existing
 *   bypass branch clears it and skips the relevance check (avoiding a re-trigger loop).
 */
export function registerContextSwitchCallbackHandler(
  bot: Bot,
  onMessage: (chatId: number, text: string, ctx: Context) => Promise<void>
): void {
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("ctxswitch:")) return next();

    const parts = data.split(":");
    const action = parts[1]; // "new" or "continue"
    const chatId = parseInt(parts[2], 10);

    const session = getSession(chatId);
    const pendingText = session?.pendingMessage ?? "";

    if (action === "new") {
      await resetSession(chatId);
      try { await ctx.editMessageText("Starting fresh! Processing your message..."); } catch {}
      await ctx.answerCallbackQuery();
      if (pendingText) await onMessage(chatId, pendingText, ctx as unknown as Context);
    } else {
      // Leave pendingContextSwitch=true — processTextMessage's bypass branch will clear
      // it and skip the relevance check, preventing a re-trigger loop.
      try { await ctx.editMessageText("Got it, continuing the conversation."); } catch {}
      await ctx.answerCallbackQuery();
      if (pendingText) await onMessage(chatId, pendingText, ctx as unknown as Context);
    }
  });
}
