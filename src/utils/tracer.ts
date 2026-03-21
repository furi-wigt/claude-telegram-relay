/**
 * Structured JSONL tracer for observability.
 *
 * Writes fire-and-forget JSON Lines to the configured log directory
 * (default: ~/.claude-relay/logs/YYYY-MM-DD.jsonl).
 *
 * Disabled by default — enable with OBSERVABILITY_ENABLED=1 in .env.
 * Cleans up log files older than the configured retention period on first write.
 *
 * Log path and retention are configured via config/observability.ts so they
 * can be changed without touching this file.
 */

import { appendFile, mkdir, readdir, stat, unlink } from "fs/promises";
import { join } from "path";
import { getObservabilityConfig } from "../../config/observability.ts";

const config = getObservabilityConfig();
const LOG_DIR = config.logDir;
const RETENTION_DAYS = config.retentionDays;
const enabled = config.enabled;

let initialized = false;

async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await mkdir(LOG_DIR, { recursive: true });
  cleanup().catch(() => {}); // fire-and-forget
}

async function cleanup(): Promise<void> {
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  const files = await readdir(LOG_DIR);
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const fp = join(LOG_DIR, f);
    const s = await stat(fp);
    if (s.mtimeMs < cutoff) await unlink(fp).catch(() => {});
  }
}

function getLogPath(): string {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(LOG_DIR, `${d}.jsonl`);
}

/**
 * Append a structured trace event to today's JSONL log file.
 * Fire-and-forget: never blocks the caller, never throws.
 * No-op when OBSERVABILITY_ENABLED is not set.
 */
export function trace(event: Record<string, unknown>): void {
  if (!enabled) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
  init()
    .then(() => appendFile(getLogPath(), line))
    .catch((err) => {
      console.error("[tracer] write failed:", err);
    });
}

/**
 * Generate a unique trace ID for correlating events across one message flow.
 */
export function generateTraceId(): string {
  return crypto.randomUUID();
}
