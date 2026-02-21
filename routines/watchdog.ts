#!/usr/bin/env bun

/**
 * @routine watchdog
 * @description System health watchdog that monitors bot and services
 * @target System
 */
// @schedule 0 */2 * * *

/**
 * Watchdog Routine — PM2 Health Monitor
 *
 * Schedule: Every 2 hours (cron: 0 * /2 * * *)
 * Target: General AI Assistant group
 *
 * Checks the health of all PM2-managed processes:
 * - Detects stopped or errored processes
 * - Flags high restart counts (potential crash loops)
 * - Optionally restarts failed always-on processes (telegram-relay)
 * - Sends alerts to the General group only when problems are found
 *
 * Run manually: bun run routines/watchdog.ts
 */

import { createRequire } from "module";
import { sendToGroup } from "../src/utils/sendToGroup.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";

// ============================================================
// CONFIGURATION
// ============================================================

interface MonitoredProcess {
  name: string;
  alwaysOn: boolean;
}

/** Load processes to monitor from ecosystem.config.cjs (auto-discovery) */
function loadMonitoredProcesses(): MonitoredProcess[] {
  try {
    const require = createRequire(import.meta.url);
    const ecosystemPath = new URL("../ecosystem.config.cjs", import.meta.url).pathname;
    const config = require(ecosystemPath);

    if (!config?.apps || !Array.isArray(config.apps)) {
      throw new Error("Invalid ecosystem config: missing apps array");
    }

    const processes = config.apps.map((app: { name: string; autorestart?: boolean }) => ({
      name: app.name,
      alwaysOn: app.autorestart === true,
    }));

    console.log(`Loaded ${processes.length} processes from ecosystem.config.cjs`);
    return processes;
  } catch (error) {
    console.error("Failed to load ecosystem config, using fallback list:", error);
    return [
      { name: "telegram-relay", alwaysOn: true },
      { name: "enhanced-morning-summary", alwaysOn: false },
      { name: "smart-checkin", alwaysOn: false },
      { name: "night-summary", alwaysOn: false },
      { name: "weekly-etf", alwaysOn: false },
      { name: "watchdog", alwaysOn: false },
    ];
  }
}

/** Processes managed by PM2 ecosystem.config.cjs (auto-discovered at runtime) */
const MONITORED_PROCESSES = loadMonitoredProcesses();

/** Restart count above this triggers an alert */
const RESTART_THRESHOLD = 10;

/** Auto-restart always-on processes that are stopped/errored */
const AUTO_RESTART_ALWAYS_ON = true;

// ============================================================
// PM2 INTERFACE
// ============================================================

interface PM2Process {
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

async function getPM2Processes(): Promise<PM2Process[]> {
  try {
    const proc = Bun.spawn(["npx", "pm2", "jlist"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error("pm2 jlist failed:", stderr);
      return [];
    }

    // pm2 jlist outputs JSON array
    const parsed = JSON.parse(stdout.trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Failed to query PM2:", error);
    return [];
  }
}

async function restartProcess(name: string): Promise<boolean> {
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

interface HealthIssue {
  process: string;
  severity: "warning" | "critical";
  message: string;
  autoFixed: boolean;
}

function formatUptime(uptimeMs: number): string {
  const seconds = Math.floor(uptimeMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatMemory(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function checkHealth(processes: PM2Process[]): Promise<{
  issues: HealthIssue[];
  statusLines: string[];
}> {
  const issues: HealthIssue[] = [];
  const statusLines: string[] = [];
  const now = Date.now();

  // Map PM2 processes by name
  const pm2Map = new Map<string, PM2Process>();
  for (const p of processes) {
    pm2Map.set(p.name, p);
  }

  for (const monitored of MONITORED_PROCESSES) {
    const proc = pm2Map.get(monitored.name);

    if (!proc) {
      // Process not found in PM2 at all
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

    // Status line for healthy report
    const uptimeStr = uptime > 0 ? formatUptime(uptime) : "-";
    const memStr = memory > 0 ? formatMemory(memory) : "-";
    statusLines.push(
      `  ${monitored.name}: ${status} | up ${uptimeStr} | ${memStr} | ${restarts} restarts`
    );

    // Check: always-on process is stopped or errored
    if (monitored.alwaysOn && (status === "stopped" || status === "errored")) {
      let autoFixed = false;

      if (AUTO_RESTART_ALWAYS_ON) {
        console.log(`Auto-restarting ${monitored.name}...`);
        autoFixed = await restartProcess(monitored.name);
      }

      issues.push({
        process: monitored.name,
        severity: "critical",
        message: `Status: ${status}${autoFixed ? " (auto-restarted)" : ""}`,
        autoFixed,
      });
    }

    // Check: high restart count (possible crash loop)
    if (restarts > RESTART_THRESHOLD) {
      issues.push({
        process: monitored.name,
        severity: restarts > RESTART_THRESHOLD * 3 ? "critical" : "warning",
        message: `High restart count: ${restarts} (threshold: ${RESTART_THRESHOLD})`,
        autoFixed: false,
      });
    }

    // Check: cron-based process stuck in errored state
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

function buildAlert(issues: HealthIssue[], statusLines: string[]): string | null {
  if (issues.length === 0) {
    // No issues — stay silent
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
// MAIN
// ============================================================

async function main() {
  console.log("Running Watchdog...");

  if (!validateGroup("GENERAL")) {
    console.error("Cannot run — GENERAL group not configured in .env");
    console.error("Set GROUP_GENERAL_CHAT_ID in your .env file");
    process.exit(1);
  }

  const processes = await getPM2Processes();

  if (processes.length === 0) {
    console.log("No PM2 processes found — PM2 may not be running");
    // Still alert since this is unexpected if the watchdog itself is running via PM2
    await sendToGroup(
      GROUPS.GENERAL.chatId,
      "Watchdog: No PM2 processes detected. PM2 may not be running or ecosystem is not started. Run: npx pm2 start ecosystem.config.cjs",
      { topicId: GROUPS.GENERAL.topicId }
    );
    return;
  }

  console.log(`Found ${processes.length} PM2 processes`);
  const { issues, statusLines } = await checkHealth(processes);

  console.log(`Issues found: ${issues.length}`);

  const alert = buildAlert(issues, statusLines);

  if (alert) {
    await sendToGroup(GROUPS.GENERAL.chatId, alert, { topicId: GROUPS.GENERAL.topicId });
    console.log("Alert sent to General group");
  } else {
    console.log("All processes healthy — no alert needed");
  }
}

main().catch((error) => {
  console.error("Error running watchdog:", error);
  process.exit(1);
});
