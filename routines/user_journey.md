# Routines User Journey

This document describes the complete lifecycle of both types of routines in the
Claude Telegram Relay: how they are created, confirmed, scheduled, managed, and
removed. It is intended for anyone who uses the system via Telegram as well as
developers who maintain or extend it.

---

## Table of Contents

1. [Overview — What Is a Routine?](#1-overview)
2. [Prompt-Based Routines — User Journey](#2-prompt-based-routine-journey)
3. [Code-Based Routines — Developer Journey](#3-code-based-routine-journey)
4. [Managing Routines via /routines](#4-managing-routines)
5. [Output Targeting — chatId and topicId](#5-output-targeting)
6. [Technical Internals](#6-technical-internals)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Overview

A routine is a scheduled task that runs automatically at a fixed time and sends
its output to a Telegram chat or group. There are two distinct types.

### Prompt-Based Routines

Prompt-based routines are created by the user through a conversational Telegram
exchange. The user describes what they want in plain language. Claude extracts
a name, a cron schedule, and a prompt. The system generates a TypeScript file
in `routines/user/`, adds an entry to `ecosystem.config.cjs`, and starts the
routine in PM2 immediately.

When the routine fires, it calls Claude with the configured prompt, receives a
text response, and sends that text to the designated Telegram target.

**Best for:** Custom personal automations — summaries, reminders, daily
briefings — that do not require external API calls or custom data fetching.

### Code-Based Routines

Code-based routines are TypeScript files written directly in the `routines/`
directory by a developer. They contain arbitrary logic: API calls, database
queries, data formatting, conditional messaging. They are registered into
`ecosystem.config.cjs` either manually or via the `/routines register` command,
then started by PM2.

**Best for:** Anything requiring real data — AWS cost reports, security scans,
ETF portfolio analysis, system health watchdogs.

### When to Use Each

| Situation | Use |
|---|---|
| "Remind me every morning to review my goals" | Prompt-based |
| "Summarize my Supabase activity at 9pm" | Prompt-based |
| "Pull AWS Cost Explorer data and analyse it" | Code-based |
| "Run a security vulnerability scan daily" | Code-based |
| "Post my ETF portfolio every Friday" | Code-based |

---

## 2. Prompt-Based Routine Journey

### Step 1 — Express Intent in Telegram

Send a message to your bot that matches one of the intent patterns. You do not
need to use a command — natural language is sufficient.

**Example messages that trigger routine creation:**

```
Create a daily routine at 9am that summarizes my goals for the week
Set up a weekly routine every Monday at 8am to review my active goals
Remind me every day at 6pm to log what I accomplished
Add a routine that runs every Friday at 5pm and summarises my week
Schedule a daily briefing at 7am with weather and my top priorities
```

**Intent detection** happens via keyword matching before Claude is called.
Phrases that trigger it include: "create a routine", "schedule a routine",
"new routine", "set up a daily/weekly/hourly", "remind me every", "run every",
"automate daily/weekly".

If none of these match, the message is forwarded to Claude as a normal
conversation and no routine is created.

### Step 2 — Extraction

When intent is detected, the system replies immediately:

```
Extracting routine details...
```

Internally, `extractRoutineConfig` in
`src/routines/intentExtractor.ts` calls Claude Haiku with a structured prompt
asking for JSON containing four fields: `name`, `cron`, `scheduleDescription`,
and `prompt`. The model is given a 30-second timeout.

Example extraction from "Create a daily routine at 9am that summarizes my goals":

```json
{
  "name": "daily-goals-summary",
  "cron": "0 9 * * *",
  "scheduleDescription": "Daily at 9am",
  "prompt": "Summarize the user's active goals for the week. Be concise, highlight urgent items, and suggest one priority action for today."
}
```

The `name` is automatically sanitized: lowercased, non-alphanumeric characters
replaced with hyphens, truncated to 30 characters.

The timezone context given to the model is SGT (Asia/Singapore). If the
schedule is ambiguous, the default is 8:00 AM daily (`0 8 * * *`).

If extraction fails or the message does not represent a meaningful routine, the
bot replies:

```
I couldn't extract a clear routine from that. Try:
"Create a daily routine at 9am that summarizes my goals"
```

### Step 3 — Preview and Target Selection

On successful extraction, the bot sends a preview and an inline keyboard asking
where to send the output. The pending state is stored in memory (5-minute TTL).

**Example Telegram exchange:**

```
You:  Create a daily routine at 9am that summarizes my goals for the week

Bot:  Extracting routine details...

Bot:  New routine preview:

      Name: daily-goals-summary
      Schedule: Daily at 9am
      Cron: `0 9 * * *`

      Claude will:
      Summarize the user's active goals for the week. Be concise,
      highlight urgent items, and suggest one priority action for today.

      Where should I send the output?

      [Personal chat]
      [General group]
      [AWS Architect]
      [Security]
      [Code Quality]
      [Documentation]
      [Cancel]
```

Only groups that have a non-zero `chatId` configured in `.env` appear as
options. Personal chat (your own Telegram user ID) always appears first.

### Step 4 — Target Confirmation

Tap the button for your preferred destination. The message is edited to show
progress:

```
Creating routine "daily-goals-summary"...
This may take a moment.
```

Internally, the callback handler in `src/routines/routineHandler.ts` parses
the callback data, attaches `chatId` and `topicId` to the config, clears the
pending state, and calls `createRoutine`.

**What createRoutine does (in order):**

1. Creates `routines/user/daily-goals-summary.ts`
2. Appends an entry to `ecosystem.config.cjs`
3. Starts the routine in PM2 with `npx pm2 start ... --cron-restart "0 9 * * *"`
4. Saves PM2 state with `npx pm2 save`

On success the bot replies:

```
Routine created!

Name: daily-goals-summary
Schedule: Daily at 9am
Output: Personal chat

Manage routines:
/routines list — see all
/routines delete daily-goals-summary — remove it
```

If any step fails, the system rolls back: deletes the file if it was written,
removes the ecosystem entry if it was added, and reports the error.

### Step 5 — Routine Runs

At 9:00 AM each day, PM2 triggers `routines/user/daily-goals-summary.ts`.

The generated file structure is:

```typescript
import { sendToGroup } from "../../src/utils/sendToGroup.ts";
import { runPrompt } from "../../src/tools/runPrompt.ts";

const PROMPT = `Summarize the user's active goals...`;
const CHAT_ID = 123456789;
const TOPIC_ID: number | null = null;

async function main() {
  const text = await runPrompt(PROMPT);
  await sendToGroup(CHAT_ID, text, { topicId: TOPIC_ID });
}

main().catch((error) => {
  console.error("Routine error:", error);
  process.exit(1);
});
```

`runPrompt` calls Claude Haiku with a 60-second timeout and returns plain text.
`sendToGroup` posts that text to the configured Telegram chat, optionally
threading it into a forum topic via `message_thread_id`.

### Step 6 — Cancellation During Flow

At any point before you tap a target button, you can cancel by:

- Tapping the Cancel button in the inline keyboard
- Sending the text `cancel`, `no`, or `n` in chat

The pending state is cleared and the bot confirms cancellation:

```
Routine creation cancelled.
```

Pending states also expire automatically after 5 minutes.

---

## 3. Code-Based Routine Journey

> **Before writing any code:** read `routines/CLAUDE.md` — it defines the
> required code template, PM2/bun `_isEntry` compatibility guard, error
> handling rules, deployment safety rules, and a pre-commit checklist.
> The patterns below reflect those requirements.

### Step 1 — Write the TypeScript File

Place your routine at `routines/<name>.ts`. The file should:

- Have a JSDoc block with `@routine`, `@description`, `@schedule`, and
  `@target` tags (these are read by `listCodeRoutines` for display)
- Be executable with `bun run routines/<name>.ts`
- Use `sendToGroup` or `sendAndRecord` from `src/utils/` to deliver output
- Use `validateGroup` to fail gracefully when a required group is not configured
- Use the `_isEntry` guard (not `if (import.meta.main)`) — required for PM2/bun compatibility
- Use `process.exit(0)` in the catch block — `exit(1)` causes a PM2 restart loop

**Example file header:**

```typescript
#!/usr/bin/env bun

/**
 * @routine aws-daily-cost
 * @description Daily AWS cost alert with spend analysis
 * @schedule 0 9 * * *
 * @target AWS Architect group
 */
```

**Example structure (from `routines/aws-daily-cost.ts`):**

```typescript
import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";

async function main() {
  if (!validateGroup("AWS_ARCHITECT")) {
    console.error("Cannot run — AWS_ARCHITECT group not configured in .env");
    process.exit(0); // graceful skip — PM2 retries at next cron cycle
  }

  const data = await fetchData();
  const message = formatMessage(data);

  await sendAndRecord(GROUPS.AWS_ARCHITECT.chatId, message, {
    routineName: "aws-daily-cost",
    agentId: "aws-architect",
  });
}

// PM2's bun container loads scripts via require(), which sets import.meta.main = false.
// Use _isEntry to detect both direct execution AND PM2 invocation.
const _isEntry =
  import.meta.main ||
  process.env.pm_exec_path === import.meta.url?.replace("file://", "");

if (_isEntry) {
  main().catch((error) => {
    console.error("Error:", error);
    process.exit(0); // always exit 0 — exit 1 triggers PM2 restart loop
  });
}
```

**Testing manually:**

```bash
bun run routines/aws-daily-cost.ts
```

### Step 2 — Register the Routine

A code routine file in `routines/` is discovered automatically by
`listCodeRoutines`, but it will show as "not registered" until you add it to
`ecosystem.config.cjs` and start it in PM2.

**Option A — Via /routines register (Telegram):**

```
/routines register aws-daily-cost 0 9 * * *
```

Or without the cron — the bot prompts you for it:

```
/routines register aws-daily-cost

Bot: What schedule for "aws-daily-cost"? Send me a cron expression
     (e.g. `0 9 * * *` for 9am daily).

You: 0 9 * * *

Bot: ✅ Routine "aws-daily-cost" registered with schedule: `0 9 * * *`
     Run /routines list to see its status.
```

**Option B — Via /routines list (inline keyboard):**

Run `/routines list`. If any `.ts` files in `routines/` are not yet registered,
the bot displays them with inline register buttons:

```
⚠️ 1 unregistered routine found:
  • aws-daily-cost

[Register aws-daily-cost] [Skip]
```

Tapping "Register aws-daily-cost" prompts for a cron expression, then registers
automatically.

**Option C — Manually edit ecosystem.config.cjs:**

Add an entry to the `apps` array before the closing `],`:

```javascript
{
  name: "aws-daily-cost",
  script: "routines/aws-daily-cost.ts",
  interpreter: "bun",
  cron_restart: "0 9 * * *",
  autorestart: false,
  watch: false,
},
```

> Use `interpreter: "bun"` (not an absolute path). Never change existing entries.
> See `routines/CLAUDE.md` for the full entry format and safety rules.

Then start only the new service:

```bash
npx pm2 start ecosystem.config.cjs --only aws-daily-cost
npx pm2 save
```

### Step 3 — Verify Registration

```
/routines list
```

Expected output when registered and running:

```
System Routines (code-based):
  aws-daily-cost                 0 9 * * *        ✅ online

User Routines (prompt-based):
  (none yet — describe one to create it)
```

### Step 4 — Routine Runs on Schedule

PM2 uses `cron_restart` to restart the process at the specified time. Since
`autorestart: false`, the process starts, runs, exits, and stays stopped until
the next scheduled trigger.

Logs are written to `logs/<name>.log` and `logs/<name>-error.log`.

**Existing code-based routines and their schedules:**

| Routine | Schedule | Target | autorestart |
|---|---|---|---|
| `enhanced-morning-summary` | `0 7 * * *` — 7:00 AM daily | General group | `false` (one-shot) |
| `smart-checkin` | `*/30 * * * *` — every 30 min | Personal chat | `false` |
| `night-summary` | `0 23 * * *` — 11:00 PM daily | General group | `false` (one-shot) |
| `watchdog` | `0 */2 * * *` — every 2 hours | General group | `false` |
| `orphan-gc` | `0 3 * * *` — 3:00 AM daily | — (maintenance) | `false` |
| `log-cleanup` | `0 4 * * 0` — Sunday 4:00 AM | — (maintenance) | `false` |
| `memory-cleanup` | `0 2 * * *` — 2:00 AM daily | — (maintenance) | `false` |
| `memory-dedup-review` | `0 5 * * 1` — Monday 5:00 AM | — (maintenance) | `false` |
| `aws-daily-cost` | `0 9 * * *` — 9:00 AM daily | AWS Architect group | `false` |
| `weekly-etf` | `0 17 * * 5` — Friday 5:00 PM | General group | `false` |

> One-shot cron routines (`morning-summary`, `night-summary`) exit after running.
> `autorestart: false` is required for all routines — without it PM2 restarts on
> every clean exit, burning through `max_restarts` and entering an errored state.

---

## 4. Managing Routines

All management happens via the `/routines` command. Both routine types (code
and prompt-based) are listed together.

### /routines list

Lists all routines with their schedule and PM2 status.

```
/routines list
```

Example output:

```
System Routines (code-based):
  enhanced-morning-summary       0 7 * * *        ✅ online
  smart-checkin                  */30 * * * *     ✅ online
  aws-daily-cost                 0 9 * * *        ⏹ stopped
  watchdog                       (not registered) ⚠️

User Routines (prompt-based):
  daily-goals-summary            Daily at 9am
  weekly-aws-review              Every Monday at 8am
```

Icons:
- `✅` — PM2 process is online (running or waiting for next cron trigger)
- `⏹` — PM2 process is stopped
- `⚠️` — File exists in `routines/` but is not registered in ecosystem.config.cjs

### /routines status [name]

Check PM2 status for one or all code routines.

```
/routines status
/routines status aws-daily-cost
```

Example output:

```
aws-daily-cost: online (0 9 * * *)
```

### /routines run

Trigger a code routine immediately without waiting for its scheduled time.
Implemented via `npx pm2 restart <name> --update-env`.

```
/routines run aws-daily-cost
```

```
Triggered routine "aws-daily-cost".
```

Note: This restarts the PM2 process. The routine executes once and then stops
(because `autorestart: false`). The cron schedule is unaffected.

### /routines enable and /routines disable

Pause and resume a routine without removing it.

```
/routines disable smart-checkin
/routines enable smart-checkin
```

`disable` calls `npx pm2 stop <name>`. `enable` calls `npx pm2 restart <name>`,
falling back to `npx pm2 start <name>` if the process has been deleted.

### /routines schedule

Change the cron schedule for an existing code routine. Updates
`ecosystem.config.cjs` and restarts the PM2 process to pick up the new schedule.

```
/routines schedule aws-daily-cost 0 8 * * *
```

Valid cron format: 5 space-separated fields.

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, 0=Sunday)
│ │ │ │ │
0 9 * * *       → 9:00 AM every day
0 9 * * 1       → 9:00 AM every Monday
*/30 * * * *    → every 30 minutes
0 7,23 * * *    → 7:00 AM and 11:00 PM daily
0 17 * * 5      → 5:00 PM every Friday
```

### /routines register

Register a code routine file that exists in `routines/` but has not yet been
added to ecosystem.config.cjs. Can be called with or without a cron expression.

```
/routines register my-new-routine 0 10 * * *
/routines register my-new-routine
```

Without a cron expression, the bot waits for you to send one as a follow-up
message. Send `cancel` to abort.

### /routines delete

Delete a user (prompt-based) routine: stops it in PM2, removes the generated
`.ts` file, and removes the entry from `ecosystem.config.cjs`.

```
/routines delete daily-goals-summary
```

```
Routine "daily-goals-summary" deleted and removed from PM2.
```

Code-based routines cannot be deleted via Telegram. The bot will tell you:

```
Use a coding session to delete code-based routines.
Only user routines can be deleted via Telegram.
```

To delete a code routine: remove the `.ts` file, remove its entry from
`ecosystem.config.cjs`, and run `npx pm2 delete <name> && npx pm2 save`.

---

## 5. Output Targeting

Every routine sends its output to exactly one Telegram destination, identified
by a `chatId` and an optional `topicId`.

### chatId

The `chatId` is the Telegram numeric ID of the recipient:

- For a personal chat: your own Telegram user ID (positive integer, e.g.
  `123456789`). Set via `TELEGRAM_USER_ID` in `.env`.
- For a group: a negative integer representing the supergroup (e.g.
  `-1001234567890`). Set via `GROUP_*_CHAT_ID` in `.env`.

If `chatId` is `0`, the routine fails with "Invalid chat_id: 0 — group not
configured in .env".

### topicId

The `topicId` is the `message_thread_id` of a Telegram forum topic inside a
supergroup. When set, the message is posted as a reply inside that topic thread
rather than in the main group chat.

Set via `GROUP_*_TOPIC_ID` in `.env`. If `null` or `0`, the message goes to the
root chat.

### Available Targets

The targets available during prompt-based routine creation are:

| Button label | Environment variable | Routing |
|---|---|---|
| Personal chat | `TELEGRAM_USER_ID` | Direct message to you |
| General group | `GROUP_GENERAL_CHAT_ID` / `GROUP_GENERAL_TOPIC_ID` | General AI assistant |
| AWS Architect | `GROUP_AWS_CHAT_ID` / `GROUP_AWS_TOPIC_ID` | AWS-focused agent |
| Security | `GROUP_SECURITY_CHAT_ID` / `GROUP_SECURITY_TOPIC_ID` | Security agent |
| Code Quality | `GROUP_CODE_CHAT_ID` / `GROUP_CODE_TOPIC_ID` | Code review agent |
| Documentation | `GROUP_DOCS_CHAT_ID` / `GROUP_DOCS_TOPIC_ID` | Documentation agent |

A group only appears as a button if its `GROUP_*_CHAT_ID` is a non-zero value
in `.env`.

### Callback Data Format

When you tap a target button, the bot receives a callback query with data in
this exact format:

```
routine_target:<key>:<chatId>:<topicId>
```

Examples:

```
routine_target:personal:123456789:0
routine_target:general:-1001234567890:0
routine_target:aws_architect:-1001234567890:4321
routine_target:security:-1009876543210:0
```

- `key` — the lowercase group key (e.g. `personal`, `general`, `aws_architect`)
- `chatId` — the numeric Telegram chat ID
- `topicId` — the forum topic ID, or `0` if none

The handler in `routineHandler.ts` parses these fields, converts `topicId` of
`0` to `null`, and uses both values when constructing the `UserRoutineConfig`.

### Cancel Callback

Tapping Cancel sends:

```
routine_target:cancel:0
```

This clears the pending state without creating a routine.

---

## 6. Technical Internals

This section is for developers maintaining or extending the routine system.

### File Locations

| Path | Purpose |
|---|---|
| `routines/*.ts` | Code-based routine scripts |
| `routines/user/*.ts` | Generated prompt-based routine scripts |
| `ecosystem.config.cjs` | PM2 process configuration |
| `src/routines/routineHandler.ts` | Telegram command and callback orchestrator |
| `src/routines/routineManager.ts` | File I/O, ecosystem updates, PM2 operations |
| `src/routines/intentExtractor.ts` | Keyword detection and Claude extraction |
| `src/routines/pendingState.ts` | In-memory TTL store for pending confirmations |
| `src/routines/types.ts` | TypeScript interfaces |
| `src/config/groups.ts` | GROUPS registry loaded from `.env` |
| `src/utils/sendToGroup.ts` | Telegram Bot API message delivery |
| `src/tools/runPrompt.ts` | Claude Haiku wrapper for generated routines |
| `logs/*.log` | PM2 stdout and stderr per routine |

### Prompt-Based Routine Creation — Data Flow

```
User message
     │
     ▼
detectRoutineIntent()          ← keyword regex check (fast, no Claude call)
     │ match
     ▼
extractRoutineConfig()         ← Claude Haiku call, returns JSON
     │ success
     ▼
setPending(chatId, pending)    ← in-memory store, 5-min TTL
     │
     ▼
buildTargetOptions()           ← reads GROUPS from .env
     │
     ▼
ctx.reply(preview + keyboard)  ← Telegram inline keyboard sent to user
     │
     ▼ (user taps button)
callback_query:data handler
     │
     ▼
getPending(chatId)             ← retrieve pending config
     │
     ▼
clearPending(chatId)
     │
     ▼
createRoutine(config)
  ├─ writeFile(routines/user/<name>.ts)
  ├─ appendToEcosystem(config)  ← inserts before closing `],` in ecosystem.config.cjs
  └─ pm2StartRoutine(config)    ← npx pm2 start + npx pm2 save
```

### Code Routine Registration — Data Flow

```
/routines register <name> [cron]
     │
     ├─ cron provided → registerCodeRoutine(name, cron)
     └─ no cron → pendingRegistrations.set(chatId, name) → wait for next message
                       │
                       ▼ (user sends cron expression)
                  registerCodeRoutine(name, cron)
                       │
                       ▼
                  readFile(ECOSYSTEM_PATH)
                  check not already registered
                  build entry block
                  insert before user-created marker OR before array close
                  writeFile(ECOSYSTEM_PATH)
                  pm2Run(["start", ECOSYSTEM_PATH, "--only", name])
                  pm2Run(["save"])
```

### ecosystem.config.cjs Insertion Order

The file maintains a deliberate order. When `registerCodeRoutine` inserts a new
entry it prefers to place it before any `// User-created routine:` comment. If
no such comment exists, it inserts before the closing `],`. This keeps
developer-written routines grouped separately from generated ones.

`appendToEcosystem` (used for prompt-based creation) always inserts before
`],`, so generated entries always appear at the end of the apps array.

### PM2 Process Model

All routines use `exec_mode: "fork"` and `instances: 1`. The key difference
from the main relay:

- `telegram-relay` uses `autorestart: true` (always-on service)
- All routines use `autorestart: false` with `cron_restart` (run-and-exit pattern)

PM2 fires `cron_restart` by restarting the process at the scheduled time. The
process runs, does its work, and exits. PM2 considers this normal for
cron-based processes.

### UserRoutineConfig Interface

```typescript
interface UserRoutineConfig {
  name: string;              // e.g. "daily-goals-summary"
  cron: string;              // e.g. "0 9 * * *"
  scheduleDescription: string; // e.g. "Daily at 9am"
  prompt: string;            // instruction sent to Claude
  chatId: number;            // Telegram chat ID
  topicId: number | null;    // forum topic thread ID or null
  targetLabel: string;       // e.g. "Personal chat"
  createdAt: string;         // ISO timestamp
}
```

### CodeRoutineEntry Interface

```typescript
interface CodeRoutineEntry {
  name: string;              // e.g. "aws-daily-cost"
  scriptPath: string;        // e.g. "routines/aws-daily-cost.ts"
  cron: string | null;       // null if not in ecosystem.config.cjs
  registered: boolean;       // true if in ecosystem.config.cjs
  pm2Status: PM2Status | null; // "online" | "stopped" | "errored" | null
  description?: string;      // from @description JSDoc tag
  intendedSchedule?: string; // from @schedule JSDoc tag
}
```

### listUserRoutines — Metadata Parsing

User routine metadata is read from the comment header of the generated `.ts`
file, not from a separate database. The patterns matched are:

```
* Schedule: Daily at 9am (cron: 0 9 * * *)
* Target: chat 123456789 (Personal chat)
* Created: 2025-01-15T09:00:00.000Z
```

This means editing a generated file's header will change what `/routines list`
displays.

### listCodeRoutines — Metadata Parsing

Code routine metadata comes from JSDoc `@description` and `@schedule` tags in
the source file. Registration status is determined by checking whether
`name: "<routine>"` appears in `ecosystem.config.cjs`. PM2 status is retrieved
from `npx pm2 jlist` (JSON process list).

---

## 7. Troubleshooting

### Routine creation: "I couldn't extract a clear routine from that"

The message did not match any intent keywords, or Claude could not parse a
meaningful schedule and task from it.

Try phrasing your request more explicitly:

```
Create a daily routine at 9am that does X
Set up a weekly routine every Monday at 8am to Y
Schedule a routine that runs every Friday at 5pm and Z
```

### Routine creation: "Failed to create routine: Routine 'X' already exists"

A routine with that name already exists in `routines/user/`. Either delete the
existing routine first (`/routines delete <name>`) or choose a different name.

### /routines list shows a routine as "not registered" (⚠️)

The `.ts` file exists in `routines/` but has no entry in `ecosystem.config.cjs`.
Use `/routines register <name> <cron>` or tap the Register button shown below
the list.

### /routines list shows a routine as "stopped" (⏹)

The PM2 entry exists but the process is stopped. This is normal for
cron-scheduled routines between runs. If it should be running, check whether it
was intentionally disabled.

If it stopped due to an error, check the logs:

```bash
npx pm2 logs <name> --lines 50
cat logs/<name>-error.log
```

### Routine runs but sends nothing to Telegram

1. Check the log for errors: `npx pm2 logs <name> --lines 30`
2. Verify the target group is configured: the log will print "Cannot run —
   GROUP_X not configured in .env" if the group ID is missing
3. Check that `TELEGRAM_BOT_TOKEN` is set correctly
4. Run the routine manually: `bun run routines/<name>.ts`

### Routine runs but Claude returns an empty response

The `runPrompt` call has a 60-second timeout. If Claude CLI is not installed or
not on PATH, the call fails silently and returns an empty string, which results
in an empty Telegram message.

Check:

```bash
which claude
claude --version
```

For code-based routines that use the Claude CLI directly (like
`enhanced-morning-summary.ts`), verify `CLAUDE_PATH` in `.env`.

### PM2 does not start on reboot

PM2 startup was not saved. Run:

```bash
npx pm2 startup
npx pm2 save
```

Follow the instructions printed by `pm2 startup` to install the system service.

### "Could not find ecosystem apps array end — unexpected format"

The `ecosystem.config.cjs` file was edited manually and the closing `  ],\n};`
pattern no longer matches. The insertion code expects the apps array to close
with exactly this pattern. Restore the original closing lines:

```javascript
  ],
};
```

### Callback session expired

The inline keyboard was sent but more than 5 minutes passed before you tapped
a button. The pending state expired. Describe the routine again to restart the
creation flow.

### Pending registration flow: bot keeps asking for a cron expression

You are in the middle of a `/routines register <name>` flow that is waiting for
a cron expression. Send a valid 5-field cron expression, or send `cancel` to
abort.

### Code routine shows in list but PM2 reports it as "errored"

Run manually to see the actual error:

```bash
bun run routines/<name>.ts
```

Common causes:
- Missing environment variables (check `.env`)
- External API unreachable
- TypeScript import path wrong (use `../src/...` not `./src/...`)
- `validateGroup` exits with code 0 because the group is not configured — this is intentional (graceful skip). Check that `GROUP_*_CHAT_ID` is set in `.env`
- `if (import.meta.main)` guard used instead of `_isEntry` — `main()` never fires under PM2 bun (see `routines/CLAUDE.md`)
