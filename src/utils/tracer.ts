/**
 * Structured JSONL tracer for observability.
 *
 * Writes fire-and-forget JSON Lines to ~/.claude-relay/logs/YYYY-MM-DD.jsonl.
 * Disabled by default — enable with OBSERVABILITY_ENABLED=1 in .env.
 * Cleans up log files older than 30 days on first write.
 */

import { appendFile, mkdir, readdir, stat, unlink } from "fs/promises";
import { join } from "path";

const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const LOG_DIR = join(RELAY_DIR, "logs");
const RETENTION_DAYS = 30;
const enabled = ["1", "true"].includes(
  (process.env.OBSERVABILITY_ENABLED || "").toLowerCase()
);

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
