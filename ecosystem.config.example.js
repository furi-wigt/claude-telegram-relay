// PM2 Ecosystem Configuration Example
// This file is generated automatically by: bun run setup:pm2
// Copy this to ecosystem.config.js and customize if needed

module.exports = {
  apps: [
    {
      name: "telegram-relay",
      script: "src/relay.ts",
      interpreter: "/Users/you/.bun/bin/bun", // Auto-detected
      cwd: "/path/to/claude-telegram-relay", // Auto-detected
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PATH: "/Users/you/.bun/bin:/usr/local/bin:/usr/bin:/bin",
        HOME: "/Users/you",
      },
      error_file: "logs/telegram-relay.error.log",
      out_file: "logs/telegram-relay.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
    {
      name: "smart-checkin",
      script: "examples/smart-checkin.ts",
      interpreter: "/Users/you/.bun/bin/bun",
      cwd: "/path/to/claude-telegram-relay",
      instances: 1,
      autorestart: false, // Cron jobs don't autorestart
      watch: false,
      max_memory_restart: "500M",
      cron_restart: "*/30 * * * *", // Every 30 minutes
      env: {
        NODE_ENV: "production",
        PATH: "/Users/you/.bun/bin:/usr/local/bin:/usr/bin:/bin",
        HOME: "/Users/you",
      },
      error_file: "logs/smart-checkin.error.log",
      out_file: "logs/smart-checkin.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
    {
      name: "morning-briefing",
      script: "examples/morning-briefing-etf.ts",
      interpreter: "/Users/you/.bun/bin/bun",
      cwd: "/path/to/claude-telegram-relay",
      instances: 1,
      autorestart: false,
      watch: false,
      max_memory_restart: "500M",
      cron_restart: "0 7 * * *", // Daily at 7:00 AM
      env: {
        NODE_ENV: "production",
        PATH: "/Users/you/.bun/bin:/usr/local/bin:/usr/bin:/bin",
        HOME: "/Users/you",
      },
      error_file: "logs/morning-briefing.error.log",
      out_file: "logs/morning-briefing.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
    {
      name: "night-summary",
      script: "examples/night-summary.ts",
      interpreter: "/Users/you/.bun/bin/bun",
      cwd: "/path/to/claude-telegram-relay",
      instances: 1,
      autorestart: false,
      watch: false,
      max_memory_restart: "500M",
      cron_restart: "0 23 * * *", // Daily at 11:00 PM
      env: {
        NODE_ENV: "production",
        PATH: "/Users/you/.bun/bin:/usr/local/bin:/usr/bin:/bin",
        HOME: "/Users/you",
      },
      error_file: "logs/night-summary.error.log",
      out_file: "logs/night-summary.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
    {
      name: "watchdog",
      script: "setup/watchdog.ts",
      interpreter: "/Users/you/.bun/bin/bun",
      cwd: "/path/to/claude-telegram-relay",
      instances: 1,
      autorestart: false,
      watch: false,
      max_memory_restart: "500M",
      cron_restart: "15 0,6,8,12,18,23 * * *", // 6 times daily
      env: {
        NODE_ENV: "production",
        PATH: "/Users/you/.bun/bin:/usr/local/bin:/usr/bin:/bin",
        HOME: "/Users/you",
      },
      error_file: "logs/watchdog.error.log",
      out_file: "logs/watchdog.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
