#!/usr/bin/env bun
/**
 * @routine routine-scheduler
 * @description Reads routines.config.json, registers cron schedules, fires jobs via webhook.
 */

import { CronJob } from "cron";
import { watch } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadEnv } from "../src/config/envLoader.ts";
import { loadRoutineConfigs } from "../src/routines/routineConfig.ts";
import { interpolate } from "../src/routines/interpolate.ts";
import type { RoutineConfig } from "../src/routines/routineConfig.ts";

loadEnv();

// ============================================================
// DATE KEY
// ============================================================

function toDateKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ============================================================
// WEBHOOK
// ============================================================

async function fireJob(
  config: RoutineConfig,
  webhookPort: string,
  webhookSecret: string,
): Promise<void> {
  const body = {
    type: "routine",
    executor: config.name,
    title: config.name,
    priority: config.priority ?? "normal",
    source: "cron",
    dedup_key: `routine:${config.name}:${toDateKey()}`,
    payload:
      config.type === "prompt"
        ? { prompt: interpolate(config.prompt ?? "") }
        : { config: config.params ?? {} },
  };

  try {
    const res = await fetch(`http://localhost:${webhookPort}/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${webhookSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(
        `[scheduler] Webhook POST failed for ${config.name}: HTTP ${res.status}`,
      );
    } else {
      console.log(
        `[scheduler] Fired job for ${config.name} (dedup: ${body.dedup_key})`,
      );
    }
  } catch (err) {
    console.error(`[scheduler] Failed to fire job for ${config.name}:`, err);
  }
}

// ============================================================
// SCHEDULER STATE
// ============================================================

const activeTasks = new Map<string, { stop: () => void }>();

function stopAll(): void {
  for (const [name, task] of activeTasks) {
    task.stop();
    console.log(`[scheduler] Stopped: ${name}`);
  }
  activeTasks.clear();
}

function validateCron(expr: string): boolean {
  // Basic validation: must have 5 or 6 fields
  const parts = expr.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6;
}

const validGroups = new Set([
  "OPERATIONS",
  "ENGINEERING",
  "SECURITY",
  "CLOUD",
  "STRATEGY",
  "COMMAND_CENTER",
]);

function loadAndSchedule(webhookPort: string, webhookSecret: string): void {
  stopAll();

  const configs = loadRoutineConfigs();
  console.log(`[scheduler] Loading ${configs.length} routine configs...`);

  for (const config of configs) {
    if (!config.enabled) {
      console.log(`[scheduler] Skipping disabled routine: ${config.name}`);
      continue;
    }

    if (!validateCron(config.schedule)) {
      console.warn(
        `[scheduler] Invalid cron expression for ${config.name}: "${config.schedule}" — skipping`,
      );
      continue;
    }

    if (!validGroups.has(config.group)) {
      console.warn(
        `[scheduler] Unknown group "${config.group}" for routine ${config.name} — will use OPERATIONS fallback`,
      );
    }

    if (config.type === "prompt" && !config.prompt) {
      console.warn(
        `[scheduler] Prompt-type routine ${config.name} missing prompt field — skipping`,
      );
      continue;
    }

    try {
      const job = new CronJob(
        config.schedule,
        () => {
          fireJob(config, webhookPort, webhookSecret).catch(console.error);
        },
        null,
        true, // start immediately
        undefined, // timezone (use system default)
      );

      activeTasks.set(config.name, { stop: () => job.stop() });
      console.log(`[scheduler] Scheduled: ${config.name} (${config.schedule})`);
    } catch (err) {
      console.error(`[scheduler] Failed to schedule ${config.name}:`, err);
    }
  }

  console.log(`[scheduler] Active schedules: ${activeTasks.size}`);
}

// ============================================================
// HOT RELOAD
// ============================================================

function setupHotReload(webhookPort: string, webhookSecret: string): void {
  const configPaths = [
    join(import.meta.dir, "../config/routines.config.json"),
    join(homedir(), ".claude-relay/routines.config.json"),
  ];

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  for (const configPath of configPaths) {
    try {
      watch(configPath, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          console.log("[scheduler] Config changed — reloading schedules...");
          loadAndSchedule(webhookPort, webhookSecret);
        }, 500);
      });
    } catch {
      // File might not exist (user config is optional)
    }
  }

  process.on("SIGUSR1", () => {
    console.log("[scheduler] SIGUSR1 — reloading config...");
    loadAndSchedule(webhookPort, webhookSecret);
  });

  process.on("SIGUSR2", () => {
    console.log("[scheduler] SIGUSR2 — validating handlers + reloading...");
    loadAndSchedule(webhookPort, webhookSecret);
  });
}

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  const webhookPort = process.env.JOBS_WEBHOOK_PORT;
  const webhookSecret = process.env.JOBS_WEBHOOK_SECRET;

  if (!webhookPort || !webhookSecret) {
    console.error(
      "[scheduler] JOBS_WEBHOOK_PORT and JOBS_WEBHOOK_SECRET must be set. Exiting.",
    );
    process.exit(0); // exit 0 to avoid PM2 restart loop
    return;
  }

  console.log(
    `[scheduler] Starting routine scheduler (webhook: http://localhost:${webhookPort}/jobs)`,
  );

  loadAndSchedule(webhookPort, webhookSecret);
  setupHotReload(webhookPort, webhookSecret);

  // SIGTERM: clean shutdown
  process.on("SIGTERM", () => {
    console.log("[scheduler] SIGTERM received — stopping all cron jobs...");
    stopAll();
    process.exit(0);
  });

  console.log("[scheduler] Running. Waiting for cron triggers...");
}

const _isEntry =
  import.meta.main ||
  process.env.pm_exec_path === import.meta.url?.replace("file://", "");

if (_isEntry) {
  main().catch((err) => {
    console.error("[scheduler] Fatal error:", err);
    process.exit(0);
  });
}
