/**
 * Routine Handler
 *
 * Orchestrates the conversational routine creation flow:
 *   1. Detect intent in message
 *   2. Extract config via Claude (intentExtractor)
 *   3. Show preview + ask for output target (inline keyboard)
 *   4. On confirmation, create the routine (routineManager)
 *
 * Integration: Call detectAndHandle() before normal Claude processing in relay.ts
 */

import type { Context, Bot } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InlineKeyboard } from "grammy";
import { detectRoutineIntent, detectRunRoutineIntent, extractRoutineConfig } from "./intentExtractor.ts";
import { setPending, getPending, clearPending, hasPending } from "./pendingState.ts";
import {
  createRoutine,
  listUserRoutines,
  deleteRoutine,
  listCodeRoutines,
  registerCodeRoutine,
  updateCodeRoutineCron,
  toggleCodeRoutine,
  triggerCodeRoutine,
} from "./routineManager.ts";
import { GROUPS } from "../config/groups.ts";
import type { UserRoutineConfig } from "./types.ts";
import { saveCommandInteraction } from "../utils/saveMessage.ts";

// Tracks pending registration flow: chatId → routine name awaiting cron input
const pendingRegistrations = new Map<number, string>();

function isValidCron(expr: string): boolean {
  return /^(\S+\s+){4}\S+$/.test(expr.trim());
}

// ============================================================
// OUTPUT TARGET OPTIONS
// ============================================================

interface TargetOption {
  label: string;
  chatId: number;
  topicId: number | null;
  callbackData: string;
}

function buildTargetOptions(userChatId: number): TargetOption[] {
  const options: TargetOption[] = [
    {
      label: "Personal chat",
      chatId: userChatId,
      topicId: null,
      callbackData: `routine_target:personal:${userChatId}:0`,
    },
  ];

  const groupEntries = [
    { name: "General group", key: "GENERAL" },
    { name: "AWS Architect", key: "AWS_ARCHITECT" },
    { name: "Security", key: "SECURITY" },
    { name: "Code Quality", key: "CODE_QUALITY" },
    { name: "Documentation", key: "DOCUMENTATION" },
  ];

  for (const g of groupEntries) {
    const group = GROUPS[g.key];
    if (group && group.chatId !== 0) {
      options.push({
        label: g.name,
        chatId: group.chatId,
        topicId: group.topicId,
        callbackData: `routine_target:${g.key.toLowerCase()}:${group.chatId}:${group.topicId ?? 0}`,
      });
    }
  }

  return options;
}

function buildTargetKeyboard(options: TargetOption[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const opt of options) {
    kb.text(opt.label, opt.callbackData).row();
  }
  kb.text("Cancel", "routine_target:cancel:0");
  return kb;
}

// ============================================================
// MAIN HANDLER
// ============================================================

/**
 * Check if the message is a routine creation request.
 * If so, extract config and show the confirmation keyboard.
 * Returns true if the message was handled (caller should not forward to Claude).
 */
export async function detectAndHandle(
  ctx: Context,
  text: string
): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;

  // Check for run/trigger intent BEFORE pending registration flow
  const runHint = detectRunRoutineIntent(text);
  if (runHint) {
    try {
      const codeRoutines = await listCodeRoutines();
      const hintLower = runHint.toLowerCase();
      const matches = codeRoutines.filter((r) =>
        r.name.toLowerCase().includes(hintLower) ||
        hintLower.includes(r.name.toLowerCase().replace(/-/g, " ")) ||
        r.name.toLowerCase().replace(/-/g, " ").includes(hintLower)
      );

      if (matches.length === 1) {
        try {
          await triggerCodeRoutine(matches[0].name);
          await ctx.reply(`Triggering routine \`${matches[0].name}\`... Done.`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          await ctx.reply(`Failed to trigger routine: ${msg}`);
        }
      } else if (matches.length === 0) {
        await ctx.reply(`No routine found matching '${runHint}'. Use /routines list to see available routines.`);
      } else {
        const names = matches.map((r) => `  - ${r.name}`).join("\n");
        await ctx.reply(`Multiple routines match '${runHint}':\n${names}\n\nBe more specific or use /routines run <name>.`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Error looking up routines: ${msg}`);
    }
    return true;
  }

  // Intercept plain-text input for pending registration flow
  if (pendingRegistrations.has(chatId)) {
    const name = pendingRegistrations.get(chatId)!;
    const trimmed = text.trim();

    // Allow explicit cancellation
    if (/^(cancel|no|n)$/i.test(trimmed)) {
      pendingRegistrations.delete(chatId);
      await ctx.reply(`Registration of "${name}" cancelled.`);
      return true;
    }

    // Validate as cron expression
    if (!isValidCron(trimmed)) {
      await ctx.reply(
        `Still waiting for a cron expression to schedule "${name}".\n\n` +
        `Send 5 space-separated fields, e.g. \`0 9 * * *\` for 9am daily.\n` +
        `Type "cancel" to abort.`
      );
      return true;
    }

    pendingRegistrations.delete(chatId);
    try {
      await registerCodeRoutine(name, trimmed);
      await ctx.reply(`✅ Routine "${name}" registered with schedule: \`${trimmed}\`\n\nRun /routines list to see its status.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Failed to register routine: ${msg}`);
    }
    return true;
  }

  // Check for pending confirmation cancellation ("cancel", "no", "n")
  if (hasPending(chatId) && /^(cancel|no|n)$/i.test(text.trim())) {
    clearPending(chatId);
    await ctx.reply("Routine creation cancelled.");
    return true;
  }

  if (!detectRoutineIntent(text)) return false;

  await ctx.reply("Extracting routine details...");

  const pending = await extractRoutineConfig(text);
  if (!pending) {
    await ctx.reply(
      "I couldn't extract a clear routine from that. Try:\n" +
        '"Create a daily routine at 9am that summarizes my goals"'
    );
    return true;
  }

  setPending(chatId, pending);

  const { config } = pending;
  const userChatId = parseInt(process.env.TELEGRAM_USER_ID || "0");
  const targets = buildTargetOptions(userChatId);
  const keyboard = buildTargetKeyboard(targets);

  const preview =
    `New routine preview:\n\n` +
    `Name: ${config.name}\n` +
    `Schedule: ${config.scheduleDescription}\n` +
    `Cron: \`${config.cron}\`\n\n` +
    `Claude will:\n${config.prompt}\n\n` +
    `Where should I send the output?`;

  await ctx.reply(preview, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });

  return true;
}

/**
 * Handle inline keyboard callback for output target selection.
 * Registers bot.on("callback_query:data") — call once at startup.
 */
export function registerCallbackHandler(bot: Bot): void {
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;

    // Handle routine registration callbacks
    if (data.startsWith("routine_register:")) {
      await ctx.answerCallbackQuery();
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      if (data === "routine_register:skip") {
        await ctx.editMessageText("Registration skipped.");
        return;
      }

      const name = data.replace("routine_register:", "");
      pendingRegistrations.set(chatId, name);
      await ctx.editMessageText(
        `What schedule for "${name}"? Send me a cron expression (e.g. \`0 9 * * *\` for 9am daily).`
      );
      return;
    }

    if (!data.startsWith("routine_target:")) return next();

    await ctx.answerCallbackQuery();

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    if (data === "routine_target:cancel:0") {
      clearPending(chatId);
      await ctx.editMessageText("Routine creation cancelled.");
      return;
    }

    const pending = getPending(chatId);
    if (!pending) {
      await ctx.editMessageText("Session expired. Please describe the routine again.");
      return;
    }

    // Parse: routine_target:<key>:<targetChatId>:<topicId>
    const parts = data.split(":");
    const targetLabel = parts[1];
    const targetChatId = parseInt(parts[2] || "0");
    const topicIdRaw = parseInt(parts[3] || "0");
    const topicId: number | null = topicIdRaw !== 0 ? topicIdRaw : null;

    if (!targetChatId || targetChatId === 0) {
      await ctx.editMessageText("Invalid target selected. Please try again.");
      return;
    }

    clearPending(chatId);

    const config: UserRoutineConfig = {
      ...pending.config,
      chatId: targetChatId,
      topicId,
      targetLabel: targetLabel === "personal" ? "Personal chat" : targetLabel,
      createdAt: new Date().toISOString(),
    };

    await ctx.editMessageText(
      `Creating routine "${config.name}"...\nThis may take a moment.`
    );

    try {
      await createRoutine(config);

      await ctx.reply(
        `Routine created!\n\n` +
          `Name: ${config.name}\n` +
          `Schedule: ${config.scheduleDescription}\n` +
          `Output: ${config.targetLabel}\n\n` +
          `Manage routines:\n` +
          `/routines list — see all\n` +
          `/routines delete ${config.name} — remove it`
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Failed to create routine: ${msg}`);
    }
  });
}

// ============================================================
// /routines COMMAND HANDLER
// ============================================================

async function handleRoutinesList(ctx: Context): Promise<void> {
  const [codeRoutines, userRoutines] = await Promise.all([
    listCodeRoutines(),
    listUserRoutines(),
  ]);

  const lines: string[] = [];

  // System (code-based) section
  lines.push("System Routines (code-based):");
  if (codeRoutines.length === 0) {
    lines.push("  (none)");
  } else {
    for (const r of codeRoutines) {
      if (r.registered && r.pm2Status) {
        const statusIcon = r.pm2Status === "online" ? "✅" : "⏹";
        lines.push(`  ${r.name.padEnd(30)} ${(r.cron ?? "").padEnd(16)} ${statusIcon} ${r.pm2Status}`);
      } else {
        lines.push(`  ${r.name.padEnd(30)} (not registered)     ⚠️`);
      }
    }
  }

  lines.push("");

  // User (prompt-based) section
  lines.push("User Routines (prompt-based):");
  if (userRoutines.length === 0) {
    lines.push("  (none yet — describe one to create it)");
  } else {
    for (const r of userRoutines) {
      lines.push(`  ${r.name.padEnd(30)} ${r.scheduleDescription}`);
    }
  }

  await ctx.reply(lines.join("\n"));

  // Check for unregistered code routines and offer inline keyboard
  const unregistered = codeRoutines.filter((r) => !r.registered);
  if (unregistered.length > 0) {
    const names = unregistered.map((r) => `  • ${r.name}`).join("\n");
    const kb = new InlineKeyboard();
    for (const r of unregistered) {
      kb.text(`Register ${r.name}`, `routine_register:${r.name}`);
    }
    kb.row().text("Skip", "routine_register:skip");

    await ctx.reply(
      `⚠️ ${unregistered.length} unregistered routine${unregistered.length > 1 ? "s" : ""} found:\n${names}\n\nRegister them to add to PM2 schedule?`,
      { reply_markup: kb }
    );
  }
}

export async function handleRoutinesCommand(
  ctx: Context,
  args: string,
  supabase?: SupabaseClient | null
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Check if user is in the middle of a registration cron-entry flow
  if (pendingRegistrations.has(chatId)) {
    const name = pendingRegistrations.get(chatId)!;
    const cronInput = args.trim();
    if (!isValidCron(cronInput)) {
      await ctx.reply("Invalid cron expression. Use 5 space-separated fields (e.g. `0 9 * * *`)");
      return;
    }
    pendingRegistrations.delete(chatId);
    try {
      await registerCodeRoutine(name, cronInput);
      await ctx.reply(`Routine "${name}" registered and started in PM2 with schedule: \`${cronInput}\``);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Failed to register routine: ${msg}`);
    }
    return;
  }

  const [subcommand, ...rest] = args.trim().split(/\s+/);

  if (!subcommand || subcommand === "list") {
    await handleRoutinesList(ctx);
    return;
  }

  if (subcommand === "status") {
    const name = rest[0];
    const codeRoutines = await listCodeRoutines();
    if (name) {
      const r = codeRoutines.find((r) => r.name === name);
      if (!r) {
        await ctx.reply(`Routine "${name}" not found.`);
        return;
      }
      const status = r.pm2Status ?? "not registered";
      await ctx.reply(`${name}: ${status}${r.cron ? ` (${r.cron})` : ""}`);
    } else {
      const lines = codeRoutines.map((r) => {
        const status = r.pm2Status ?? "⚠️ not registered";
        return `${r.name}: ${status}`;
      });
      await ctx.reply(`PM2 Status:\n\n${lines.join("\n")}`);
    }
    return;
  }

  if (subcommand === "run") {
    const name = rest[0];
    if (!name) {
      await ctx.reply("Usage: /routines run <name>");
      return;
    }
    try {
      await triggerCodeRoutine(name);
      await ctx.reply(`Triggered routine "${name}".`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Failed to run routine: ${msg}`);
    }
    return;
  }

  if (subcommand === "enable") {
    const name = rest[0];
    if (!name) {
      await ctx.reply("Usage: /routines enable <name>");
      return;
    }
    try {
      await toggleCodeRoutine(name, true);
      await ctx.reply(`Routine "${name}" enabled.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Failed to enable routine: ${msg}`);
    }
    return;
  }

  if (subcommand === "disable") {
    const name = rest[0];
    if (!name) {
      await ctx.reply("Usage: /routines disable <name>");
      return;
    }
    try {
      await toggleCodeRoutine(name, false);
      await ctx.reply(`Routine "${name}" disabled (stopped in PM2).`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Failed to disable routine: ${msg}`);
    }
    return;
  }

  if (subcommand === "schedule") {
    const name = rest[0];
    const cron = rest.slice(1).join(" ");
    if (!name || !cron) {
      await ctx.reply("Usage: /routines schedule <name> <cron>\nExample: /routines schedule aws-daily-cost 0 9 * * *");
      return;
    }
    if (!isValidCron(cron)) {
      await ctx.reply("Invalid cron expression. Use 5 space-separated fields (e.g. `0 9 * * *`)");
      return;
    }
    try {
      await updateCodeRoutineCron(name, cron);
      await ctx.reply(`Updated schedule for "${name}" to: \`${cron}\``);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Failed to update schedule: ${msg}`);
    }
    return;
  }

  if (subcommand === "register") {
    const name = rest[0];
    const cron = rest.slice(1).join(" ");
    if (!name) {
      await ctx.reply("Usage: /routines register <name> <cron>");
      return;
    }
    if (cron && !isValidCron(cron)) {
      await ctx.reply("Invalid cron expression. Use 5 space-separated fields (e.g. `0 9 * * *`)");
      return;
    }
    if (cron) {
      try {
        await registerCodeRoutine(name, cron);
        await ctx.reply(`Routine "${name}" registered with schedule: \`${cron}\``);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await ctx.reply(`Failed to register routine: ${msg}`);
      }
    } else {
      // No cron provided — ask for it
      pendingRegistrations.set(chatId, name);
      await ctx.reply(`What schedule for "${name}"? Enter a cron expression (e.g. \`0 9 * * *\` for 9am daily):`);
    }
    return;
  }

  if (subcommand === "delete") {
    const name = rest[0];
    if (!name) {
      await ctx.reply("Usage: /routines delete <name>");
      return;
    }
    // Block deletion of code routines
    const codeRoutines = await listCodeRoutines();
    if (codeRoutines.some((r) => r.name === name)) {
      await ctx.reply("Use a coding session to delete code-based routines. Only user routines can be deleted via Telegram.");
      return;
    }
    try {
      await deleteRoutine(name);
      const replyText = `Routine "${name}" deleted and removed from PM2.`;
      await ctx.reply(replyText);
      await saveCommandInteraction(supabase ?? null, chatId, `/routines delete ${name}`, replyText);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Failed to delete routine: ${msg}`);
    }
    return;
  }

  await ctx.reply(
    "Routines commands:\n\n" +
      "/routines list — list all routines\n" +
      "/routines status [name] — PM2 status\n" +
      "/routines run <name> — trigger immediately\n" +
      "/routines enable <name> — resume routine\n" +
      "/routines disable <name> — pause routine\n" +
      "/routines schedule <name> <cron> — update schedule\n" +
      "/routines register <name> [cron] — register code routine\n" +
      "/routines delete <name> — delete user routine"
  );
}
