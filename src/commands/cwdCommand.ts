/**
 * /cwd command handler — per-topic working directory configuration.
 *
 * Extracts the pure handler logic so it can be unit-tested without a grammy Bot.
 * Integration with the bot (command registration, session persistence) is done in
 * botCommands.ts.
 *
 * Usage:
 *   /cwd              — display configured cwd and active cwd for this topic
 *   /cwd /path/to/dir — set cwd; takes effect after /new
 *   /cwd reset        — clear configured cwd; falls back to PROJECT_DIR after /new
 */

import { access } from "fs/promises";
import type { Context } from "grammy";

export interface CwdCommandResult {
  ok: boolean;
  /** New cwd value to persist. undefined means clear (reset). Only present when ok=true and a set/reset was performed. */
  newCwd?: string;
}

/**
 * Handle a /cwd command.
 *
 * @param ctx          grammy context
 * @param currentCwd   The topic's currently configured cwd (session.cwd)
 * @param projectDir   Fallback directory (PROJECT_DIR env or empty string)
 * @returns            Result object when a set/reset was performed; undefined for display-only
 */
export async function handleCwdCommand(
  ctx: Context,
  currentCwd: string | undefined,
  projectDir: string | undefined
): Promise<CwdCommandResult | undefined> {
  const raw = ctx.message?.text ?? "";
  // Strip the command prefix to get the argument (handles /cwd, /cwd@botname, etc.)
  const arg = raw.replace(/^\/cwd\S*\s*/, "").trim();

  // ── Display mode (no argument) ────────────────────────────────────────────
  if (!arg) {
    const configured = currentCwd ?? "(not configured)";
    const fallback = projectDir || "(relay working directory)";
    const lines = [
      `Working directory for this topic:`,
      `  Configured: ${configured}`,
      `  Fallback:   ${fallback}`,
    ];
    await ctx.reply(lines.join("\n"));
    return undefined;
  }

  // ── Reset ─────────────────────────────────────────────────────────────────
  if (arg === "reset") {
    const fallback = projectDir || "(relay working directory)";
    await ctx.reply(
      `Working directory cleared. Will use: ${fallback}\n` +
      `Use /new to start a session with the updated path.`
    );
    return { ok: true, newCwd: undefined };
  }

  // ── Set path ──────────────────────────────────────────────────────────────
  try {
    await access(arg);
  } catch {
    await ctx.reply(`Path does not exist: ${arg}`);
    return { ok: false };
  }

  await ctx.reply(
    `Working directory set to: ${arg}\n` +
    `Use /new to start a session with the updated path.`
  );
  return { ok: true, newCwd: arg };
}
