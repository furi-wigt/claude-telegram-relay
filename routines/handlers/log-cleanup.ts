/**
 * @routine log-cleanup
 * @description Delete PM2 logs, observability JSONL logs, and NLAH harness state JSON files older than the retention threshold
 * @schedule 0 6 * * 1  (Monday 6:00 AM)
 * @target no Telegram message unless files were deleted
 *
 * Handler — pure logic only. No standalone entry point, no PM2 boilerplate.
 * Use ctx.send() for Telegram output and ctx.log() for console output.
 */

import type { RoutineContext } from "../../src/jobs/executors/routineContext.ts";
import { readdir, stat, unlink } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";
import { getObservabilityConfig, getPm2LogsDir } from "../../config/observability.ts";

// ============================================================
// TYPES
// ============================================================

export interface CleanupConfig {
  retainDays: number;
  pm2LogDir: string;
  obsLogDir: string;
  harnessStateDir: string;
  dryRun: boolean;
}

export interface FileEntry {
  path: string;
  mtimeMs: number;
}

export interface CleanupResult {
  pm2Deleted: number;
  obsDeleted: number;
  harnessDeleted: number;
  pm2Total: number;
  obsTotal: number;
  harnessTotal: number;
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
  const relayDir =
    process.env.RELAY_USER_DIR ||
    process.env.RELAY_DIR ||
    join(homedir(), ".claude-relay");

  return {
    retainDays,
    pm2LogDir: process.env.LOG_CLEANUP_PM2_DIR || getPm2LogsDir(projectRoot),
    obsLogDir: process.env.LOG_CLEANUP_OBS_DIR || obsConfig.logDir,
    harnessStateDir:
      process.env.LOG_CLEANUP_HARNESS_DIR || join(relayDir, "harness", "state"),
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
  lines.push(`Harness state scanned: ${result.harnessTotal}`);
  lines.push(`Harness state deleted: ${result.harnessDeleted}`);

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
  const totalDeleted = result.pm2Deleted + result.obsDeleted + result.harnessDeleted;
  const lines: string[] = [];

  if (totalDeleted === 0) {
    lines.push(`Log Cleanup${mode}: nothing to remove`);
    lines.push(`All logs within ${result.retainDays}-day retention window.`);
    return lines.join("\n");
  }

  lines.push(`Log Cleanup Complete${mode}`);
  lines.push("");
  lines.push(`Retention: ${result.retainDays} days`);
  lines.push(`PM2 logs:      ${result.pm2Deleted} deleted of ${result.pm2Total} scanned`);
  lines.push(`Obs logs:      ${result.obsDeleted} deleted of ${result.obsTotal} scanned`);
  lines.push(`Harness state: ${result.harnessDeleted} deleted of ${result.harnessTotal} scanned`);

  if (result.errors.length > 0) {
    lines.push(`Errors:        ${result.errors.length}`);
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
  console.log(`  PM2 logs dir:      ${config.pm2LogDir}`);
  console.log(`  Obs logs dir:      ${config.obsLogDir}`);
  console.log(`  Harness state dir: ${config.harnessStateDir}`);

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

  // --- NLAH harness state files ---
  const harnessAll = await scanFiles(config.harnessStateDir, [".json"]);
  const harnessStale = filterStale(harnessAll, config.retainDays);
  console.log(`Harness state: ${harnessAll.length} total, ${harnessStale.length} stale`);
  const harnessDeleted = await deleteFiles(harnessStale, config.dryRun);

  const result: CleanupResult = {
    pm2Deleted,
    obsDeleted,
    harnessDeleted,
    pm2Total: pm2All.length,
    obsTotal: obsAll.length,
    harnessTotal: harnessAll.length,
    dryRun: config.dryRun,
    retainDays: config.retainDays,
    errors,
  };

  console.log(buildReport(result));
  return result;
}

// ============================================================
// HANDLER — RoutineContext interface
// ============================================================

export async function run(ctx: RoutineContext): Promise<void> {
  const result = await runLogCleanup();
  const totalDeleted = result.pm2Deleted + result.obsDeleted + result.harnessDeleted;

  if (totalDeleted > 0) {
    await ctx.send(buildTelegramMessage(result));
  } else {
    ctx.log("Nothing deleted — no message sent");
  }
}
