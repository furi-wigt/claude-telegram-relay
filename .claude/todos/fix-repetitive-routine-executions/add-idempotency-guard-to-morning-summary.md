# Fix: Repetitive Enhanced Morning Summary Executions

**Goal**: Prevent enhanced-morning-summary from running more than once per day

---

## 2-Hour Window Analysis (10:00–12:14 UTC / 18:00–20:14 SGT, Feb 18)

### Exact Event Timeline

| Time (UTC) | Time (SGT) | Event |
|-----------|-----------|-------|
| 10:35:42 | 18:35 | telegram-relay manually restarted (SIGINT, clean exit 0) |
| 10:45:53 | 18:45 | telegram-relay **memory kill** at 839MB (only 10 min uptime!) |
| 12:00:00 | 20:00 | smart-checkin + watchdog cron restart (scheduled, normal) |
| 12:04:56 | **12:05** | morning-summary routine **sent #1** (SGT times - these are this morning!) |
| 12:07:20 | **12:07** | morning-summary routine **sent #2** |
| 12:07:40 | **12:07** | morning-summary routine **sent #3** |
| 12:14:24 | 20:14 | telegram-relay **memory kill** at 788MB — process **stuck/unkillable** for 3+ sec |

*Note: Morning summary SGT times are from this morning (04:xx UTC); PM2 events after 12:00 UTC = 20:00 SGT (evening).*

### Root Cause of 3x Morning Summary (Confirmed)

**Conversation trace leading to triple send:**
```
12:01 SGT — User: "i have enhanced morning summary routine in pm2, i want this"
12:02 SGT — User: "use pm2 to query and understand how to run this routine"
12:02 SGT — Claude (relay): Explained routine status
[No further user message]
12:05 SGT — Routine sent #1  ← Claude spawned the script
12:07 SGT — Routine sent #2  ← Claude spawned the script AGAIN
12:07 SGT — Routine sent #3  ← Claude spawned the script AGAIN
```

**Primary cause**: The Telegram relay (Claude Code running headlessly) spawned `bun run routines/enhanced-morning-summary.ts` **three times** in response to one user message.

**Why three times?** Most likely:
1. Telegram bot crashed mid-response (memory kill at 10:45 UTC) → Telegram **re-delivered** the same update on restart
2. Bot processed it again → spawned script → sent #2
3. Bot crashed again or had parallel handlers → spawned script → sent #3

This is a **Telegram unacknowledged update + crash-loop** interaction. When the bot crashes before sending a response, Telegram re-queues the update and re-delivers it on the next bot connection.

### Secondary Root Cause: Memory Crash Loop

telegram-relay reaches 500–800MB in under 10 minutes and gets killed repeatedly (112+ restarts). Each crash causes:
1. Unprocessed Telegram updates get re-delivered
2. Any in-progress routine spawns may re-execute
3. Memory-intensive operations (embeddings, Claude calls) never release

---

## Fixes

### Fix 1 (CRITICAL): Acknowledge Telegram updates BEFORE processing (anti-duplicate)

In `src/index.ts`, send an immediate acknowledgment / "thinking..." message before spawning any slow operations:

```typescript
// In the message handler, acknowledge immediately:
bot.on('message', async (ctx) => {
  const updateId = ctx.update.update_id;

  // Idempotency: skip if already processed this update
  const alreadyProcessed = await checkUpdateProcessed(updateId);
  if (alreadyProcessed) {
    console.log(`Skipping duplicate update ${updateId}`);
    return;
  }

  await markUpdateProcessed(updateId);  // Mark BEFORE processing
  // ... proceed with handling
});
```

Store processed `update_id` values in Supabase (or a simple local file) to detect re-deliveries.

### Fix 2 (HIGH): Add "sent today" guard in enhanced-morning-summary.ts

Even if the script is spawned multiple times, it should exit early if already sent today:

```typescript
async function alreadySentToday(): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false;
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Get today in SGT as YYYY-MM-DD
  const sgDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" });

  const { count } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("metadata->>routine", "morning-summary")
    .gte("created_at", `${sgDate}T00:00:00+08:00`)
    .lt("created_at", `${sgDate}T23:59:59+08:00`);

  return (count ?? 0) > 0;
}

async function main() {
  if (await alreadySentToday()) {
    console.log("Morning summary already sent today — skipping.");
    process.exit(0);
  }
  // ... rest of main
}
```

### Fix 3 (HIGH): Fix memory leak to stop crash loop (see separate todo)

Without fixing the memory leak, the crash → re-delivery → duplicate execution cycle will continue regardless of the above fixes.

### Fix 4 (MEDIUM): Filter routine messages from Claude's chat context

`sendAndRecord()` stores routine messages as `role: "assistant"` — they get included in Claude's context window on subsequent queries, inflating it with repeated morning summaries.

In `src/index.ts` (wherever chat history is fetched):
```typescript
const { data: history } = await supabase
  .from("messages")
  .select("role, content")
  .not("metadata->>source", "eq", "routine")   // exclude routine messages
  .order("created_at", { ascending: false })
  .limit(50);
```

---

## Files to Change

| File | Change |
|------|--------|
| `src/index.ts` | Add update_id idempotency check before processing |
| `routines/enhanced-morning-summary.ts` | Add `alreadySentToday()` guard in `main()` |
| `src/index.ts` | Filter `source: routine` from chat history context |

---

## Verification

```sql
-- After fix: should return 1 per day
SELECT
  DATE_TRUNC('day', created_at AT TIME ZONE 'Asia/Singapore') as day_sgt,
  COUNT(*) as morning_summary_sends
FROM messages
WHERE metadata->>'routine' = 'morning-summary'
GROUP BY 1
ORDER BY 1 DESC;
```

---

**Priority**: HIGH
**Effort**: ~3 hours
**Impact**: Prevents duplicate Telegram messages, Supabase bloat, and distorted chat context
