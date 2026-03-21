/**
 * Centralised observability configuration.
 *
 * Externalises log directory, retention period, and enabled flag so they
 * can be changed via environment variables without touching source files.
 *
 * Imported by src/utils/tracer.ts and any module that needs to read
 * observability settings.
 */

import { join } from "path";
import { homedir } from "os";

export interface ObservabilityConfig {
  /** Directory where JSONL trace files are written. */
  logDir: string;
  /** Number of days to retain trace files before cleanup. */
  retentionDays: number;
  /** Whether structured tracing is active. Enable with OBSERVABILITY_ENABLED=1. */
  enabled: boolean;
}

/**
 * Returns the relay user directory (~/.claude-relay by default).
 * Used as the base for both PM2 logs and observability logs.
 */
function getRelayUserDir(): string {
  return process.env.RELAY_USER_DIR || process.env.RELAY_DIR || join(homedir(), ".claude-relay");
}

/**
 * Returns the PM2 service log directory.
 *
 * Centralised here so both configure-pm2.ts and log-cleanup.ts
 * resolve the same path from the same source.
 *
 * Override via .env:
 *   PM2_LOG_DIR — absolute path (default: ~/.claude-relay/logs)
 *
 * @param _projectRoot — kept for backward compatibility but no longer used as default
 */
export function getPm2LogsDir(_projectRoot?: string): string {
  return process.env.PM2_LOG_DIR || join(getRelayUserDir(), "logs");
}

/**
 * Returns the current observability configuration resolved from
 * environment variables with sensible defaults.
 *
 * Called once at tracer module initialisation — changes to env vars
 * after module load are not reflected at runtime.
 *
 * Override defaults via .env:
 *   RELAY_USER_DIR     — root directory (default: ~/.claude-relay)
 *   LOG_DIR            — JSONL log directory (default: {RELAY_USER_DIR}/logs)
 *   LOG_RETENTION_DAYS — days to keep log files (default: 30)
 *   OBSERVABILITY_ENABLED — set to "1" or "true" to enable (default: off)
 */
export function getObservabilityConfig(): ObservabilityConfig {
  const relayDir = getRelayUserDir();

  return {
    logDir: process.env.LOG_DIR || join(relayDir, "logs"),
    retentionDays: Number(process.env.LOG_RETENTION_DAYS) || 30,
    enabled: ["1", "true"].includes(
      (process.env.OBSERVABILITY_ENABLED || "").toLowerCase()
    ),
  };
}
