# Watchdog System

The watchdog monitors all PM2-managed services and alerts you via Telegram when something is down or misbehaving.

## Overview

| Property | Value |
|---|---|
| Script | `routines/watchdog.ts` |
| PM2 service name | `watchdog` |
| Schedule | Every 2 hours (`0 */2 * * *`) |
| autorestart | `false` (one-shot cron job) |
| Alert target | General AI Assistant group |

## What It Monitors

### PM2 process health

The watchdog auto-discovers all services from `ecosystem.config.cjs` at runtime. For each process it checks:

1. **Existence** — Is the process registered in PM2?
2. **Status** — Is it `online`, `stopped`, or `errored`?
3. **Restart count** — Has it exceeded the restart threshold (default: 10), indicating a crash loop?

If auto-discovery fails (e.g. ecosystem config is missing), it falls back to a hardcoded list: `telegram-relay`, `morning-summary`, `smart-checkin`, `night-summary`, `weekly-etf`, `watchdog`.

### Bot responsiveness

After checking PM2 processes, the watchdog probes the SQLite database to detect whether the bot is actually responding to user messages:

- Compares timestamps of the most recent user message vs. the most recent bot response
- If the gap exceeds a threshold (default: 10 minutes) and there are pending unanswered messages, it sends a responsiveness alert
- Configurable via `WATCHDOG_HEARTBEAT_THRESHOLD_MIN` env var

### Auto-restart

Always-on processes (those with `autorestart: true` in the ecosystem config, such as `telegram-relay`) are automatically restarted if found in a `stopped` or `errored` state. The alert notes whether the auto-restart succeeded.

## Alert Behavior

- Alerts are sent only when problems are detected — no noise when everything is healthy
- Alerts go to the General AI Assistant group (resolved via `GROUPS.GENERAL`)
- Each alert includes the issue severity, affected service, error details, and current status of all processes
- Severity levels: **CRITICAL** (always-on process down, extreme restart count) and **WARNING** (cron job errored, elevated restart count, missing process)

### Example alert

```
Watchdog Alert

CRITICAL:
  [!] telegram-relay: Status: stopped (auto-restarted)

WARNINGS:
  [~] morning-summary: Last run errored — check logs

Process status:
  telegram-relay: online | up 2h 15m | 45.2 MB | 1 restarts
  morning-summary: errored | up - | - | 0 restarts
  smart-checkin: online | up 1h 30m | 32.1 MB | 0 restarts
  night-summary: stopped | up - | - | 0 restarts
  watchdog: online | up 0s | 28.4 MB | 0 restarts

Run 'npx pm2 logs <name>' to inspect. Reply to acknowledge.
```

### Responsiveness alert

```
Bot Responsiveness Alert

Last user message: 2026-03-23T14:05:00Z
Last bot response: 2026-03-23T13:50:00Z
Gap: 15 minutes
Pending messages: 3

The bot may be stuck in a long-running session. Check PM2 logs or send /cancel.
```

## Configuration

No special environment variables are required. The watchdog uses existing project configuration:

| Variable | Default | Purpose |
|---|---|---|
| `WATCHDOG_HEARTBEAT_THRESHOLD_MIN` | `10` | Minutes before an unanswered message triggers a responsiveness alert |

Group routing (General Assistant chat ID and topic ID) is resolved from `config/agents.json` via the `GROUPS` registry. The watchdog exits gracefully if the General group is not configured.

## PM2 Commands

```bash
# View watchdog output
npx pm2 logs watchdog

# Force an immediate health check
npx pm2 restart watchdog

# Check watchdog status
npx pm2 show watchdog

# Run manually outside PM2
bun run routines/watchdog.ts
```

## Installation

The watchdog is included in the standard PM2 setup:

```bash
bun run setup:pm2 -- --service all
```

Or start it individually:

```bash
npx pm2 start ecosystem.config.cjs --only watchdog
npx pm2 save
```

## Troubleshooting

### Watchdog not running

```bash
# Check if it is registered
npx pm2 status

# If missing, start it
npx pm2 start ecosystem.config.cjs --only watchdog
npx pm2 save
```

### No alerts despite known issues

1. Check watchdog logs: `npx pm2 logs watchdog --lines 50`
2. Verify the General group is configured: ensure `chatId` is set for the General agent in `config/agents.json`
3. Run manually to see output: `bun run routines/watchdog.ts`

### False positives for cron jobs

Cron-based routines (morning-summary, night-summary) normally show `stopped` status between runs. The watchdog only flags `stopped` as an issue for always-on processes. For cron jobs, only the `errored` state triggers a warning.

### Watchdog itself fails

If the watchdog encounters a fatal error, it sends a failure notification to the General group before exiting. Since `autorestart: false`, it waits for the next cron cycle (2 hours) to retry. Check logs with:

```bash
npx pm2 logs watchdog --err --lines 50
```

## Log Files

PM2 manages watchdog logs at `~/.claude-relay/logs/`:

- `watchdog-out.log` — standard output (health check results)
- `watchdog-error.log` — errors and exceptions
