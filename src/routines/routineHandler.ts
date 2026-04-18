/**
 * Routine Handler
 *
 * /routines command and conversational routine-creation flow.
 *
 * Subcommands:
 *   /routines [list]          — core + user routines
 *   /routines run <name>      — trigger via job queue
 *   /routines enable <name>   — set enabled: true
 *   /routines disable <name>  — set enabled: false
 *   /routines edit <name>     — inline keyboard → prompt or schedule
 *   /routines delete <name>   — remove from user config
 *   /routines new-handler     — bun-script routine guide
 *
 * NL creation: detectAndHandle() intercepts messages before Claude.
 */

import type { Context, Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  detectRoutineIntent,
  detectRunRoutineIntent,
  extractRoutineConfig,
} from "./intentExtractor.ts";
import {
  setPending,
  getPending,
  clearPending,
  hasPending,
  setPendingEdit,
  getPendingEdit,
  clearPendingEdit,
} from "./pendingState.ts";
import {
  listAllRoutines,
  isCoreRoutine,
  addUserRoutine,
  updateUserRoutine,
  deleteUserRoutine,
  setRoutineEnabled,
  triggerRoutine,
} from "./routineManager.ts";
import { GROUPS } from "../config/groups.ts";
import type { RoutineConfig } from "./routineConfig.ts";
import { saveCommandInteraction } from "../utils/saveMessage.ts";

const EDIT_TTL_MS = 5 * 60 * 1000;

function isValidCron(expr: string): boolean {
  return /^(\S+\s+){4}\S+$/.test(expr.trim());
}

// ============================================================
// TARGET OPTIONS (for creation flow)
// ============================================================

interface TargetOption {
  label: string;
  groupKey: string;
  callbackData: string;
}

function buildTargetOptions(): TargetOption[] {
  const options: TargetOption[] = [
    { label: "Personal chat", groupKey: "PERSONAL", callbackData: "routine_target:PERSONAL" },
  ];

  const groupLabels: { label: string; key: string }[] = [
    { label: "Operations Hub", key: "OPERATIONS" },
    { label: "Engineering", key: "ENGINEERING" },
    { label: "Cloud", key: "CLOUD" },
    { label: "Security", key: "SECURITY" },
    { label: "Strategy", key: "STRATEGY" },
    { label: "Command Center", key: "COMMAND_CENTER" },
  ];

  for (const { label, key } of groupLabels) {
    if (GROUPS[key]?.chatId && GROUPS[key].chatId !== 0) {
      options.push({ label, groupKey: key, callbackData: `routine_target:${key}` });
    }
  }

  return options;
}

function buildTargetKeyboard(options: TargetOption[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const opt of options) {
    kb.text(opt.label, opt.callbackData).row();
  }
  kb.text("Cancel", "routine_target:CANCEL");
  return kb;
}

// ============================================================
// /routines list
// ============================================================

async function handleRoutinesList(ctx: Context): Promise<void> {
  const { core, user } = listAllRoutines();

  const lines: string[] = [];

  lines.push("🔒 Core Routines (read-only — enable/disable only):");
  if (core.length === 0) {
    lines.push("  (none)");
  } else {
    for (const r of core) {
      const icon = r.enabled !== false ? "✅" : "⏹";
      lines.push(`  ${icon} ${r.name.padEnd(26)} ${r.schedule}`);
    }
  }

  lines.push("");
  lines.push("👤 User Routines:");
  if (user.length === 0) {
    lines.push("  (none — describe a routine to create one)");
  } else {
    for (const r of user) {
      const icon = r.enabled !== false ? "✅" : "⏹";
      const tag = r.type === "prompt" ? "prompt" : "handler";
      lines.push(`  ${icon} ${r.name.padEnd(26)} ${r.schedule}  [${tag}]`);
    }
  }

  const kb = new InlineKeyboard()
    .text("+ Create routine", "routine_action:create").row()
    .text("? Bun-script guide", "routine_action:new_handler");

  await ctx.reply(lines.join("\n"), { reply_markup: kb });
}

// ============================================================
// /routines new-handler
// ============================================================

async function handleNewHandler(ctx: Context): Promise<void> {
  const guide =
    `📦 *Creating a bun-script routine*\n\n` +
    `Bun-script routines are TypeScript files that export a \`run(ctx)\` function. ` +
    `They live in \`~/.claude-relay/routines/<name>.ts\` and get an entry in \`~/.claude-relay/routines.config.json\`.\n\n` +
    `*Handler skeleton:*\n` +
    "```typescript\n" +
    `import type { RoutineContext } from "../../src/jobs/executors/routineContext.ts";\n\n` +
    `export async function run(ctx: RoutineContext): Promise<void> {\n` +
    `  // ctx.llm(prompt) — call the routine model\n` +
    `  // ctx.send(text)  — post to Telegram + record in memory\n` +
    `  // ctx.log(msg)    — structured log\n` +
    `  // ctx.skipIfRanWithin(hours) — skip if ran recently\n\n` +
    `  const result = await ctx.llm("Your prompt here");\n` +
    `  await ctx.send(result);\n` +
    `}\n` +
    "```\n\n" +
    `*Ask Jarvis (Engineering group) to create one:*\n` +
    `Copy and customise the prompt below, then tap the button.`;

  const kb = new InlineKeyboard().text(
    "Open in Engineering →",
    "routine_action:open_handler_guide"
  );

  await ctx.reply(guide, { parse_mode: "Markdown", reply_markup: kb });
}

// ============================================================
// MAIN /routines COMMAND
// ============================================================

export async function handleRoutinesCommand(ctx: Context, args: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Check if we're waiting for a cron expression (edit schedule flow)
  const pendingEdit = getPendingEdit(chatId);
  if (pendingEdit) {
    const trimmed = args.trim();
    if (/^(cancel|no|n)$/i.test(trimmed)) {
      clearPendingEdit(chatId);
      await ctx.reply("Edit cancelled.");
      return;
    }
    // Treat the /routines args as the input (user may have sent /routines 0 9 * * *)
    await handleEditInput(ctx, chatId, trimmed);
    return;
  }

  const [subcommand, ...rest] = args.trim().split(/\s+/);

  if (!subcommand || subcommand === "list") {
    await handleRoutinesList(ctx);
    return;
  }

  if (subcommand === "new-handler") {
    await handleNewHandler(ctx);
    return;
  }

  if (subcommand === "run") {
    const name = rest[0];
    if (!name) { await ctx.reply("Usage: /routines run <name>"); return; }
    try {
      await triggerRoutine(name);
      await ctx.reply(`Triggered \`${name}\` via job queue.`);
    } catch (e) {
      await ctx.reply(`Failed: ${(e as Error).message}`);
    }
    return;
  }

  if (subcommand === "enable") {
    const name = rest[0];
    if (!name) { await ctx.reply("Usage: /routines enable <name>"); return; }
    try {
      await setRoutineEnabled(name, true);
      await ctx.reply(`✅ \`${name}\` enabled.`);
    } catch (e) {
      await ctx.reply(`Failed: ${(e as Error).message}`);
    }
    return;
  }

  if (subcommand === "disable") {
    const name = rest[0];
    if (!name) { await ctx.reply("Usage: /routines disable <name>"); return; }
    try {
      await setRoutineEnabled(name, false);
      await ctx.reply(`⏹ \`${name}\` disabled.`);
    } catch (e) {
      await ctx.reply(`Failed: ${(e as Error).message}`);
    }
    return;
  }

  if (subcommand === "edit") {
    const name = rest[0];
    if (!name) { await ctx.reply("Usage: /routines edit <name>"); return; }

    // Block core routine edits (only enable/disable allowed)
    if (isCoreRoutine(name)) {
      await ctx.reply(
        `\`${name}\` is a core routine — only enable/disable is allowed via bot.\n` +
        `To change its schedule, add an override in \`~/.claude-relay/routines.config.json\`.`
      );
      return;
    }

    const kb = new InlineKeyboard()
      .text("Edit Prompt", `routine_edit:${name}:prompt`)
      .text("Edit Schedule", `routine_edit:${name}:schedule`)
      .row()
      .text("Cancel", `routine_edit:${name}:cancel`);

    await ctx.reply(`What would you like to edit for \`${name}\`?`, { reply_markup: kb });
    return;
  }

  if (subcommand === "delete") {
    const name = rest[0];
    if (!name) { await ctx.reply("Usage: /routines delete <name>"); return; }

    if (isCoreRoutine(name)) {
      await ctx.reply(
        `\`${name}\` is a core routine and cannot be deleted via bot.\n` +
        `Use \`/routines disable ${name}\` to stop it from running.`
      );
      return;
    }

    try {
      await deleteUserRoutine(name);
      const msg = `Routine \`${name}\` deleted.`;
      await ctx.reply(msg);
      await saveCommandInteraction(chatId, `/routines delete ${name}`, msg);
    } catch (e) {
      await ctx.reply(`Failed: ${(e as Error).message}`);
    }
    return;
  }

  await ctx.reply(
    "Routines commands:\n\n" +
    "/routines list — all routines\n" +
    "/routines run <name> — trigger immediately\n" +
    "/routines enable <name> — resume routine\n" +
    "/routines disable <name> — pause routine\n" +
    "/routines edit <name> — edit prompt or schedule\n" +
    "/routines delete <name> — remove user routine\n" +
    "/routines new-handler — guide for bun-script routines\n\n" +
    "Or just describe a routine in plain language to create one."
  );
}

// ============================================================
// EDIT INPUT HANDLER (multi-turn)
// ============================================================

async function handleEditInput(ctx: Context, chatId: number, text: string): Promise<void> {
  const edit = getPendingEdit(chatId);
  if (!edit) return;

  if (/^(cancel|no|n)$/i.test(text)) {
    clearPendingEdit(chatId);
    await ctx.reply("Edit cancelled.");
    return;
  }

  if (edit.field === "schedule") {
    if (!isValidCron(text)) {
      await ctx.reply(
        `Invalid cron expression. Expected 5 fields, e.g. \`0 9 * * *\`\nType "cancel" to abort.`
      );
      return;
    }
    try {
      await updateUserRoutine(edit.name, { schedule: text });
      clearPendingEdit(chatId);
      await ctx.reply(`Schedule for \`${edit.name}\` updated to: \`${text}\`\nScheduler will reload automatically.`);
    } catch (e) {
      clearPendingEdit(chatId);
      await ctx.reply(`Failed to update: ${(e as Error).message}`);
    }
    return;
  }

  // field === "prompt"
  try {
    await updateUserRoutine(edit.name, { prompt: text });
    clearPendingEdit(chatId);
    await ctx.reply(`Prompt for \`${edit.name}\` updated.`);
  } catch (e) {
    clearPendingEdit(chatId);
    await ctx.reply(`Failed to update: ${(e as Error).message}`);
  }
}

// ============================================================
// NL DETECTION + CREATION FLOW
// ============================================================

/**
 * Intercept messages before Claude for routine-related intents.
 * Returns true if the message was handled (caller must not forward to Claude).
 */
export async function detectAndHandle(ctx: Context, text: string): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;

  // Check pending edit input (plain-text reply to edit prompt)
  const pendingEdit = getPendingEdit(chatId);
  if (pendingEdit) {
    await handleEditInput(ctx, chatId, text);
    return true;
  }

  // Cancel creation flow
  if (hasPending(chatId) && /^(cancel|no|n)$/i.test(text.trim())) {
    clearPending(chatId);
    await ctx.reply("Routine creation cancelled.");
    return true;
  }

  // Run-intent detection
  const runHint = detectRunRoutineIntent(text);
  if (runHint) {
    const { user, core } = listAllRoutines();
    const all = [...core, ...user];
    const hint = runHint.toLowerCase();
    const matches = all.filter(
      (r) =>
        r.name.toLowerCase().includes(hint) ||
        hint.includes(r.name.toLowerCase().replace(/-/g, " ")) ||
        r.name.toLowerCase().replace(/-/g, " ").includes(hint)
    );

    if (matches.length === 1) {
      try {
        await triggerRoutine(matches[0].name);
        await ctx.reply(`Triggering \`${matches[0].name}\` via job queue...`);
      } catch (e) {
        await ctx.reply(`Failed: ${(e as Error).message}`);
      }
    } else if (matches.length === 0) {
      await ctx.reply(`No routine found matching '${runHint}'. Use /routines list.`);
    } else {
      const names = matches.map((r) => `  • ${r.name}`).join("\n");
      await ctx.reply(`Multiple matches for '${runHint}':\n${names}\n\nUse /routines run <name>.`);
    }
    return true;
  }

  if (!detectRoutineIntent(text)) return false;

  await ctx.reply("Extracting routine details...");

  const pending = await extractRoutineConfig(text);
  if (!pending) {
    await ctx.reply(
      "Couldn't extract a clear routine. Try:\n" +
      '"Create a daily routine at 9am that summarizes my goals"'
    );
    return true;
  }

  setPending(chatId, pending);

  const targets = buildTargetOptions();
  const keyboard = buildTargetKeyboard(targets);

  const preview =
    `New routine preview:\n\n` +
    `Name: ${pending.config.name}\n` +
    `Schedule: ${pending.config.scheduleDescription}\n` +
    `Cron: \`${pending.config.schedule}\`\n\n` +
    `Claude will:\n${pending.config.prompt}\n\n` +
    `Where should I send the output?`;

  await ctx.reply(preview, { parse_mode: "Markdown", reply_markup: keyboard });
  return true;
}

// ============================================================
// CALLBACK HANDLER
// ============================================================

export function registerCallbackHandler(bot: Bot): void {
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    if (!chatId) return next();

    // ── routine_edit: field selection ──────────────────────
    if (data.startsWith("routine_edit:")) {
      await ctx.answerCallbackQuery();
      const [, name, field] = data.split(":");

      if (field === "cancel") {
        await ctx.editMessageText("Edit cancelled.");
        return;
      }

      if (field !== "prompt" && field !== "schedule") return next();

      setPendingEdit(chatId, { name, field, createdAt: Date.now() });

      if (field === "prompt") {
        await ctx.editMessageText(
          `Send me the new prompt for \`${name}\`:\n(or type "cancel" to abort)`
        );
      } else {
        await ctx.editMessageText(
          `Send me a cron expression for \`${name}\` (e.g. \`0 9 * * *\` = 9am daily):\n(or type "cancel" to abort)`
        );
      }
      return;
    }

    // ── routine_target: creation target selection ──────────
    if (data.startsWith("routine_target:")) {
      await ctx.answerCallbackQuery();

      if (data === "routine_target:CANCEL") {
        clearPending(chatId);
        await ctx.editMessageText("Routine creation cancelled.");
        return;
      }

      const pending = getPending(chatId);
      if (!pending) {
        await ctx.editMessageText("Session expired. Please describe the routine again.");
        return;
      }

      const groupKey = data.replace("routine_target:", "");
      clearPending(chatId);

      await ctx.editMessageText(`Creating routine \`${pending.config.name}\`...`);

      const config: RoutineConfig = {
        name: pending.config.name,
        type: "prompt",
        schedule: pending.config.schedule,
        group: groupKey,
        enabled: true,
        prompt: pending.config.prompt,
      };

      try {
        await addUserRoutine(config);
        await ctx.reply(
          `Routine created!\n\n` +
          `Name: ${config.name}\n` +
          `Schedule: ${pending.config.scheduleDescription}\n` +
          `Target: ${groupKey}\n\n` +
          `Manage: /routines edit ${config.name} | /routines delete ${config.name}`
        );
      } catch (e) {
        await ctx.reply(`Failed to create routine: ${(e as Error).message}`);
      }
      return;
    }

    // ── routine_action: list keyboard actions ──────────────
    if (data.startsWith("routine_action:")) {
      await ctx.answerCallbackQuery();
      const action = data.replace("routine_action:", "");

      if (action === "create") {
        await ctx.reply(
          "Describe the routine you want to create, e.g.:\n\n" +
          '"Create a daily routine at 9am that summarizes my pending goals"\n' +
          '"Schedule a weekly AWS cost check every Monday at 8am"'
        );
        return;
      }

      if (action === "new_handler" || action === "open_handler_guide") {
        const prompt =
          `Please create a bun-script routine for me.\n\n` +
          `Handler file: \`~/.claude-relay/routines/<name>.ts\`\n` +
          `Config entry: \`~/.claude-relay/routines.config.json\`\n\n` +
          `The handler should export \`run(ctx: RoutineContext)\` and use:\n` +
          `- \`ctx.llm(prompt)\` to call the model\n` +
          `- \`ctx.send(text)\` to post output to Telegram\n` +
          `- \`ctx.skipIfRanWithin(hours)\` to guard against re-runs\n\n` +
          `[Describe what you want the routine to do]`;

        // Post prefilled prompt to Engineering group if configured
        const engGroup = GROUPS["ENGINEERING"];
        if (engGroup?.chatId && engGroup.chatId !== 0) {
          const { sendToGroup } = await import("../utils/sendToGroup.ts");
          await sendToGroup(engGroup.chatId, prompt, { topicId: engGroup.topicId });
          await ctx.editMessageText("Prompt sent to Engineering group. Describe your routine there.");
        } else {
          await ctx.editMessageText(prompt);
        }
        return;
      }

      return next();
    }

    return next();
  });
}
