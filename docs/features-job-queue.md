# Job Queue System

The job queue is a persistent subsystem for scheduling, tracking, and executing background work. It supports multiple job sources, priority-based scheduling, and automation-first intervention handling.

## Quick Start

### Submit a job via CLI
```bash
bun run relay:jobs run "Summarize my ETF portfolio"
bun run relay:jobs run --type routine --executor morning-summary
```

### Check job status
```bash
bun run relay:jobs                    # list all
bun run relay:jobs --intervention     # jobs needing your attention
bun run relay:jobs <id>               # detail view
bun run relay:jobs --json             # JSON output for scripting
```

### Manage jobs
```bash
bun run relay:jobs approve <id>       # confirm an intervention
bun run relay:jobs abort <id>         # cancel a job
bun run relay:jobs retry <id>         # retry a failed job
bun run relay:jobs cancel <id>        # cancel a pending job
```

### Telegram
- `/jobs` — list recent jobs with status indicators
- `/jobs pending` / `/jobs failed` — filtered views
- Intervention cards appear automatically with inline action buttons

## Job Sources

| Source | How it works |
|---|---|
| **CLI** | `bun run relay:jobs run "<prompt>"` |
| **Telegram** | Long-running requests auto-enqueue |
| **Cron** | Scheduler submits via `submitJob()` |
| **Webhook** | `POST /jobs` on configured port with bearer auth |
| **Agent** | Call `submitJob()` directly from code |

## Webhook API

Start the webhook server by setting in `.env`:
```
JOBS_WEBHOOK_PORT=8900
JOBS_WEBHOOK_SECRET=your-secret-here
```

Submit a job:
```bash
curl -X POST http://localhost:8900/jobs \
  -H "Authorization: Bearer your-secret-here" \
  -H "Content-Type: application/json" \
  -d '{"type": "routine", "executor": "morning-summary", "title": "Morning Summary"}'
```

Health check: `GET http://localhost:8900/health`

### Webhook ACL (Optional)

For per-source access control, create `~/.claude-relay/webhook-acl.json`:
```json
{
  "tokens": [
    { "name": "cron-agent", "secret": "...", "allowed_types": ["routine"] },
    { "name": "admin", "secret": "...", "allowed_types": "*" }
  ]
}
```

## Priority + Concurrency

Jobs are dispatched by priority (urgent > normal > background), then FIFO within each lane.

| Type | Max concurrent |
|---|---|
| `claude-session` | 1 |
| `compound` | 2 |
| `routine` | 3 |
| `api-call` | 5 |

## Auto-Approve Rules

Create `~/.claude-relay/auto-approve.json` to auto-resolve zero-risk interventions:
```json
[
  { "executor": "log-cleanup", "intervention_types": ["approval"], "action": "confirm" },
  { "executor": "orphan-gc", "intervention_types": ["approval"], "action": "confirm" }
]
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `JOBS_WEBHOOK_PORT` | (disabled) | Webhook server port |
| `JOBS_WEBHOOK_SECRET` | (required if port set) | Bearer token for webhook auth |
| `INTERVENTION_REMINDER_MINS` | 30 | Minutes before first reminder |
| `INTERVENTION_T3_MINS` | 60 | Minutes before Things 3 escalation |
