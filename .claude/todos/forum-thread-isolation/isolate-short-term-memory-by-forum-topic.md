# Forum Thread Isolation — Short-Term Memory

**Goal**: Isolate short-term memory (and sessions/queues) by Telegram forum topic (`message_thread_id`)
within each group chat. Currently all topics in a group share one memory keyed by `chatId`.

**Root Cause**: Every query uses `chat_id` alone. In Telegram forum groups:
- `chat.id` = the **group** ID (same for all topics, e.g. `-1001234567890`)
- `message.message_thread_id` = the **topic** ID (different per topic, e.g. `5`, `10`)

So all topics bleed into each other's memory.

---

## Implementation Plan

### Step 1 — DB Migration (`db/migrations/003_add_thread_id.sql`)
Add `thread_id BIGINT` column to:
- `messages` table
- `conversation_summaries` table
- `memory` table (optional — scope memory to topic too)

Add composite indexes:
- `(chat_id, thread_id)` on messages
- `(chat_id, thread_id)` on conversation_summaries

Update SQL function:
- `get_unsummarized_message_count(p_chat_id, p_thread_id)` — add thread_id param + filter

Backward compatibility: existing rows have `thread_id = NULL` = non-forum / group-wide.
Non-forum messages continue to use `thread_id = NULL`.

### Step 2 — Extract threadId in `src/relay.ts`
In ALL message handlers (text, voice, photo, document):
```ts
const threadId = ctx.message?.message_thread_id ?? null;
```
Pass `threadId` to:
- `saveMessage(role, content, metadata, chatId, agentId, threadId)`
- `getShortTermContext(supabase, chatId, threadId)`
- `loadGroupSession(chatId, agentId, threadId)`
- `queueManager.hasCapacity(chatId, threadId)`
- `queueManager.getOrCreate(chatId, threadId)`

### Step 3 — Update `src/queue/groupQueueManager.ts`
- Change `Map<number, MessageQueue>` → `Map<string, MessageQueue>`
- Add helper: `getQueueKey(chatId: number, threadId?: number | null): string`
  → returns `"${chatId}:${threadId ?? ''}"`
- Update all methods to accept `(chatId, threadId?)` signature
- Update `lastActivity` map similarly
- Log key includes thread context

### Step 4 — Update `src/session/groupSessions.ts`
- Change in-memory Map key from `chatId: number` to string `"${chatId}_${threadId ?? ''}"`
- Session file naming: `{chatId}_{threadId}.json` for forum, `{chatId}.json` for non-forum
- `loadSession(chatId, agentId, threadId?)` — add threadId parameter
- `saveSession(state)` — state includes `threadId`
- `SessionState` interface: add `threadId: number | null`
- Update `updateSessionId`, `touchSession`, `getSession`, `resetSession`, `getSessionSummary`

### Step 5 — Update `src/memory/shortTermMemory.ts`
Add `threadId?: number | null` param to:
- `getRecentMessages(supabase, chatId, limit, threadId?)`
  → `.eq("thread_id", threadId)` if threadId, else `.is("thread_id", null)`
- `getConversationSummaries(supabase, chatId, threadId?)`
- `getTotalMessageCount(supabase, chatId, threadId?)`
- `shouldSummarize(supabase, chatId, threadId?)` — pass to RPC
- `summarizeOldMessages(supabase, chatId, threadId?)` — include thread_id in INSERT
- `getShortTermContext(supabase, chatId, threadId?)`

### Step 6 — Update `saveMessage` in `src/relay.ts`
```ts
async function saveMessage(role, content, metadata?, chatId?, agentId?, threadId?) {
  await supabase.from("messages").insert({
    role, content, channel: "telegram",
    chat_id: chatId ?? null,
    agent_id: agentId ?? null,
    thread_id: threadId ?? null,   // NEW
    metadata: metadata || {},
  });
}
```

### Step 7 — Update tests
- `src/memory/shortTermMemory.test.ts` — add thread_id parameter tests
- `src/session/groupSessions.ts` — mock tests for forum isolation

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `db/migrations/003_add_thread_id.sql` | CREATE new migration |
| `src/relay.ts` | MODIFY — extract threadId, pass everywhere |
| `src/queue/groupQueueManager.ts` | MODIFY — string composite key |
| `src/session/groupSessions.ts` | MODIFY — add threadId to SessionState + file naming |
| `src/memory/shortTermMemory.ts` | MODIFY — add threadId param to all functions |

## Out of Scope
- `src/memory.ts` (facts/goals memory) — keep group-scoped, NOT topic-scoped (intentional: facts are about the user, not per-topic)
- `src/commands/botCommands.ts` — /status, /new commands should work per-topic too (update chatId usage)
- User profile (`longTermExtractor.ts`) — user-scoped, not topic-scoped ✓

---

## Backward Compatibility
- Non-forum chats: `threadId = null` → filter `thread_id IS NULL` in DB
- Forum topics: `threadId = message_thread_id` (positive integer)
- Existing data (all rows with `thread_id = NULL`) continues to work for DMs/regular groups
