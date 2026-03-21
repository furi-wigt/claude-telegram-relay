/**
 * tshoot Commands
 *
 * Telegram command handlers for System Troubleshooter integration.
 * All commands execute `tshoot` with the topic's active cwd injected.
 *
 * Registered commands:
 *   /ts <cmd> <subcmd> [args]  — generic tshoot proxy (manifest-routed, Phase 7)
 *   /scan             — run AWS + GitLab health scans in parallel
 *   /ts-new [slug]    — start a new tshoot session
 *   /ts-sessions      — list sessions for current project
 *   /ts-resume [slug] — resume latest or named session
 *   /ts-status        — show current project + active session
 *
 * Inline capture prefixes (handled in relay.ts message handler):
 *   !finding <text>             → tshoot capture finding "<text>"
 *   !discovery <slug> <text>    → tshoot capture discovery <slug> "<text>"
 *
 * Requires:
 *   - topic cwd set via /cwd to a valid tshoot project dir (contains project.conf)
 *   - tshoot installed and in PATH
 */

import { InputFile } from "grammy";
import type { Bot, Context } from "grammy";
import { getSession, loadSession } from "../session/groupSessions.ts";

const TELEGRAM_MAX_LENGTH = 4096;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TshoOtCommandOptions {
  /** Resolves agent ID for a given chat ID (for pre-loading sessions) */
  agentResolver?: (chatId: number) => string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ManifestEntry {
  cmd: string;
  args: string;
  output: "text" | "file";
  /** Relative path to artifact file (only present when output === "file") */
  artifact?: string;
}

interface CommandManifest {
  version: string;
  commands: ManifestEntry[];
}

// ─── Manifest cache ────────────────────────────────────────────────────────────

/** Per-cwd manifest cache. Key = absolute cwd path. */
const manifestCache = new Map<string, CommandManifest>();

/**
 * Fetch and cache the tshoot command manifest for a given cwd.
 * Returns null if `tshoot commands --json` fails or output is not valid JSON.
 */
async function fetchManifest(cwd: string): Promise<CommandManifest | null> {
  const cached = manifestCache.get(cwd);
  if (cached) return cached;

  const result = await runTshoot(["commands", "--json"], cwd);
  if (result.exitCode !== 0) return null;

  try {
    const manifest = JSON.parse(result.stdout) as CommandManifest;
    manifestCache.set(cwd, manifest);
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Invalidate the cached manifest for a cwd (call when /cwd changes).
 * No-op if the cwd was not cached.
 */
export function invalidateManifestCache(cwd: string): void {
  manifestCache.delete(cwd);
}

/**
 * Build a human-readable help string from a manifest.
 */
function formatManifestHelp(manifest: CommandManifest): string {
  const lines = ["Available /ts commands:"];
  for (const entry of manifest.commands) {
    const argPart = entry.args ? ` ${entry.args}` : "";
    lines.push(`  /ts ${entry.cmd}${argPart}`);
  }
  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a tshoot command with cwd injected.
 * Uses Bun's spawn (project standard, no child_process).
 */
async function runTshoot(args: string[], cwd: string): Promise<ExecResult> {
  const proc = Bun.spawn(["tshoot", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdoutBuf, stderrBuf] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  return {
    stdout: stdoutBuf.trim(),
    stderr: stderrBuf.trim(),
    exitCode,
  };
}

/**
 * Truncate to Telegram message limit with a notice.
 */
function truncate(text: string): string {
  if (text.length <= TELEGRAM_MAX_LENGTH) return text;
  const suffix = "\n\n…(truncated)";
  return text.slice(0, TELEGRAM_MAX_LENGTH - suffix.length) + suffix;
}

/**
 * Strip ANSI escape codes from tshoot terminal output.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[mGKHF]/g, "");
}

/**
 * Resolve the effective cwd for a topic.
 * Uses activeCwd (locked for current session) then falls back to cwd.
 * Returns undefined if neither is set.
 */
function resolveTopicCwd(
  chatId: number,
  threadId: number | null
): string | undefined {
  const session = getSession(chatId, threadId);
  return session?.activeCwd ?? session?.cwd ?? undefined;
}

/**
 * Pre-load session if needed (so getSession() returns a result).
 */
async function ensureSession(
  chatId: number,
  threadId: number | null,
  agentResolver?: (chatId: number) => string
): Promise<void> {
  if (getSession(chatId, threadId)) return;
  if (!agentResolver) return;
  try {
    const agentId = agentResolver(chatId);
    await loadSession(chatId, agentId, threadId);
  } catch {
    // best-effort; resolveTopicCwd will return undefined if session missing
  }
}

/**
 * Reply with the error if tshoot exits non-zero, return true if error occurred.
 */
async function replyOnError(
  ctx: Context,
  result: ExecResult,
  cmd: string
): Promise<boolean> {
  if (result.exitCode === 0) return false;
  const detail = stripAnsi(result.stderr || result.stdout || "(no output)");
  await ctx.reply(`tshoot ${cmd} failed:\n${truncate(detail)}`);
  return true;
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerTshoOtCommands(
  bot: Bot,
  options: TshoOtCommandOptions = {}
): void {
  const { agentResolver } = options;

  // ── Guard helper ────────────────────────────────────────────────────────────
  async function getCwdOrReply(
    ctx: Context,
    chatId: number,
    threadId: number | null
  ): Promise<string | null> {
    await ensureSession(chatId, threadId, agentResolver);
    const cwd = resolveTopicCwd(chatId, threadId);
    if (!cwd) {
      await ctx.reply(
        "No project context set.\nUse /cwd /path/to/projects/<name> first."
      );
      return null;
    }
    return cwd;
  }

  // ── /scan ───────────────────────────────────────────────────────────────────
  bot.command("scan", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const threadId = ctx.message?.message_thread_id ?? null;

    const cwd = await getCwdOrReply(ctx, chatId, threadId);
    if (!cwd) return;

    await ctx.reply("Running AWS + GitLab scans…");

    const [aws, gitlab] = await Promise.all([
      runTshoot(["scan", "aws"], cwd),
      runTshoot(["scan", "gitlab"], cwd),
    ]);

    const awsOut = stripAnsi(aws.stdout || aws.stderr);
    const gitlabOut = stripAnsi(gitlab.stdout || gitlab.stderr);

    const report =
      `AWS scan (exit ${aws.exitCode}):\n${awsOut || "(no output)"}\n\n` +
      `GitLab scan (exit ${gitlab.exitCode}):\n${gitlabOut || "(no output)"}`;

    await ctx.reply(truncate(report));
  });

  // ── /ts-new [slug] ──────────────────────────────────────────────────────────
  bot.command("ts_new", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const threadId = ctx.message?.message_thread_id ?? null;

    const cwd = await getCwdOrReply(ctx, chatId, threadId);
    if (!cwd) return;

    const raw = ctx.message?.text ?? "";
    const slug = raw.replace(/^\/ts[_-]new\S*\s*/, "").trim() || "investigation";

    const result = await runTshoot(["session", "new", slug], cwd);
    if (await replyOnError(ctx, result, "session new")) return;

    const out = stripAnsi(result.stdout);
    await ctx.reply(truncate(out || `Session '${slug}' started.`));
  });

  // ── /ts-sessions ────────────────────────────────────────────────────────────
  bot.command("ts_sessions", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const threadId = ctx.message?.message_thread_id ?? null;

    const cwd = await getCwdOrReply(ctx, chatId, threadId);
    if (!cwd) return;

    const result = await runTshoot(["session", "list"], cwd);
    // session list may exit 0 with "no sessions yet" — still show output
    const out = stripAnsi(result.stdout || result.stderr);
    await ctx.reply(truncate(out || "(no sessions)"));
  });

  // ── /ts-resume [slug] ───────────────────────────────────────────────────────
  bot.command("ts_resume", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const threadId = ctx.message?.message_thread_id ?? null;

    const cwd = await getCwdOrReply(ctx, chatId, threadId);
    if (!cwd) return;

    const raw = ctx.message?.text ?? "";
    const slug = raw.replace(/^\/ts[_-]resume\S*\s*/, "").trim();

    const args = slug ? ["session", "resume", slug] : ["session", "resume"];
    const result = await runTshoot(args, cwd);
    if (await replyOnError(ctx, result, "session resume")) return;

    const out = stripAnsi(result.stdout);
    await ctx.reply(truncate(out || "Session resumed."));
  });

  // ── /ts-status ──────────────────────────────────────────────────────────────
  bot.command("ts_status", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const threadId = ctx.message?.message_thread_id ?? null;

    const cwd = await getCwdOrReply(ctx, chatId, threadId);
    if (!cwd) return;

    const result = await runTshoot(["status"], cwd);
    if (await replyOnError(ctx, result, "status")) return;

    const out = stripAnsi(result.stdout);
    await ctx.reply(truncate(out || `Project context: ${cwd}`));
  });

  // ── /ts <cmd> <subcmd> [args…] ──────────────────────────────────────────────
  //
  // Generic tshoot proxy. Routes any subcommand via the manifest returned by
  // `tshoot commands --json`. No relay change needed when tshoot adds new
  // subcommands — just update tshoot and the manifest.
  //
  // Usage examples:
  //   /ts incident new 2026-02-28_enum-bug
  //   /ts incident list
  //   /ts incident export            ← uploads artifacts/incident.docx
  //   /ts incident status
  //   /ts incident link path/to/evidence
  //   /ts scan aws
  //
  bot.command("ts", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const threadId = ctx.message?.message_thread_id ?? null;

    const cwd = await getCwdOrReply(ctx, chatId, threadId);
    if (!cwd) return;

    // Parse args: strip "/ts" (with optional @bot suffix) and split
    const raw = ctx.message?.text ?? "";
    const rest = raw.replace(/^\/ts(?:@\S+)?\s*/, "").trim();
    const tokens = rest.split(/\s+/).filter(Boolean);

    // Fetch manifest (cached per cwd)
    const manifest = await fetchManifest(cwd);
    if (!manifest) {
      await ctx.reply(
        "Could not load tshoot command manifest.\n" +
          "Ensure tshoot is installed and `tshoot commands --json` works in your project dir."
      );
      return;
    }

    // Match first two tokens against manifest cmd (e.g. "incident new")
    const lookup =
      tokens.length >= 2
        ? `${tokens[0]} ${tokens[1]}`
        : tokens[0] ?? "";

    const entry = manifest.commands.find((e) => e.cmd === lookup);

    if (!entry) {
      if (!lookup) {
        await ctx.reply(formatManifestHelp(manifest));
      } else {
        const help = formatManifestHelp(manifest);
        await ctx.reply(`Unknown command: /ts ${lookup}\n\n${help}`);
      }
      return;
    }

    // Extra args after cmd+subcmd
    const extraArgs = tokens.slice(2);
    const tshootArgs = [...entry.cmd.split(" "), ...extraArgs];

    const result = await runTshoot(tshootArgs, cwd);
    if (await replyOnError(ctx, result, entry.cmd)) return;

    if (entry.output === "file") {
      // stdout contains the absolute path to the artifact
      const filePath = result.stdout.trim();
      if (!filePath) {
        await ctx.reply(`tshoot ${entry.cmd} produced no file path on stdout.`);
        return;
      }
      try {
        await ctx.replyWithDocument(new InputFile(filePath));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`File upload failed: ${msg}\nPath: ${filePath}`);
      }
    } else {
      const out = stripAnsi(result.stdout);
      await ctx.reply(truncate(out || `(no output from tshoot ${entry.cmd})`));
    }
  });
}

// ─── Inline capture handler ───────────────────────────────────────────────────

/**
 * Handle !finding and !discovery message prefixes.
 * Call this from the main message handler BEFORE sending to Claude.
 *
 * Returns true if the message was a capture command (caller should NOT forward
 * to Claude). Returns false if the message is a regular message.
 */
export async function handleTshoOtCapture(
  ctx: Context,
  text: string,
  chatId: number,
  threadId: number | null,
  agentResolver?: (chatId: number) => string
): Promise<boolean> {
  const isFinding = text.startsWith("!finding ");
  const isDiscovery = text.startsWith("!discovery ");

  if (!isFinding && !isDiscovery) return false;

  await ensureSession(chatId, threadId, agentResolver);
  const cwd = resolveTopicCwd(chatId, threadId);
  if (!cwd) {
    await ctx.reply(
      "No project context set.\nUse /cwd /path/to/projects/<name> first."
    );
    return true;
  }

  if (isFinding) {
    const desc = text.slice("!finding ".length).trim();
    if (!desc) {
      await ctx.reply("Usage: !finding <description>");
      return true;
    }
    const result = await runTshoot(["capture", "finding", desc], cwd);
    if (result.exitCode !== 0) {
      const detail = stripAnsi(result.stderr || result.stdout);
      const hint = detail.includes("No active session")
        ? "\nStart one with /ts-new first."
        : "";
      await ctx.reply(`capture failed: ${detail}${hint}`);
    } else {
      await ctx.reply("Finding captured.");
    }
    return true;
  }

  if (isDiscovery) {
    // !discovery <slug> <text>
    const rest = text.slice("!discovery ".length).trim();
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) {
      await ctx.reply("Usage: !discovery <slug> <description>");
      return true;
    }
    const slug = rest.slice(0, spaceIdx);
    const desc = rest.slice(spaceIdx + 1).trim();
    const result = await runTshoot(["capture", "discovery", slug, desc], cwd);
    if (result.exitCode !== 0) {
      await ctx.reply(
        `capture failed: ${stripAnsi(result.stderr || result.stdout)}`
      );
    } else {
      await ctx.reply(`Discovery '${slug}' saved.`);
    }
    return true;
  }

  return false;
}
