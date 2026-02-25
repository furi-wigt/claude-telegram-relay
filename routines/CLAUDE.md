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

if (import.meta.main) {
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
if (import.meta.main) {
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

## Quick checklist

Before committing a new routine:

- [ ] `#!/usr/bin/env bun` shebang on line 1
- [ ] JSDoc frontmatter: `@routine`, `@description`, `@schedule`, `@target`
- [ ] Uses `sendAndRecord` (not `sendToGroup`) for user-facing messages
- [ ] `validateGroup()` called before any Supabase or Telegram calls
- [ ] All Supabase calls guarded with URL/key check and try/catch
- [ ] `process.exit(0)` in catch (never exit 1)
- [ ] `if (import.meta.main)` guard on the main() call
- [ ] Pure functions extracted and exported for testing
- [ ] Test file exists: `routines/<name>.test.ts`
- [ ] Entry added to `ecosystem.config.cjs` with correct cron and script path
