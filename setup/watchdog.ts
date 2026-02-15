/**
 * Watchdog Service - Ensures all cron jobs run successfully
 *
 * Monitors:
 * - Morning briefing (7am daily)
 * - Night summary (11pm daily)
 * - Future scheduled jobs
 *
 * Features:
 * - Checks if jobs executed recently
 * - Validates job output and success
 * - Alerts via Telegram if jobs fail or don't run
 * - Self-monitoring to detect watchdog failures
 *
 * Schedule this to run every 30 minutes with launchd.
 * Run manually: bun run setup/watchdog.ts
 */

import { createClient } from "@supabase/supabase-js";
import { existsSync, statSync, readFileSync } from "fs";
import { join } from "path";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

const PROJECT_ROOT = join(import.meta.dir, "..");
const LOGS_DIR = join(PROJECT_ROOT, "logs");

// ============================================================
// JOB DEFINITIONS
// ============================================================

interface JobSchedule {
  name: string;
  label: string; // launchd service label
  script: string;
  schedule: string; // Human-readable schedule
  expectedHours: number[]; // Hours when job should have run
  maxDelayMinutes: number; // How late is acceptable before alerting
  checkLogFile: boolean; // Should we check log file for success?
}

const JOBS: JobSchedule[] = [
  {
    name: "Morning Briefing",
    label: "com.claude.morning-briefing",
    script: "examples/morning-briefing-etf.ts",
    schedule: "Daily at 7:00 AM",
    expectedHours: [7],
    maxDelayMinutes: 30,
    checkLogFile: true,
  },
  {
    name: "Night Summary",
    label: "com.claude.night-summary",
    script: "examples/night-summary.ts",
    schedule: "Daily at 11:00 PM",
    expectedHours: [23],
    maxDelayMinutes: 30,
    checkLogFile: true,
  },
];

// ============================================================
// TELEGRAM HELPER
// ============================================================

async function sendAlert(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: `🚨 **Watchdog Alert**\n\n${message}`,
          parse_mode: "Markdown",
        }),
      }
    );

    return response.ok;
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

// ============================================================
// JOB MONITORING
// ============================================================

interface JobStatus {
  job: JobSchedule;
  running: boolean;
  lastRunTime?: Date;
  shouldHaveRun: boolean;
  isOverdue: boolean;
  logExists: boolean;
  logHasErrors: boolean;
  errorDetails?: string;
}

async function checkJobRunning(job: JobSchedule): Promise<boolean> {
  // Try PM2 first (cross-platform)
  try {
    const proc = Bun.spawn(["npx", "pm2", "jlist"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const code = await proc.exited;

    if (code === 0) {
      // PM2 is available - check if process exists
      try {
        const processes = JSON.parse(output);
        const pm2Name = job.label.replace("com.claude.", ""); // e.g., "morning-briefing"
        return processes.some((p: any) => p.name === pm2Name);
      } catch {
        return false;
      }
    }
  } catch {
    // PM2 not available, fall through to launchd
  }

  // Fallback to launchd (macOS only)
  try {
    const proc = Bun.spawn(["launchctl", "list", job.label], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const code = await proc.exited;

    // launchctl list returns 0 if job exists, non-zero otherwise
    return code === 0 && output.includes(job.label);
  } catch {
    return false;
  }
}

function getLogFilePath(job: JobSchedule): string {
  return join(LOGS_DIR, `${job.label}.log`);
}

function getLogLastModified(logPath: string): Date | null {
  try {
    if (!existsSync(logPath)) return null;
    const stats = statSync(logPath);
    return stats.mtime;
  } catch {
    return null;
  }
}

function checkLogForErrors(logPath: string): {
  hasErrors: boolean;
  errorDetails?: string;
} {
  try {
    if (!existsSync(logPath)) {
      return { hasErrors: true, errorDetails: "Log file does not exist" };
    }

    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n");
    const recentLines = lines.slice(-50); // Check last 50 lines

    // Look for common error patterns
    const errorPatterns = [
      /error:/i,
      /failed/i,
      /exception/i,
      /cannot/i,
      /missing/i,
      /undefined/i,
      /exit.*1/i,
    ];

    for (const line of recentLines) {
      for (const pattern of errorPatterns) {
        if (pattern.test(line)) {
          return {
            hasErrors: true,
            errorDetails: line.substring(0, 200),
          };
        }
      }
    }

    // Check for success indicators
    const successPatterns = [
      /success/i,
      /sent successfully/i,
      /completed/i,
      /done/i,
    ];

    const hasSuccess = recentLines.some((line) =>
      successPatterns.some((p) => p.test(line))
    );

    if (!hasSuccess && content.length > 0) {
      return {
        hasErrors: true,
        errorDetails: "No success confirmation found in logs",
      };
    }

    return { hasErrors: false };
  } catch (error) {
    return {
      hasErrors: true,
      errorDetails: `Cannot read log: ${error}`,
    };
  }
}

function shouldJobHaveRun(job: JobSchedule): boolean {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  // Check if we're past the scheduled time for any expected hour
  for (const hour of job.expectedHours) {
    if (currentHour > hour) {
      return true;
    }
    if (currentHour === hour && currentMinute >= job.maxDelayMinutes) {
      return true;
    }
  }

  return false;
}

function isJobOverdue(job: JobSchedule, lastRun: Date | null): boolean {
  if (!lastRun) return shouldJobHaveRun(job);

  const now = new Date();
  const currentHour = now.getHours();

  // Find the most recent expected run time
  let mostRecentExpectedRun: Date | null = null;

  for (const hour of job.expectedHours) {
    const expectedRun = new Date(now);
    expectedRun.setHours(hour, 0, 0, 0);

    // If the scheduled time is in the future today, check yesterday
    if (expectedRun > now) {
      expectedRun.setDate(expectedRun.getDate() - 1);
    }

    if (
      !mostRecentExpectedRun ||
      expectedRun > mostRecentExpectedRun
    ) {
      mostRecentExpectedRun = expectedRun;
    }
  }

  if (!mostRecentExpectedRun) return false;

  // Job is overdue if it hasn't run since the most recent expected time
  // plus the max delay window
  const deadline = new Date(mostRecentExpectedRun);
  deadline.setMinutes(deadline.getMinutes() + job.maxDelayMinutes);

  return lastRun < deadline && now > deadline;
}

async function checkJob(job: JobSchedule): Promise<JobStatus> {
  const running = await checkJobRunning(job);
  const logPath = getLogFilePath(job);
  const lastRunTime = getLogLastModified(logPath);
  const shouldRun = shouldJobHaveRun(job);
  const overdue = isJobOverdue(job, lastRunTime);

  let logExists = existsSync(logPath);
  let logHasErrors = false;
  let errorDetails: string | undefined;

  if (job.checkLogFile && logExists) {
    const logCheck = checkLogForErrors(logPath);
    logHasErrors = logCheck.hasErrors;
    errorDetails = logCheck.errorDetails;
  }

  return {
    job,
    running,
    lastRunTime: lastRunTime || undefined,
    shouldHaveRun: shouldRun,
    isOverdue: overdue,
    logExists,
    logHasErrors,
    errorDetails,
  };
}

// ============================================================
// WATCHDOG STATE PERSISTENCE
// ============================================================

interface WatchdogState {
  lastCheckTime: string;
  alertsSent: {
    jobName: string;
    issue: string;
    timestamp: string;
  }[];
}

const STATE_FILE = join(PROJECT_ROOT, "logs", "watchdog-state.json");

function loadState(): WatchdogState {
  try {
    if (existsSync(STATE_FILE)) {
      const content = readFileSync(STATE_FILE, "utf-8");
      return JSON.parse(content);
    }
  } catch (error) {
    console.error("Failed to load watchdog state:", error);
  }

  return {
    lastCheckTime: new Date().toISOString(),
    alertsSent: [],
  };
}

function saveState(state: WatchdogState): void {
  try {
    const { writeFileSync } = require("fs");
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error("Failed to save watchdog state:", error);
  }
}

function shouldSendAlert(
  state: WatchdogState,
  jobName: string,
  issue: string
): boolean {
  // Don't spam - only alert once per issue per 6 hours
  const sixHoursAgo = new Date();
  sixHoursAgo.setHours(sixHoursAgo.getHours() - 6);

  const recentAlert = state.alertsSent.find(
    (a) =>
      a.jobName === jobName &&
      a.issue === issue &&
      new Date(a.timestamp) > sixHoursAgo
  );

  return !recentAlert;
}

function recordAlert(
  state: WatchdogState,
  jobName: string,
  issue: string
): void {
  state.alertsSent.push({
    jobName,
    issue,
    timestamp: new Date().toISOString(),
  });

  // Keep only last 50 alerts
  if (state.alertsSent.length > 50) {
    state.alertsSent = state.alertsSent.slice(-50);
  }
}

// ============================================================
// MAIN WATCHDOG LOGIC
// ============================================================

async function runWatchdog() {
  console.log("🐕 Watchdog check starting...");

  const state = loadState();
  const now = new Date();
  const issues: string[] = [];

  // Check all jobs
  for (const job of JOBS) {
    console.log(`\nChecking: ${job.name}`);

    const status = await checkJob(job);

    console.log(`  Running: ${status.running ? "✓" : "✗"}`);
    console.log(`  Last run: ${status.lastRunTime?.toLocaleString() || "Never"}`);
    console.log(`  Should have run: ${status.shouldHaveRun ? "Yes" : "No"}`);
    console.log(`  Overdue: ${status.isOverdue ? "YES ⚠️" : "No"}`);

    if (status.logExists) {
      console.log(
        `  Log errors: ${status.logHasErrors ? "YES ⚠️" : "No"}`
      );
    }

    // Build alert messages
    if (!status.running) {
      const issue = "not_loaded";
      if (shouldSendAlert(state, job.name, issue)) {
        issues.push(
          `**${job.name}** is not loaded in launchd.\nSchedule: ${job.schedule}\nLabel: ${job.label}`
        );
        recordAlert(state, job.name, issue);
      }
    }

    if (status.isOverdue) {
      const issue = "overdue";
      if (shouldSendAlert(state, job.name, issue)) {
        const lastRunStr = status.lastRunTime
          ? status.lastRunTime.toLocaleString()
          : "Never";
        issues.push(
          `**${job.name}** is overdue.\nSchedule: ${job.schedule}\nLast run: ${lastRunStr}\nMax delay: ${job.maxDelayMinutes} minutes`
        );
        recordAlert(state, job.name, issue);
      }
    }

    if (status.logHasErrors && status.errorDetails) {
      const issue = "log_errors";
      if (shouldSendAlert(state, job.name, issue)) {
        issues.push(
          `**${job.name}** has errors in logs.\n\`\`\`\n${status.errorDetails}\n\`\`\``
        );
        recordAlert(state, job.name, issue);
      }
    }
  }

  // Update state
  state.lastCheckTime = now.toISOString();
  saveState(state);

  // Send alerts if needed
  if (issues.length > 0) {
    const alertMessage = issues.join("\n\n---\n\n");
    console.log("\n⚠️  Issues detected, sending alert...");
    const sent = await sendAlert(alertMessage);

    if (sent) {
      console.log("✓ Alert sent successfully");
    } else {
      console.error("✗ Failed to send alert");
    }
  } else {
    console.log("\n✓ All jobs healthy");
  }

  console.log(`\nWatchdog check completed at ${now.toLocaleString()}`);
}

// ============================================================
// SELF-MONITORING
// ============================================================

async function checkWatchdogHealth() {
  // Try PM2 first
  try {
    const proc = Bun.spawn(["npx", "pm2", "jlist"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const code = await proc.exited;

    if (code === 0) {
      try {
        const processes = JSON.parse(output);
        const watchdogExists = processes.some((p: any) => p.name === "watchdog");
        if (!watchdogExists) {
          console.warn(
            "⚠️  Watchdog service is not in PM2. Run setup to enable."
          );
        }
        return;
      } catch {
        // Fall through to launchd check
      }
    }
  } catch {
    // PM2 not available, try launchd
  }

  // Fallback to launchd (macOS only)
  const watchdogLabel = "com.claude.watchdog";

  try {
    const proc = Bun.spawn(["launchctl", "list", watchdogLabel], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const code = await proc.exited;

    if (code !== 0) {
      console.warn(
        "⚠️  Watchdog service is not loaded in launchd. Run setup to enable."
      );
    }
  } catch {
    console.warn("⚠️  Could not check watchdog service status");
  }
}

// ============================================================
// ENTRY POINT
// ============================================================

async function main() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  // Check watchdog's own health
  await checkWatchdogHealth();

  // Run watchdog checks
  await runWatchdog();
}

main().catch((error) => {
  console.error("Watchdog error:", error);
  process.exit(1);
});
