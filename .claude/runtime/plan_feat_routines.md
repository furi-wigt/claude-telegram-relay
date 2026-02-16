# Plan: Two-Type Routines Support

**Branch:** `routines`
**Date:** 2026-02-17
**Status:** Draft

---

## Problem Statement

The `/routines` bot command only surfaces prompt-based routines (`routines/user/`).
Code-based routines (`routines/*.ts`) — built via coding sessions and registered in
`ecosystem.config.cjs` — are invisible to the bot. Two routines (`aws-daily-cost.ts`,
`security-daily-scan.ts`) exist on disk but aren't even registered in PM2.

---

## Two Routine Types

### Type 1: Prompt-Based Routines

| Property | Value |
|----------|-------|
| Location | `routines/user/<name>.ts` |
| Creation | Conversational (natural language → Claude extracts config) |
| Logic | Auto-generated wrapper: calls Claude with a prompt, sends response to Telegram |
| PM2 | Dynamically appended to `ecosystem.config.cjs` by `routineManager.ts` |
| Source of truth | File comment headers + `routines/user/` directory scan |

### Type 2: Code-Based Routines

| Property | Value |
|----------|-------|
| Location | `routines/<name>.ts` (root level, not in `user/`) |
| Creation | Coding session (VS Code or Telegram `/code` agentic sessions) |
| Logic | Hand-coded TypeScript with real integrations (APIs, Supabase, etc.) |
| PM2 | Registered as static entries in `ecosystem.config.cjs` |
| Source of truth | `ecosystem.config.cjs` apps array (for registered ones) + file scan (for all) |

---

## Current Files

### Registered in ecosystem.config.cjs
- `enhanced-morning-summary` — cron `0 7 * * *` (daily 7am)
- `smart-checkin` — cron `*/30 * * * *` (every 30min)
- `night-summary` — cron `0 23 * * *` (daily 11pm)
- `weekly-etf` — cron `0 18 * * 5` (Friday 6pm)
- `watchdog` — cron `0 */2 * * *` (every 2h)

### Unregistered (exist on disk, not in ecosystem.config.cjs)
- `aws-daily-cost.ts` — intended schedule: 9am daily
- `security-daily-scan.ts` — intended schedule: TBD

---

## Desired `/routines list` Output

```
System Routines (code-based):
  enhanced-morning-summary  daily 7:00am     running
  smart-checkin             every 30min      running
  night-summary             daily 11:00pm    stopped
  weekly-etf                Friday 6:00pm    stopped
  watchdog                  every 2h         running
  aws-daily-cost            (not registered) ⚠️
  security-daily-scan       (not registered) ⚠️

User Routines (prompt-based):
  (none yet — describe one to create it)
```

Unregistered files prompt registration flow via inline keyboard.

---

## Implementation Plan

### Phase 1: Data Layer

**1a. `listCodeRoutines()` in `routineManager.ts`**

```typescript
export interface CodeRoutineEntry {
  name: string;
  scriptPath: string;        // e.g. "routines/aws-daily-cost.ts"
  cron: string | null;       // null if not registered
  registered: boolean;       // in ecosystem.config.cjs
  pm2Status: PM2Status | null; // null if not registered
}

type PM2Status = "online" | "stopped" | "errored" | "launching" | "unknown";
```

Logic:
1. Scan `routines/*.ts` (exclude `user/` subdirectory) → all code routine files
2. Parse `ecosystem.config.cjs` → extract entries where `script` starts with `routines/` but not `routines/user/`
3. Run `pm2 jlist` → parse JSON for current process status
4. Merge all three sources into `CodeRoutineEntry[]`

**1b. `registerCodeRoutine(name, cron)` in `routineManager.ts`**

- Add entry to `ecosystem.config.cjs` apps array (static section, before user-created entries)
- Run `pm2 start` for the routine
- Run `pm2 save`

**1c. `updateCodeRoutineCron(name, newCron)` in `routineManager.ts`**

- Update `cron_restart` in `ecosystem.config.cjs`
- Run `pm2 restart <name>` to apply

**1d. `toggleCodeRoutine(name, enabled)` in `routineManager.ts`**

- Enabled → `pm2 start <name>` (or `pm2 restart`)
- Disabled → `pm2 stop <name>` (does not remove from ecosystem)

**1e. `triggerCodeRoutine(name)` in `routineManager.ts`**

- Run `pm2 restart <name>` with `--update-env`
- This triggers an immediate execution run

---

### Phase 2: `/routines` Command Extension

**Updated `handleRoutinesCommand` in `routineHandler.ts`**

Subcommands:

```
/routines list               → show both sections (auto-detects unregistered)
/routines status [name]      → PM2 status for all or specific routine
/routines run <name>         → manually trigger execution
/routines enable <name>      → resume stopped routine
/routines disable <name>     → pause routine (pm2 stop)
/routines schedule <name> <cron>  → update cron expression
/routines register <name> <cron> → register unregistered code routine into PM2
/routines delete <name>      → delete (user routines only; code routines blocked)
```

**Unregistered Routine Prompt Flow (inline keyboard):**

When `/routines list` detects unregistered files:
```
⚠️ 2 unregistered routines found:
  • aws-daily-cost
  • security-daily-scan

Register them to add to PM2 schedule?
[Register aws-daily-cost] [Register security-daily-scan] [Skip]
```

Clicking "Register <name>" triggers a cron-entry sub-flow (ask for schedule).

---

### Phase 3: Code-Based Routine Metadata Convention

To enable richer display without parsing ecosystem.config.cjs for descriptions,
add a standard file header to all code routines:

```typescript
/**
 * @routine aws-daily-cost
 * @description AWS cost alert with spend analysis
 * @schedule 0 9 * * *
 * @target AWS Architect group
 */
```

The `listCodeRoutines()` can optionally parse this for description/intended schedule
if the routine isn't registered yet.

---

### Phase 4: Coding Session Integration

When a `/code` session creates a new `.ts` file in `routines/`:
- The session's completion handler checks for new files in `routines/` (not `user/`)
- If new files found, sends Telegram notification:
  ```
  New routine file detected: aws-daily-cost.ts
  Run /routines list to register it with PM2.
  ```

This is a lightweight integration — no automatic registration, just detection and prompt.

---

## File Changes Summary

| File | Change |
|------|--------|
| `src/routines/routineManager.ts` | Add `listCodeRoutines()`, `registerCodeRoutine()`, `updateCodeRoutineCron()`, `toggleCodeRoutine()`, `triggerCodeRoutine()` |
| `src/routines/types.ts` | Add `CodeRoutineEntry`, `PM2Status`, `PM2ProcessInfo` types |
| `src/routines/routineHandler.ts` | Extend `handleRoutinesCommand()`, add inline keyboard for unregistered routines |
| `src/coding/sessionManager.ts` | Post-session: detect new `routines/*.ts` files and notify |
| `routines/*.ts` | Add `@routine` JSDoc metadata headers |

---

---

## Testing & Verification Plan

### Bug Investigation: `/memory` Not Responding

**Root cause (identified):** Two compounding issues in `src/relay.ts`:

1. **No global error handler.** grammy swallows unhandled errors silently unless `bot.catch()` is registered. If `ctx.reply()` throws (e.g. network error, grammy timeout), the failure is invisible.
   - Fix: Add `bot.catch((err) => console.error("Bot error:", err))` before `bot.start()`

2. **Middleware ordering — commands bypass security.** `registerCommands(bot, ...)` is called at line 145 **before** `bot.use(securityMiddleware)` at line 154. In grammy, middleware runs in registration order. Command handlers registered first execute without passing through the security check.
   - Fix: Move `registerCommands` to AFTER the security `bot.use()` block
   - Secondary effect: currently any Telegram user (not just the allowed ID) can invoke `/memory`, `/status`, etc.

3. **Potential silent Supabase failure.** `getMemoryContext` orders the goals query by `.order("priority", ...)`. If the `priority` column doesn't exist in the deployed schema, Supabase returns an error. The `catch` block returns `""` silently, causing the bot to reply "No memories stored yet" even when goals exist.
   - Verification: Check `db/schema.sql` for `priority` column on `memory` table

---

### Bot Command Test Coverage

**Strategy:** All bot commands must be covered by unit tests with a mock grammy `Context`. Tests live in `src/commands/botCommands.test.ts`. No live Supabase or Telegram calls.

#### Test helper: Mock Context

```typescript
// Shared mock factory for all command tests
function mockCtx(overrides?: Partial<Context>): Context {
  return {
    chat: { id: 12345 },
    from: { id: 99999 },
    match: "",
    reply: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as Context;
}
```

---

#### `/help` command

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Send `/help` | Reply contains all command names: `/status`, `/new`, `/memory`, `/history`, `/routines`, `/code`, `/help` |
| 2 | Reply is a single message (not split) | `ctx.reply` called exactly once |

---

#### `/status` command

| # | Scenario | Expected |
|---|----------|----------|
| 1 | No session exists for chatId | Reply contains "Session Status" |
| 2 | Active session exists | Reply includes message count |
| 3 | `ctx.chat` is null | Handler returns silently (no reply, no throw) |

---

#### `/new` command

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Send `/new` | Reply confirms fresh start |
| 2 | Session is reset | `resetSession` called with correct chatId |
| 3 | `ctx.chat` is null | Handler returns silently |

---

#### `/memory` command — **PRIMARY BUG AREA**

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Supabase is null | Reply: "Memory is not configured" |
| 2 | Supabase configured, no facts/goals | Reply: "No memories stored yet" |
| 3 | Supabase configured, facts exist | Reply contains "FACTS:" section |
| 4 | Supabase configured, goals exist | Reply contains "GOALS:" section |
| 5 | Supabase query throws error | Reply still sends (does not silently fail) |
| 6 | `ctx.chat` is null | Handler returns silently |
| 7 | `ctx.reply` throws | Error is caught by `bot.catch()` handler (verify it exists) |

Test for case 5 uses a mock supabase that rejects:
```typescript
const badSupabase = {
  from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.reject(new Error("DB down")) }) }) })
} as unknown as SupabaseClient;
```

---

#### `/history` command

| # | Scenario | Expected |
|---|----------|----------|
| 1 | No session exists | Reply: "No recent messages in current session" |
| 2 | Session exists, no messages | Reply: "No recent messages in current session" |
| 3 | Session exists with messages | Reply lists up to 100 chars per message |
| 4 | Long message is truncated | Message ends with "..." |
| 5 | `ctx.chat` is null | Handler returns silently |

---

#### `/routines` command (existing + new subcommands)

| # | Scenario | Expected |
|---|----------|----------|
| 1 | `/routines` with no args | Same as `list` |
| 2 | `/routines list` — no user routines, no code routines | Empty state message with instructions |
| 3 | `/routines list` — code routines exist | Shows "System Routines" section |
| 4 | `/routines list` — user routines exist | Shows "User Routines" section |
| 5 | `/routines list` — unregistered code files detected | Shows warning + inline keyboard |
| 6 | `/routines delete` with no name arg | Reply: "Usage: /routines delete <name>" |
| 7 | `/routines delete <name>` — name not found | Reply: error message |
| 8 | `/routines delete <name>` — code routine name | Reply: "Use a coding session to delete code-based routines" |
| 9 | `/routines status` — shows all PM2 statuses | Reply contains all routine names |
| 10 | `/routines run <name>` — valid name | PM2 restart triggered, reply confirms |
| 11 | `/routines run <name>` — unknown name | Reply: error |
| 12 | `/routines enable <name>` | PM2 start triggered |
| 13 | `/routines disable <name>` | PM2 stop triggered |
| 14 | `/routines schedule <name> <cron>` — valid cron | ecosystem updated, PM2 restart |
| 15 | `/routines schedule <name> <cron>` — invalid cron | Reply: "Invalid cron expression" |
| 16 | `/routines register <name> <cron>` — unregistered file | Adds to ecosystem, PM2 start |
| 17 | `/routines register <name> <cron>` — already registered | Reply: "Already registered" |
| 18 | Unregistered callback: `routine_target:cancel:0` | Clears pending, edits message |
| 19 | Callback with expired pending state | Reply: "Session expired" |

---

#### `/code` command

| # | Scenario | Expected |
|---|----------|----------|
| 1 | `/code list` — no sessions | Reply: no active sessions message |
| 2 | `/code list` — sessions exist | Reply lists active sessions |
| 3 | `/code status` | Reply shows current session or "none" |
| 4 | `/code new <path> <task>` — valid args | Session created, reply confirms |
| 5 | `/code new` — missing args | Reply: usage instructions |

---

### Integration / Smoke Tests

These tests require a real bot token (in CI: env var `TELEGRAM_TEST_BOT_TOKEN`) and send actual messages to a test chat. Run with `bun test --tag integration`.

| # | Command | Verification |
|---|---------|-------------|
| 1 | `/help` | Response arrives within 5s, contains "/memory" |
| 2 | `/status` | Response arrives within 5s |
| 3 | `/memory` | Response arrives within 5s (any message — configured or not) |
| 4 | `/history` | Response arrives within 5s |
| 5 | `/routines list` | Response arrives within 10s |

**Verification script:** `scripts/verify-bot-commands.ts`
- Sends each command sequentially to `TELEGRAM_TEST_CHAT_ID`
- Listens for response via webhook or polling (5s timeout per command)
- Reports pass/fail per command
- Use case: run after deployment to confirm bot is live and responding

---

### Test Files to Create/Update

| File | Action | What's covered |
|------|--------|----------------|
| `src/commands/botCommands.test.ts` | **Update** | Add mock-ctx tests for all 6 commands |
| `src/routines/routineHandler.test.ts` | **Create** | `/routines` subcommands, callback handler, unregistered detection |
| `src/routines/routineManager.test.ts` | **Update** | Add `listCodeRoutines`, `registerCodeRoutine`, `toggleCodeRoutine` tests |
| `src/memory.test.ts` | **Create** | `getMemoryContext` with mock supabase (happy path + error cases) |
| `scripts/verify-bot-commands.ts` | **Create** | Smoke test script for live bot verification |

---

### Fix Checklist (pre-implementation)

Before implementing routines feature, fix these bugs first:

- [ ] **Add `bot.catch()` handler** in `relay.ts` to surface silenced errors
- [ ] **Move `registerCommands(bot, ...)` AFTER `bot.use(securityMiddleware)`** in `relay.ts`
- [ ] **Verify `priority` column exists** in `db/schema.sql` → `memory` table
- [ ] **Verify `/memory` responds** after above fixes using `scripts/verify-bot-commands.ts`

---

## Out of Scope (This Feature)

- Web UI for routine management
- Routine logs viewer via Telegram (use `pm2 logs <name>` directly)
- Routine editing via Telegram (requires coding session)
- Multi-user routine isolation

---

## Open Questions

1. Should `/routines delete` be allowed for code-based routines (removes from ecosystem + disk)?
   Current proposal: block it with message "Use a coding session to delete code-based routines."

2. For `updateCodeRoutineCron` — should we validate cron syntax before writing?
   Recommend: yes, use a simple cron-parser validation.

3. `security-daily-scan.ts` — no intended schedule in file header yet.
   When registering via prompt, user must provide cron manually.
