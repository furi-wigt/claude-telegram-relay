# Routines — Developer Guide

This guide explains how to write a correct code-based routine in this project.
Read it before creating or modifying any file in `routines/`.

---

## Core vs User Routines

Routines are split into two categories stored in separate directories:

| Category | Location | Config file | Purpose |
|----------|----------|-------------|---------|
| **Core** | `routines/handlers/` (in repo) | `config/routines.config.json` | System maintenance: log cleanup, memory cleanup, watchdog, GC, dedup review, weekly retro |
| **User** | `~/.claude-relay/routines/` (external) | `~/.claude-relay/routines.config.json` | Personal routines: morning summary, check-ins, ETF reports, etc. |

The executor resolves handlers in this order:
1. `~/.claude-relay/routines/<name>.ts` (user directory — checked first)
2. `routines/handlers/<name>.ts` (repo directory — fallback)

This means users can override core routines by placing a same-named file in the user directory.

**Examples:** `routines/handlers/examples/` contains annotated example handlers
(morning-summary, smart-checkin) that demonstrate common patterns. Copy and
customise them — see instructions inside each file.

---

## When to write a code-based routine

Use a TypeScript handler when the task needs real data:
API calls, database queries, conditional logic, or external integrations.

For simple scheduled prompts with no custom logic, add a `"type": "prompt"` entry
to the appropriate config file — no handler file needed.

---

## Handler contract

Handlers export a single `run` function. The scheduler owns all lifecycle
boilerplate — no `_isEntry`, `loadEnv`, or `process.exit` needed.

**Core handler** (lives in `routines/handlers/<name>.ts`):
```typescript
import type { RoutineContext } from "../../src/jobs/executors/routineContext.ts";

export async function run(ctx: RoutineContext): Promise<void> {
  await ctx.skipIfRanWithin(6);
  const result = await ctx.llm("Summarise today's activity.");
  await ctx.send(result);
  ctx.log("my-routine complete");
}
```

**User handler** (lives in `~/.claude-relay/routines/<name>.ts`):
```typescript
// Import paths are relative to the repo root (the executor resolves from there)
import type { RoutineContext } from "../../src/jobs/executors/routineContext.ts";

export async function run(ctx: RoutineContext): Promise<void> {
  const result = await ctx.llm("Give me a morning briefing.");
  await ctx.send(result);
}
```

> **Note:** User handlers use the same import paths as core handlers because Bun
> resolves relative imports from the project root at runtime.

### RoutineContext API

Import path: `../../src/jobs/executors/routineContext.ts`

| Method | Signature | Description |
|---|---|---|
| `send` | `(message: string) => Promise<void>` | Send message to the routine's Telegram group and persist to database. |
| `llm` | `(prompt: string, opts?: LlmOpts) => Promise<string>` | Call LLM via ModelRegistry `routine` slot (cascade: Claude → local model). |
| `log` | `(message: string) => void` | Write a tagged log line. |
| `skipIfRanWithin` | `(hours: number) => Promise<void>` | Mark job `skipped` and stop if routine ran successfully within N hours. |

### Registering the routine

**Core routine** — add to `config/routines.config.json`:
```json
{ "name": "my-routine", "schedule": "0 9 * * *", "group": "OPERATIONS", "type": "handler", "enabled": true }
```

**User routine** — add to `~/.claude-relay/routines.config.json`:
```json
{ "name": "my-routine", "schedule": "0 9 * * *", "group": "OPERATIONS", "type": "handler", "enabled": true }
```

The scheduler merges both configs. User entries override repo entries with the same name.

Do NOT add an entry to `ecosystem.config.cjs` — the `routine-scheduler` service reads the config and registers cron jobs automatically.

---

## Sending messages in handlers: `ctx.send()`

In handler-type routines (`routines/handlers/`), always use `ctx.send(message)`.
This sends to Telegram AND persists the message to the local database, equivalent
to `sendAndRecord`. The `RoutineContext` handles group resolution internally.

---

## Sending messages in legacy scripts: `sendAndRecord` vs `sendToGroup`

> This section applies to any remaining standalone scripts. New code should use handlers.


| Situation | Use |
|---|---|
| Proactive bot message (briefing, check-in, summary, reminder) | **`sendAndRecord`** |
| Infrastructure / system alert (watchdog, health check) | `sendToGroup` directly |

**Always use `sendAndRecord` for conversational messages.** It sends to
Telegram AND persists the message to the local database so it appears in the
bot's rolling short-term memory window (with a pre-computed local LLM summary).

Using `sendToGroup` directly bypasses memory — correct for infra alerts,
wrong for anything the user might want to reference later.

### sendAndRecord signature

```ts
await sendAndRecord(chatId, message, {
  routineName: "my-routine",      // required — kebab-case, matches @routine tag
  agentId: "general-assistant",   // required — agent from config/agents.json
  topicId: GROUPS.GENERAL.topicId,// required — pass null if no forum topics
  parseMode?: "HTML" | "Markdown",// optional — see parse mode rules below
});
```

### Parse mode rules

| parseMode | When to use | What you pass as `message` |
|---|---|---|
| omitted (default) | LLM-generated text, markdown strings | Raw markdown — auto-converted to HTML |
| `"HTML"` | Pre-formatted HTML, mixed content | `markdownToHtml(yourMarkdown)` |
| `"Markdown"` | Simple text needing legacy Telegram markdown | Raw Telegram markdown |

**Recommended pattern:** write your content in markdown, omit `parseMode`,
and let `sendAndRecord` handle the conversion automatically.

If you explicitly pass `parseMode: "HTML"`, you must call `markdownToHtml()`
yourself before passing the string:

```ts
import { markdownToHtml } from "../src/utils/htmlFormat.ts";

await sendAndRecord(GROUPS.GENERAL.chatId, markdownToHtml(markdownContent), {
  routineName: "my-routine",
  agentId: "general-assistant",
  parseMode: "HTML",
  topicId: GROUPS.GENERAL.topicId,
});
```

---

## Group resolution

Always resolve chat IDs via the `GROUPS` registry — never hardcode numbers.

```ts
import { GROUPS, validateGroup } from "../src/config/groups.ts";

// Validate first — exit gracefully if group not configured
if (!validateGroup("GENERAL")) {
  console.error("Set chatId in config/agents.json");
  process.exit(0);
}

// Then use
GROUPS.GENERAL.chatId   // number
GROUPS.GENERAL.topicId  // number | null
```

Available group keys match `groupKey` values in `config/agents.json`:
`GENERAL`, `AWS_ARCHITECT`, `SECURITY`, `DOCS`, `CODE_QUALITY`.

---

## Data fetching patterns

### Parallel independent fetches
```ts
const [messages, facts, goals] = await Promise.all([
  getTodaysMessages(),
  getTodaysFacts(),
  getActiveGoals(),
]);
```

### Partial failure acceptable
```ts
const [weatherRes, forecastRes] = await Promise.allSettled([
  weather.getMorningSummary(),
  weather.get2HourForecast(),
]);
if (forecastRes.status === "fulfilled") { /* use it */ }
```

---

## Error handling

**Always `process.exit(0)` in `main()` catch — never exit with code 1.**
Exit 1 triggers an immediate PM2 restart loop. Exit 0 tells PM2 the cron
task completed; it retries at the next scheduled time.

**Always send a Telegram notification on fatal error.** Routines run
unattended — silent failures are invisible. Use `sendToGroup` (not
`sendAndRecord`) for fatal errors. Wrap the send in its own try/catch so
a Telegram failure does not prevent `process.exit(0)`.

```ts
import { sendToGroup } from "../src/utils/sendToGroup.ts";
import { GROUPS } from "../src/config/groups.ts";

// ⚠️ Do NOT use `if (import.meta.main)` — it breaks under PM2 bun container.
// PM2's ProcessContainerForkBun.js loads scripts via require(), which sets
// import.meta.main = false. main() silently never fires. Use _isEntry instead.
const _isEntry =
  import.meta.main ||
  process.env.pm_exec_path === import.meta.url?.replace("file://", "");

if (_isEntry) {
  main().catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Error running my-routine:", err);
    try {
      await sendToGroup(GROUPS.GENERAL.chatId, `⚠️ my-routine failed:\n\n${msg}`);
    } catch { /* ignore secondary failure */ }
    process.exit(0); // ← always 0
  });
}
```

Validate required config at the top of `main()` and exit 0 early rather
than letting the routine fail mid-execution:

```ts
async function main() {
  if (!validateGroup("GENERAL")) { process.exit(0); }
  // Validate any required config here
  // ... rest of logic
}
```

---

## Testing: export pure functions

Extract business logic into pure functions; export them for tests.
Keep side effects (network calls, database writes, Telegram sends) in
private functions or behind injected providers.

```ts
// ✓ exportable — pure, testable
export function buildMessage(data: MyData): string { ... }

// ✓ exportable — injectable providers, no real I/O
export async function analyzeWithProviders(
  prompt: string,
  providers: { claude: (p: string) => Promise<string>; local: ... }
): Promise<Result> { ... }

// ✗ keep private — real I/O
async function fetchFromDatabase(): Promise<Data[]> { ... }
```

Test file convention: `routines/<name>.test.ts`
Run: `bun test routines/<name>.test.ts`

---

## User config

```ts
import { USER_NAME, USER_TIMEZONE } from "../src/config/userConfig.ts";
```

Use these in prompts and date formatting — never hardcode names or timezones.

---

## ⚠️ PM2 + Bun: handler files do not need `_isEntry`

Handlers in `routines/handlers/` are pure modules — they export `run(ctx)` and
nothing else. The `routine-scheduler` service owns the PM2 lifecycle. You do NOT
need `_isEntry`, `import.meta.main`, `loadEnv`, or `process.exit` in handler files.

The old `_isEntry` pattern was required for standalone routine scripts
(`routines/*.ts`). Those scripts no longer exist; all routines are now handlers.

---

## ⚠️ PM2 Deployment Safety Rules

### Only two always-running PM2 services

After the handler migration, `ecosystem.config.cjs` has two always-running services:

- `telegram-relay` — the main bot. Sacred. Never restart accidentally.
- `routine-scheduler` — single cron dispatcher. Reads `config/routines.config.json` and submits jobs via webhook.

Per-routine PM2 entries (e.g. `morning-summary`, `night-summary`, `smart-checkin`) have been removed. Do NOT add new per-routine entries to `ecosystem.config.cjs`.

### Never restart all services at once

```bash
# ✗ DO NOT — restarts ALL services including telegram-relay (Jarvis goes offline)
npx pm2 reload ecosystem.config.cjs
npx pm2 restart ecosystem.config.cjs
npx pm2 reload ecosystem.config.cjs --update-env

# ✓ DO — restart only the specific service(s) you changed
npx pm2 restart routine-scheduler
```

`telegram-relay` is sacred. Accidentally restarting it via an ecosystem-wide
command causes a restart loop and takes Jarvis offline. Always name the service
explicitly.

### Never modify ecosystem.config.cjs interpreter patterns

```js
// ✗ DO NOT — breaks all services, causes Jarvis to restart continuously
{ interpreter: "none", exec: "/bin/sh -c 'bun run script.ts'" }

// ✓ DO — keep the default bun interpreter entry
{ interpreter: "bun", script: "src/scheduler.ts" }
```

Changing the interpreter or exec pattern in `ecosystem.config.cjs` affects every
service. Never work around a broken routine by patching the ecosystem config —
fix the handler instead.

### Adding a new core routine

1. Create `routines/handlers/<name>.ts` exporting `run(ctx: RoutineContext)`.
2. Add an entry to `config/routines.config.json` with name, schedule, group, and type.
3. Restart `routine-scheduler` only:

```bash
npx pm2 restart routine-scheduler
npx pm2 save
```

No `ecosystem.config.cjs` edit needed.

### Adding a new user routine

1. Copy an example from `routines/handlers/examples/` to `~/.claude-relay/routines/<name>.ts`.
2. Customise the handler logic.
3. Add an entry to `~/.claude-relay/routines.config.json`.
4. The scheduler hot-reloads config changes — no restart needed for config-only changes.
   If you added a new handler file, restart `routine-scheduler`: `npx pm2 restart routine-scheduler`.

---

## LLM provider order

For text-only tasks (summarization, extraction, classification), use `callRoutineModel()`
which routes through the **ModelRegistry** (`routine` slot). Logging is handled automatically.

```ts
import { callRoutineModel } from "../src/routines/routineModel.ts";

const result = await callRoutineModel(prompt, {
  label: "my-routine",
  timeoutMs: 30_000,
});
```

**Provider:** Configured in `~/.claude-relay/models.json` under the `routine` slot.
Cascade order is user-defined — typically Claude → LM Studio / Ollama → error.
The ModelRegistry handles health checks and failover automatically.

**Note:** Local models do **not** support tool use. If a routine needs
Claude tools/agentic capabilities, use `claudeText`/`claudeStream` directly.

---

## Quick checklist

### Core routine (committed to repo)

- [ ] File lives at `routines/handlers/<name>.ts`
- [ ] Exports `export async function run(ctx: RoutineContext): Promise<void>`
- [ ] No `_isEntry`, `import.meta.main`, `loadEnv`, or `process.exit` — scheduler owns boilerplate
- [ ] Uses `ctx.send()` for user-facing messages (records to DB automatically)
- [ ] Uses `ctx.llm()` for LLM calls (not `callRoutineModel` directly)
- [ ] Uses `ctx.skipIfRanWithin(hours)` if idempotency is required
- [ ] Pure functions extracted and exported for testing
- [ ] Test file exists: `routines/<name>.test.ts`
- [ ] Entry added to `config/routines.config.json` with correct `name`, `schedule`, `group`, `type`
- [ ] After deploy: `npx pm2 restart routine-scheduler` only (never ecosystem-wide restart)

### User routine (external, per-user)

- [ ] File lives at `~/.claude-relay/routines/<name>.ts`
- [ ] Exports `export async function run(ctx: RoutineContext): Promise<void>`
- [ ] Entry added to `~/.claude-relay/routines.config.json`
- [ ] Uses `ctx.send()`, `ctx.llm()`, `ctx.log()`, `ctx.skipIfRanWithin()` as needed
