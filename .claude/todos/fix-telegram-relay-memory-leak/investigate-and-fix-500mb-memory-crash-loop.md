# Fix: Telegram-Relay Memory Leak (112 Restarts, Crash Loop)

**Goal**: Stop telegram-relay from growing to 500-800MB and crashing every 5-10 minutes

---

## Investigation Summary

### Observed Behaviour
From PM2 logs (2026-02-18):
```
Process 0 restarted because it exceeds --max-memory-restart value
  current_memory=839237632  (800MB)
  max_memory_limit=524288000 (500MB)
```

Restart count: **112 restarts** in the `telegram-relay` process. Crashes happen every 5-10 minutes:
- 10:45:53 — restart (839MB)
- 11:16:24 — restart (693MB)
- 11:21:53 — restart (722MB)
- 11:32:24 — restart (756MB)
- 11:37:54 — restart (783MB)

Memory grows from ~36MB (startup) to 500-800MB within minutes of startup, suggesting an unbounded memory accumulation.

### Likely Root Causes

#### 1. Chat history / embedding accumulation in memory (HIGH)
`src/index.ts` likely loads conversation history into memory for each message and may be accumulating embeddings, message arrays, or context windows without bounds.

#### 2. Ollama/LLM response buffering (HIGH)
The chat memory feature uses Ollama for extraction. If responses are buffered in memory and not released, repeated messages will grow memory unboundedly.

#### 3. Telegram bot polling accumulating updates (MEDIUM)
`telegraf` or `grammy` polling may accumulate unprocessed updates in memory if the handler is slow (especially when Claude Code takes 30-60s to respond).

#### 4. `setTimeout` reminders in enhanced-morning-summary leaking into relay (LOW)
`scheduleTaskReminders()` uses `setTimeout` — but this runs in the routine process, not relay. Not likely the cause.

#### 5. Semantic search cache growing without eviction (MEDIUM)
If semantic search results are cached in-process without TTL/LRU eviction, repeated queries accumulate cached data.

---

## Fixes

### Fix A: Profile memory usage — identify what's growing

Add memory logging to find the leak:

```typescript
// In src/index.ts, add periodic memory logging:
setInterval(() => {
  const used = process.memoryUsage();
  console.log(`[MEM] heapUsed=${Math.round(used.heapUsed/1024/1024)}MB rss=${Math.round(used.rss/1024/1024)}MB`);
}, 60_000);
```

Correlate memory spikes with specific operations (message receipt, Claude call, Supabase query).

### Fix B: Limit in-memory chat history

If history is loaded and kept in a module-level array:

```typescript
// BAD — unbounded growth:
const chatHistory: Message[] = [];
chatHistory.push(newMessage);

// GOOD — bounded circular buffer:
const MAX_HISTORY = 50;
const chatHistory: Message[] = [];
chatHistory.push(newMessage);
if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
```

### Fix C: Increase `max_memory_restart` temporarily as a band-aid

In `ecosystem.config.cjs`:
```js
max_memory_restart: "1G",  // Was "500M" — gives more headroom while fixing root cause
```

**Note**: This is a band-aid, not a fix. Memory will still grow, just restart less often.

### Fix D: Force garbage collection after Claude responses

```typescript
// After each message handling cycle:
if (global.gc) {
  global.gc();
}
```

Run with: `bun --expose-gc src/index.ts`

### Fix E: Check for event listener accumulation

```typescript
// Detect listener leaks:
process.on('warning', (warning) => {
  if (warning.name === 'MaxListenersExceededWarning') {
    console.error('Memory leak: too many listeners:', warning);
  }
});
```

### Fix F: Supabase client — use singleton, not per-request instantiation

If `createClient()` is called per-message:
```typescript
// BAD — creates new client per message:
async function handleMessage(msg) {
  const supabase = createClient(URL, KEY);  // leaks connections
  ...
}

// GOOD — singleton:
const supabase = createClient(URL, KEY);  // once at module level
```

---

## Files to Investigate

| File | What to Check |
|------|---------------|
| `src/index.ts` | Global state, event listeners, history accumulation |
| `src/memory/*.ts` or similar | In-memory caches, history arrays |
| `src/utils/routineMessage.ts` | Supabase client instantiation |
| Any file with `createClient()` | Ensure singleton pattern |
| `package.json` | Check telegraf/grammy version for known memory issues |

---

## Verification

After fixes, monitor:
```bash
# Watch memory every 30 seconds:
watch -n 30 "npx pm2 list | grep telegram-relay"

# Should stay stable around 50-100MB
# NOT growing to 500MB+ within minutes
```

Target: 0 memory-triggered restarts per day.

---

**Priority**: CRITICAL (bot is essentially non-functional — crashing every 5-10 min)
**Effort**: 4-8 hours (profiling + fix)
**Impact**: Bot stability, 112 → 0 restarts
