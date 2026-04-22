/**
 * @routine attachment-gc
 * @description Garbage-collect old CC attachment directories under ~/.claude-relay/attachments/
 * @schedule 0 3 * * *  (daily at 03:00 local)
 * @target no Telegram message unless dirs were actually removed
 *
 * Each CC dispatch downloads attachments into a per-UUID directory. These are
 * never touched again after the dispatch completes, so without GC they
 * accumulate forever. Default max age is 7 days (tunable via
 * ATTACHMENT_GC_MAX_AGE_DAYS). Older-than-threshold dirs are removed.
 */

import type { RoutineContext } from "../../src/jobs/executors/routineContext.ts";
import { readdir, stat, rm } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

// ============================================================
// TYPES
// ============================================================

export interface AttachmentGCConfig {
  /** Base directory holding per-dispatch UUID subdirs. */
  baseDir: string;
  /** Directories with mtime older than this are candidates for deletion. */
  maxAgeMs: number;
  /** When true, log what would be removed but do not delete. */
  dryRun: boolean;
}

export interface GCResult {
  scanned: number;
  removed: number;
  bytesFreed: number;
  errors: string[];
  dryRun: boolean;
}

// ============================================================
// CONFIG
// ============================================================

export function parseConfig(): AttachmentGCConfig {
  const relayDir = process.env.RELAY_DIR || join(homedir(), ".claude-relay");
  const maxAgeDays = Number(process.env.ATTACHMENT_GC_MAX_AGE_DAYS) || 7;
  return {
    baseDir: join(relayDir, "attachments"),
    maxAgeMs: maxAgeDays * 24 * 60 * 60 * 1000,
    dryRun: process.env.DRY_RUN === "true",
  };
}

// ============================================================
// SIZE CALCULATION
// ============================================================

/**
 * Recursively sum file sizes under `dir`. Best-effort: a permissions error
 * on one file does not abort the walk. Returns 0 on fatal read failure.
 */
export async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          total += await dirSizeBytes(full);
        } else if (entry.isFile()) {
          const st = await stat(full);
          total += st.size;
        }
      } catch {
        // per-entry failure — ignore
      }
    }
  } catch {
    // fatal readdir — treat as zero
  }
  return total;
}

// ============================================================
// SWEEP
// ============================================================

/**
 * Walk `baseDir`, delete each top-level subdir whose mtime is older than
 * `maxAgeMs`. Returns counts and a list of per-dir error messages.
 *
 * @param now  Injectable clock for tests (defaults to Date.now()).
 */
export async function sweepAttachments(
  config: AttachmentGCConfig,
  now: number = Date.now(),
): Promise<GCResult> {
  const result: GCResult = {
    scanned: 0,
    removed: 0,
    bytesFreed: 0,
    errors: [],
    dryRun: config.dryRun,
  };

  let entries: Awaited<ReturnType<typeof readdir>> = [];
  try {
    entries = await readdir(config.baseDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Base dir not created yet (no dispatches have happened). Not an error.
      return result;
    }
    result.errors.push(`readdir ${config.baseDir}: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    result.scanned++;

    const full = join(config.baseDir, entry.name);
    let st;
    try {
      st = await stat(full);
    } catch (err) {
      result.errors.push(`stat ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const ageMs = now - st.mtimeMs;
    if (ageMs <= config.maxAgeMs) continue;

    const sizeBytes = await dirSizeBytes(full);

    if (config.dryRun) {
      console.log(`[attachment-gc] [DRY RUN] Would remove ${full} (age=${Math.round(ageMs / 3600000)}h, ${sizeBytes}B)`);
      result.removed++;
      result.bytesFreed += sizeBytes;
      continue;
    }

    try {
      await rm(full, { recursive: true, force: true });
      result.removed++;
      result.bytesFreed += sizeBytes;
    } catch (err) {
      result.errors.push(`rm ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

// ============================================================
// REPORT
// ============================================================

export function buildTelegramMessage(result: GCResult): string {
  const mode = result.dryRun ? " (dry run)" : "";
  const mb = (result.bytesFreed / (1024 * 1024)).toFixed(1);
  const lines: string[] = [
    `🧹 Attachment GC${mode}`,
    `Scanned: ${result.scanned} dir(s)`,
    `Removed: ${result.removed} dir(s) (${mb} MB freed)`,
  ];
  if (result.errors.length > 0) {
    lines.push(`Errors: ${result.errors.length}`);
  }
  return lines.join("\n");
}

// ============================================================
// HANDLER — RoutineContext interface
// ============================================================

export async function run(ctx: RoutineContext): Promise<void> {
  const config = parseConfig();
  ctx.log(`Attachment GC starting — baseDir=${config.baseDir} maxAgeMs=${config.maxAgeMs} dryRun=${config.dryRun}`);

  const result = await sweepAttachments(config);

  ctx.log(`Attachment GC complete — scanned=${result.scanned} removed=${result.removed} bytesFreed=${result.bytesFreed} errors=${result.errors.length}`);

  // Only notify if something was actually removed OR an error occurred.
  if (result.removed > 0 || result.errors.length > 0) {
    await ctx.send(buildTelegramMessage(result));
  }
}
