/**
 * Run-once guard for scheduled routines.
 *
 * Two guard strategies:
 *
 * shouldSkipToday(file) — calendar-day guard.
 *   Blocks if the routine already ran today (same YYYY-MM-DD in local timezone).
 *   Use for morning-summary: safe because it is never triggered manually.
 *
 * shouldSkipRecently(file, cooldownHours) — time-based cooldown.
 *   Blocks only if the routine ran within the last N hours.
 *   Use for night-summary: allows a daytime manual run without blocking
 *   the scheduled 11 PM cron run (2h cooldown clears well before 23:00).
 *
 * Usage:
 *   const LAST_RUN_FILE = join(getPm2LogsDir(), "night-summary.lastrun");
 *   if (shouldSkipRecently(LAST_RUN_FILE, 2)) { process.exit(0); }
 *   // ... run the routine ...
 *   markRanToday(LAST_RUN_FILE);
 */

import { readFileSync, statSync, writeFileSync } from "fs";

/**
 * YYYY-MM-DD string for the current day in the configured local timezone.
 *
 * IMPORTANT: Do NOT use toISOString().slice(0,10) — that returns UTC.
 * At 7 AM SGT (UTC+8), UTC is still 11 PM the previous day, which causes
 * the morning-summary to falsely match yesterday's lastrun flag and skip.
 *
 * en-CA locale always formats as YYYY-MM-DD regardless of system locale.
 */
function todayDate(): string {
  const tz = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

/**
 * Returns true if the routine already ran today (i.e. the lastrun file
 * contains today's date). Returns false if the file doesn't exist or
 * contains any other date.
 */
export function shouldSkipToday(lastRunFile: string): boolean {
  try {
    const lastRun = readFileSync(lastRunFile, "utf8").trim();
    return lastRun === todayDate();
  } catch {
    // File doesn't exist — first run of the day, proceed
    return false;
  }
}

/**
 * Returns true if the routine ran within the last `cooldownHours` hours.
 * Returns false if the lastrun file does not exist or is older than the cooldown.
 *
 * Use instead of shouldSkipToday() for routines that have a fixed schedule
 * but may also be triggered manually (e.g. night-summary at 23:00).
 * A 2-hour cooldown prevents PM2 crash-restart duplicates while allowing
 * a 3 PM manual run to not block the 11 PM scheduled cron.
 */
export function shouldSkipRecently(lastRunFile: string, cooldownHours: number): boolean {
  try {
    const { mtimeMs } = statSync(lastRunFile);
    const ageMs = Date.now() - mtimeMs;
    return ageMs < cooldownHours * 60 * 60 * 1000;
  } catch {
    // File doesn't exist — first run, proceed
    return false;
  }
}

/**
 * Write today's date to the lastrun file.
 * Call this after the routine has successfully sent its message.
 */
export function markRanToday(lastRunFile: string): void {
  writeFileSync(lastRunFile, todayDate(), "utf8");
}
