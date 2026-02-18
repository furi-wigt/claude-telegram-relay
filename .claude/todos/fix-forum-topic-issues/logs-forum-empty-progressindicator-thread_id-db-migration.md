# Analysis: Logs Forum Empty + ProgressIndicator + DB Migration

**Date**: 2026-02-18
**Branch**: `add_topic`
**Status**: Pending fixes

---

## Issues Found

### Issue 1: Logs Forum Always Empty (Design Gap)

**Symptom**: `GROUP_GENERAL_CODING_TOPIC_ID` is configured in `.env` but the #Logs forum topic never receives any messages.

**Root Cause**: The logs topic routing only exists inside `CodingSessionManager.launchSession()` via the `onProgress` callback (`sessionManager.ts:199`):

```typescript
if (this.getCodingTopicId(session.chatId) && (event.type === "tool_use" || event.type === "worker_message")) {
    this.sendProgressToTopic(session, event.summary...)
}
```

This ONLY fires for `/code new` sessions (SessionRunner with NDJSON stream). Regular text messages go through `callClaude()` in `relay.ts` — a plain `claude -p` subprocess with no streaming callbacks. There are no tool_use events to intercept, so nothing ever reaches the logs forum.

**The "Claude — working... (2m 08s) Thinking..." message**: IS working correctly. It comes from `ProgressIndicator`. It always says "Thinking..." because `callClaude()` never calls `indicator.update()` with progress updates.

**Fix Options**:
- Accept the current design: logs forum is only for `/code` sessions; regular calls have no log routing
- OR: add a basic call-start/call-end event to the logs topic even for regular calls (not tool-use granularity, just session-level observability)

---

### Issue 2: ProgressIndicator Missing `thread_id`

**Symptom**: The "working..." message may appear in the wrong location in a forum group.

**Root Cause**: `ProgressIndicator.start(chatId, bot)` — `progressIndicator.ts:47` — does not accept a `threadId` parameter. `sendInitialMessage()` at line 115 sends without `message_thread_id`:

```typescript
const msg = await this.bot.api.sendMessage(this.chatId, text);
// ↑ No message_thread_id — goes to root chat, not the topic
```

In `relay.ts`, the indicator is started without thread context:
```typescript
const indicator = new ProgressIndicator();
indicator.start(chatId, bot).catch(() => {}); // threadId not passed
```

**Fix**: Add `threadId?: number | null` parameter to `ProgressIndicator.start()` and pass it through to `sendMessage` and `editMessageText` calls.

---

### Issue 3: DB Migration Never Applied — `thread_id` Column Missing

**Symptom**: Short-term memory appears to work (reads pre-forum messages in forum context) but topic isolation is not actually happening.

**Root Cause**: The `add_topic` branch code references `thread_id` in both tables, but **neither column exists in Supabase**.

| Table | `thread_id` column | Code references |
|---|---|---|
| `messages` | ❌ Missing | INSERT + SELECT filter |
| `conversation_summaries` | ❌ Missing | INSERT + SELECT filter |

**Why it silently "works"**:
- **INSERT**: PostgREST ignores unknown JSON fields → messages save successfully without `thread_id`
- **SELECT filter**: PostgREST ignores unknown filter params → `thread_id=is.null` is dropped → ALL messages for `chat_id` are returned regardless of topic

This means short-term memory returns **all messages for the chat** (no topic isolation), which happens to give the correct behaviour for `thread_id=null` contexts (#General + pre-forum messages both visible).

**Required Migration**:

```sql
-- 1. Add thread_id to messages
ALTER TABLE messages ADD COLUMN thread_id BIGINT;
CREATE INDEX idx_messages_chat_thread ON messages(chat_id, thread_id);

-- 2. Add thread_id to conversation_summaries
ALTER TABLE conversation_summaries ADD COLUMN thread_id BIGINT;
CREATE INDEX idx_conv_summaries_chat_thread ON conversation_summaries(chat_id, thread_id);

-- 3. Update the get_unsummarized_message_count RPC to include p_thread_id
-- (check existing function signature and update accordingly)
```

After migration: existing messages (all with implicit `thread_id = NULL`) will correctly belong to the null-thread scope, maintaining continuity with pre-forum messages in #General.

---

## Code Locations

| File | Relevant Lines | Issue |
|---|---|---|
| `src/relay.ts` | 433–434 | ProgressIndicator started without threadId |
| `src/utils/progressIndicator.ts` | 47, 115, 133 | Missing threadId param in start/send/edit |
| `src/coding/sessionManager.ts` | 199–201, 926–946 | Logs topic routing (works correctly for /code) |
| `src/memory/shortTermMemory.ts` | 63–67, 85–90 | thread_id filter (silently ignored by PostgREST) |
| `src/relay.ts` | 128–136 | saveMessage inserts thread_id (silently ignored) |

---

## Fix Priority

1. **High** — Apply DB migration (thread_id columns) so isolation actually works once needed
2. **Medium** — Fix ProgressIndicator to pass threadId so working message appears in correct topic
3. **Low** — Decide on logs forum strategy for regular (non-/code) Claude calls
