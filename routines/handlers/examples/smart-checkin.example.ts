/**
 * EXAMPLE: Interval-Based Smart Check-In Routine
 *
 * This is a simplified example showing the "interval with skip logic" pattern.
 * Copy this file to ~/.claude-relay/routines/ and customise it.
 *
 * Pattern: Runs every N minutes on a cron schedule. Uses ctx.skipIfRanWithin()
 * to avoid duplicate runs, and an LLM call to decide whether a check-in is
 * warranted before sending.
 *
 * To use:
 *   1. Copy to ~/.claude-relay/routines/smart-checkin.ts
 *   2. Add to ~/.claude-relay/routines.config.json:
 *      { "name": "smart-checkin", "type": "handler", "schedule": "0 * * * *", "group": "OPERATIONS", "enabled": true }
 *   3. Restart routine-scheduler: npx pm2 restart routine-scheduler
 */

import type { RoutineContext } from "../../../src/jobs/executors/routineContext.ts";
import { USER_NAME } from "../../../src/config/userConfig.ts";

// --- Pure functions (export for testing) ---

/** Determine the time-of-day context for the check-in prompt */
export function getTimeContext(hour: number): string {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

/** Decide from LLM response whether to actually send a check-in */
export function shouldCheckin(llmDecision: string): boolean {
  const lower = llmDecision.trim().toLowerCase();
  return lower.startsWith("yes");
}

// --- Handler entry point ---

export async function run(ctx: RoutineContext): Promise<void> {
  // Skip if this routine already ran within the last hour (idempotency guard).
  // If skipped, the job is marked "skipped" and execution stops here.
  await ctx.skipIfRanWithin(1);

  const hour = new Date().getHours();
  const timeCtx = getTimeContext(hour);

  // Step 1: Ask the LLM whether a check-in is appropriate right now
  const decision = await ctx.llm(
    `You are a personal assistant for ${USER_NAME}. ` +
    `It is currently ${timeCtx} (${hour}:00). ` +
    `Should you send a brief check-in message? Consider: ` +
    `- Don't check in too often (max 2-3 times per day) ` +
    `- Skip late night (after 10pm) and early morning (before 8am) ` +
    `- A good check-in has a specific, actionable suggestion ` +
    `Answer with exactly "Yes" or "No" on the first line, then optionally explain.`
  );

  if (!shouldCheckin(decision)) {
    ctx.log(`skipped — LLM said no (${timeCtx})`);
    return;
  }

  // Step 2: Generate the actual check-in message
  const message = await ctx.llm(
    `You are a personal assistant for ${USER_NAME}. ` +
    `Write a brief ${timeCtx} check-in (2-3 sentences). ` +
    `Include one actionable suggestion. Be warm but concise.`
  );

  await ctx.send(message);
  ctx.log("check-in sent");
}
