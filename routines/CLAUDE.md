# Routines — Developer Guide

This guide explains how to write a correct code-based routine in this project.
Read it before creating or modifying any file in `routines/`.

---

## When to write a code-based routine

Use a TypeScript routine (this directory) when the task needs real data:
API calls, database queries, conditional logic, or external integrations.

For simple scheduled prompts with no custom logic, use the prompt-based
system instead (created via Telegram's `/routines` command — files land in
`routines/user/`).

---

## File template

```ts
#!/usr/bin/env bun

/**
 * @routine my-routine-name          ← kebab-case, matches PM2 process name
 * @description One-line description
 * @schedule 0 9 * * *               ← cron expression
 * @target General / AWS / etc.
 */

import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";
import { USER_NAME, USER_TIMEZONE } from "../src/config/userConfig.ts";

async function main() {
  if (!validateGroup("GENERAL")) {
    console.error("Cannot run — GENERAL group not configured");
    process.exit(0); // graceful skip — PM2 retries at next cron cycle
  }

  const message = buildMessage(); // your logic here

  await sendAndRecord(GROUPS.GENERAL.chatId, message, {
    routineName: "my-routine-name",
    agentId: "general-assistant",
    topicId: GROUPS.GENERAL.topicId,
  });
}

// PM2's bun container loads scripts via require(), which sets import.meta.main = false.
// Use _isEntry to detect both direct execution AND PM2 invocation.
const _isEntry =
  import.meta.main ||
  process.env.pm_exec_path === import.meta.url?.replace("file://", "");

if (_isEntry) {
  main().catch((err) => {
    console.error("Error:", err);
    process.exit(0); // exit 0 — prevents PM2 restart loop on failure
  });
}
```

---

## Sending messages: `sendAndRecord` vs `sendToGroup`

| Situation | Use |
|---|---|
| Proactive bot message (briefing, check-in, summary, reminder) | **`sendAndRecord`** |
| Infrastructure / system alert (watchdog, health check) | `sendToGroup` directly |

**Always use `sendAndRecord` for conversational messages.** It sends to
Telegram AND persists the message to Supabase so it appears in the bot's
rolling short-term memory window (with a pre-computed Ollama summary).

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

### Supabase guard
```ts
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

async function fetchData() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return [];  // always guard first
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    // ...
  } catch (err) {
    console.error("fetchData failed:", err);
    return [];  // never throw from data fetchers
  }
}
```

---

## Error handling

**Always `process.exit(0)` in `main()` catch — never exit with code 1.**
Exit 1 triggers an immediate PM2 restart loop. Exit 0 tells PM2 the cron
task completed; it retries at the next scheduled time.

```ts
// ⚠️ Do NOT use `if (import.meta.main)` — it breaks under PM2 bun container.
// PM2's ProcessContainerForkBun.js loads scripts via require(), which sets
// import.meta.main = false. main() silently never fires. Use _isEntry instead.
const _isEntry =
  import.meta.main ||
  process.env.pm_exec_path === import.meta.url?.replace("file://", "");

if (_isEntry) {
  main().catch((err) => {
    console.error("Error:", err);
    process.exit(0); // ← always 0
  });
}
```

Validate required config at the top of `main()` and exit 0 early rather
than letting the routine fail mid-execution:

```ts
async function main() {
  if (!validateGroup("GENERAL")) { process.exit(0); }
  if (!SUPABASE_URL)             { process.exit(0); }
  // ... rest of logic
}
```

---

## Testing: export pure functions

Extract business logic into pure functions; export them for tests.
Keep side effects (network calls, Supabase writes, Telegram sends) in
private functions or behind injected providers.

```ts
// ✓ exportable — pure, testable
export function buildMessage(data: MyData): string { ... }

// ✓ exportable — injectable providers, no real I/O
export async function analyzeWithProviders(
  prompt: string,
  providers: { claude: (p: string) => Promise<string>; ollama: ... }
): Promise<Result> { ... }

// ✗ keep private — real network I/O
async function fetchFromSupabase(): Promise<Data[]> { ... }
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

## ⚠️ PM2 + Bun: `import.meta.main` is always `false`

**Root cause (confirmed 26 Feb 2026):** PM2's `ProcessContainerForkBun.js`
loads routine scripts via `require(process.env.pm_exec_path)`. When Bun
`require()`s a module, `import.meta.main` is `false`. A plain
`if (import.meta.main)` guard causes `main()` to never fire under PM2 — the
routine runs silently and sends nothing to Telegram.

**Correct pattern — always use `_isEntry`:**

```ts
// At the bottom of every routine file — replaces `if (import.meta.main)`
const _isEntry =
  import.meta.main ||
  process.env.pm_exec_path === import.meta.url?.replace("file://", "");

if (_isEntry) {
  main().catch((err) => {
    console.error("Error:", err);
    process.exit(0);
  });
}
```

`pm_exec_path` is set by PM2 to the absolute path of the entry script.
Comparing it against `import.meta.url` (after stripping `file://`) correctly
detects PM2 execution even when `import.meta.main` is false.

**For one-shot cron routines** (morning-summary, night-summary): also set
`autorestart: false` in `ecosystem.config.cjs`. Without it, PM2 restarts on
every clean exit, burning through `max_restarts` and entering an errored state.

---

## ⚠️ PM2 Deployment Safety Rules

### Never restart all services at once

```bash
# ✗ DO NOT — restarts ALL services including telegram-relay (Jarvis goes offline)
npx pm2 reload ecosystem.config.cjs
npx pm2 restart ecosystem.config.cjs
npx pm2 reload ecosystem.config.cjs --update-env

# ✓ DO — restart only the specific service(s) you changed
npx pm2 restart morning-summary
npx pm2 restart morning-summary night-summary smart-checkin
```

`telegram-relay` is sacred. Accidentally restarting it via an ecosystem-wide
command causes a restart loop and takes Jarvis offline. Always name the service
explicitly.

### Never modify ecosystem.config.cjs interpreter patterns

```js
// ✗ DO NOT — breaks all services, causes Jarvis to restart continuously
{ interpreter: "none", exec: "/bin/sh -c 'bun run script.ts'" }

// ✓ DO — keep the default bun interpreter entry
{ interpreter: "bun", script: "routines/my-routine.ts" }
```

Changing the interpreter or exec pattern in `ecosystem.config.cjs` affects every
service. If a routine doesn't run under PM2, fix the routine itself (use
`_isEntry` guard) — never work around it by patching the ecosystem config.

### Adding a new routine to ecosystem.config.cjs

Only append a new entry — never touch existing ones:

```js
{
  name: "my-routine",
  script: "routines/my-routine.ts",
  interpreter: "bun",
  cron_restart: "0 9 * * *",
  autorestart: false,     // required for one-shot cron jobs
  watch: false,
},
```

Then start only the new service:

```bash
npx pm2 start ecosystem.config.cjs --only my-routine
npx pm2 save
```

---

## Quick checklist

Before committing a new routine:

- [ ] `#!/usr/bin/env bun` shebang on line 1
- [ ] JSDoc frontmatter: `@routine`, `@description`, `@schedule`, `@target`
- [ ] Uses `sendAndRecord` (not `sendToGroup`) for user-facing messages
- [ ] `validateGroup()` called before any Supabase or Telegram calls
- [ ] All Supabase calls guarded with URL/key check and try/catch
- [ ] `process.exit(0)` in catch (never exit 1)
- [ ] `_isEntry` guard on the main() call (NOT `import.meta.main` — PM2 bun sets it to false)
- [ ] Pure functions extracted and exported for testing
- [ ] Test file exists: `routines/<name>.test.ts`
- [ ] Entry added to `ecosystem.config.cjs` with correct cron and script path
- [ ] After deploy: `npx pm2 start ecosystem.config.cjs --only <name>` (never ecosystem-wide restart)
