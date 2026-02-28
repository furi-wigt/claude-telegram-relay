#!/usr/bin/env bun

/**
 * @routine orphan-gc
 * @description Kill orphaned Claude CLI processes left behind after relay crashes
 * @schedule 0 * * * *  (every hour)
 * @target no Telegram message unless orphans were found and killed
 */

/**
 * Orphan GC Routine — Claude Process Garbage Collector
 *
 * Schedule: Every hour (cron: 0 * * * *)
 *
 * Finds and kills orphaned `claude` CLI processes: processes that are running
 * on the system but have no corresponding active coding session in the relay's
 * session store. This happens when the relay crashes mid-session and leaves
 * the spawned `claude` subprocess behind.
 *
 * Orphan detection criteria:
 *   1. Process has `--dangerously-skip-permissions` in its command line
 *      (the flag used exclusively by SessionRunner for coding sessions)
 *   2. Process PID does not match any session in
 *      running / starting / waiting_for_input / waiting_for_plan state
 *   3. Process has been running longer than ORPHAN_GC_MIN_AGE_MINUTES
 *      (default: 30 min) to avoid racing against session startup
 *
 * Kill strategy: SIGTERM, then SIGKILL after 5 seconds if still alive.
 *
 * Configuration (via .env):
 *   ORPHAN_GC_MIN_AGE_MINUTES — minimum process age before killing (default: 30)
 *   DRY_RUN=true              — preview what would be killed, no actual kills
 *   RELAY_DIR                 — relay data directory (default: ~/.claude-relay)
 *
 * Run manually: bun run routines/orphan-gc.ts
 * Dry run:      DRY_RUN=true bun run routines/orphan-gc.ts
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "bun";
import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";

// ============================================================
// TYPES
// ============================================================

export interface OrphanGCConfig {
  /** Minimum process age in ms before it can be treated as orphaned. */
  minAgeMs: number;
  /** When true, log what would be killed but do not send signals. */
  dryRun: boolean;
  /** Path to the coding sessions JSON file. */
  sessionsFile: string;
}

export interface ProcessEntry {
  pid: number;
  command: string;
  elapsedMs: number;
}

export interface ReapResult {
  killed: number;
  errors: string[];
}

export interface GCResult {
  processesFound: number;
  activePids: number;
  orphansFound: number;
  killed: number;
  errors: string[];
  dryRun: boolean;
}

/** Kill function signature — injectable for testing. */
export type KillFn = (pid: number, signal: string | number) => void;

// Active session statuses — processes with these statuses are NOT orphans.
const ACTIVE_STATUSES = new Set([
  "running",
  "starting",
  "waiting_for_input",
  "waiting_for_plan",
]);

// ============================================================
// CONFIG
// ============================================================

export function parseConfig(): OrphanGCConfig {
  const relayDir = process.env.RELAY_DIR || join(homedir(), ".claude-relay");
  const minAgeMinutes = Number(process.env.ORPHAN_GC_MIN_AGE_MINUTES) || 30;

  return {
    minAgeMs: minAgeMinutes * 60 * 1000,
    dryRun: process.env.DRY_RUN === "true",
    sessionsFile: join(relayDir, "coding-sessions.json"),
  };
}

// ============================================================
// PS OUTPUT PARSING
// ============================================================

/**
 * Convert a ps ELAPSED field (`[[DD-]HH:]MM:SS`) to milliseconds.
 * Returns 0 for unrecognised formats.
 */
export function parseElapsedMs(elapsed: string): number {
  const s = elapsed.trim();
  const parts = s.split(":");

  if (parts.length === 2) {
    // MM:SS
    const mins = parseInt(parts[0]);
    const secs = parseInt(parts[1]);
    if (isNaN(mins) || isNaN(secs)) return 0;
    return (mins * 60 + secs) * 1000;
  }

  if (parts.length === 3) {
    // HH:MM:SS  or  DD-HH:MM:SS
    const mins = parseInt(parts[1]);
    const secs = parseInt(parts[2]);
    if (isNaN(mins) || isNaN(secs)) return 0;

    const hrPart = parts[0];
    if (hrPart.includes("-")) {
      const [dayStr, hourStr] = hrPart.split("-");
      const days = parseInt(dayStr);
      const hours = parseInt(hourStr);
      if (isNaN(days) || isNaN(hours)) return 0;
      return ((days * 24 * 60 + hours * 60 + mins) * 60 + secs) * 1000;
    }

    const hours = parseInt(hrPart);
    if (isNaN(hours)) return 0;
    return ((hours * 60 + mins) * 60 + secs) * 1000;
  }

  return 0;
}

/**
 * Parse a single line from `ps -Ao pid,etime,command` output.
 * Returns null for the header line or any unparseable lines.
 */
export function parsePsLine(line: string): ProcessEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("PID")) return null;

  // First token: PID
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) return null;

  const pid = parseInt(trimmed.slice(0, firstSpace));
  if (isNaN(pid)) return null;

  const rest = trimmed.slice(firstSpace).trim();

  // Second token: ELAPSED
  const secondSpace = rest.search(/\s/);
  if (secondSpace === -1) return null;

  const elapsed = rest.slice(0, secondSpace);
  const command = rest.slice(secondSpace).trim();
  if (!command) return null;

  const elapsedMs = parseElapsedMs(elapsed);

  return { pid, command, elapsedMs };
}

// ============================================================
// PROCESS SCANNING
// ============================================================

/**
 * Find all `claude` coding session processes currently running.
 *
 * Matches processes whose command line contains `--dangerously-skip-permissions`
 * — the flag used exclusively by SessionRunner for coding sessions.
 *
 * @param psOutputProvider  Optional override for testing (returns ps stdout).
 */
export async function findClaudeProcesses(
  psOutputProvider?: () => Promise<string>
): Promise<ProcessEntry[]> {
  let psOutput: string;

  if (psOutputProvider) {
    psOutput = await psOutputProvider();
  } else {
    try {
      const proc = spawn(["ps", "-Ao", "pid,etime,command"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      psOutput = output;
    } catch (err) {
      console.warn("[orphan-gc] Failed to run ps:", err);
      return [];
    }
  }

  const entries: ProcessEntry[] = [];
  for (const line of psOutput.split("\n")) {
    const entry = parsePsLine(line);
    if (!entry) continue;
    // Only match coding session processes (the unique flag used by SessionRunner)
    if (entry.command.includes("--dangerously-skip-permissions")) {
      entries.push(entry);
    }
  }

  return entries;
}

// ============================================================
// SESSION STORE
// ============================================================

/**
 * Read the coding sessions JSON and return the set of PIDs
 * belonging to sessions currently in an active state.
 *
 * Returns an empty Set if the file is missing or unreadable.
 */
export async function loadActivePids(sessionsFile: string): Promise<Set<number>> {
  try {
    const raw = await readFile(sessionsFile, "utf-8");
    const data = JSON.parse(raw) as {
      sessions?: Array<{ pid?: number; status?: string }>;
    };
    const sessions = data.sessions ?? [];
    const pids = new Set<number>();

    for (const s of sessions) {
      if (typeof s.pid === "number" && s.status && ACTIVE_STATUSES.has(s.status)) {
        pids.add(s.pid);
      }
    }

    return pids;
  } catch {
    // File missing or malformed — no active sessions to protect
    return new Set();
  }
}

// ============================================================
// ORPHAN DETECTION
// ============================================================

/**
 * Return only processes that are orphaned:
 *   - PID not in activePids (no tracked active session owns this process)
 *   - elapsedMs strictly exceeds minAgeMs (too young → might be mid-startup)
 */
export function detectOrphans(
  processes: ProcessEntry[],
  activePids: Set<number>,
  minAgeMs: number
): ProcessEntry[] {
  return processes.filter(
    (p) => !activePids.has(p.pid) && p.elapsedMs > minAgeMs
  );
}

// ============================================================
// KILLING
// ============================================================

/**
 * Send SIGTERM to each orphaned process, then SIGKILL after 5 s if still alive.
 * In dry-run mode, logs what would be killed without sending signals.
 *
 * @param killFn  Injectable kill function (defaults to `process.kill`).
 * @returns ReapResult with counts and error messages.
 */
export async function reapOrphans(
  orphans: ProcessEntry[],
  dryRun: boolean,
  killFn: KillFn = process.kill.bind(process),
  /** ms to wait between SIGTERM and SIGKILL escalation (injectable for tests). */
  sigkillDelayMs: number = 5_000
): Promise<ReapResult> {
  if (orphans.length === 0) return { killed: 0, errors: [] };

  if (dryRun) {
    for (const o of orphans) {
      console.log(`[DRY RUN] Would kill orphan: pid=${o.pid}  elapsed=${Math.round(o.elapsedMs / 1000)}s  cmd=${o.command.slice(0, 80)}`);
    }
    return { killed: orphans.length, errors: [] };
  }

  let killed = 0;
  const errors: string[] = [];

  for (const o of orphans) {
    try {
      console.log(`[orphan-gc] Killing pid=${o.pid} (elapsed=${Math.round(o.elapsedMs / 1000)}s)`);
      killFn(o.pid, "SIGTERM");

      // Wait, then escalate to SIGKILL if process is still alive
      await new Promise<void>((resolve) => setTimeout(resolve, sigkillDelayMs));

      try {
        killFn(o.pid, 0); // Probe: throws ESRCH if already dead
        // Still alive after SIGTERM — force kill
        killFn(o.pid, "SIGKILL");
        console.log(`[orphan-gc] SIGKILL sent to pid=${o.pid} (SIGTERM ignored)`);
      } catch {
        // Process already exited after SIGTERM — good
      }

      killed++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const msg = code === "ESRCH"
        ? `pid ${o.pid}: already exited (ESRCH)`
        : `pid ${o.pid}: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[orphan-gc] Kill error: ${msg}`);
      errors.push(msg);
    }
  }

  return { killed, errors };
}

// ============================================================
// REPORT BUILDERS
// ============================================================

export function buildReport(result: GCResult): string {
  const mode = result.dryRun ? " [DRY RUN]" : "";
  const lines: string[] = [];

  lines.push(`Orphan GC Report${mode}`);
  lines.push("=".repeat(40));
  lines.push(`Claude processes found:  ${result.processesFound}`);
  lines.push(`Active tracked PIDs:     ${result.activePids}`);
  lines.push(`Orphans detected:        ${result.orphansFound}`);

  if (result.orphansFound === 0) {
    lines.push("No orphans found — all processes are tracked.");
  } else {
    lines.push(`Killed:                  ${result.killed}`);
  }

  if (result.errors.length > 0) {
    lines.push("");
    lines.push(`Errors (${result.errors.length}):`);
    for (const e of result.errors) {
      lines.push(`  ${e}`);
    }
  }

  return lines.join("\n");
}

export function buildTelegramMessage(result: GCResult): string {
  const mode = result.dryRun ? " (dry run)" : "";
  const lines: string[] = [];

  if (result.orphansFound === 0) {
    lines.push(`Orphan GC${mode}: no orphans found`);
    lines.push(`All ${result.processesFound} claude process(es) are tracked.`);
    return lines.join("\n");
  }

  lines.push(`Orphan GC Complete${mode}`);
  lines.push("");
  lines.push(`Processes found: ${result.processesFound}`);
  lines.push(`Orphans killed:  ${result.killed}`);

  if (result.errors.length > 0) {
    lines.push(`Errors:          ${result.errors.length}`);
  }

  return lines.join("\n");
}

// ============================================================
// MAIN ORCHESTRATOR
// ============================================================

export async function runOrphanGC(): Promise<GCResult> {
  const config = parseConfig();

  console.log(
    `Starting orphan GC (minAgeMs=${config.minAgeMs}, dryRun=${config.dryRun})`
  );
  console.log(`  Sessions file: ${config.sessionsFile}`);

  // Find candidate processes
  const claudeProcs = await findClaudeProcesses();
  console.log(`Claude processes with --dangerously-skip-permissions: ${claudeProcs.length}`);

  // Load PIDs of sessions in active states
  const activePids = await loadActivePids(config.sessionsFile);
  console.log(`Active tracked PIDs: ${activePids.size}`);

  // Detect orphans
  const orphans = detectOrphans(claudeProcs, activePids, config.minAgeMs);
  console.log(`Orphans detected: ${orphans.length}`);

  // Kill orphans
  const reapResult = await reapOrphans(orphans, config.dryRun);

  const gcResult: GCResult = {
    processesFound: claudeProcs.length,
    activePids: activePids.size,
    orphansFound: orphans.length,
    killed: reapResult.killed,
    errors: reapResult.errors,
    dryRun: config.dryRun,
  };

  console.log(buildReport(gcResult));
  return gcResult;
}

// ============================================================
// ENTRY POINT
// ============================================================

async function main(): Promise<void> {
  const result = await runOrphanGC();

  if (result.orphansFound > 0 && validateGroup("GENERAL")) {
    const message = buildTelegramMessage(result);
    await sendAndRecord(GROUPS.GENERAL.chatId, message, {
      routineName: "orphan-gc",
      agentId: "general-assistant",
      topicId: GROUPS.GENERAL.topicId,
    });
    console.log("Summary sent to General group");
  } else if (result.orphansFound === 0) {
    console.log("No orphans found — no Telegram message sent");
  } else {
    console.warn("GENERAL group not configured — skipping Telegram notification");
  }

  process.exit(0);
}

// PM2's bun container uses require() internally, which sets import.meta.main = false.
// Fall back to pm_exec_path to detect when PM2 is the entry runner.
const _isEntry =
  import.meta.main ||
  process.env.pm_exec_path === import.meta.url?.replace("file://", "");

if (_isEntry) {
  main().catch((error) => {
    console.error("Error running orphan GC:", error);
    process.exit(0); // exit 0 so PM2 does not immediately restart
  });
}
