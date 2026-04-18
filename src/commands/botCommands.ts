/**
 * Bot Commands
 *
 * Registers Telegram bot commands for session management and status tracking.
 *
 * Available commands:
 *   /status         - Show current session status
 *   /new            - Force start a new session (clear current)
 *   /renew          - New Claude session, preserve full STM + LTM context
 *   /memory         - Show all memory (goals, prefs, facts, dates)
 *   /memory goals   - Active goals only
 *   /memory done    - Completed goals
 *   /memory prefs   - Preferences
 *   /memory facts   - Facts
 *   /memory dates   - Dates & reminders
 *   /history        - Show recent messages in session
 *   /help           - Show all available commands
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { basename } from "path";
import { execFile, spawn } from "child_process";
import { extractDocTitle } from "../utils/docTitle.ts";
import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getSession, loadSession, getSessionSummary, resetSession, renewSession, saveSession, setTopicCwd, setSessionModel } from "../session/groupSessions.ts";
import { getMemoryFull, type FullMemory } from "../memory.ts";
import { detectConflicts } from "../memory/conflictResolver.ts";
import { savePendingConflicts } from "../memory/pendingConflict.ts";
import { handleRoutinesCommand } from "../routines/routineHandler.ts";
import { registerMemoryCommands } from "./memoryCommands.ts";
import { registerDirectMemoryCommands } from "./directMemoryCommands.ts";
import { saveCommandInteraction } from "../utils/saveMessage.ts";
import { searchDocumentsByTitles, type DocumentSearchResult } from "../rag/documentSearch.ts";
import { invalidateManifestCache } from "./tshoOtCommands.ts";
import { listDocuments, deleteDocument, ingestText, resolveUniqueTitle } from "../documents/documentProcessor.ts";
import { isTROQAActive } from "../tro/troQAState.ts";
import { handleCwdCommand } from "./cwdCommand.ts";
import { resolveSourceLabel } from "../utils/chatNames.ts";
import { smartSplit } from "../utils/smartBoundary";
import { indexCwdDocuments, getIndexStatus } from "../rag/filesystemIndex";

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Send a potentially long message by splitting it into ≤4096-character chunks.
 * Uses QMD-style scored break-point detection for natural reading boundaries.
 */
async function sendLongMessage(ctx: Context, text: string): Promise<void> {
  const chunks = smartSplit(text, TELEGRAM_MAX_MESSAGE_LENGTH);
  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

export interface CommandOptions {
  userId?: number;
  /** Called by /new <prompt> to process the follow-up text as a user message */
  onMessage?: (chatId: number, text: string, ctx: Context) => Promise<void>;
  /** Returns the most recent large paste (>200 chars) for the given chatId, used by /doc save */
  getLastPaste?: (chatId: number) => string | undefined;
  /** Fallback working directory (PROJECT_DIR) shown in /cwd display output */
  projectDir?: string;
  /**
   * Resolves the agent ID for a given chat ID.
   * Used by /cwd to pre-load the session when it is not yet in the in-memory
   * cache (e.g., when /cwd is issued before any regular message in a topic).
   */
  agentResolver?: (chatId: number) => string;
  /**
   * Shared map for /doc delete keyboard flow.
   * Key = `${chatId}:${threadId ?? ""}`, value = ordered list of document titles shown.
   * Populated by the doc command handler; consumed by the doc_del: callback handler.
   */
  pendingDocDeleteChoices?: Map<string, string[]>;
}

// ── Memory formatting helpers ────────────────────────────────────────────────

function sourceTag(item: { chat_id?: number | null; thread_id?: number | null }): string {
  const label = resolveSourceLabel(item.chat_id, item.thread_id);
  return ` [${label}]`;
}

function formatGoalLine(g: FullMemory["goals"][0]): string {
  const deadline = g.deadline
    ? ` · due ${new Date(g.deadline).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" })}`
    : "";
  return `  • ${g.content}${deadline}${sourceTag(g)}`;
}

function formatCompletedLine(g: FullMemory["completedGoals"][0]): string {
  const when = g.completed_at
    ? ` · ${new Date(g.completed_at).toLocaleDateString("en-SG", { day: "numeric", month: "short" })}`
    : "";
  return `  • ${g.content}${when}${sourceTag(g)}`;
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

  const factsSection = formatSection("📌 Facts", mem.facts, (f) => `  • ${f.content}${sourceTag(f)}`);
  if (factsSection) parts.push(factsSection);

  const datesSection = formatSection("📅 Dates & Reminders", mem.dates, (d) => `  • ${d.content}${sourceTag(d)}`);
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
  listFn: () => ReturnType<typeof listDocuments> = listDocuments,
  deleteFn: (title: string) => ReturnType<typeof deleteDocument> = deleteDocument,
  searchFn: (question: string, titles: string[], opts?: { matchThreshold?: number; keywordFallback?: boolean }) => Promise<DocumentSearchResult> = searchDocumentsByTitles,
  lastPaste?: string,
  ingestFn: (text: string, title: string, opts?: any) => ReturnType<typeof ingestText> = ingestText,
  resolveTitleFn: (baseTitle: string) => ReturnType<typeof resolveUniqueTitle> = resolveUniqueTitle,
  readFileFn: (path: string) => string = (p) => readFileSync(p, "utf-8")
): Promise<string> {

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

    const result = await searchFn(question, titles, {
      matchThreshold: 0.40,
      keywordFallback: true,
    });

    if (result.searchError) {
      return `❌ Search failed: ${result.searchError}\n\nThe search service may be temporarily unavailable. Try again shortly.`;
    }

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
      const sectionLabel = chunk.chunk_heading
        ? `${chunk.title} — ${chunk.chunk_heading} (relevance ${pct}%)`
        : `${chunk.title} — ${chunk.source} (relevance ${pct}%)`;
      lines.push(`📄 ${sectionLabel}`);
      lines.push(chunk.content.substring(0, 400) + (chunk.content.length > 400 ? "…" : ""));
      lines.push("");
    }
    lines.push("💡 Ask me anything about these excerpts for a fuller answer.");
    return lines.join("\n");
  }

  if (!subcmd || subcmd === "list") {
    const docs = await listFn();
    if (!docs.length) {
      return "No documents saved yet.";
    }
    const lines = [`Your documents (${docs.length}):\n`];
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const date = doc.latestAt ? doc.latestAt.slice(0, 10) : "unknown";
      lines.push(`${i + 1}. ${doc.title} — ${date}`);
    }
    return lines.join("\n");
  }

  if (subcmd === "delete" || subcmd === "forget") {
    const title = rest.join(" ").trim();
    if (!title) {
      return `Usage: /doc ${subcmd} <document title>\n\nExample: /doc ${subcmd} "My Policy"`;
    }
    const result = await deleteFn(title);
    if (result.deleted === 0) {
      return `No document found matching "${title}".`;
    }
    const deletedTitle = result.matchedTitle ?? title;
    const fuzzyNote = result.matchedTitle ? ` (matched "${result.matchedTitle}")` : "";
    return `🗑️ Deleted "${deletedTitle}"${fuzzyNote} — ${result.deleted} chunk${result.deleted === 1 ? "" : "s"} removed.`;
  }

  if (subcmd === "ingest") {
    const combined = rest.join(" ").trim();
    if (!combined) {
      return (
        "Usage: /doc ingest <filepath> [| title]\n\n" +
        "Examples:\n" +
        "  /doc ingest /path/to/notes.md\n" +
        "  /doc ingest /path/to/notes.md | My Notes"
      );
    }
    const pipeIdx = combined.indexOf(" | ");
    let filePath: string;
    let explicitTitle: string;
    if (pipeIdx === -1) {
      const spaceIdx = combined.indexOf(" ");
      filePath = spaceIdx === -1 ? combined : combined.slice(0, spaceIdx);
      explicitTitle = spaceIdx === -1 ? "" : combined.slice(spaceIdx + 1).trim();
    } else {
      filePath = combined.slice(0, pipeIdx).trim();
      explicitTitle = combined.slice(pipeIdx + 3).trim();
    }

    const resolvedPath = filePath.startsWith("~") ? homedir() + filePath.slice(1) : filePath;
    let content: string;
    try {
      content = readFileFn(resolvedPath);
    } catch {
      return `❌ Cannot read file: ${filePath}\n\nMake sure the path is absolute and the file exists.`;
    }
    if (!content.trim()) {
      return `❌ File is empty: ${filePath}`;
    }
    const title = explicitTitle || basename(filePath).replace(/\.[^.]+$/, "");
    try {
      const result = await ingestFn(content, title);
      if (result.duplicate) {
        return `ℹ️ Already in your knowledge base as "${result.title}". Nothing changed.`;
      }
      if (result.conflict === "title") {
        const versionTitle = await resolveTitleFn(title);
        const versioned = await ingestFn(content, versionTitle);
        return `✅ Saved as "${versionTitle}" — ${versioned.chunksInserted} chunk${versioned.chunksInserted !== 1 ? "s" : ""}.`;
      }
      return `✅ Saved "${title}" from ${filePath} — ${result.chunksInserted} chunk${result.chunksInserted !== 1 ? "s" : ""}.`;
    } catch (err) {
      return `❌ Ingest failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (subcmd === "save") {
    if (!lastPaste) {
      return (
        "No recent paste found.\n\n" +
        "Send a text message (>200 chars) first, then use /doc save [title] to store it."
      );
    }
    const title = rest.join(" ").trim() || extractDocTitle(lastPaste);
    try {
      const result = await ingestFn(lastPaste, title);
      if (result.duplicate) {
        return `ℹ️ Already in your knowledge base as "${result.title}". Nothing changed.`;
      }
      if (result.conflict === "title") {
        const versionTitle = await resolveTitleFn(title);
        const versioned = await ingestFn(lastPaste, versionTitle);
        return `✅ Saved as "${versionTitle}" — ${versioned.chunksInserted} chunk${versioned.chunksInserted !== 1 ? "s" : ""}.`;
      }
      return `✅ Saved as "${title}" — ${result.chunksInserted} chunk${result.chunksInserted !== 1 ? "s" : ""}.`;
    } catch (err) {
      return `❌ Save failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return (
    "Usage:\n" +
    "  /doc list — list all indexed documents\n" +
    "  /doc save [title] — save most recent large paste to knowledge base\n" +
    "  /doc ingest <filepath> [| title] — ingest a local file into knowledge base\n" +
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
  const { onMessage } = options;

  // /help - show available commands (excluded from short-term memory)
  bot.command("help", async (ctx) => {
    if (process.env.E2E_DEBUG) console.log("[e2e:command:help]", JSON.stringify({ message: ctx.message, chat: ctx.chat, from: ctx.from, match: ctx.match }));
    const help = [
      "Available commands:",
      "",
      "/new [prompt] - Start a fresh conversation (optionally with first message)",
      "/renew [prompt] - New Claude session, inject full conversation context (STM + LTM)",
      "/memory - Show all memory (goals, prefs, facts, dates)",
      "/memory goals - Active goals only",
      "/memory done - Completed goals",
      "/memory prefs - Preferences",
      "/memory facts - Facts",
      "/memory dates - Dates & reminders",
      "/memory dedup - Detect and resolve contradictory facts",
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
      "/cwd - Show working directory for this topic",
      "/cwd /path/to/dir - Set working directory (takes effect after /new)",
      "/cwd reset - Clear working directory (reverts to default after /new)",
      "/model sonnet|opus|haiku|local - Set session-scoped model (resets on /new)",
      "/model default - Clear model override, use agent default",
      "/doc list - List all indexed documents",
      "/doc save [title] - Save most recent large paste to knowledge base",
      "/doc query <question> - Search all indexed documents",
      "/doc query <question> | <title> - Search specific document(s)",
      "/doc delete <title> - Remove a document from the index",
      "/doc forget <title> - Remove a document (alias for delete)",
      "/monthly_update - Trigger TRO monthly update pipeline (ad-hoc)",
      "/agents - List all agents with capabilities",
      "/search <query> - Search across all agent groups",
      "/reboot - Restart Jarvis (with confirmation)",
      "/schedule <prompt> - Queue a background Claude session job",
      "/help - Show this help",
      "",
      "Create routines by describing them:",
      '"Create a daily routine at 9am that checks my goals"',
      "",
      "During long sessions, I'll show progress updates automatically.",
    ].join("\n");
    await ctx.reply(help);
  });

  // /status - show current session status
  bot.command("status", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const threadId = ctx.msg?.message_thread_id ?? null;
    const summary = getSessionSummary(chatId, threadId);
    await ctx.reply(`Session Status\n\n${summary}`);
  });

  // /routines - manage user-created scheduled routines
  bot.command("routines", async (ctx) => {
    const args = ctx.match || "";
    await handleRoutinesCommand(ctx, args);
  });

  // /new [prompt] - reset session; if prompt given, immediately process it
  bot.command("new", async (ctx) => {
    if (process.env.E2E_DEBUG) console.log("[e2e:command:new]", JSON.stringify({ message: ctx.message, chat: ctx.chat, from: ctx.from, match: ctx.match }));
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const threadId = ctx.msg?.message_thread_id ?? null;
    const prompt = (ctx.match ?? "").trim();

    // Wrap resetSession in try/catch — a disk write failure or missing session
    // must not silently swallow the handler. The user must always get a reply
    // so subsequent messages are not silently dropped.
    try {
      await resetSession(chatId, threadId);
    } catch (err) {
      console.error("[/new] resetSession failed:", err instanceof Error ? err.message : err);
      // Continue — session may not have existed yet (first use after restart).
      // The next Claude call will start a fresh session without --resume anyway.
    }

    try {
      if (prompt.startsWith("/")) {
        // Prompt is a bot command — re-dispatch through Grammy so command handlers fire normally.
        await ctx.reply("Starting a fresh conversation! Redirecting your command...");
        const cmdName = prompt.slice(1).split(/[\s@]/)[0];
        await bot.handleUpdate({
          update_id: ctx.update.update_id,
          message: {
            ...ctx.message,
            text: prompt,
            entities: [{ type: "bot_command", offset: 0, length: cmdName.length + 1 }],
          },
        });
      } else if (prompt && onMessage) {
        await ctx.reply("Starting a fresh conversation! Processing your message...");
        await onMessage(chatId, prompt, ctx);
      } else {
        await ctx.reply(
          "Starting a fresh conversation! Your previous session has been cleared.\n" +
          "What would you like to talk about?"
        );
      }
    } catch (replyErr) {
      console.error("[/new] ctx.reply failed:", replyErr instanceof Error ? replyErr.message : replyErr);
    }
  });

  // /renew [prompt] - new Claude session, full STM + LTM context injected
  bot.command("renew", async (ctx) => {
    if (process.env.E2E_DEBUG) console.log("[e2e:command:renew]", JSON.stringify({ message: ctx.message, chat: ctx.chat, from: ctx.from, match: ctx.match }));
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const threadId = ctx.msg?.message_thread_id ?? null;
    const prompt = (ctx.match ?? "").trim();

    try {
      await renewSession(chatId, threadId);
    } catch (err) {
      console.error("[/renew] renewSession failed:", err instanceof Error ? err.message : err);
      // Continue — session may not have existed yet. Next Claude call starts fresh.
    }

    try {
      if (prompt.startsWith("/")) {
        // Prompt is a bot command — re-dispatch through Grammy so command handlers fire normally.
        await ctx.reply("Session renewed! Redirecting your command...");
        const cmdName = prompt.slice(1).split(/[\s@]/)[0];
        await bot.handleUpdate({
          update_id: ctx.update.update_id,
          message: {
            ...ctx.message,
            text: prompt,
            entities: [{ type: "bot_command", offset: 0, length: cmdName.length + 1 }],
          },
        });
      } else if (prompt && onMessage) {
        await ctx.reply("Session renewed with full context! Processing your message...");
        await onMessage(chatId, prompt, ctx);
      } else {
        await ctx.reply(
          "Session renewed! Starting a fresh Claude session with your full conversation context.\n" +
          "What would you like to continue with?"
        );
      }
    } catch (replyErr) {
      console.error("[/renew] ctx.reply failed:", replyErr instanceof Error ? replyErr.message : replyErr);
    }
  });

  // /memory [subcommand] — included in short-term memory
  // Subcommands: goals | done | prefs | facts | dates | (none = all)
  bot.command("memory", async (ctx) => {
    if (process.env.E2E_DEBUG) console.log("[e2e:command:memory]", JSON.stringify({ message: ctx.message, chat: ctx.chat, from: ctx.from, match: ctx.match }));
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const arg = (ctx.match ?? "").trim().toLowerCase();
    const userCmd = arg ? `/memory ${arg}` : "/memory";
    const mem = await getMemoryFull(chatId);
    const total = mem.goals.length + mem.facts.length + mem.dates.length + mem.completedGoals.length;

    if (total === 0 && arg !== "done") {
      const noMemText =
        "No memories stored yet.\n\n" +
        "Tell me something to remember, set a goal, or share your preferences. " +
        "I'll tag them automatically.";
      await ctx.reply(noMemText);
      await saveCommandInteraction(chatId, userCmd, noMemText);
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
        replyText = "Preferences type has been retired. Use /remember to store facts instead.";
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

      case "dedup": {
        await ctx.reply("Scanning for contradictory facts... this may take a moment.");
        try {
          const clusters = await detectConflicts();
          if (clusters.length === 0) {
            replyText = "No conflicting facts detected. Your memory looks clean!";
            break;
          }

          // Save clusters for callback handler
          await savePendingConflicts(clusters);

          // Format each cluster as a message with inline keyboard
          const { InlineKeyboard } = await import("grammy");
          for (let i = 0; i < clusters.length; i++) {
            const cluster = clusters[i];
            const lines = [
              `⚠️ Conflict ${i + 1}/${clusters.length}: ${cluster.topic}`,
              "─".repeat(24),
            ];
            for (let j = 0; j < cluster.entries.length; j++) {
              const entry = cluster.entries[j];
              const date = entry.created_at
                ? new Date(entry.created_at).toLocaleDateString("en-SG", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })
                : "unknown";
              lines.push(`  ${j + 1}. ${entry.content} (${date})`);
            }
            lines.push("", `Recommendation: ${cluster.recommendation}`);

            const keyboard = new InlineKeyboard()
              .text("Keep newest", `mcr_keep:${i}`)
              .text("Keep all", `mcr_all:${i}`);

            await ctx.reply(lines.join("\n"), { reply_markup: keyboard });
          }

          // Final skip-all button
          const skipKeyboard = new InlineKeyboard().text(
            "Skip all",
            "mcr_skip"
          );
          await ctx.reply(
            `Found ${clusters.length} potential conflict${clusters.length === 1 ? "" : "s"}. Use the buttons above to resolve, or:`,
            { reply_markup: skipKeyboard }
          );
          await saveCommandInteraction(chatId, "/memory dedup", `${clusters.length} conflicts found`);
          return; // already sent all messages
        } catch (err) {
          console.error("[/memory dedup] error:", err);
          replyText = "Failed to scan for conflicts. Is Ollama running?";
        }
        break;
      }

      default:
        replyText = buildMemoryOverview(mem);
    }

    await sendLongMessage(ctx, replyText);
    await saveCommandInteraction(chatId, userCmd, replyText);
  });

  // /history - show recent messages from session
  bot.command("history", async (ctx) => {
    if (process.env.E2E_DEBUG) console.log("[e2e:command:history]", JSON.stringify({ message: ctx.message, chat: ctx.chat, from: ctx.from, match: ctx.match }));
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
  registerMemoryCommands(bot, { userId: options.userId ?? 0 });

  // Register direct memory mutation commands (/goals, /facts, /prefs, /reminders)
  registerDirectMemoryCommands(bot, {});

  // /doc list|query|delete|forget - manage and search indexed RAG documents
  bot.command("doc", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const args = (ctx.match ?? "").trim();
    const [subcmd, ...rest] = args.split(/\s+/);

    // delete/forget: show inline keyboard so user picks the exact document to delete
    if (subcmd === "delete" || subcmd === "forget") {
      const filter = rest.join(" ").trim().toLowerCase();
      const docs = await listDocuments();
      const matching = filter
        ? docs.filter((d) => d.title.toLowerCase().includes(filter))
        : docs;

      if (!matching.length) {
        await ctx.reply(
          filter ? `No document found matching "${filter}".` : "No documents saved yet."
        );
        return;
      }

      const threadId = ctx.message?.message_thread_id ?? null;
      const mapKey = `${chatId}:${threadId ?? ""}`;
      options.pendingDocDeleteChoices?.set(mapKey, matching.map((d) => d.title));

      const kb = new InlineKeyboard();
      const tid = threadId ?? 0;
      matching.slice(0, 10).forEach((doc, idx) => {
        kb.text(`🗑 ${doc.title}`, `doc_del:${chatId}:${tid}:${idx}`).row();
      });
      kb.text("❌ Cancel", `doc_del:cancel:${chatId}:${tid}`);

      const scope = filter ? ` matching "${filter}"` : ` (${matching.length} total)`;
      await ctx.reply(`Which document to delete?${scope}`, { reply_markup: kb });
      return;
    }

    const lastPaste = options.getLastPaste?.(chatId);
    const result = await handleDocCommand(args, listDocuments, deleteDocument, searchDocumentsByTitles, lastPaste);
    await sendLongMessage(ctx, result);
  });

  // /kb — knowledge base commands (CWD filesystem indexing)
  bot.command("kb", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const args = (ctx.match ?? "").trim();
    const [subcmd, ...rest] = args.split(/\s+/);
    const threadId = ctx.message?.message_thread_id ?? null;

    // Get CWD from session
    const session = getSession(chatId, threadId);
    const cwdPath = session?.activeCwd || session?.cwd || options.projectDir;

    if (!cwdPath) {
      await ctx.reply("No working directory configured. Use /cwd to set one first.");
      return;
    }

    if (!subcmd || subcmd === "help") {
      await ctx.reply(
        "Knowledge Base commands:\n\n" +
        "  /kb index  — Index markdown files from CWD\n" +
        "  /kb status — Show index status\n" +
        "  /kb search <query> — Search indexed files\n\n" +
        `Current CWD: ${cwdPath}`
      );
      return;
    }

    if (subcmd === "index") {
      await ctx.reply(`Indexing markdown files from:\n${cwdPath}\n\nThis may take a moment...`);
      const result = await indexCwdDocuments(cwdPath, async (msg) => {
        // Progress updates are logged, not sent as messages (too noisy)
        console.log(`[kb:index] ${msg}`);
      });
      const lines = [
        `✅ Indexing complete`,
        ``,
        `  Files found: ${result.filesFound}`,
        `  Indexed: ${result.filesIndexed}`,
        `  Skipped (unchanged): ${result.filesSkipped}`,
        ...(result.filesFailed > 0 ? [`  Failed: ${result.filesFailed}`] : []),
      ];
      if (result.indexed.length > 0 && result.indexed.length <= 10) {
        lines.push("", "Indexed files:");
        for (const f of result.indexed) {
          lines.push(`  • ${f.relativePath} (${f.chunks} chunks)`);
        }
      }
      await sendLongMessage(ctx, lines.join("\n"));
      return;
    }

    if (subcmd === "status") {
      const status = getIndexStatus(cwdPath);
      const lines = [
        `Knowledge Base Status`,
        ``,
        `  CWD: ${status.cwdPath}`,
        `  Indexed files: ${status.indexedFiles}`,
        `  Total .md files: ${status.totalFiles}`,
        `  Stale/new files: ${status.staleFiles.length}`,
        ...(status.lastIndexed ? [`  Last indexed: ${status.lastIndexed}`] : []),
      ];
      if (status.staleFiles.length > 0 && status.staleFiles.length <= 10) {
        lines.push("", "Stale files:");
        for (const f of status.staleFiles) {
          lines.push(`  • ${f}`);
        }
        lines.push("", "Run /kb index to update.");
      }
      await ctx.reply(lines.join("\n"));
      return;
    }

    if (subcmd === "search") {
      const query = rest.join(" ").trim();
      if (!query) {
        await ctx.reply("Usage: /kb search <query>");
        return;
      }
      // Use the existing document search with keyword fallback enabled
      const result = await searchDocumentsByTitles(query, [], {
        keywordFallback: true,
        matchCount: 5,
      });
      if (!result.hasResults) {
        await ctx.reply("No results found. Try /kb index first if you haven't indexed yet.");
        return;
      }
      const lines = result.chunks.map((c, i) => {
        const score = (c.similarity * 100).toFixed(0);
        return `${i + 1}. ${c.title} (${score}%)\n   ${c.content.slice(0, 150)}...`;
      });
      await sendLongMessage(ctx, `Search results for "${query}":\n\n${lines.join("\n\n")}`);
      return;
    }

    await ctx.reply(`Unknown subcommand: ${subcmd}. Use /kb help for usage.`);
  });

  // /monthly_update — trigger TRO monthly update pipeline ad-hoc
  bot.command("monthly_update", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Guard: refuse if a pipeline is already in Q&A phase
    if (isTROQAActive(chatId)) {
      await ctx.reply(
        "TRO monthly update is already running — currently waiting for your Q&A answers.\n\n" +
        "Answer the questions sent above, or wait for the 15-minute timeout to pass."
      );
      return;
    }

    await ctx.reply(
      "Starting TRO monthly update pipeline...\n\n" +
      "This will:\n" +
      "1. Pull GitLab activity for the past 30 days\n" +
      "2. Read past monthly update PDFs for context\n" +
      "3. Ask you context questions via this chat\n" +
      "4. Generate slide outline and PPTX draft\n\n" +
      "You'll receive updates as each phase completes."
    );

    // Spawn the routine as a background process with --ad-hoc flag
    const routineScript = new URL("../../routines/tro-monthly-update.ts", import.meta.url).pathname;
    const proc = Bun.spawn(
      ["bun", "run", routineScript, "--ad-hoc"],
      {
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env },
        detached: true,
      }
    );

    // Unref so the relay doesn't wait for it
    proc.unref();

    console.log(`[monthly-update] Spawned tro-monthly-update.ts (pid ${proc.pid})`);
  });

  // /cwd — view or change the working directory for this topic
  bot.command("cwd", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const threadId = ctx.message?.message_thread_id ?? null;

    // Ensure the session is in the in-memory cache before we try to persist cwd.
    // getSession() only checks the cache; if the user issues /cwd before sending
    // any regular message in this topic, the session won't be loaded yet and
    // setTopicCwd() would silently no-op.
    let session = getSession(chatId, threadId);
    if (!session && options.agentResolver) {
      try {
        const agentId = options.agentResolver(chatId);
        session = await loadSession(chatId, agentId, threadId);
        console.log(`[/cwd] pre-loaded session for chatId=${chatId} threadId=${threadId} agentId=${agentId}`);
      } catch (loadErr) {
        console.error("[/cwd] session pre-load error:", loadErr instanceof Error ? loadErr.message : loadErr);
      }
    }

    const result = await handleCwdCommand(ctx, session?.cwd, options.projectDir);

    if (result?.ok) {
      try {
        await setTopicCwd(chatId, threadId, result.newCwd);
        // Invalidate manifest cache so /ts fetches fresh commands for the new cwd
        if (result.newCwd) invalidateManifestCache(result.newCwd);
      } catch (err) {
        console.error("[/cwd] setTopicCwd error:", err instanceof Error ? err.message : err);
      }
    }
  });

  // /model [alias|default] — set or clear session-scoped model override
  bot.command("model", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const threadId = ctx.message?.message_thread_id ?? null;

    const alias = ((ctx.match as string) ?? "").trim().toLowerCase();

    const VALID_ALIASES: Record<string, string> = {
      sonnet: "sonnet",
      opus: "opus",
      haiku: "haiku",
      local: "local",
    };
    const ALIAS_LABELS: Record<string, string> = {
      sonnet: "Sonnet", opus: "Opus", haiku: "Haiku", local: "Local",
    };

    if (!alias || alias === "default") {
      // Ensure session is loaded before mutating
      if (!getSession(chatId, threadId) && options.agentResolver) {
        const agentId = options.agentResolver(chatId);
        await loadSession(chatId, agentId, threadId).catch(() => {});
      }
      await setSessionModel(chatId, threadId, undefined);
      await ctx.reply("Session model cleared. Using agent default.");
      return;
    }

    if (!VALID_ALIASES[alias]) {
      await ctx.reply(
        "Unknown model. Usage:\n" +
        "  /model sonnet   — Claude Sonnet (default)\n" +
        "  /model opus     — Claude Opus\n" +
        "  /model haiku    — Claude Haiku\n" +
        "  /model local    — Local LM Studio\n" +
        "  /model default  — Clear override, use agent default",
      );
      return;
    }

    if (!getSession(chatId, threadId) && options.agentResolver) {
      const agentId = options.agentResolver(chatId);
      await loadSession(chatId, agentId, threadId).catch(() => {});
    }
    await setSessionModel(chatId, threadId, alias);
    await ctx.reply(`Session model set to ${ALIAS_LABELS[alias]}. Resets on /new.`);
  });

  // /agents - list all agents with capabilities
  bot.command("agents", async (ctx) => {
    const { AGENTS } = await import("../agents/config.ts");
    const lines: string[] = ["\u{1F916} Available Agents:\n"];
    for (const agent of Object.values(AGENTS)) {
      const caps = agent.capabilities.slice(0, 5).join(", ");
      const more = agent.capabilities.length > 5 ? ` (+${agent.capabilities.length - 5} more)` : "";
      const status = agent.chatId ? "\u2705" : "\u26AA";
      lines.push(`${status} **${agent.name}** (${agent.id})`);
      lines.push(`   ${caps}${more}\n`);
    }
    await sendLongMessage(ctx, lines.join("\n"));
  });

  // /search <query> - cross-topic semantic search via Qdrant
  bot.command("search", async (ctx) => {
    const query = ((ctx.match as string) ?? "").trim();
    if (!query) {
      await ctx.reply("Usage: /search <query>\n\nSearches across all agent groups and topics.");
      return;
    }

    try {
      const { getDb } = await import("../local/db.ts");
      const db = getDb();
      // Full-text search across messages from all agents
      const results = db.query(
        `SELECT agent_id, thread_name, content, created_at
         FROM messages
         WHERE content LIKE ? AND role = 'assistant'
         ORDER BY created_at DESC
         LIMIT 10`
      ).all(`%${query}%`) as Array<{ agent_id: string | null; thread_name: string | null; content: string; created_at: string }>;

      if (results.length === 0) {
        await ctx.reply(`No results found for "${query}".`);
        return;
      }

      const lines: string[] = [`\u{1F50D} Search results for "${query}":\n`];
      for (const row of results) {
        const source = row.agent_id ?? "unknown";
        const topic = row.thread_name ? ` / ${row.thread_name}` : "";
        const snippet = row.content.length > 150 ? row.content.slice(0, 150) + "..." : row.content;
        const date = row.created_at?.split("T")[0] ?? "";
        lines.push(`\u{1F4CC} [${source}${topic}] ${date}`);
        lines.push(`   ${snippet}\n`);
      }
      await sendLongMessage(ctx, lines.join("\n"));
    } catch (err) {
      console.error("[/search] error:", err);
      await ctx.reply("Search failed. Please try again.");
    }
  });

  // /reboot - restart the telegram-relay PM2 service (requires inline confirmation)
  bot.command("reboot", async (ctx) => {
    const keyboard = new InlineKeyboard()
      .text("✅ Confirm restart", "reboot:confirm")
      .text("❌ Cancel", "reboot:cancel");
    await ctx.reply(
      "⚠️ Restart Jarvis (telegram-relay)?\n\nThis will briefly take the bot offline. Confirm?",
      { reply_markup: keyboard }
    );
  });

  bot.callbackQuery("reboot:confirm", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("🔄 Restarting Jarvis… bot will be briefly offline.", { reply_markup: { inline_keyboard: [] } });
    // Delay restart so the edited message is delivered before the process dies.
    // Use spawn+detach so the child outlives the parent process.
    setTimeout(() => {
      const child = spawn("/opt/homebrew/bin/pm2", ["restart", "telegram-relay"], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (err) => {
        console.error("[/reboot] PM2 restart failed:", err.message);
      });
      child.unref();
    }, 1000);
  });

  bot.callbackQuery("reboot:cancel", async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled.");
    await ctx.editMessageText("❌ Restart cancelled.");
  });
}

/**
 * Register the /reboot confirmation callback handler.
 * @deprecated Callbacks are now registered inside registerCommands. This is a no-op kept for relay.ts compatibility.
 */
export function registerRebootCallbackHandler(_bot: Bot): void {
  // no-op — callbacks registered in registerCommands
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
