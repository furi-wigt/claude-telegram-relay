# Job Queue System

The job queue is a persistent subsystem for scheduling, tracking, and executing background work. It supports multiple job sources, priority-based scheduling, and automation-first intervention handling.

## Executor Types

The job queue supports four executor types. Each executor is registered in `src/jobs/index.ts`.

### routine

`RoutineExecutor` — runs scheduled routines.

- **Handler-type routine**: executor looks up `routines/handlers/<executor-name>.ts` and calls `run(ctx)` with an injected `RoutineContext`. Handler module is loaded on first execution and cached — no startup cost.
- **Prompt-type routine**: if no handler file exists and `payload.prompt` is set, the executor sends the prompt to the LLM inline and posts the result to Telegram. No TypeScript handler needed.
- Handler modules are loaded via dynamic import; send `SIGUSR2` to `routine-scheduler` to reset the cache and hot-reload handlers without a full restart.

### claude-session

`ClaudeSessionExecutor` — runs an agentic Claude session.

- Invokes the orchestration layer: `classifyIntent` → `executeBlackboardDispatch`.
- If `metadata.chatId` is set, posts the result back to the originating Telegram chat (and `metadata.threadId` if present).
- On retry: re-runs the full dispatch from scratch (no partial resume — checkpoint resume deferred to v2).

### compound

`CompoundExecutor` — multi-step blackboard dispatch.

- Runs a sequence of blackboard dispatch steps defined in `payload.steps`.
- Agent-overlap guard: returns `awaiting-intervention` if any target agent is currently busy handling another job.
- Suitable for workflows that need multiple agents to contribute sequentially.

### api-call

`ApiCallExecutor` — makes an outbound HTTP request.

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

This replaces the previous pattern of one PM2 entry per routine. `ecosystem.config.cjs` no longer needs per-routine cron entries — only `routine-scheduler` and `telegram-relay` are always-running services.

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
- `/jobs` — list recent jobs with status indicators
- `/jobs pending` / `/jobs failed` — filtered views
- `/schedule <prompt>` — enqueue a `claude-session` job; result is posted back to the originating chat/thread
- Intervention cards appear automatically with inline action buttons

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

User rules in `~/.claude-relay/auto-approve.json` are merged with repo defaults — you only need to add rules beyond the defaults.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `JOBS_WEBHOOK_PORT` | (disabled) | Webhook server port. **Required** for `routine-scheduler` to submit jobs. |
| `JOBS_WEBHOOK_SECRET` | (required if port set) | Bearer token for webhook auth. **Required** alongside `JOBS_WEBHOOK_PORT`. |
| `INTERVENTION_REMINDER_MINS` | 30 | Minutes before first reminder |
| `INTERVENTION_T3_MINS` | 60 | Minutes before Things 3 escalation |

> `JOBS_WEBHOOK_PORT` and `JOBS_WEBHOOK_SECRET` must both be set for the `routine-scheduler` service to function. Without them, the webhook server does not start and scheduled routines cannot be submitted.
