# Telegram Relay Failure Analysis

**Date**: 2026-02-16
**Analyst**: Claude Code (investigation session)
**Scope**: Two failure modes observed in PM2-managed `telegram-relay` service

---

## Problem Statement

1. **Dropped messages**: Messages sent via Telegram sometimes don't reach the bot server at all
2. **No response**: Messages that do reach the bot don't get a reply back, likely due to Claude CLI invocation failures

---

## Evidence Gathered

### PM2 Process State
- **Restarts**: 4 restarts since creation (2026-02-16T03:15:58Z)
- **Uptime at analysis**: 52 minutes
- **Heap usage**: 100% (4.66 MiB / 4.66 MiB) -- concerning, no headroom
- **Script**: `relay-wrapper.js` (dynamic import wrapper for `src/relay.ts`)

### Log Timeline (key events)

| Time | Event | Outcome |
|------|-------|---------|
| 15:58:05 | Claude spawn failed | **Instant** failure (0 seconds), fallback to Ollama |
| 15:58:10 | Another message, Claude spawn | **Instant** failure again (3 messages in 8 seconds) |
| 15:58:23 | SIGINT received | PM2 restart cycle |
| 15:58:32 | SIGINT again | Another restart 9 seconds later |
| 16:00:02 | "test" message | Claude called, **no response or error logged** before next restart at 16:05:22 |
| 16:39:23 | Complex query | Claude called, **no timeout/error logged** for ~15 minutes |
| 17:14:59 | sendMessage | **GrammyError 400**: message text is empty |
| 17:14:59 | grammY reference | Error 409 warning in source ("running bot several times on long polling") |
| 11:31:50 | "Hi testing" | **SUCCESS** - responded in 17 seconds |
| 12:01:57 | Complex message | **60-second timeout** hit, fallback to Ollama |

### Error Log Highlights

**Empty response crash:**
```
GrammyError: Call to 'sendMessage' failed! (400: Bad Request: message text is empty)
  payload: { chat_id: 1078052084, text: "" }
```

**Timeout crash:**
```
Spawn error: ...
error: Claude timeout after 60s
  at relay.ts:247:35
```

---

## Root Cause Analysis

### RC1: Multiple Bot Instances Competing for Updates (CRITICAL)

**Severity**: CRITICAL
**Impact**: Messages randomly distributed between instances, some dropped entirely

grammY uses **long polling** by default. When PM2 restarts the process (SIGINT + new spawn), there is a window where **both old and new instances** are polling Telegram simultaneously. Telegram responds with HTTP 409 Conflict and distributes messages unpredictably.

**Evidence:**
- grammY error log references Error 409: "you are running your bot several times on long polling"
- 4 PM2 restarts observed
- Multiple rapid SIGINT/restart cycles (15:58:23 -> 15:58:32, only 9 seconds apart)
- Lock file mechanism has race conditions (non-atomic check-and-set)

**Contributing factors:**
- `bot.start()` is fire-and-forget (not awaited, line 596)
- PM2 `autorestart: true` spawns new instance immediately while old may still be shutting down
- Lock file has **duplicate SIGINT handlers** (lines 126-129 AND 574-578) -- the second one calls `bot.stop()` but does NOT release the lock
- Lock file cleanup uses `require('fs').unlinkSync` in `process.on('exit')` which may not work correctly under Bun runtime

### RC2: No Error Handling in Message Handlers (HIGH)

**Severity**: HIGH
**Impact**: User sends message, bot silently fails, no response sent

The `bot.on("message:text")` handler (line 313-339) has **no try/catch** wrapping the entire handler. If any of these async operations throw:

- `getRelevantContext()` -- Supabase edge function call
- `getMemoryContext()` -- Supabase RPC call
- `callClaude()` -- already has internal try/catch, but outer code doesn't
- `processMemoryIntents()` -- Supabase operations
- `sendResponse()` -- Telegram API call

...the error propagates to grammY's default error handler, which logs it but the user receives **nothing**. No error message, no retry, no notification.

**Evidence:**
- Multiple log entries show "Calling Claude" with no subsequent response log before next message
- The empty response GrammyError (text: "") confirms this silent failure path

### RC3: Claude CLI 60-Second Timeout Too Short (HIGH)

**Severity**: HIGH
**Impact**: Complex queries consistently fail; only simple queries succeed

The `callClaude()` function has a hardcoded 60-second timeout (line 247). Analysis of successful vs failed calls:

| Query Type | Time Taken | Result |
|-----------|-----------|--------|
| "Hi testing" | 17 seconds | Success |
| Complex message about reliability | 60 seconds | Timeout |
| "look at central claude log..." | >15 minutes? | Silent failure (no timeout logged) |

The 60-second timeout is **insufficient** for:
- Queries that include rich context (profile + memory + semantic search results)
- Queries asking Claude to perform research or complex analysis
- First invocation after idle period (CLI cold start)

**Note**: Some calls show no timeout being triggered despite running for minutes. This suggests the timeout code may not have been present in the version running at that time, or there's a code path where the timeout promise isn't properly raced.

### RC4: Immediate Claude CLI Spawn Failure (MEDIUM)

**Severity**: MEDIUM
**Impact**: Claude fails instantly, falls back to Ollama (which does respond)

At 15:58, three messages in rapid succession all hit **instant** spawn failures (0 seconds between "Calling Claude" and "Claude spawn failed"). This is `Bun.spawn()` throwing, not a timeout.

**Possible causes:**
- **Concurrent spawns**: Three messages arrived within 8 seconds. No message queue exists, so all three try to spawn `claude` simultaneously. Multiple concurrent `claude -p` invocations may conflict.
- **Environment issues**: PM2 sets `CLAUDECODE=""` in env which could interfere with Claude CLI behavior
- **Session conflict**: `--resume` flag with a stale/invalid session ID could cause immediate failure

### RC5: Empty Response After Memory Tag Stripping (LOW)

**Severity**: LOW
**Impact**: Bot crashes trying to send empty Telegram message

When Claude's entire response consists only of `[REMEMBER: ...]` or `[GOAL: ...]` tags with no user-facing text, `processMemoryIntents()` strips everything and returns `""`. The code then attempts to send this empty string to Telegram, which rejects it with 400.

**Current state**: A guard was added (line 337-338: `response || rawResponse || "No response generated"`), but the error suggests this wasn't present when the crash occurred.

---

## Failure Flow Diagrams

### Message Drop Flow (RC1)
```
User sends message on Telegram
        |
  Telegram queues update
        |
  +-----------+     +-----------+
  | Instance A |     | Instance B |  (PM2 restart overlap)
  | (old, dying)|    | (new, starting)|
  +-----+-----+     +-----+-----+
        |                   |
  Both call getUpdates simultaneously
        |                   |
  Telegram returns 409 to one, message to other
        |                   |
  Instance A may get message but is shutting down
  Instance B may not get message at all
        |
  MESSAGE LOST
```

### Silent Failure Flow (RC2 + RC3)
```
Message arrives at bot
        |
  bot.on("message:text") fires
        |
  getRelevantContext() -- may throw (Supabase timeout)
  getMemoryContext()   -- may throw (Supabase RPC fail)
        |
  callClaude(enrichedPrompt)
        |
  +----- 60s timeout -----+
  |                        |
  Claude responds          Timeout fires
  (17s for simple)         proc.kill()
  |                        throw Error
  |                        |
  |                   Falls to catch block
  |                   "Claude spawn failed"
  |                   Tries Ollama fallback
  |                        |
  processMemoryIntents()   |
  (may strip to empty)     |
        |                  |
  sendResponse()           |
  (may fail if empty)      |
        |                  |
  NO TRY/CATCH AROUND ANY OF THIS
  Error goes to grammY default handler
  User sees NOTHING
```

---

## Recommended Fixes (Priority Order)

### 1. Fix Multiple Instance Conflict (CRITICAL)

**Option A: PM2 kill timeout + graceful shutdown delay**
```js
// ecosystem.config.cjs
{
  kill_timeout: 10000,        // Give old instance 10s to die
  wait_ready: true,           // Wait for process.send('ready')
  listen_timeout: 15000,      // Timeout waiting for ready signal
}

// relay.ts - send ready signal after bot starts
bot.start({
  onStart: () => {
    process.send?.('ready');   // Tell PM2 we're ready
  }
});
```

**Option B: Switch to webhook mode (production-grade)**
- Eliminates long polling entirely
- No duplicate instance conflict possible
- Requires a public URL (ngrok for dev, or deploy behind a reverse proxy)

**Option C: Add startup delay + drop pending updates**
```ts
bot.start({
  drop_pending_updates: true,  // Ignore queued messages from downtime
  onStart: () => { ... }
});
```

### 2. Add Try/Catch to All Message Handlers (HIGH)

```ts
bot.on("message:text", async (ctx) => {
  try {
    // ... existing handler code ...
  } catch (error) {
    console.error("Message handler error:", error);
    await ctx.reply("Sorry, I encountered an error processing your message. Please try again.")
      .catch(() => {}); // Don't let error notification itself crash
  }
});
```

Apply the same pattern to voice, photo, and document handlers.

### 3. Increase Claude Timeout + Periodic Typing (HIGH)

```ts
// Make timeout configurable
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || "180000"); // 3 minutes

// Send typing indicator periodically
const typingInterval = setInterval(() => {
  ctx.replyWithChatAction("typing").catch(() => {});
}, 5000);

try {
  const response = await callClaude(prompt);
} finally {
  clearInterval(typingInterval);
}
```

### 4. Add Message Queue / Serialization (MEDIUM)

Prevent concurrent `claude` spawns:

```ts
const messageQueue: Array<() => Promise<void>> = [];
let processing = false;

async function processQueue() {
  if (processing) return;
  processing = true;
  while (messageQueue.length > 0) {
    const task = messageQueue.shift()!;
    await task();
  }
  processing = false;
}

bot.on("message:text", async (ctx) => {
  messageQueue.push(async () => {
    // ... actual handler logic ...
  });
  processQueue();
});
```

### 5. Fix Lock File Implementation (MEDIUM)

- Remove duplicate SIGINT handlers
- Use atomic file operations
- Or remove entirely and rely on PM2's `instances: 1` + `kill_timeout`

### 6. Monitor Heap Usage (LOW)

PM2 reports 100% heap usage at 4.66 MiB. While Bun reports memory differently than Node, this warrants monitoring. Consider:
- Adding `max_memory_restart: "200M"` (already set to 500M, reasonable)
- Logging memory usage periodically

---

## Quick Win Summary

| Fix | Effort | Impact | Priority |
|-----|--------|--------|----------|
| Add `drop_pending_updates: true` to bot.start() | 1 line | Reduces message confusion on restart | Do now |
| Add `kill_timeout: 10000` to PM2 config | 1 line | Prevents instance overlap | Do now |
| Wrap message handlers in try/catch | 10 min | Stops silent failures | Do now |
| Increase timeout to 180s | 1 line | Fixes complex query failures | Do now |
| Add periodic typing indicator | 5 min | Better UX during long waits | Do soon |
| Add message queue | 30 min | Prevents concurrent spawn issues | Do soon |
| Switch to webhook mode | 2 hours | Eliminates polling issues entirely | Plan for later |

---

## Appendix: Key File References

- `src/relay.ts:219-306` -- `callClaude()` function with timeout logic
- `src/relay.ts:313-339` -- Text message handler (no try/catch)
- `src/relay.ts:596-604` -- Bot startup (fire-and-forget)
- `src/relay.ts:88-133` -- Lock file implementation (race conditions)
- `ecosystem.config.cjs:7-26` -- PM2 configuration (no kill_timeout)
- `src/memory.ts:20-71` -- `processMemoryIntents()` (can return empty string)
