# CLAUDE.e2e.md — E2E Fixture Framework

**Load condition**: Read this file when:
- Modifying or creating any file under `src/` that interacts with Telegram
- Writing or reviewing `*.test.ts` or `*.e2e.test.ts` files
- Any task mentioning "e2e", "mock", "fixture", or "Telegram test"

---

## Core rule

**No assumptions about Grammy ctx shapes.** All fixture fields must come from
a real capture or be marked `source: "derived"` with a rationale. Do not infer
what Grammy delivers — read the fixture.

**No test runner code before Phase 4** (3 real fixtures required first).

---

## Fixture schema

```json
{
  "id": "plain-text-message",
  "description": "User sends a plain text message to the private chat",
  "source": "real",
  "captured_at": "2026-03-03T09:40:00+08:00",
  "trigger": "Send any plain text (not a command) to Jarvis in private chat",
  "boundary": "grammy-ctx",
  "payload": {
    /* exact Grammy ctx fields accessed by relay.ts handlers */
  }
}
```

**`source` values:**
- `"real"` — captured from an actual Telegram interaction (`captured_at` required)
- `"derived"` — extrapolated from a real fixture (`derived_from` + `rationale` required)

**`boundary` values:**
- `"grammy-ctx"` — the ctx object delivered to a `bot.on()` / `bot.command()` handler
- `"bot-api-response"` — what `bot.api.*` returns

---

## Known ctx fields (from codebase investigation, 2026-03-03)

These are the fields relay.ts handlers actually access. Fixtures must cover them.

### message:text handler
```
ctx.message.text
ctx.chat?.id
ctx.message?.message_thread_id
ctx.from?.id
ctx.message?.reply_to_message?.message_id
ctx.match  (populated by Grammy for bot.command() — the args string after the command)
```

### message:voice handler
```
ctx.message.voice          (object: { file_id, file_unique_id, duration, mime_type, file_size })
ctx.chat?.id
ctx.message?.message_thread_id
ctx.from?.id
ctx.getFile()              (async call — returns { file_path })
```

### message:photo handler
```
ctx.message.photo          (array of PhotoSize objects, last = largest)
ctx.chat?.id
ctx.message?.message_thread_id
ctx.message.media_group_id (string | undefined — for album grouping)
ctx.message.caption        (string | undefined)
ctx.from?.id
```

### callback_query:data handler
```
ctx.callbackQuery.data     (string — the button's callback_data)
ctx.callbackQuery.message  (the original message that had the keyboard)
ctx.from?.id
ctx.answerCallbackQuery()  (must be called to dismiss spinner)
```

### bot.command() handlers
```
ctx.chat?.id
ctx.message?.message_thread_id
ctx.match                  (string — everything after the command name)
ctx.from?.id
```

---

## Directory layout

```
tests/fixtures/telegram/
├── README.md          ← Catalogue (update after every capture session)
├── incoming/          ← ctx shapes delivered to handlers
└── outgoing/          ← bot.api.* response shapes
```

---

## Capture protocol

1. I identify the behavior and name it.
2. I give exact trigger instructions (what to type, where, what to tap).
3. **You run:** `npx pm2 logs telegram-relay --nocolor --lines 100`
4. **You trigger** the action on Telegram.
5. **You paste** the log output here.
6. I extract Grammy-level fields from the logs and write the fixture JSON.
7. I update `tests/fixtures/telegram/README.md`.

**Debug logging**: The relay has conditional debug logging. If logs don't show
enough Grammy ctx detail, add `if (process.env.E2E_DEBUG) console.log("[e2e]", JSON.stringify(ctx.message))` inside the handler temporarily, then `E2E_DEBUG=1 npx pm2 restart telegram-relay`.

---

## Capture priority order

| # | Fixture | Trigger |
|---|---------|---------|
| 1 | `plain-text-message` | Send "hello" in private chat |
| 2 | `command-help` | Send `/help` |
| 3 | `callback-query-button-tap` | Tap any inline button |
| 4 | `command-new` | Send `/new` |
| 5 | `command-memory` | Send `/memory` |
| 6 | `voice-message` | Send a voice note |
| 7 | `photo-with-caption` | Send a photo with caption |
| 8 | `group-message` | Send a message in a group chat |
| 9 | `edited-message` | Edit a sent message |
| 10 | `document-upload` | Send a PDF |

---

## Runner DSL (implemented — Phase 4 + Phase 5)

Runner: `tests/e2e/runner.ts`
Tests: `tests/e2e/fixtures.test.ts` (36 tests, all passing)

```typescript
import { loadFixture, step, branch, repeat, runNodes, assertResult, createMockApi } from "./runner";

// Sequential
const fixture = loadFixture("incoming/plain-text-message");
const mockApi = createMockApi();
step(fixture, handler, mockApi);
assertResult(mockApi, "sendMessage");

// Conditional
runNodes([
  step(...),
  branch({
    if: (calls) => calls.some(c => c.method === "sendMessage"),
    then: [assertResult(mockApi, "sendMessage")],
    else: [() => { throw new Error("expected sendMessage"); }],
  }),
]);

// Loop
runNodes([repeat(3, step(...))]);
```

**Global library promoted**: `~/.claude/e2e-fixtures/telegram/` (2026-03-03, 10 fixtures)
**Global agent context**: `~/.claude/CLAUDE.e2e.md`

---

## What we are NOT doing

- No HTTP-level interception (Grammy SDK boundary only)
- No assumptions about Grammy ctx shape before capture
- No test runner code before Phase 4
- No Supabase or Claude CLI fixtures until Telegram library has ≥ 10 entries
