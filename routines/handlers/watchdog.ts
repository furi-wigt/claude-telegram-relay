/**
 * @routine watchdog
 * @description System health watchdog that monitors bot and services
 * @schedule 0 *\/2 * * *
 * @target System
 *
 * Handler — pure logic only. No standalone entry point, no PM2 boilerplate.
 * Use ctx.send() for Telegram output and ctx.log() for console output.
 */

import type { RoutineContext } from "../../src/jobs/executors/routineContext.ts";
import { createRequire } from "module";
import { getDb } from "../../src/local/db.ts";

// ============================================================
// CONFIGURATION
// ============================================================

export interface MonitoredProcess {
  name: string;
  alwaysOn: boolean;
}

/** Load processes to monitor from ecosystem.config.cjs (auto-discovery) */
export function loadMonitoredProcesses(): MonitoredProcess[] {
  try {
    const require = createRequire(import.meta.url);
    const ecosystemPath = new URL("../../ecosystem.config.cjs", import.meta.url).pathname;
    const config = require(ecosystemPath);

    if (!config?.apps || !Array.isArray(config.apps)) {
      throw new Error("Invalid ecosystem config: missing apps array");
    }

    const processes: MonitoredProcess[] = config.apps.map(
      (app: { name: string; autorestart?: boolean }) => ({
        name: app.name,
        alwaysOn: app.autorestart === true,
      })
    );

    // Ensure routine-scheduler is included if not already present
    if (!processes.some((p) => p.name === "routine-scheduler")) {
      processes.push({ name: "routine-scheduler", alwaysOn: true });
    }

    return processes;
  } catch (error) {
    return [
      { name: "telegram-relay", alwaysOn: true },
      { name: "routine-scheduler", alwaysOn: true },
      { name: "morning-summary", alwaysOn: false },
      { name: "smart-checkin", alwaysOn: false },
      { name: "night-summary", alwaysOn: false },
      { name: "weekly-etf", alwaysOn: false },
      { name: "watchdog", alwaysOn: false },
    ];
  }
}

/** Restart count above this triggers an alert */
export const RESTART_THRESHOLD = 10;

/** Auto-restart always-on processes that are stopped/errored */
export const AUTO_RESTART_ALWAYS_ON = true;

// ============================================================
// PM2 INTERFACE
// ============================================================

export interface PM2Process {
  name: string;
  pm_id: number;
  pid: number;
  status: string; // "online" | "stopped" | "errored" | "launching"
  restart_time: number;
  pm2_env: {
    pm_uptime: number;
    unstable_restarts: number;
    created_at: number;
    status: string;
  };
  monit: {
    memory: number; // bytes
    cpu: number; // percent
  };
}

export async function getPM2Processes(): Promise<PM2Process[]> {
  try {
    const proc = Bun.spawn(["npx", "pm2", "jlist"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return [];
    }

    const parsed = JSON.parse(stdout.trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function restartProcess(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["npx", "pm2", "restart", name], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

// ============================================================
// HEALTH CHECKS
// ============================================================

export interface HealthIssue {
  process: string;
  severity: "warning" | "critical";
  message: string;
  autoFixed: boolean;
}

export function formatUptime(uptimeMs: number): string {
  const seconds = Math.floor(uptimeMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatMemory(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function checkHealth(
  processes: PM2Process[],
  monitoredProcesses: MonitoredProcess[],
  restartFn: (name: string) => Promise<boolean> = restartProcess
): Promise<{
  issues: HealthIssue[];
  statusLines: string[];
}> {
  const issues: HealthIssue[] = [];
  const statusLines: string[] = [];
  const now = Date.now();

  const pm2Map = new Map<string, PM2Process>();
  for (const p of processes) {
    pm2Map.set(p.name, p);
  }

  for (const monitored of monitoredProcesses) {
    const proc = pm2Map.get(monitored.name);

    if (!proc) {
      issues.push({
        process: monitored.name,
        severity: monitored.alwaysOn ? "critical" : "warning",
        message: "Not found in PM2 — may not be started yet",
        autoFixed: false,
      });
      statusLines.push(`  ${monitored.name}: NOT FOUND`);
      continue;
    }

    const status = proc.pm2_env?.status || proc.status || "unknown";
    const restarts = proc.restart_time || 0;
    const uptime = proc.pm2_env?.pm_uptime ? now - proc.pm2_env.pm_uptime : 0;
    const memory = proc.monit?.memory || 0;
    const cpu = proc.monit?.cpu || 0;

    const uptimeStr = uptime > 0 ? formatUptime(uptime) : "-";
    const memStr = memory > 0 ? formatMemory(memory) : "-";
    statusLines.push(
      `  ${monitored.name}: ${status} | up ${uptimeStr} | ${memStr} | ${restarts} restarts`
    );

    if (monitored.alwaysOn && (status === "stopped" || status === "errored")) {
      let autoFixed = false;

      if (AUTO_RESTART_ALWAYS_ON) {
        autoFixed = await restartFn(monitored.name);
      }

      issues.push({
        process: monitored.name,
        severity: "critical",
        message: `Status: ${status}${autoFixed ? " (auto-restarted)" : ""}`,
        autoFixed,
      });
    }

    if (restarts > RESTART_THRESHOLD) {
      issues.push({
        process: monitored.name,
        severity: restarts > RESTART_THRESHOLD * 3 ? "critical" : "warning",
        message: `High restart count: ${restarts} (threshold: ${RESTART_THRESHOLD})`,
        autoFixed: false,
      });
    }

    if (!monitored.alwaysOn && status === "errored") {
      issues.push({
        process: monitored.name,
        severity: "warning",
        message: "Last run errored — check logs",
        autoFixed: false,
      });
    }
  }

  return { issues, statusLines };
}

// ============================================================
// ALERT BUILDER
// ============================================================

export function buildAlert(issues: HealthIssue[], statusLines: string[]): string | null {
  if (issues.length === 0) {
    return null;
  }

  const lines: string[] = [];
  const criticals = issues.filter((i) => i.severity === "critical");
  const warnings = issues.filter((i) => i.severity === "warning");

  lines.push("Watchdog Alert");
  lines.push("");

  if (criticals.length > 0) {
    lines.push("CRITICAL:");
    for (const issue of criticals) {
      const fixTag = issue.autoFixed ? " [auto-fixed]" : "";
      lines.push(`  [!] ${issue.process}: ${issue.message}${fixTag}`);
    }
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push("WARNINGS:");
    for (const issue of warnings) {
      lines.push(`  [~] ${issue.process}: ${issue.message}`);
    }
    lines.push("");
  }

  lines.push("Process status:");
  lines.push(...statusLines);
  lines.push("");
  lines.push("Run 'npx pm2 logs <name>' to inspect. Reply to acknowledge.");

  return lines.join("\n");
}

// ============================================================
// HEARTBEAT RESPONSIVENESS PROBE
// ============================================================

export interface ResponsivenessResult {
  ok: boolean;
  lastUserAt: string | null;
  lastBotAt: string | null;
  gapMinutes: number;
  pendingCount: number;
}

/**
 * Check if the bot is actually responding to messages.
 * Pure function — accepts a db-like object for testability.
 */
export function checkBotResponsiveness(
  db: { prepare: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined } },
  thresholdMin: number = 10,
): ResponsivenessResult {
  const lastUser = db
    .prepare("SELECT MAX(created_at) as ts FROM messages WHERE role = 'user'")
    .get() as { ts: string | null } | undefined;

  const lastBot = db
    .prepare("SELECT MAX(created_at) as ts FROM messages WHERE role = 'assistant'")
    .get() as { ts: string | null } | undefined;

  const lastUserAt = lastUser?.ts ?? null;
  const lastBotAt = lastBot?.ts ?? null;

  if (!lastUserAt) {
    return { ok: true, lastUserAt: null, lastBotAt: null, gapMinutes: 0, pendingCount: 0 };
  }

  const pending = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE role = 'user' AND created_at > COALESCE((SELECT MAX(created_at) FROM messages WHERE role = 'assistant'), '1970-01-01')"
    )
    .get() as { cnt: number } | undefined;

  const pendingCount = pending?.cnt ?? 0;

  let gapMinutes = 0;
  if (lastUserAt && lastBotAt && new Date(lastUserAt) > new Date(lastBotAt)) {
    gapMinutes = Math.round((Date.now() - new Date(lastBotAt).getTime()) / 60_000);
  } else if (lastUserAt && !lastBotAt) {
    gapMinutes = Math.round((Date.now() - new Date(lastUserAt).getTime()) / 60_000);
  }

  const ok = gapMinutes < thresholdMin || pendingCount === 0;
  return { ok, lastUserAt, lastBotAt, gapMinutes, pendingCount };
}

export function buildResponsivenessAlert(result: ResponsivenessResult): string {
  return [
    "Bot Responsiveness Alert",
    "",
    `Last user message: ${result.lastUserAt ?? "none"}`,
    `Last bot response: ${result.lastBotAt ?? "none"}`,
    `Gap: ${result.gapMinutes} minutes`,
    `Pending messages: ${result.pendingCount}`,
    "",
    "The bot may be stuck in a long-running session. Check PM2 logs or send /cancel.",
  ].join("\n");
}

// ============================================================
// HANDLER ENTRY POINT
// ============================================================

export async function run(ctx: RoutineContext): Promise<void> {
  ctx.log("Running Watchdog...");

  const monitoredProcesses = loadMonitoredProcesses();
  const processes = await getPM2Processes();

  if (processes.length === 0) {
    ctx.log("No PM2 processes found — PM2 may not be running");
    await ctx.send(
      "Watchdog: No PM2 processes detected. PM2 may not be running or ecosystem is not started. Run: npx pm2 start ecosystem.config.cjs"
    );
    return;
  }

  ctx.log(`Found ${processes.length} PM2 processes`);
  const { issues, statusLines } = await checkHealth(processes, monitoredProcesses);

  ctx.log(`Issues found: ${issues.length}`);

  const alert = buildAlert(issues, statusLines);

  if (alert) {
    await ctx.send(alert);
    ctx.log("Alert sent to General group");
  } else {
    ctx.log("All processes healthy — no alert needed");
  }

  // Heartbeat responsiveness probe
  const thresholdMin = parseInt(process.env.WATCHDOG_HEARTBEAT_THRESHOLD_MIN || "10");
  try {
    const db = getDb();
    const responsiveness = checkBotResponsiveness(db, thresholdMin);
    if (!responsiveness.ok) {
      const respAlert = buildResponsivenessAlert(responsiveness);
      await ctx.send(respAlert);
      ctx.log("Responsiveness alert sent");
    } else {
      ctx.log("Responsiveness ok");
    }
  } catch (err) {
    ctx.log(
      `Responsiveness probe failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
