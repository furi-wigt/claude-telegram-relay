/**
 * EXAMPLE: Daily Morning Summary Routine
 *
 * This is a simplified example showing the "one-shot daily" pattern.
 * Copy this file to ~/.claude-relay/routines/ and customise it.
 *
 * Pattern: Runs once daily, gathers data from multiple sources, builds a
 * single summary message, sends via ctx.send().
 *
 * To use:
 *   1. Copy to ~/.claude-relay/routines/morning-summary.ts
 *   2. Add to ~/.claude-relay/routines.config.json:
 *      { "name": "morning-summary", "type": "handler", "schedule": "0 7 * * *", "group": "OPERATIONS", "enabled": true }
 *   3. Restart routine-scheduler: npx pm2 restart routine-scheduler
 */

import type { RoutineContext } from "../../../src/jobs/executors/routineContext.ts";
import { USER_NAME, USER_TIMEZONE } from "../../../src/config/userConfig.ts";

// --- Pure functions (export for testing) ---

/** Format a Date as a human-readable string in the user's timezone */
export function formatDate(date: Date, tz: string): string {
  return date.toLocaleDateString("en-SG", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Build the morning summary message from gathered data */
export function buildMessage(userName: string, dateStr: string, llmSummary: string): string {
  const lines = [
    `**Good morning, ${userName}!**`,
    `📅 ${dateStr}`,
    "",
    "---",
    "",
    llmSummary,
  ];
  return lines.join("\n");
}

// --- Handler entry point ---

export async function run(ctx: RoutineContext): Promise<void> {
  // ctx.llm() calls the LLM via ModelRegistry "routine" slot (Claude → local fallback)
  const summary = await ctx.llm(
    `You are a personal assistant for ${USER_NAME}. ` +
    `Write a brief, energetic morning briefing for today. ` +
    `Include: a motivational quote, 3 suggested focus areas, and a reminder to stay hydrated. ` +
    `Keep it under 200 words. Use markdown formatting.`
  );

  const dateStr = formatDate(new Date(), USER_TIMEZONE);
  const message = buildMessage(USER_NAME, dateStr, summary);

  // ctx.send() sends to the routine's configured Telegram group AND persists to DB
  await ctx.send(message);
  ctx.log("morning summary sent");
}
