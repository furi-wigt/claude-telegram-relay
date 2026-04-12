# Job Queue System — Design Spec

**Date:** 2026-04-12
**Status:** Approved
**Related spec:** `~/.claude-relay/specs/260411_2356_01_plugin-routines-scheduler-spec.md`

---

## Problem

The bot currently handles two classes of work that are architecturally separate and invisible to each other:

1. **Interactive Telegram messages** — processed via `src/queue/messageQueue.ts` (in-memory FIFO per chat, no persistence, no visibility)
2. **Scheduled routines** — fired directly by PM2 cron (no queue, no dedup, no history, no intervention support)

There is no unified mechanism to: accept jobs from external sources (webhooks, agents, CLI), track their lifecycle, surface status to the user without Telegram, or pause execution for human approval.

## Proposed Solution

A persistent **job queue subsystem** (`src/jobs/`) that sits alongside — not replacing — the existing message queue and orchestration layer. All work that is not a real-time Telegram reply goes through this queue. Sources are source-agnostic; executors are pluggable; visibility is available via Telegram and CLI.

---

## Architecture Overview

```
Sources                  src/jobs/                    Executors
──────────────────       ─────────────────────────    ─────────────────────────
routine-scheduler   →    submitJob()                  ClaudeSessionExecutor
  (node-cron)            ↓                              → orchestration layer
webhook server      →    JobStore (SQLite)            RoutineExecutor
  (POST /jobs)           ↓                              → routines/handlers/*
agent handoff       →    JobQueue                     ApiCallExecutor
  (submitJob())            priority lanes               → src/tools/*
CLI submission      →      concurrency caps           CompoundExecutor
  (relay jobs run)         scheduler loop               → blackboard
Telegram message    →    ↓
                         InterventionManager
                           Telegram push
                           t3 add (T+60min)
                         ↓
Visibility               JobStore (read)
──────────────────       /jobs Telegram command
relay jobs (CLI)         job detail cards
```

---

## Data Model

### `jobs` table

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `dedup_key` | text (unique, nullable) | Prevents duplicate submissions (e.g. `routine:morning-summary:2026-04-12`) |
| `source` | enum | `telegram` \| `cron` \| `webhook` \| `agent` \| `cli` |
| `type` | enum | `claude-session` \| `routine` \| `api-call` \| `compound` |
| `priority` | enum | `urgent` \| `normal` \| `background` |
| `executor` | text | Registered executor name (e.g. `"morning-summary"`, `"claude-session"`) |
| `title` | text | Human-readable label |
| `payload` | JSON | Executor-specific parameters |
| `status` | enum | See status lifecycle |
| `intervention_type` | enum (nullable) | `approval` \| `clarification` \| `e2e` \| `error-recovery` \| `budget` |
| `intervention_prompt` | text (nullable) | Message shown to user when paused |
| `intervention_due_at` | datetime (nullable) | When to send next reminder |
| `created_at` | datetime | |
| `started_at` | datetime (nullable) | |
| `completed_at` | datetime (nullable) | |
| `error` | text (nullable) | Last error message |
| `metadata` | JSON (nullable) | Originating `chatId`, `threadId`, tags, context |

### `job_checkpoints` table

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `job_id` | FK → jobs | |
| `round` | int | Checkpoint sequence number |
| `state` | JSON | Executor-specific progress snapshot |
| `created_at` | datetime | |

### Status Lifecycle

```
pending → running → done
                 ↘ paused ↔ running                    (manual pause/resume)
                 ↘ awaiting-intervention → running      (user resolved)
                              ↘ cancelled               (user aborted)
                 ↘ preempted → pending                  (higher-priority job took the slot)
                 ↘ failed → pending (retry) / cancelled
```

`awaiting-intervention` never self-resolves — only a user action (Telegram inline button or `relay jobs approve/abort/answer`) transitions it out.

---

## Job Sources

### Cron (via routine-scheduler)

`routines/scheduler.ts` (per the approved Plugin Routines Scheduler spec) handles cron registration and hot-reload. When `node-cron` fires a task, the scheduler calls `submitJob()` instead of executing directly:

```typescript
cron.schedule(config.schedule, async () => {
  await submitJob({
    type: "routine",
    executor: config.name,
    title: config.name,
    priority: "normal",
    source: "cron",
    dedup_key: `routine:${config.name}:${toDateKey()}`,
    payload: { config },
  });
});
```

The dedup key prevents double-fire on PM2 retry or scheduler restart.

### Webhook / External Events

`src/jobs/sources/webhookServer.ts` — lightweight HTTP server on a configurable local port. Accepts `POST /jobs` with JSON body matching the `submitJob()` payload. Auth via shared secret (`JOBS_WEBHOOK_SECRET` in `.env`).

External tools, scripts, and other agents POST jobs without touching Telegram.

### Agent Handoff

Other Claude agents (orchestration layer or external) call `submitJob()` directly — same function used by cron, no separate IPC. The blackboard's artifact space can also trigger a job when a compound workflow produces a handoff artifact.

### CLI Submission

`relay jobs run "<prompt>"` submits a `claude-session` job. Reads/writes SQLite directly — no HTTP hop. Works even when the bot is offline.

### Telegram

Long-running Telegram requests (detected as >N seconds, or via explicit `/schedule`) are enqueued as jobs rather than blocking the message handler. Originating `chatId` and `threadId` stored in `metadata` so results route back to the right group/thread when done.

---

## Executors

All executors implement a common interface:

```typescript
interface JobExecutor {
  type: JobType;
  maxConcurrent: number;
  execute(job: Job, checkpoint?: JobCheckpoint): Promise<ExecutorResult>;
  checkpoint?(job: Job, state: unknown): Promise<void>;
}

interface ExecutorResult {
  status: "done" | "failed" | "awaiting-intervention";
  intervention?: {
    type: InterventionType;
    prompt: string;
    dueInMs: number;
  };
  error?: string;
  summary?: string;
  artifactPath?: string;
}
```

### `ClaudeSessionExecutor` — `maxConcurrent: 1`

Wraps the existing orchestration dispatch. Submits a `DispatchPlan` to the orchestration engine and streams results back. Checkpoints after each subtask completes (stores blackboard round + completed seq numbers). Resumes from last completed seq on restart.

### `RoutineExecutor` — `maxConcurrent: 3`

Implements the `RoutineContext` interface from the approved scheduler spec. Dynamically imports `routines/handlers/<executor>.ts` and calls `run(ctx)`. No checkpoint needed — handlers are short-lived and idempotent. On failure: job marked `failed`, dedup key expires, next cron trigger re-runs cleanly.

### `ApiCallExecutor` — `maxConcurrent: 5`

Executes a configured HTTP request or a named integration from `src/tools/`. Stores response in `job_checkpoints`. Retries with exponential backoff before escalating to `failed`. Returns `awaiting-intervention` on budget or rate-limit responses.

### `CompoundExecutor` — `maxConcurrent: 1`

Orchestrates multi-step workflows using the existing blackboard (`src/orchestration/blackboard.ts`). Each blackboard round is a checkpoint. On restart: rehydrates the blackboard session from last checkpoint and continues from current round.

---

## Priority Lanes + Concurrency

The scheduler loop runs every 500ms. It fills available concurrency slots in priority order.

### Lanes

| Lane | Use cases |
|---|---|
| `urgent` | User-initiated from Telegram, critical alerts |
| `normal` | Scheduled routines, CLI submissions, agent handoffs |
| `background` | ETF screener, memory cleanup, log rotation |

Urgent is always drained before normal; normal before background.

### Per-type concurrency caps (global)

| Type | Max concurrent | Rationale |
|---|---|---|
| `claude-session` | 1 | Expensive; serialised to avoid context bleed |
| `compound` | 1 | Single active blackboard session |
| `routine` | 3 | Lightweight handlers, safe to parallelise |
| `api-call` | 5 | I/O-bound; high parallelism fine |

### Scheduling decision

```
for each lane [urgent, normal, background]:
  for each pending job in FIFO order:
    if runningCount(job.type) < maxConcurrent(job.type):
      dispatch(job)
```

### Background preemption

If an `urgent` job needs a slot held by a `background` job of the same type, the background job is checkpointed and moved to `pending` (status: `preempted`). Same-lane jobs are never preempted.

---

## Intervention Protocol

### Triggering

An executor returns `status: "awaiting-intervention"` with intervention details. The job queue:
1. Sets job status to `awaiting-intervention`
2. Releases the concurrency slot immediately
3. Sets `intervention_due_at = now + dueInMs`
4. Delegates to `InterventionManager`

### Telegram notification

Bot sends a structured card to the originating `chatId`/`threadId` (from job metadata), falling back to Command Center:

```
⚠️ Job awaiting your input
──────────────────────────
morning-summary · routine · 4 min ago

<intervention_prompt>

[✅ Confirm]  [✏️ Edit]  [⏭ Skip]  [❌ Abort]
```

### Reminder escalation

| Time | Action |
|---|---|
| T+0 | First Telegram push |
| T+30min | Reminder #1 (re-sent card) |
| T+60min | Reminder #2 + `t3 add "Jarvis: <title> needs your input"` |
| T+60min+ | Job stays in `awaiting-intervention` indefinitely — no auto-abort |

Intervals configurable: `INTERVENTION_REMINDER_MINS` (default: 30), `INTERVENTION_T3_MINS` (default: 60).

### Resolution

| Action | Result |
|---|---|
| Confirm | Job resumes; executor receives `{ resolution: "confirmed" }` in checkpoint |
| Edit | Bot asks follow-up inline; answer stored in checkpoint; job resumes |
| Skip | Job marked `done` with note "skipped by user" |
| Abort | Job marked `cancelled` |

### CLI resolution

```bash
relay jobs approve <id>        # confirm
relay jobs answer <id> "text"  # answer clarification
relay jobs abort <id>          # cancel
```

---

## Visibility Layer

### Telegram — `/jobs [filter]`

Default view (10 most recent active/recent jobs):

```
📋 Jobs (3 running · 1 awaiting you · 2 done)
────────────────────────────────────────────
⚠️  cdk-deploy          approval needed   12m
▶️  morning-summary     running           2m
▶️  weekly-etf          running           5m
⏳  memory-cleanup      pending           —
✅  orphan-gc           done  14s         8m ago
✅  smart-checkin       done  42s         1h ago

[⚠️ Needs attention]  [▶️ Running]  [📜 History]
```

Tap any job → detail card (description, source, started, duration, error, action buttons).

Filter shortcuts: `/jobs pending` · `/jobs failed` · `/jobs today`

### CLI — `relay jobs`

```bash
relay jobs                          # table: active + last 20 done
relay jobs --status pending         # filter by status
relay jobs --type routine           # filter by type
relay jobs --intervention           # only awaiting-intervention jobs
relay jobs <id>                     # full detail: timeline, checkpoint, error
relay jobs run "<prompt>"           # submit claude-session job
relay jobs run --type routine --executor morning-summary
relay jobs approve <id>             # resolve → confirmed
relay jobs answer <id> "text"       # resolve clarification
relay jobs abort <id>               # cancel
relay jobs retry <id>               # re-queue failed (new id, same payload)
relay jobs cancel <id>              # cancel before it starts
```

Output: plain table by default; `--json` for scripting.

The CLI reads SQLite directly — works even when the bot is offline.

---

## Integration with Existing Code

### Unchanged

- `src/queue/messageQueue.ts` + `src/queue/groupQueueManager.ts`
- `src/orchestration/` (dispatch engine, blackboard, interrupt protocol)
- `routines/*.ts` (migrated gradually to `routines/handlers/` per scheduler spec)
- `ecosystem.config.cjs` (one entry added: `routine-scheduler`; existing per-routine entries removed as handlers are migrated)

### New structure

```
src/jobs/
  jobQueue.ts                # scheduler loop, priority dispatch, slot management
  jobStore.ts                # SQLite read/write (Drizzle schema)
  interventionManager.ts     # pause, notify, remind, t3 escalation
  submitJob.ts               # shared helper — all sources use this
  executors/
    claudeSessionExecutor.ts
    routineExecutor.ts
    apiCallExecutor.ts
    compoundExecutor.ts
  sources/
    webhookServer.ts         # POST /jobs HTTP server
  cli.ts                     # relay jobs <command> entry point

routines/
  scheduler.ts               # single PM2 process (per scheduler spec)
  handlers/                  # migrated handler modules (one per routine)
    morning-summary.ts
    night-summary.ts
    smart-checkin.ts
    weekly-etf.ts
    etf-52week-screener.ts
    watchdog.ts
    memory-cleanup.ts
    memory-dedup-review.ts
    log-cleanup.ts
    orphan-gc.ts
```

### Boot sequence

`JobQueue.start()` is called from `src/relay.ts` startup alongside the existing bot. The webhook server starts on a separate configurable port. `routine-scheduler` is a separate PM2 process that only submits jobs — it never executes them.

### `package.json` additions

```json
"relay:jobs": "bun run src/jobs/cli.ts"
```

Available as `bun run relay:jobs` or shell alias `relay`.

---

## Acceptance Criteria

### Data model
- [ ] `jobs` and `job_checkpoints` tables created via Drizzle migration
- [ ] `dedup_key` unique constraint prevents double-submission
- [ ] All status transitions enforced (no invalid state jumps)

### Job sources
- [ ] `routine-scheduler` submits jobs via `submitJob()` instead of executing directly
- [ ] Webhook server accepts `POST /jobs`, rejects requests without valid secret
- [ ] `relay jobs run "<prompt>"` submits a `claude-session` job
- [ ] Telegram long-running requests enqueued with originating `chatId`/`threadId` in metadata

### Executors
- [ ] `ClaudeSessionExecutor` delegates to orchestration layer and checkpoints per subtask
- [ ] `RoutineExecutor` constructs `RoutineContext` per scheduler spec and calls `run(ctx)`
- [ ] `ApiCallExecutor` retries with backoff before marking failed
- [ ] `CompoundExecutor` rehydrates blackboard session from checkpoint on restart

### Priority + concurrency
- [ ] Urgent lane always dispatched before normal, normal before background
- [ ] `claude-session` global cap of 1 enforced
- [ ] `routine` global cap of 3 enforced
- [ ] Background job preempted when urgent job of same type needs the slot

### Intervention
- [ ] Job status moves to `awaiting-intervention`; concurrency slot released
- [ ] Telegram card sent to originating chat (fallback: Command Center)
- [ ] Reminder at T+30min
- [ ] `t3 add` called at T+60min
- [ ] No auto-abort — job stays until user acts
- [ ] All four resolution actions (confirm / edit / skip / abort) work via Telegram and CLI

### Visibility
- [ ] `/jobs` renders status summary with emoji indicators
- [ ] `/jobs pending`, `/jobs failed`, `/jobs today` filters work
- [ ] Tap on job → detail card with timeline and action buttons
- [ ] `relay jobs` table output readable without the bot running
- [ ] `relay jobs --json` produces valid JSON

### Integration
- [ ] Existing Telegram message flow unaffected (`bun run test` green)
- [ ] `routine-scheduler` PM2 entry starts cleanly; existing per-routine entries still work during migration
- [ ] Job queue starts and stops cleanly with `src/relay.ts`

---

## Out of Scope

- Web dashboard (browser UI) — CLI + Telegram covers v1
- Job dependency graph (job A triggers job B on completion) — v2
- Per-job retry policies — uniform: log + mark failed + allow manual retry
- Job templates / saved job presets — v2
- Multi-user / multi-bot job queues — single user only
