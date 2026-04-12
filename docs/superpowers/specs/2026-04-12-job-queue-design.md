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
  (relay jobs run)         event-driven dispatch        → blackboard
Telegram message    →    ↓
                         InterventionManager
                           auto-approve rules
                           auto-resolve policies
                           Playwright E2E runner
                           confidence-based auto-proceed
                           Telegram push (fallback)
                           t3 add (escalation)
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
| `auto_resolve_policy` | enum (nullable) | `none` \| `approve_after_timeout` \| `skip_after_timeout` \| `abort_after_timeout` |
| `auto_resolve_timeout_ms` | int (nullable) | How long before auto-resolve triggers (null = inherit from type default) |
| `retry_count` | int | Default 0. Incremented on each retry. Max 3 before permanent failure |
| `timeout_ms` | int (nullable) | Per-job override for running timeout (null = inherit from type default) |
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
                 ↘ awaiting-intervention → running      (user or auto-resolved)
                              ↘ cancelled               (user aborted or auto-aborted)
                 ↘ preempted → pending                  (higher-priority job took the slot)
                 ↘ failed → pending (retry, if retry_count < 3) / cancelled
                 ↘ timed-out → failed                   (running exceeded timeout_ms)
```

**Auto-resolution:** `awaiting-intervention` jobs can self-resolve based on:
1. **Auto-resolve policy** — per-job `auto_resolve_policy` determines what happens after `auto_resolve_timeout_ms` elapses (see Intervention Protocol)
2. **Auto-approve rules** — matching rules in `~/.claude-relay/auto-approve.json` skip human notification entirely
3. **E2E auto-verification** — `e2e` interventions route to Playwright runner first; only genuine failures surface to user
4. **Confidence-based auto-proceed** — executors with confidence >= 0.85 proceed with best-guess, post non-blocking FYI

Jobs without a matching auto-resolve path stay in `awaiting-intervention` until a user acts (Telegram inline button or `relay jobs approve/abort/answer`).

**Retry cap:** Jobs track `retry_count`. After 3 retries, the job is permanently `failed` with `intervention_type: "error-recovery"` (dead-letter). No further auto-retry — user must investigate.

**Running timeout:** Each job type has a default timeout. If `started_at + timeout_ms < now`, the scheduler transitions the job to `failed`, releases the concurrency slot, and auto-retries once (if `retry_count < 3`).

| Type | Default timeout |
|---|---|
| `routine` | 5 min |
| `api-call` | 2 min |
| `claude-session` | 30 min |
| `compound` | 60 min |

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

`src/jobs/sources/webhookServer.ts` — lightweight HTTP server on a configurable local port. Accepts `POST /jobs` with JSON body matching the `submitJob()` payload. Auth via bearer token (`JOBS_WEBHOOK_SECRET` in `.env`).

Per-source scoping: `~/.claude-relay/webhook-acl.json` maps secrets to allowed job types:

```json
{
  "tokens": [
    { "name": "cron-agent", "secret": "...", "allowed_types": ["routine"] },
    { "name": "external-ci", "secret": "...", "allowed_types": ["api-call", "claude-session"] },
    { "name": "admin", "secret": "...", "allowed_types": "*" }
  ]
}
```

If only `JOBS_WEBHOOK_SECRET` is set (no ACL file), it acts as an admin token allowing all types. The ACL file is optional — only needed when multiple external sources need different access levels.

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
    autoResolvePolicy?: AutoResolvePolicy;   // override per-type default
    autoResolveTimeoutMs?: number;
    autoProceedConfidence?: number;           // 0-1; >= 0.85 → auto-proceed with FYI
    e2eScenario?: string;                     // Playwright scenario for auto-verification
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

### `CompoundExecutor` — `maxConcurrent: 2`

Orchestrates multi-step workflows using the existing blackboard (`src/orchestration/blackboard.ts`). Each blackboard round is a checkpoint. On restart: rehydrates the blackboard session from last checkpoint and continues from current round.

Concurrency of 2 is safe because blackboard sessions are isolated by `session_id`. The scheduler enforces that no two active compound jobs target overlapping `agentId` sets (prevents context bleed via shared Telegram message routing). If agent overlap is detected, the second job stays `pending` until the first completes.

---

## Priority Lanes + Concurrency

The scheduler is **event-driven** with a heartbeat safety net. It wakes on: `submitJob()`, job completion, intervention resolution, or timeout detection. A 500ms heartbeat poll runs as a fallback to catch missed events. This gives near-zero latency for urgent jobs while avoiding wasteful polling during long sessions.

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
| `compound` | 2 | Isolated by `session_id`; blocked if agent targets overlap |
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

The intervention system is designed **automation-first**: the majority of interventions should resolve without bothering the user. Human notification is the last resort, not the first action.

### Resolution cascade

When an executor returns `status: "awaiting-intervention"`, the `InterventionManager` runs this cascade top-to-bottom. The first match resolves the job — no human involved:

```
1. Auto-approve rules     → match? → auto-confirm, log FYI
2. Confidence auto-proceed → >= 0.85? → proceed with best-guess, post FYI
3. E2E auto-verification  → e2e type? → run Playwright scenario → pass? → auto-confirm
4. Auto-resolve policy     → has policy? → schedule auto-resolve at timeout
5. (fallback)             → notify human via Telegram
```

### Step 1: Auto-approve rules

Configurable rules at `~/.claude-relay/auto-approve.json`:

```json
[
  { "executor": "log-cleanup",     "intervention_types": ["approval"], "action": "confirm" },
  { "executor": "orphan-gc",       "intervention_types": ["approval"], "action": "confirm" },
  { "executor": "memory-cleanup",  "intervention_types": ["approval"], "action": "confirm" },
  { "source": "cron",              "intervention_types": ["budget"],   "action": "confirm",
    "condition": "confidence_gte:0.9" }
]
```

Rules checked on every intervention before any notification is sent. Matching rule → job auto-resolved, action logged to `metadata` for audit. Zero user involvement for zero-risk ops.

### Step 2: Confidence-based auto-proceed

Executors can set `autoProceedConfidence` in the `ExecutorResult.intervention` payload. If confidence >= 0.85, the `InterventionManager`:
1. Resumes the job immediately with `{ resolution: "auto-proceeded", confidence: N }`
2. Posts a non-blocking FYI to the originating chat: "Proceeded with best-guess (confidence: 0.92). Reply 'undo' within 5 min to rollback."
3. Logs the assumption in `metadata`

The 0.85 threshold is consistent with the existing `/reflect` confidence level used elsewhere in the bot.

### Step 3: E2E auto-verification (Playwright)

When `intervention_type === "e2e"` and the executor provides an `e2eScenario` string, the `InterventionManager` routes to the Playwright E2E runner (per the approved Playwright E2E architecture in `project_playwright_e2e_architecture.md`):

1. Launch Playwright with the scenario against Telegram Web
2. Claude Vision evaluates the result screenshot
3. If verdict is `pass` → auto-confirm, log result
4. If verdict is `fail` → fall through to human notification with the screenshot and failure reason attached

This means most E2E verifications complete automatically. The user only sees failures — not successes.

### Step 4: Auto-resolve policy

Per-job `auto_resolve_policy` determines what happens after `auto_resolve_timeout_ms` elapses with no human response:

| Policy | Behaviour | Default for |
|---|---|---|
| `none` | Never auto-resolve; stays until human acts | Destructive ops (deploys, restarts) |
| `approve_after_timeout` | Auto-confirm after timeout | Non-destructive `approval` interventions |
| `skip_after_timeout` | Auto-skip (mark done) after timeout | Idempotent routines, informational jobs |
| `abort_after_timeout` | Auto-cancel after timeout | Budget interventions |

Default policy per type (overridable per job):

| Type | Default policy | Default timeout |
|---|---|---|
| `routine` | `skip_after_timeout` | 2 hours |
| `api-call` | `abort_after_timeout` | 4 hours |
| `claude-session` | `none` | — |
| `compound` | `none` | — |

### Step 5: Human notification (fallback)

Only reached when steps 1-4 don't resolve the intervention.

Bot sends a structured card to the originating `chatId`/`threadId` (from job metadata), falling back to Command Center:

```
⚠️ Job awaiting your input
──────────────────────────
morning-summary · routine · 4 min ago

<intervention_prompt>

[✅ Confirm]  [✏️ Edit]  [⏭ Skip]  [❌ Abort]
```

### Reminder escalation (human path only)

| Time | Action |
|---|---|
| T+0 | First Telegram push |
| T+30min | Reminder #1 (re-sent card) |
| T+60min | Reminder #2 + `t3 add "Jarvis: <title> needs your input"` |
| T+60min+ | Job stays until user acts (or auto-resolve policy fires if set) |

Intervals configurable: `INTERVENTION_REMINDER_MINS` (default: 30), `INTERVENTION_T3_MINS` (default: 60).

### Resolution actions

| Action | Result |
|---|---|
| Confirm | Job resumes; executor receives `{ resolution: "confirmed" }` in checkpoint |
| Edit | Bot asks follow-up inline; answer stored in checkpoint; job resumes |
| Skip | Job marked `done` with note "skipped by user/auto" |
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
  jobQueue.ts                # event-driven scheduler, priority dispatch, slot management
  jobStore.ts                # SQLite read/write (Drizzle schema)
  interventionManager.ts     # auto-resolve cascade, Playwright E2E, notifications
  autoApproveEngine.ts       # rule matcher for ~/.claude-relay/auto-approve.json
  submitJob.ts               # shared helper — all sources use this
  executors/
    claudeSessionExecutor.ts
    routineExecutor.ts
    apiCallExecutor.ts
    compoundExecutor.ts
  sources/
    webhookServer.ts         # POST /jobs HTTP server + ACL
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
- [ ] `retry_count` incremented on retry; job permanently `failed` after 3 retries (dead-letter)
- [ ] `timeout_ms` defaults applied per type; timed-out running jobs transition to `failed`

### Job sources
- [ ] `routine-scheduler` submits jobs via `submitJob()` instead of executing directly
- [ ] Webhook server accepts `POST /jobs`, rejects requests without valid secret
- [ ] Webhook ACL: per-token `allowed_types` enforced when `webhook-acl.json` exists
- [ ] `relay jobs run "<prompt>"` submits a `claude-session` job
- [ ] Telegram long-running requests enqueued with originating `chatId`/`threadId` in metadata

### Executors
- [ ] `ClaudeSessionExecutor` delegates to orchestration layer and checkpoints per subtask
- [ ] `RoutineExecutor` constructs `RoutineContext` per scheduler spec and calls `run(ctx)`
- [ ] `ApiCallExecutor` retries with backoff before marking failed
- [ ] `CompoundExecutor` rehydrates blackboard session from checkpoint on restart
- [ ] `CompoundExecutor` blocks second job when agent targets overlap with a running job

### Priority + concurrency
- [ ] Urgent lane always dispatched before normal, normal before background
- [ ] `claude-session` global cap of 1 enforced
- [ ] `compound` cap of 2 with agent-overlap guard
- [ ] `routine` global cap of 3 enforced
- [ ] Background job preempted when urgent job of same type needs the slot
- [ ] Event-driven scheduler wake on submit/complete/resolve; 500ms heartbeat as safety net

### Intervention — automation
- [ ] Auto-approve rules loaded from `~/.claude-relay/auto-approve.json`; matching rules auto-confirm without notification
- [ ] Confidence >= 0.85 auto-proceeds with non-blocking FYI message
- [ ] `e2e` interventions route to Playwright runner; pass → auto-confirm; fail → surface to user with screenshot
- [ ] Auto-resolve policy (`skip_after_timeout`, `approve_after_timeout`, `abort_after_timeout`) fires at configured timeout
- [ ] Default policies applied per type: `routine` → skip@2h, `api-call` → abort@4h, `claude-session`/`compound` → none

### Intervention — human fallback
- [ ] Job status moves to `awaiting-intervention`; concurrency slot released
- [ ] Telegram card sent to originating chat (fallback: Command Center)
- [ ] Reminder at T+30min
- [ ] `t3 add` called at T+60min
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
- Job templates / saved job presets — v2
- Multi-user / multi-bot job queues — single user only
- Per-client API key management for webhook (v2 — v1 uses per-token ACL)
- Handler sandboxing / process isolation for routines
