# Job Queue System

The job queue is a persistent subsystem for scheduling, tracking, and executing background work. It supports multiple job sources, priority-based scheduling, and automation-first intervention handling.

## Executor Types

The job queue supports four executor types. Each executor is registered in `src/jobs/index.ts`.

### routine

`RoutineExecutor` -- runs scheduled routines.

- **Handler-type routine**: executor looks up `routines/handlers/<executor-name>.ts` and calls `run(ctx)` with an injected `RoutineContext`. Handler module is loaded on first execution and cached -- no startup cost.
- **Prompt-type routine**: if no handler file exists and `payload.prompt` is set, the executor sends the prompt to the LLM inline and posts the result to Telegram. No TypeScript handler needed.
- Handler modules are loaded via dynamic import; send `SIGUSR2` to `routine-scheduler` to reset the cache and hot-reload handlers without a full restart.

### claude-session

`ClaudeSessionExecutor` -- runs an agentic Claude session.

- Invokes the orchestration layer: `classifyIntent` → target agent dispatch.
- **Job Topic UX**: on execution, creates a dedicated forum topic in the Command Center group (`⚙️ #NNN — <prompt>`), posts a job card with status `🔄 Running…`, streams the response into the topic, and updates the card to `✅ Done` or `❌ Failed` on completion.
- Topic creation is best-effort — if it fails (CC not configured, API error), the result falls back to `metadata.chatId`/`metadata.threadId` as before.
- **Follow-up routing**: messages sent in a job topic are detected by `commandCenter.ts` and routed through the CC classifier with the original job prompt injected as context, enabling natural multi-turn follow-ups.
- **Job numbering**: sequential counter persisted to `~/.claude-relay/data/job-counter.json`; zero-padded 3 digits (`001`, `002`, …); never resets.
- On retry: re-runs the full dispatch from scratch (no partial resume — checkpoint resume deferred to v2).

### compound

`CompoundExecutor` -- multi-step sequential dispatch.

- Runs a sequence of agent tasks defined in `payload.plan.tasks` via `dispatchEngine`.
- Agent-overlap guard: returns `awaiting-intervention` if any target agent is currently busy handling another job.
- Suitable for workflows that need multiple agents to contribute sequentially.
- Checkpoint resume is v1 (re-runs from start on retry).

### api-call

`ApiCallExecutor` -- makes an outbound HTTP request.

- Supports configurable retry with exponential backoff.
- Payload: `{ url, method, headers, body, retries, backoffMs }`.

---

## Adding a New Routine

### Prompt-type (zero code)

Add an entry to `config/routines.config.json` with `"type": "prompt"` and a `"prompt"` field. No handler file needed.

```json
{
  "name": "my-prompt-routine",
  "schedule": "0 8 * * 1",
  "group": "GENERAL",
  "type": "prompt",
  "prompt": "Summarise the week's goals and flag any blockers."
}
```

User overrides: `~/.claude-relay/routines.config.json` is merged on top of repo defaults at startup.

### Handler-type (TypeScript logic)

1. Add an entry to `config/routines.config.json` (same as above, omit `prompt`, use `"type": "routine"`).
2. Create `routines/handlers/<name>.ts` exporting a `run` function:

```typescript
// routines/handlers/my-routine.ts
import type { RoutineContext } from "../../src/jobs/executors/routineContext.ts";

export async function run(ctx: RoutineContext): Promise<void> {
  await ctx.skipIfRanWithin(6); // skip if ran in last 6 hours

  const result = await ctx.llm("Summarise today's activity.");
  await ctx.send(result);
  ctx.log("my-routine complete");
}
```

No `ecosystem.config.cjs` edit needed. The `routine-scheduler` service reads `config/routines.config.json` and registers all cron jobs automatically.

---

## RoutineContext API

`RoutineContext` is injected into every handler by `RoutineExecutor`. Import the type from `src/jobs/executors/routineContext.ts`.

| Method | Signature | Description |
|---|---|---|
| `send` | `(message: string) => Promise<void>` | Send a message to the routine's configured Telegram group and record it in the database. |
| `llm` | `(prompt: string, opts?: LlmOpts) => Promise<string>` | Call the LLM via the ModelRegistry `routine` slot. |
| `log` | `(message: string) => void` | Write a log line tagged with the routine name. |
| `skipIfRanWithin` | `(hours: number) => Promise<void>` | Throw `SkipError` (job marked `skipped`) if this routine ran successfully within the last N hours. |

---

## routine-scheduler PM2 Service

`routine-scheduler` is the single cron dispatcher. It:

1. Reads `config/routines.config.json` (merged with `~/.claude-relay/routines.config.json` if present).
2. Registers one cron job per entry.
3. On each trigger, fires a `POST /jobs` webhook to the relay (using `JOBS_WEBHOOK_PORT` and `JOBS_WEBHOOK_SECRET`).
4. The relay enqueues the job and the appropriate executor handles it.

This replaces the previous pattern of one PM2 entry per routine. `ecosystem.config.cjs` no longer needs per-routine cron entries -- only `routine-scheduler` and `telegram-relay` are always-running services.

---

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

| Command | Description |
|---|---|
| `/jobs` | List recent jobs with status indicators and filter buttons |
| `/jobs pending` \| `failed` \| `running` | Filtered views |
| `/jobs detail <id8>` | Full job card with contextual action buttons |
| `/jobs cancel <id8>` | Cancel a pending or running job |
| `/jobs retry <id8>` | Re-queue a failed job back to pending |
| `/jobs clear` | Purge done/cancelled jobs older than `JOBS_PURGE_DAYS` days (default 7) |
| `/schedule <prompt>` | Enqueue a `claude-session` job; result posted back to originating chat |

`<id8>` is the first 8 characters of the job UUID (shown in `/jobs` list and detail cards). Inline action buttons on detail cards provide the same cancel/retry/refresh actions without typing.

Intervention cards (for `awaiting-intervention` jobs) appear automatically with Confirm / Skip / Abort buttons.

## Job Sources

| Source | How it works |
|---|---|
| **CLI** | `bun run relay:jobs run "<prompt>"` |
| **Telegram** | Long-running requests auto-enqueue; `/schedule <prompt>` for on-demand claude-session jobs |
| **Cron** | `routine-scheduler` reads `config/routines.config.json` and submits via webhook |
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

The repo ships with `config/auto-approve.default.json` which pre-approves approval-type interventions for maintenance routines (`log-cleanup`, `orphan-gc`, `memory-cleanup`, `memory-dedup-review`) and skips budget interventions for all cron jobs. These defaults are active without any configuration.

To add your own rules, create `~/.claude-relay/auto-approve.json`:
```json
[
  { "executor": "log-cleanup", "intervention_types": ["approval"], "action": "confirm" },
  { "executor": "orphan-gc", "intervention_types": ["approval"], "action": "confirm" }
]
```

User rules in `~/.claude-relay/auto-approve.json` are merged with repo defaults -- you only need to add rules beyond the defaults.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `JOBS_WEBHOOK_PORT` | (disabled) | Webhook server port. **Required** for `routine-scheduler` to submit jobs. |
| `JOBS_WEBHOOK_SECRET` | (required if port set) | Bearer token for webhook auth. **Required** alongside `JOBS_WEBHOOK_PORT`. |
| `INTERVENTION_REMINDER_MINS` | 30 | Minutes before first reminder |
| `INTERVENTION_T3_MINS` | 60 | Minutes before Things 3 escalation |

> `JOBS_WEBHOOK_PORT` and `JOBS_WEBHOOK_SECRET` must both be set for the `routine-scheduler` service to function. Without them, the webhook server does not start and scheduled routines cannot be submitted.

---

## Testing

### Automated tests

```bash
bun run test
```

All job queue tests should pass. Pre-existing failures in `tests/local/local-stack.test.ts` (MLX embed server not running) are unrelated.

### Schema verification

```bash
sqlite3 ~/.claude-relay/data/local.sqlite ".tables" | tr ' ' '\n' | grep -E '^(jobs|job_checkpoints)$'
```

Both `jobs` and `job_checkpoints` tables must be present. If missing, start the relay once (`bun run start`) to trigger schema creation.

### CLI smoke tests

- [ ] `bun run relay:jobs` -- lists jobs or shows "No jobs found"
- [ ] `bun run relay:jobs run "test" --type routine --executor test-cli` -- inserts a job
- [ ] `bun run relay:jobs <id>` -- shows detail view (use 8-char prefix from list)
- [ ] `bun run relay:jobs cancel <id>` -- cancels a pending job
- [ ] `bun run relay:jobs --status pending` / `--status cancelled` / `--intervention` -- filtered views
- [ ] `bun run relay:jobs --json` -- valid JSON output

### Telegram smoke tests

- [ ] `/jobs` -- reply with job list and inline buttons (Needs attention, Running, History)
- [ ] Inline buttons respond within 3 seconds, no stuck loading spinners
- [ ] `/jobs pending` / `/jobs failed` -- filtered views work

### Webhook tests

Start the relay with webhook enabled:
```bash
JOBS_WEBHOOK_PORT=8900 JOBS_WEBHOOK_SECRET=test-secret bun run start
```

```bash
# Health check -- expect 200
curl -s http://localhost:8900/health | jq .

# Submit job -- expect 201
curl -s -X POST http://localhost:8900/jobs \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"type":"routine","executor":"webhook-test","title":"Webhook smoke test"}'

# No auth -- expect 401
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8900/jobs \
  -H "Content-Type: application/json" \
  -d '{"type":"routine","executor":"test","title":"Unauthorized"}'

# Missing required fields -- expect 400
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8900/jobs \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"executor":"test","title":"Missing type"}'

# Dedup rejection -- expect 409 on second call
curl -s -X POST http://localhost:8900/jobs \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"type":"routine","executor":"dup-test","title":"First","dedup_key":"dedup:test:1"}'
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8900/jobs \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"type":"routine","executor":"dup-test","title":"Second","dedup_key":"dedup:test:1"}'
```

### Clean shutdown

```bash
bun run start &
RELAY_PID=$!
sleep 3
kill -TERM $RELAY_PID
wait $RELAY_PID
```

Verify exit code 0 or 143 (SIGTERM). No orphaned running jobs:
```bash
sqlite3 ~/.claude-relay/data/local.sqlite "SELECT id, status FROM jobs WHERE status='running';"
# Expected: empty result
```

### Regression

After any job queue changes, verify existing bot functionality:
- [ ] Regular chat message gets a Claude response
- [ ] `/status`, `/help`, `/memory` all respond correctly
- [ ] Group agent messages route correctly (if using multi-agent groups)
