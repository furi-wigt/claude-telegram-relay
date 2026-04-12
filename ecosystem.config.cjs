// PM2 Ecosystem Configuration
// Manages telegram-relay (always-on) and scheduled routines (cron-based)

const path = require("path");
const CWD = process.env.RELAY_CWD || __dirname;
const BUN = process.env.BUN_PATH || "bun";
const HOME = process.env.HOME || "";
const RELAY_USER_DIR = process.env.RELAY_USER_DIR || process.env.RELAY_DIR || path.join(HOME, ".claude-relay");
const LOGS_DIR = process.env.PM2_LOG_DIR || path.join(RELAY_USER_DIR, "logs");
const ENV = {
  NODE_ENV: "production",
  PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  HOME: HOME,
};

const QDRANT_BIN = process.env.QDRANT_BIN || HOME + "/.qdrant/bin/qdrant";
const MLX_BIN    = process.env.MLX_BIN    || HOME + "/.local/share/uv/tools/mlx-local/bin/mlx";
// Note: MLX generation server (port 8800) removed — replaced by LM Studio via ModelRegistry.
// MLX is now used exclusively for embeddings (mlx-embed, bge-m3, port 8801).

module.exports = {
  apps: [
    // ── Infrastructure: always-on ────────────────────────────────────────
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
      args: "--config-path " + HOME + "/.qdrant/config.yaml",
      env: ENV,
      error_file: LOGS_DIR + "/qdrant-error.log",
      out_file: LOGS_DIR + "/qdrant-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },

    // ── Embedding server (mlx-local tool) ─────────────────────────────────────
    // mlx-embed: embeddings via bge-m3-mlx-fp16, port 8801
    // Text generation handled by LM Studio (or any OpenAI-compatible server) via ModelRegistry.
    {
      name: "mlx-embed",
      script: MLX_BIN,
      args: "serve-embed",
      interpreter: "none",
      exec_mode: "fork",
      cwd: CWD,
      instances: 1,
      autorestart: true,
      watch: false,
      kill_timeout: 5000,
      env: ENV,
      error_file: LOGS_DIR + "/mlx-embed-error.log",
      out_file: LOGS_DIR + "/mlx-embed-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },

    // ── Core: always-on ────────────────────────────────────────────────────
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
      error_file: LOGS_DIR + "/telegram-relay-error.log",
      out_file: LOGS_DIR + "/telegram-relay-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },

    // ── Routine scheduler (cron-to-webhook dispatcher) ─────────────────────
    // NOTE: Per-routine PM2 cron entries removed. routine-scheduler is now the
    // single source of cron truth — it reads config/routines.config.json and
    // dispatches jobs via the webhook server. To add/disable routines, edit
    // config/routines.config.json (or ~/.claude-relay/routines.config.json).
    {
      name: "routine-scheduler",
      script: "routines/scheduler.ts",
      interpreter: BUN,
      exec_mode: "fork",
      cwd: CWD,
      instances: 1,
      autorestart: true,
      watch: false,
      env: ENV,
      error_file: LOGS_DIR + "/routine-scheduler-error.log",
      out_file: LOGS_DIR + "/routine-scheduler-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
