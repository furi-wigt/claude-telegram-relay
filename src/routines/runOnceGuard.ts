/**
 * Run-once-per-day guard for scheduled routines.
 *
 * Prevents a routine from running more than once per calendar day, which
 * is necessary when autorestart:true is set in PM2 — on crash, PM2 restarts
 * the process immediately, but we only want the routine to send once per day.
 *
 * Usage:
 *   const LAST_RUN_FILE = join(import.meta.dir, "../../logs/morning-summary.lastrun");
 *   if (shouldSkipToday(LAST_RUN_FILE)) { process.exit(0); }
 *   // ... run the routine ...
 *   markRanToday(LAST_RUN_FILE);
 */

import { readFileSync, writeFileSync } from "fs";

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
 * Write today's date to the lastrun file.
 * Call this after the routine has successfully sent its message.
 */
export function markRanToday(lastRunFile: string): void {
  writeFileSync(lastRunFile, todayDate(), "utf8");
}
