#!/usr/bin/env bun

/**
 * @routine log-cleanup
 * @description Delete PM2 logs from ./logs/ and observability JSONL logs older than the retention threshold
 * @schedule 0 6 * * 1  (Monday 6:00 AM)
 * @target no Telegram message unless files were deleted
 */

/**
 * Log Cleanup Routine
 *
 * Schedule: 6:00 AM every Monday (cron: 0 6 * * 1)
 *
 * Scans two log directories and deletes files older than the retention threshold:
 *   1. ./logs/        — PM2 service logs (*.log)
 *   2. LOG_DIR        — observability JSONL traces (*.jsonl)
 *
 * Sends a Telegram summary only when files were actually deleted.
 *
 * Configuration (via .env):
 *   LOG_CLEANUP_RETAIN_DAYS  — days to keep log files (default: 7)
 *   LOG_CLEANUP_PM2_DIR      — override PM2 log dir (default: {PROJECT_ROOT}/logs)
 *   LOG_CLEANUP_OBS_DIR      — override observability log dir (default: LOG_DIR or ~/.claude-relay/logs)
 *   DRY_RUN=true             — preview what would be deleted without deleting
 *
 * Run manually: bun run routines/log-cleanup.ts
 * Dry run:      DRY_RUN=true bun run routines/log-cleanup.ts
 */

import { readdir, stat, unlink } from "fs/promises";
import { join, dirname } from "path";
import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";
import { getObservabilityConfig, getPm2LogsDir } from "../config/observability.ts";

// ============================================================
// TYPES
// ============================================================

export interface CleanupConfig {
  retainDays: number;
  pm2LogDir: string;
  obsLogDir: string;
  dryRun: boolean;
}

export interface FileEntry {
  path: string;
  mtimeMs: number;
}

export interface CleanupResult {
  pm2Deleted: number;
  obsDeleted: number;
  pm2Total: number;
  obsTotal: number;
  dryRun: boolean;
  retainDays: number;
  errors: string[];
}

// ============================================================
// CONFIG
// ============================================================

export function parseConfig(projectRoot: string): CleanupConfig {
  const retainDays = Number(process.env.LOG_CLEANUP_RETAIN_DAYS) || 7;
  const obsConfig = getObservabilityConfig();

  return {
    retainDays,
    pm2LogDir: process.env.LOG_CLEANUP_PM2_DIR || getPm2LogsDir(projectRoot),
    obsLogDir: process.env.LOG_CLEANUP_OBS_DIR || obsConfig.logDir,
    dryRun: process.env.DRY_RUN === "true",
  };
}

// ============================================================
// FILE SCANNING
// ============================================================

/**
 * List files in a directory matching the given extensions.
 * Returns empty array if the directory does not exist.
 *
 * @param dir        — directory to scan
 * @param exts       — file extensions to include (e.g. ['.log', '.jsonl'])
 * @param filterFn   — optional filename filter (for testing)
 */
export async function scanFiles(
  dir: string,
  exts: string[],
  filterFn?: (filename: string) => boolean
): Promise<FileEntry[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    // Directory does not exist or is not accessible — skip silently
    return [];
  }

  const results: FileEntry[] = [];

  for (const file of files) {
    if (!exts.some((ext) => file.endsWith(ext))) continue;
    if (filterFn && !filterFn(file)) continue;

    const fp = join(dir, file);
    try {
      const s = await stat(fp);
      results.push({ path: fp, mtimeMs: s.mtimeMs });
    } catch {
      // stat failed — skip this file
    }
  }

  return results;
}

// ============================================================
// AGE FILTER
// ============================================================

/**
 * Return only files whose last-modified time is at or beyond the retention boundary.
 * A file exactly `retainDays` old is considered stale (boundary is inclusive).
 */
export function filterStale(entries: FileEntry[], retainDays: number): FileEntry[] {
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  return entries.filter((e) => e.mtimeMs <= cutoff);
}

// ============================================================
// DELETION
// ============================================================

/**
 * Delete the given files.
 * In dry-run mode, logs what would be deleted and returns the count without touching the filesystem.
 * Continues on individual file errors (best-effort).
 *
 * @returns number of files successfully deleted (or would-be-deleted in dry-run)
 */
export async function deleteFiles(
  entries: FileEntry[],
  dryRun: boolean
): Promise<number> {
  if (entries.length === 0) return 0;

  if (dryRun) {
    for (const e of entries) {
      console.log(`[DRY RUN] Would delete: ${e.path}`);
    }
    return entries.length;
  }

  let deleted = 0;
  for (const e of entries) {
    try {
      await unlink(e.path);
      deleted++;
    } catch (err) {
      console.warn(`Failed to delete ${e.path}:`, err);
    }
  }
  return deleted;
}

// ============================================================
// REPORT BUILDERS
// ============================================================

export function buildReport(result: CleanupResult): string {
  const mode = result.dryRun ? " [DRY RUN]" : "";
  const lines: string[] = [];

  lines.push(`Log Cleanup Report${mode}`);
  lines.push("=".repeat(40));
  lines.push(`Retain threshold:    ${result.retainDays} days`);
  lines.push(`PM2 logs scanned:    ${result.pm2Total}`);
  lines.push(`PM2 logs deleted:    ${result.pm2Deleted}`);
  lines.push(`Obs logs scanned:    ${result.obsTotal}`);
  lines.push(`Obs logs deleted:    ${result.obsDeleted}`);

  if (result.errors.length > 0) {
    lines.push("");
    lines.push(`Errors (${result.errors.length}):`);
    for (const e of result.errors) {
      lines.push(`  ${e}`);
    }
  }

  return lines.join("\n");
}

export function buildTelegramMessage(result: CleanupResult): string {
  const mode = result.dryRun ? " (dry run)" : "";
  const totalDeleted = result.pm2Deleted + result.obsDeleted;
  const lines: string[] = [];

  if (totalDeleted === 0) {
    lines.push(`Log Cleanup${mode}: nothing to remove`);
    lines.push(`All logs within ${result.retainDays}-day retention window.`);
    return lines.join("\n");
  }

  lines.push(`Log Cleanup Complete${mode}`);
  lines.push("");
  lines.push(`Retention: ${result.retainDays} days`);
  lines.push(`PM2 logs:  ${result.pm2Deleted} deleted of ${result.pm2Total} scanned`);
  lines.push(`Obs logs:  ${result.obsDeleted} deleted of ${result.obsTotal} scanned`);

  if (result.errors.length > 0) {
    lines.push(`Errors:    ${result.errors.length}`);
  }

  return lines.join("\n");
}

// ============================================================
// MAIN ORCHESTRATOR
// ============================================================

export async function runLogCleanup(
  configOverride?: Partial<CleanupConfig>
): Promise<CleanupResult> {
  const projectRoot = dirname(import.meta.dir);
  const config: CleanupConfig = {
    ...parseConfig(projectRoot),
    ...configOverride,
  };

  console.log(
    `Starting log cleanup (retainDays=${config.retainDays}, dryRun=${config.dryRun})`
  );
  console.log(`  PM2 logs dir:  ${config.pm2LogDir}`);
  console.log(`  Obs logs dir:  ${config.obsLogDir}`);

  const errors: string[] = [];

  // --- PM2 logs ---
  const pm2All = await scanFiles(config.pm2LogDir, [".log"]);
  const pm2Stale = filterStale(pm2All, config.retainDays);
  console.log(`PM2 logs: ${pm2All.length} total, ${pm2Stale.length} stale`);
  const pm2Deleted = await deleteFiles(pm2Stale, config.dryRun);

  // --- Observability JSONL logs ---
  const obsAll = await scanFiles(config.obsLogDir, [".jsonl"]);
  const obsStale = filterStale(obsAll, config.retainDays);
  console.log(`Obs logs: ${obsAll.length} total, ${obsStale.length} stale`);
  const obsDeleted = await deleteFiles(obsStale, config.dryRun);

  const result: CleanupResult = {
    pm2Deleted,
    obsDeleted,
    pm2Total: pm2All.length,
    obsTotal: obsAll.length,
    dryRun: config.dryRun,
    retainDays: config.retainDays,
    errors,
  };

  console.log(buildReport(result));
  return result;
}

// ============================================================
// ENTRY POINT
// ============================================================

async function main(): Promise<void> {
  const result = await runLogCleanup();

  const totalDeleted = result.pm2Deleted + result.obsDeleted;

  if (totalDeleted > 0 && validateGroup("GENERAL")) {
    const message = buildTelegramMessage(result);
    await sendAndRecord(GROUPS.GENERAL.chatId, message, {
      routineName: "log-cleanup",
      agentId: "general-assistant",
      topicId: GROUPS.GENERAL.topicId,
    });
    console.log("Summary sent to General group");
  } else if (totalDeleted === 0) {
    console.log("Nothing deleted — no Telegram message sent");
  } else {
    console.warn("GENERAL group not configured — skipping Telegram notification");
  }

  process.exit(0);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Error running log cleanup:", error);
    process.exit(0); // exit 0 so PM2 does not immediately restart
  });
}
