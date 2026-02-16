/**
 * Registers the /code command and all subcommands for managing
 * agentic coding sessions from Telegram.
 */

import type { Bot, Context } from "grammy";
import { existsSync } from "node:fs";
import { homedir } from "os";
import { resolve, basename } from "path";
import type { CodingSessionManager } from "./sessionManager.ts";
import type { InputRouter } from "./inputRouter.ts";
import { analyzeTaskForTeam } from "./teamAnalyzer.ts";

/**
 * Register the /code command and callback query handler on the bot.
 */
export function registerCodingCommands(
  bot: Bot,
  sessionManager: CodingSessionManager,
  inputRouter: InputRouter
): void {
  bot.command("code", async (ctx) => {
    const rawMatch = ctx.match?.trim() || "";
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Parse subcommand
    const spaceIdx = rawMatch.indexOf(" ");
    const subcommand = spaceIdx === -1 ? rawMatch : rawMatch.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? "" : rawMatch.slice(spaceIdx + 1).trim();

    switch (subcommand.toLowerCase()) {
      case "list":
        await handleList(ctx, sessionManager, chatId);
        break;
      case "new":
        await handleNew(ctx, sessionManager, chatId, args);
        break;
      case "status":
        await handleStatus(ctx, sessionManager, chatId, args);
        break;
      case "logs":
        await handleLogs(ctx, sessionManager, chatId, args);
        break;
      case "diff":
        await handleDiff(ctx, sessionManager, chatId, args);
        break;
      case "stop":
        await handleStop(ctx, sessionManager, chatId, args);
        break;
      case "perms":
        await handlePerms(ctx, sessionManager);
        break;
      case "permit":
        await handlePermit(ctx, sessionManager, chatId, args);
        break;
      case "revoke":
        await handleRevoke(ctx, sessionManager, args);
        break;
      case "scan":
        await handleScan(ctx, sessionManager, chatId);
        break;
      case "answer":
        await handleAnswer(ctx, sessionManager, chatId, args);
        break;
      case "help":
      case "":
        await handleHelp(ctx);
        break;
      default:
        await handleHelp(ctx);
        break;
    }
  });

  // Register callback query handler for coding-related callbacks
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (
      data.startsWith("code_answer:") ||
      data.startsWith("code_plan:") ||
      data.startsWith("code_dash:") ||
      data.startsWith("code_perm:")
    ) {
      // Handle permission callbacks directly
      if (data.startsWith("code_perm:")) {
        await handlePermCallback(ctx, sessionManager);
        await ctx.answerCallbackQuery();
        return;
      }
      await inputRouter.handleCallbackQuery(ctx, sessionManager);
      await ctx.answerCallbackQuery();
    }
  });
}

// ---------------------------------------------------------------------------
// Permission callback handler
// ---------------------------------------------------------------------------

async function handlePermCallback(
  ctx: Context,
  sessionManager: CodingSessionManager
): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const chatId = ctx.callbackQuery?.message?.chat.id ?? ctx.chat?.id ?? ctx.from?.id;
  if (!chatId) return;

  try {
    // Format: code_perm:{action}:{base64Directory}
    const parts = data.slice("code_perm:".length).split(":");
    if (parts.length < 2) return;

    const action = parts[0]; // once, always, deny
    const dirBase64 = parts.slice(1).join(":");
    const directory = Buffer.from(dirBase64, "base64").toString("utf-8");
    const pm = sessionManager.getPermissionManager();

    if (action === "deny") {
      await ctx.api.sendMessage(chatId, `\u274C Permission denied for: ${directory}`);
      return;
    }

    // Grant permission
    const type = action === "always" ? "prefix" : "exact";
    await pm.grant(directory, type, chatId);

    const label = action === "always" ? "Always allowed (+ subdirs)" : "Allowed once";
    await ctx.api.sendMessage(chatId, `\u2705 ${label}: ${directory}`);

    // Launch any pending_permission sessions for this directory
    const sessions = sessionManager.listForChat(chatId);
    for (const s of sessions) {
      if (s.status === "pending_permission" && s.directory === directory) {
        await sessionManager.launchSession(s);
        // Wait up to 5s for the Claude Code session ID from the NDJSON system init event.
        const claudeSessionId = await sessionManager.waitForClaudeSessionId(s.id);
        const displayId = claudeSessionId
          ? claudeSessionId.slice(0, 8)
          : s.id.slice(0, 8);
        await ctx.api.sendMessage(
          chatId,
          `\u2699\uFE0F Started coding session for ${s.projectName}.\n` +
            `Session ID: ${displayId}\n\nUse /code status to check progress.`
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[handlePermCallback] error:", msg);
    try {
      await ctx.api.sendMessage(chatId, `\u274C Permission callback failed: ${msg}`);
    } catch {
      // send failed
    }
  }
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function handleHelp(ctx: Context): Promise<void> {
  const text = [
    "Agentic Coding Commands:",
    "",
    "/code list              \u2014 List all sessions (bot + desktop)",
    "/code new <path> <task> \u2014 Start coding session [--team for agent team]",
    "/code status [id]       \u2014 Show session details",
    "/code logs [id]         \u2014 Show recent Claude output",
    "/code diff [id]         \u2014 Show git diff for changed files",
    "/code stop [id]         \u2014 Kill a session",
    "/code perms             \u2014 Show permitted directories",
    "/code permit <path>     \u2014 Pre-approve a directory",
    "/code revoke <path>     \u2014 Remove directory permission",
    "/code scan              \u2014 Scan for desktop sessions now",
    "/code answer <text>     \u2014 Answer current waiting session",
    "",
    "[id] defaults to most recent active session",
  ].join("\n");

  await ctx.reply(text);
}

async function handleList(
  ctx: Context,
  sessionManager: CodingSessionManager,
  chatId: number
): Promise<void> {
  const sessions = await sessionManager.listAll(chatId);

  if (sessions.length === 0) {
    await ctx.reply("No coding sessions found.\n\nStart one with:\n/code new <path> <task>");
    return;
  }

  let text = "\u{1F4CB} Coding Sessions\n" + "\u2501".repeat(19) + "\n\n";

  for (const s of sessions) {
    const icon = sessionIcon(s.status);
    const elapsed = formatRelative(s.startedAt, s.completedAt);
    const shortId = s.id.slice(0, 6);
    const source = s.source === "desktop" ? " [desktop]" : "";

    text += `${icon} ${s.projectName}  [${elapsed}]${source}\n`;
    text += `   "${s.task.slice(0, 60)}${s.task.length > 60 ? "..." : ""}"\n`;
    text += `   \u21B3 /code status ${shortId}\n\n`;
  }

  await ctx.reply(text);
}

async function handleNew(
  ctx: Context,
  sessionManager: CodingSessionManager,
  chatId: number,
  args: string
): Promise<void> {
  if (!args) {
    await ctx.reply(
      "Usage: /code new <path> <task> [--team]\n\n" +
      "For paths with spaces, use quotes:\n" +
      '  /code new "/tmp/my project" Add tests\n\n' +
      "Example:\n" +
      "/code new ~/my-project Add OAuth authentication"
    );
    return;
  }

  const { rawPath, task, useAgentTeam } = parsePathAndTask(args);

  if (!task) {
    await ctx.reply(
      "Please provide a task description.\n\n" +
      "For paths with spaces, use quotes:\n" +
      '  /code new "/tmp/my project" Add tests\n\n' +
      "Example:\n" +
      "/code new ~/my-project Add OAuth authentication"
    );
    return;
  }

  // Resolve path (handle ~)
  let directory = rawPath;
  if (directory.startsWith("~")) {
    directory = resolve(homedir(), directory.slice(2)); // slice "~/" or "~"
  }
  if (!directory.startsWith("/")) {
    directory = resolve(homedir(), directory);
  }

  const projectName = basename(directory);

  await ctx.reply(`\u23F3 Starting coding session for ${projectName}...`);

  try {
    const session = await sessionManager.startSession(chatId, ctx, {
      directory,
      task,
      useAgentTeam,
    });

    if (session.status === "pending_permission") {
      // Permission request was sent -- user needs to approve
      return;
    }

    let agentTeamLine = "";
    if (useAgentTeam) {
      const composition = await analyzeTaskForTeam(task);
      const roleNames = composition.roles.map((r) => r.name).join(" + ");
      agentTeamLine = `Agent team: enabled\nTeam: ${roleNames} (${composition.strategy})\n`;
    }

    // Wait up to 5s for the Claude Code session ID from the NDJSON system init event.
    // Falls back to the relay's internal ID if the event does not arrive in time.
    const claudeSessionId = await sessionManager.waitForClaudeSessionId(session.id);
    const displayId = claudeSessionId
      ? claudeSessionId.slice(0, 8)
      : session.id.slice(0, 8);

    await ctx.reply(
      `\u2705 Started coding session for ${projectName}.\n` +
        `Session ID: ${displayId}\n` +
        agentTeamLine +
        `\nUse /code status to check progress.`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`\u274C Failed to start session: ${msg}`);
  }
}

async function handleStatus(
  ctx: Context,
  sessionManager: CodingSessionManager,
  chatId: number,
  args: string
): Promise<void> {
  const sessionId = resolveSessionId(sessionManager, chatId, args);
  if (!sessionId) {
    await ctx.reply("No active session found. Provide a session ID or start a new one.");
    return;
  }

  const text = sessionManager.getStatusText(sessionId);
  await ctx.reply(text);
}

async function handleLogs(
  ctx: Context,
  sessionManager: CodingSessionManager,
  chatId: number,
  args: string
): Promise<void> {
  const sessionId = resolveSessionId(sessionManager, chatId, args);
  if (!sessionId) {
    await ctx.reply("No active session found. Provide a session ID or start a new one.");
    return;
  }

  const logs = await sessionManager.getLogs(sessionId);
  await ctx.reply(logs);
}

async function handleDiff(
  ctx: Context,
  sessionManager: CodingSessionManager,
  chatId: number,
  args: string
): Promise<void> {
  const sessionId = resolveSessionId(sessionManager, chatId, args);
  if (!sessionId) {
    await ctx.reply("No active session found. Provide a session ID or start a new one.");
    return;
  }

  const diff = await sessionManager.getDiff(sessionId);
  await ctx.reply(diff);
}

async function handleStop(
  ctx: Context,
  sessionManager: CodingSessionManager,
  chatId: number,
  args: string
): Promise<void> {
  const sessionId = resolveSessionId(sessionManager, chatId, args);
  if (!sessionId) {
    await ctx.reply("No active session found to stop.");
    return;
  }

  await sessionManager.killSession(sessionId);
  await ctx.reply("\u26D4 Session stopped.");
}

async function handlePerms(
  ctx: Context,
  sessionManager: CodingSessionManager
): Promise<void> {
  const pm = sessionManager.getPermissionManager();
  const permitted = await pm.listPermitted();

  if (permitted.length === 0) {
    await ctx.reply("No directories permitted yet.\n\nUse /code permit <path> to pre-approve a directory.");
    return;
  }

  let text = "\u{1F510} Permitted Directories\n" + "\u2501".repeat(20) + "\n\n";
  for (const entry of permitted) {
    const typeLabel = entry.type === "prefix" ? " (+ subdirs)" : "";
    text += `\u2022 ${entry.path}${typeLabel}\n`;
  }

  await ctx.reply(text);
}

async function handlePermit(
  ctx: Context,
  sessionManager: CodingSessionManager,
  chatId: number,
  args: string
): Promise<void> {
  if (!args) {
    await ctx.reply("Usage: /code permit <path>\n\nExample:\n/code permit ~/Documents/projects");
    return;
  }

  let directory = args.trim();
  if (directory.startsWith("~")) {
    directory = resolve(homedir(), directory.slice(2));
  }
  if (!directory.startsWith("/")) {
    directory = resolve(homedir(), directory);
  }

  const pm = sessionManager.getPermissionManager();
  await pm.grant(directory, "prefix", chatId);
  await ctx.reply(`\u2705 Directory permitted: ${directory}\n(includes all subdirectories)`);
}

async function handleRevoke(
  ctx: Context,
  sessionManager: CodingSessionManager,
  args: string
): Promise<void> {
  if (!args) {
    await ctx.reply("Usage: /code revoke <path>");
    return;
  }

  let directory = args.trim();
  if (directory.startsWith("~")) {
    directory = resolve(homedir(), directory.slice(2));
  }
  if (!directory.startsWith("/")) {
    directory = resolve(homedir(), directory);
  }

  const pm = sessionManager.getPermissionManager();
  const revoked = await pm.revoke(directory);
  if (revoked) {
    await ctx.reply(`\u2705 Permission revoked for: ${directory}`);
  } else {
    await ctx.reply(`\u2754 Directory was not in the permitted list: ${directory}`);
  }
}

async function handleScan(
  ctx: Context,
  sessionManager: CodingSessionManager,
  chatId: number
): Promise<void> {
  await ctx.reply("\u{1F50D} Scanning for desktop sessions...");

  await sessionManager.syncDesktopSessions(chatId);
  const sessions = await sessionManager.listAll(chatId);
  const desktopSessions = sessions.filter((s) => s.source === "desktop");

  if (desktopSessions.length === 0) {
    await ctx.reply("No desktop sessions found.");
  } else {
    let text = `Found ${desktopSessions.length} desktop session(s):\n\n`;
    for (const s of desktopSessions) {
      text += `\u{1F5A5} ${s.projectName}\n`;
      text += `   \u21B3 /code status ${s.id.slice(0, 6)}\n`;
    }
    await ctx.reply(text);
  }
}

async function handleAnswer(
  ctx: Context,
  sessionManager: CodingSessionManager,
  chatId: number,
  args: string
): Promise<void> {
  if (!args) {
    await ctx.reply("Usage: /code answer <text>\n\nAnswers the most recent waiting session.");
    return;
  }

  try {
    await sessionManager.answerCurrentWaiting(chatId, args);
    await ctx.reply("\u2705 Answer sent.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`\u274C ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse path and task from the args string of `/code new`.
 *
 * Mode 1 — Quoted path: user wraps path in single or double quotes.
 *   `/code new "/tmp/my project" Add tests` → path="/tmp/my project", task="Add tests"
 *
 * Mode 2 — Smart path probing: no quotes present.
 *   Walk tokens left-to-right building cumulative path strings.
 *   For each prefix, resolve ~ and relative paths, then check existsSync.
 *   Take the LONGEST existing path prefix as the directory.
 *   If no prefix matches the filesystem, fall back to the first token.
 *
 * The `--team` flag is stripped before path/task parsing and returned separately.
 */
function parsePathAndTask(args: string): { rawPath: string; task: string; useAgentTeam: boolean } {
  const useAgentTeam = /(?:^|\s)--team(?:\s|$)/.test(args);
  const cleaned = args.replace(/\s*--team(?:\s|$)/g, " ").trim();

  // Mode 1: quoted path (single or double quotes)
  const quoteMatch = cleaned.match(/^(['"])(.*?)\1\s*([\s\S]*)/);
  if (quoteMatch) {
    return { rawPath: quoteMatch[2], task: quoteMatch[3].trim(), useAgentTeam };
  }

  // Mode 2: smart path probing — find the longest existing path prefix
  const tokens = cleaned.split(/\s+/);
  let bestLen = 1; // default: first token only

  for (let i = 1; i < tokens.length; i++) {
    const candidate = tokens.slice(0, i + 1).join(" ");
    let resolved = candidate;
    if (resolved.startsWith("~")) {
      resolved = resolve(homedir(), resolved.slice(2));
    } else if (!resolved.startsWith("/")) {
      resolved = resolve(homedir(), resolved);
    }
    if (existsSync(resolved)) {
      bestLen = i + 1;
    }
  }

  const rawPath = tokens.slice(0, bestLen).join(" ");
  const task = tokens.slice(bestLen).join(" ");
  return { rawPath, task, useAgentTeam };
}

/**
 * Resolve a session ID from user input.
 * If args is empty, use the most recent active session.
 * If args is a partial ID, find the matching session.
 */
function resolveSessionId(
  sessionManager: CodingSessionManager,
  chatId: number,
  args: string
): string | null {
  const trimmed = args.trim();

  if (!trimmed) {
    // Default to most recent active session
    const recent = sessionManager.getMostRecentActive(chatId);
    if (recent) return recent.id;

    // Fall back to most recent session of any status
    const all = sessionManager.listForChat(chatId);
    if (all.length > 0) return all[0].id;

    return null;
  }

  // Try exact match first
  const exact = sessionManager.getSession(trimmed);
  if (exact) return exact.id;

  // Try prefix match against all sessions in this chat
  const all = sessionManager.listForChat(chatId);
  const matches = all.filter((s) => s.id.startsWith(trimmed));
  if (matches.length === 1) return matches[0].id;

  // If multiple matches or none, return null
  return matches.length > 0 ? matches[0].id : null;
}

function sessionIcon(status: string): string {
  const icons: Record<string, string> = {
    pending_permission: "\u{1F510}",
    starting: "\u23F3",
    running: "\u2699\uFE0F",
    waiting_for_input: "\u2753",
    waiting_for_plan: "\u{1F4CB}",
    paused: "\u23F8",
    completed: "\u2705",
    failed: "\u274C",
    killed: "\u26D4",
  };
  return icons[status] || "\u2754";
}

function formatRelative(startedAt: string, completedAt?: string): string {
  const endTime = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = endTime - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
