// PM2 Ecosystem Configuration — Example
// Copy to ecosystem.config.cjs and adjust paths as needed.
//
// Manages telegram-relay (always-on), qdrant (vector DB), and scheduled routines (cron-based).
// Logs are written to ~/.claude-relay/logs/ by default.

const path = require("path");
const CWD = process.env.RELAY_CWD || __dirname;
const BUN = process.env.BUN_PATH || "bun";
const HOME = process.env.HOME || "";
const RELAY_USER_DIR = process.env.RELAY_USER_DIR || path.join(HOME, ".claude-relay");
const LOGS_DIR = process.env.PM2_LOG_DIR || path.join(RELAY_USER_DIR, "logs");
const ENV = {
  NODE_ENV: "production",
  PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  HOME: HOME,
};

// Path to qdrant binary — adjust if installed elsewhere
const QDRANT_BIN = process.env.QDRANT_BIN || path.join(HOME, ".qdrant", "bin", "qdrant");

module.exports = {
  apps: [
    // ── Infrastructure: always-on ────────────────────────────────────────
    // Local vector database for semantic search
    {
      name: "qdrant",
      script: QDRANT_BIN,
      interpreter: "none",
      exec_mode: "fork",
      cwd: CWD,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      kill_timeout: 5000,
      args: "--config-path " + path.join(HOME, ".qdrant", "config.yaml"),
      env: ENV,
      error_file: path.join(LOGS_DIR, "qdrant-error.log"),
      out_file: path.join(LOGS_DIR, "qdrant-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },

    // ── Core: always-on ────────────────────────────────────────────────────
    // Main Telegram bot — handles all messages and commands
    {
      name: "telegram-relay",
      script: "relay-wrapper.js",
      interpreter: BUN,
      exec_mode: "fork",
      cwd: CWD,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1500M",
      kill_timeout: 10000,
      wait_ready: true,
      listen_timeout: 15000,
      env: ENV,
      error_file: path.join(LOGS_DIR, "telegram-relay-error.log"),
      out_file: path.join(LOGS_DIR, "telegram-relay-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },

    // ── Daily briefings ────────────────────────────────────────────────────
    // Morning summary — runs once at 7am, then stops (autorestart: false)
    {
      name: "morning-summary",
      script: "routines/morning-summary.ts",
      interpreter: BUN,
      exec_mode: "fork",
      cwd: CWD,
      instances: 1,
      autorestart: false,
      watch: false,
      cron_restart: "0 7 * * *",
      env: ENV,
      error_file: path.join(LOGS_DIR, "morning-summary-error.log"),
      out_file: path.join(LOGS_DIR, "morning-summary-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },

    // Night summary — runs once at 11pm, then stops
    {
      name: "night-summary",
      script: "routines/night-summary.ts",
      interpreter: BUN,
      exec_mode: "fork",
      cwd: CWD,
      instances: 1,
      autorestart: false,
      watch: false,
      cron_restart: "0 23 * * *",
      env: ENV,
      error_file: path.join(LOGS_DIR, "night-summary-error.log"),
      out_file: path.join(LOGS_DIR, "night-summary-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },

    // ── Periodic check-ins ─────────────────────────────────────────────────
    // Context-aware check-ins every 30 minutes during waking hours
    {
      name: "smart-checkin",
      script: "routines/smart-checkin.ts",
      interpreter: BUN,
      exec_mode: "fork",
      cwd: CWD,
      instances: 1,
      autorestart: false,
      watch: false,
      cron_restart: "*/30 * * * *",
      env: ENV,
      error_file: path.join(LOGS_DIR, "smart-checkin-error.log"),
      out_file: path.join(LOGS_DIR, "smart-checkin-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },

    // ── Health & maintenance ───────────────────────────────────────────────
    // Health monitor — checks service status every 2 hours
    {
      name: "watchdog",
      script: "routines/watchdog.ts",
      interpreter: BUN,
      exec_mode: "fork",
      cwd: CWD,
      instances: 1,
      autorestart: false,
      watch: false,
      cron_restart: "0 */2 * * *",
      env: ENV,
      error_file: path.join(LOGS_DIR, "watchdog-error.log"),
      out_file: path.join(LOGS_DIR, "watchdog-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },

    // Orphan process garbage collector — hourly
    {
      name: "orphan-gc",
      script: "routines/orphan-gc.ts",
      interpreter: BUN,
      exec_mode: "fork",
      cwd: CWD,
      instances: 1,
      autorestart: false,
      watch: false,
      cron_restart: "0 * * * *",
      env: ENV,
      error_file: path.join(LOGS_DIR, "orphan-gc-error.log"),
      out_file: path.join(LOGS_DIR, "orphan-gc-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },

    // Log rotation — weekly on Monday at 6am
    {
      name: "log-cleanup",
      script: "routines/log-cleanup.ts",
      interpreter: BUN,
      exec_mode: "fork",
      cwd: CWD,
      instances: 1,
      autorestart: false,
      watch: false,
      cron_restart: "0 6 * * 1",
      env: ENV,
      error_file: path.join(LOGS_DIR, "log-cleanup-error.log"),
      out_file: path.join(LOGS_DIR, "log-cleanup-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },

    // Memory deduplication review — Friday at 4pm
    {
      name: "memory-dedup-review",
      script: "routines/memory-dedup-review.ts",
      interpreter: BUN,
      exec_mode: "fork",
      cwd: CWD,
      instances: 1,
      autorestart: false,
      watch: false,
      cron_restart: "0 16 * * 5",
      env: ENV,
      error_file: path.join(LOGS_DIR, "memory-dedup-review-error.log"),
      out_file: path.join(LOGS_DIR, "memory-dedup-review-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },

    // Memory cleanup — daily at 3am
    {
      name: "memory-cleanup",
      script: "routines/memory-cleanup.ts",
      interpreter: BUN,
      exec_mode: "fork",
      cwd: CWD,
      instances: 1,
      autorestart: false,
      watch: false,
      cron_restart: "0 3 * * *",
      env: ENV,
      error_file: path.join(LOGS_DIR, "memory-cleanup-error.log"),
      out_file: path.join(LOGS_DIR, "memory-cleanup-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
