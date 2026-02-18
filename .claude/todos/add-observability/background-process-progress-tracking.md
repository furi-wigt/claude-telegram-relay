# Observability: Background Process Progress Tracking

**Goal**: Add non-intrusive progress feedback for long-running Claude Code sessions (both regular chat mode and /code mode) without polluting chat history or short-term memory.

**User Requirements**:
- Periodic brief updates every N minutes while work is in progress
- Progress details route to separate Telegram topic (if forum groups configured)
- Updates must NOT be stored in Supabase/short-term memory (avoid context pollution)

---

## Problem Statement

### Regular Chat Mode
- When `callClaude()` runs for minutes (e.g. complex coding task), user sees nothing
- No "still working" indicator → user doesn't know if bot is stuck or working
- When Claude finally responds, the full response floods chat (every multi-turn phase)

### /code Mode
- Pinned dashboard exists but is silent between tool calls
- No periodic pulse for long-running background work
- Detailed tool events (bash, file edits) have nowhere to go except the log file

---

## Implementation Plan

### Part 1: In-Progress Indicator for Regular Chat Mode
**File**: `src/relay.ts` (modify `callClaude` invocation area) + new `src/utils/progressIndicator.ts`

Create a `ProgressIndicator` class:
```typescript
class ProgressIndicator {
  private messageId: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();
  private lastSummary = "Thinking...";

  async start(chatId: number, bot: Bot): Promise<void>
  // Sends initial "⚙️ Working..." message, starts edit timer every UPDATE_INTERVAL_MS

  async update(summary: string): Promise<void>
  // Updates lastSummary — next timer tick will edit the message

  async finish(finalText?: string): Promise<void>
  // Clears timer, optionally edits to show "done" or deletes the indicator
}
```

**Key constraint**: Progress indicator messages are NEVER passed to `saveMessage()`, `getShortTermContext()`, or any memory pipeline.

**Timer behavior**:
- Start after 8 seconds (short tasks don't need an indicator)
- Edit every `PROGRESS_UPDATE_INTERVAL_MS` (default: 120000 = 2 min, env configurable)
- Format: `⚙️ {projectName or "Claude"} — {elapsed}\n{lastSummary}`
- On completion: edit to "✅ Done" and auto-delete after 5 seconds (or just leave as done marker)

**Integration point in relay.ts**: Wrap the `callClaude()` call in the main message handler:
```typescript
const indicator = new ProgressIndicator();
// Start indicator after short delay (don't show for quick responses)
const indicatorTimer = setTimeout(() => indicator.start(chatId, bot), 8000);

const response = await callClaude(prompt, ...);

clearTimeout(indicatorTimer);
await indicator.finish();
// Then send actual response
```

---

### Part 2: Periodic Heartbeat for /code Sessions
**File**: `src/coding/sessionManager.ts` (add heartbeat to `launchSession`)

Add a heartbeat timer alongside the session runner:
```typescript
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.PROGRESS_HEARTBEAT_INTERVAL_MS || "300000", 10); // 5 min

// In launchSession(), after runner.run():
let heartbeatTimer = setInterval(async () => {
  const session = this.sessions.get(sessionId);
  if (!session || session.status !== "running") return;

  const elapsed = formatElapsed(session.startedAt);
  const fileCount = session.filesChanged.length;
  const text = `⚙️ ${session.projectName} — still working (${elapsed})\n📝 ${fileCount} file(s) changed so far`;

  // Send to CODING_TOPIC_ID if available, else to chatId
  // IMPORTANT: Do NOT store in Supabase or memory
  await this.sendProgressHeartbeat(session, text);
}, HEARTBEAT_INTERVAL_MS);
```

Heartbeat messages:
- Sent to `CODING_TOPIC_ID` topic if configured
- Include inline button: `[📊 Status]` that triggers `/code status`
- Are NOT saved to Supabase or short-term memory
- Timer is cleared on session complete/fail/kill

---

### Part 3: Topic Routing for /code Progress Details
**File**: `src/coding/sessionManager.ts` + `src/coding/dashboardManager.ts`

New env var: `CODING_TOPIC_ID` (integer thread_id of the Telegram forum topic for coding logs)

When `CODING_TOPIC_ID` is set:
- Route `onProgress` events (tool_use, bash, file changes) to the topic as messages
- Main chat only receives: `onQuestion`, `onPlanApproval`, `onComplete`, `onError`
- The pinned dashboard message remains in main chat

Topic message format (batched every 30s to avoid spam):
```
🔧 rebalancer.py — 14:23
• Write: python/rebalancer.py
• Bash: pytest python/tests/
• Edit: python/telegram_alert.py
```

**Batching**: Buffer progress events and send as a single batched message every 30s to avoid flooding the topic.

---

### Part 4: Non-Memory Guard
**All progress/heartbeat messages must bypass memory pipeline.**

Implement by:
1. Progress indicator messages in regular chat: never passed to `saveMessage()` or `shortTermMemory`
2. Session heartbeat messages: marked with `{ memory: false }` internally, not stored
3. Topic messages: different chat_id (the topic) so they won't be in the main conversation context

---

## Files to Create/Modify

| File | Action | What |
|------|--------|------|
| `src/utils/progressIndicator.ts` | CREATE | ProgressIndicator class for regular chat mode |
| `src/relay.ts` | MODIFY | Wrap callClaude with progress indicator |
| `src/coding/sessionManager.ts` | MODIFY | Add heartbeat timer + topic routing |
| `src/coding/dashboardManager.ts` | MODIFY | Add topic-aware message sending |
| `.env.example` | MODIFY | Document new env vars |

---

## New Environment Variables

```env
# Observability
PROGRESS_UPDATE_INTERVAL_MS=120000   # How often to edit the "working..." message (default: 2 min)
PROGRESS_HEARTBEAT_INTERVAL_MS=300000 # /code session heartbeat interval (default: 5 min)
CODING_TOPIC_ID=                     # Telegram forum topic thread_id for coding progress (optional)
PROGRESS_INDICATOR_DELAY_MS=8000     # Delay before showing indicator (skip for fast responses)
```

---

## Tests to Write

1. `src/utils/progressIndicator.test.ts` — unit tests for ProgressIndicator lifecycle
2. Update `src/coding/sessionManager.test.ts` — verify heartbeat fires, is cleared on completion
3. Verify heartbeat messages don't appear in memory/Supabase

---

## Acceptance Criteria

- [ ] Regular chat: "⚙️ Working..." appears after 8s, edits every 2 min, disappears on response
- [ ] /code mode: Heartbeat sent every 5 min while session is running
- [ ] Progress messages NOT stored in Supabase `messages` table
- [ ] Progress messages NOT in `shortTermMemory` context
- [ ] When `CODING_TOPIC_ID` set, tool-use events route to topic, not main chat
- [ ] Dashboard pinned message continues to work as before
- [ ] All timers properly cleared to avoid memory leaks

---

## Implementation Order

1. `src/utils/progressIndicator.ts` — create and unit test
2. `src/relay.ts` — integrate indicator into message handler
3. `src/coding/sessionManager.ts` — add heartbeat
4. `src/coding/sessionManager.ts` — add topic routing
5. `src/coding/dashboardManager.ts` — topic-aware sending
6. Update `.env.example`
7. Run all tests
