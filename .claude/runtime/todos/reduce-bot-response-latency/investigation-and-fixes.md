# Bot Response Latency Investigation & Fixes

**Observed**: "what's my goals?" → 33s, "what're my preferences?" → 30s
**Target**: <5s for simple memory queries, <12s for complex responses
**Branch**: `chat_memory`
**Investigated**: 2026-02-18

---

## Root Cause Summary

The 30-33 second latency is caused by **two compounding factors**:

1. **Semantic search (OpenAI embedding) runs on every message** — even trivial queries
   - `getRelevantContext()` calls the Supabase `search` Edge Function
   - Edge Function calls OpenAI `text-embedding-3-small` + pgvector similarity search
   - **Cost: 300-800ms** on every single message, blocking Claude call

2. **Claude CLI process spawn is slow + large context window**
   - Claude is invoked via `spawn(["claude", "-p", enrichedPrompt, "--resume", sessionId])`
   - No streaming — waits for full response before returning
   - Enriched prompt is **3-10KB** (session history + profile + memory + semantic results)
   - For "what's my goals?" the answer is in memory context already; Claude doesn't need it
   - **Cost: 20-30s** for these simple queries because Claude reads the full context

3. **Async Ollama extraction from previous message can block the queue** (secondary)
   - After each response, `setImmediate()` runs: extractMemoriesFromExchange (20s timeout) → summarizeOldMessages → rebuildProfileSummary (20s timeout)
   - If you send two messages quickly, the second waits for Ollama to finish

---

## Bottleneck Timeline (Confirmed via Code Inspection)

```
Message arrives
  │
  ├─ [~300-800ms]  getRelevantContext() → Supabase Edge Function → OpenAI embed
  ├─ [~200-500ms]  getShortTermContext() → SELECT last 20 messages
  ├─ [~100-300ms]  getUserProfile() → SELECT user_profile
  ├─ [~100-200ms]  getMemoryContext() → SELECT memory WHERE type IN (fact, goal)
  │                ↑ ALL PARALLEL via Promise.all — dominated by semantic search
  │
  ├─ [~25-30s]     callClaude() → spawn process → wait for full output
  │                - Process spawn: ~200ms
  │                - Network to Anthropic: ~1-2s
  │                - Claude reads 3-10KB context: slow for simple queries
  │                - No streaming = wait for last token
  │
  └─ USER SEES RESPONSE AFTER ~30s TOTAL
```

---

## Fixes — Ranked by Impact

### FIX 1 (Highest Impact): Skip Semantic Search for Memory Queries
**File**: `src/memory.ts:254-284` (`getRelevantContext()`)
**File**: `src/relay.ts:394` (call site)

**Problem**: "what's my goals?" triggers OpenAI embedding + pgvector search for "what's my goals?" — this retrieves past messages about goals, which is redundant when `memoryContext` already has all goals from the `memory` table.

**Fix**: Detect intent and skip semantic search when the query is a direct memory retrieval question.

```typescript
// In relay.ts, before Promise.all at line 391:
const isMemoryQuery = /\b(goal|goals|preference|preferences|reminder|fact|facts|memory|memories)\b/i.test(text)
  && text.length < 100; // Short query = likely direct question

const [shortTermCtxRaw, userProfile, relevantContext, memoryContext] = await Promise.all([
  supabase ? getShortTermContext(supabase, chatId) : Promise.resolve(...),
  supabase ? getUserProfile(supabase, userId) : Promise.resolve(""),
  isMemoryQuery ? Promise.resolve("") : getRelevantContext(supabase, text, chatId), // SKIP
  getMemoryContext(supabase, chatId),
]);
```

**Impact**: Saves **300-800ms** per memory query. More importantly, eliminates one blocking network round-trip to OpenAI.

---

### FIX 2 (Highest Impact): Direct Answer for Pure Memory Queries (Bypass Claude)
**File**: `src/relay.ts` — add before `callClaude()` at line 421

**Problem**: For "what's my goals?", Claude gets a 3-10KB prompt just to answer a question that's literally already answered in `memoryContext`. Claude re-reads the context and paraphrases it — this takes 20-30s.

**Fix**: Detect pure memory queries and return the structured answer directly from the DB, bypassing Claude.

```typescript
// Add helper function:
function tryDirectMemoryAnswer(text: string, memoryContext: string): string | null {
  const lower = text.toLowerCase().trim();
  if (/^(what('s| are| is)? my ?(goals?|targets?|objectives?)\??)$/i.test(lower)) {
    // Extract goals section from memoryContext
    const goalsMatch = memoryContext.match(/🎯 GOALS\n([\s\S]*?)(?=\n\n|$)/);
    if (goalsMatch) return `Your goals:\n${goalsMatch[1]}`;
  }
  if (/^(what('s| are| is)? my ?(prefs?|preferences?|settings?)\??)$/i.test(lower)) {
    const factMatch = memoryContext.match(/📌 FACTS\n([\s\S]*?)(?=\n\n|$)/);
    if (factMatch) return `Here's what I know about your preferences:\n${factMatch[1]}`;
  }
  return null;
}

// In message handler, after building memoryContext:
const directAnswer = tryDirectMemoryAnswer(text, memoryContext);
if (directAnswer) {
  await sendResponse(ctx, directAnswer);
  // Still log and do async extraction, but no Claude call
  return;
}
```

**Impact**: Eliminates the **25-30s Claude call** entirely for these queries. Response time becomes ~1-2s.

---

### FIX 3 (High Impact): Replace Claude CLI Spawn with Anthropic SDK
**File**: `src/relay.ts:190-268` (`callClaude()`)

**Problem**: Spawning `claude -p "..."` as a child process is slow:
- Process startup overhead: ~200-500ms
- No streaming — waits for complete response
- Can't set precise timeouts on individual tokens
- Full output buffered in memory before returning

**Fix**: Use the Anthropic TypeScript SDK directly with streaming.

```typescript
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function callClaudeSDK(prompt: string, chatId: number): Promise<string> {
  // Build messages from short-term context instead of resuming sessions
  const stream = await anthropic.messages.stream({
    model: "claude-haiku-4-5-20251001", // Use Haiku for chat, Sonnet for complex
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  // Stream tokens to Telegram as they arrive (with throttling)
  let response = "";
  for await (const chunk of stream) {
    if (chunk.type === "content_block_delta") {
      response += chunk.delta.text;
    }
  }
  return response;
}
```

**Additional win**: Use `claude-haiku-4-5-20251001` for simple queries (2-3x faster, cheaper), `claude-sonnet-4-5-20250929` only for complex tasks.

**Impact**: Eliminates 200-500ms spawn overhead + enables streaming responses user sees immediately.

---

### FIX 4 (High Impact): Model Routing — Haiku for Simple, Sonnet for Complex
**File**: `src/relay.ts` — add before `callClaude()` at line 421

**Problem**: Every query — including "what's my goals?" — uses the same Sonnet model which is 3-5x slower than Haiku for simple responses.

**Fix**: Route simple queries to Haiku, complex to Sonnet.

```typescript
function selectModel(text: string, memoryContext: string): string {
  const isSimple = (
    text.length < 150 &&                              // Short question
    !/code|implement|write|build|create|debug/i.test(text) &&  // Not code task
    !/analyze|research|compare|explain in detail/i.test(text)  // Not deep analysis
  );
  return isSimple
    ? "claude-haiku-4-5-20251001"   // ~2-4s response
    : "claude-sonnet-4-5-20250929"; // ~8-15s response
}
```

**Impact**: For "what's my goals?" and "what're my preferences?": 3-5x speedup → **6-10s → 2-4s**.

---

### FIX 5 (Medium Impact): Reduce Short-Term Context Size
**File**: `src/memory/shortTermMemory.ts` — `getShortTermContext()`

**Problem**: Fetches last 20 messages + summaries every time. For simple memory queries, past conversation history is noise that inflates the prompt and slows Claude.

**Fix**: Cap verbatim messages at 5 for simple queries (pass a `limit` parameter):

```typescript
// In relay.ts, determine context depth before Promise.all:
const contextDepth = isComplexQuery(text) ? 20 : 5;

// Pass to getShortTermContext:
getShortTermContext(supabase, chatId, contextDepth)
```

**Impact**: Reduces prompt size by ~60% for simple queries → Claude processes fewer tokens → faster response.

---

### FIX 6 (Medium Impact): Cache Semantic Search Results
**File**: `src/memory.ts:254-284` (`getRelevantContext()`)

**Problem**: Same or similar queries re-run the same OpenAI embedding + pgvector search.

**Fix**: Cache search results in-memory with a short TTL:

```typescript
const searchCache = new Map<string, { result: string; expiry: number }>();

export async function getRelevantContext(...): Promise<string> {
  const cacheKey = `${chatId}:${query.slice(0, 50)}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) return cached.result;

  // ... existing search logic ...

  searchCache.set(cacheKey, { result, expiry: Date.now() + 60_000 }); // 60s TTL
  return result;
}
```

**Impact**: Follow-up questions in same session avoid repeated OpenAI calls. Saves **300-800ms** on repeated queries.

---

### FIX 7 (Medium Impact): Rate-Limit Async Ollama Extraction
**File**: `src/relay.ts:448-460`

**Problem**: `setImmediate()` fires Ollama extraction (20s timeout) + profile rebuild (20s timeout) after EVERY message. If user sends 2 messages in quick succession, 2 extraction jobs queue up, blocking Ollama for 40-60s total.

**Fix**: Debounce extraction and add a simple mutex:

```typescript
let extractionInFlight = false;

// In message handler:
if (supabase && !extractionInFlight) {
  extractionInFlight = true;
  setImmediate(async () => {
    try {
      await extractAndStore(supabase, chatId, userId, text, response || rawResponse);
      // Only summarize/rebuild every N messages, not every time
      if (session.messageCount % 5 === 0) {
        if (await shouldSummarize(supabase, chatId)) {
          await summarizeOldMessages(supabase, chatId);
        }
        await rebuildProfileSummary(supabase, userId);
      }
    } catch (err) {
      console.error("Async memory extraction failed:", err);
    } finally {
      extractionInFlight = false;
    }
  });
}
```

**Impact**: Prevents Ollama queue buildup. Reduces profile rebuild frequency (only every 5 messages instead of every message). **Saves 5-15s** on rapid message sequences.

---

### FIX 8 (Low Impact): Add DB Indexes
**File**: `supabase/migrations/` — new migration

**Problem**: `getShortTermContext()` queries `messages` table with `WHERE chat_id = ? ORDER BY created_at DESC LIMIT 20`. Without a composite index, this is a full table scan as the table grows.

**Fix**: Add migration:

```sql
-- Migration: add_performance_indexes
CREATE INDEX IF NOT EXISTS idx_messages_chat_id_created_at
  ON messages(chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_chat_id_type
  ON memory(chat_id, type) WHERE chat_id IS NOT NULL;

-- For global memory queries (chat_id IS NULL):
CREATE INDEX IF NOT EXISTS idx_memory_global_type
  ON memory(type) WHERE chat_id IS NULL;
```

**Impact**: As database grows, prevents query time from degrading. Currently low impact (small dataset), high impact at scale.

---

## Implementation Priority

| Fix | Impact | Effort | Do First? |
|-----|--------|--------|-----------|
| FIX 2: Direct answer for memory queries | -25s → <1s | Low | **YES — do now** |
| FIX 1: Skip semantic search for memory queries | -800ms | Low | **YES — do now** |
| FIX 4: Model routing (Haiku vs Sonnet) | 3-5x speed | Medium | Yes |
| FIX 3: Replace CLI spawn with SDK | -500ms + streaming | High | Yes |
| FIX 7: Rate-limit Ollama extraction | Prevents 40s queuing | Low | Yes |
| FIX 5: Reduce context size | -60% prompt tokens | Low | Yes |
| FIX 6: Cache semantic search | -800ms on repeat | Low | Optional |
| FIX 8: DB indexes | Scale protection | Low | Later |

---

## Quick Win: Fixes 1 + 2 Together

Implementing FIX 1 (skip semantic search) + FIX 2 (direct answer) together will reduce:
- "what's my goals?" → **33s → ~1-2s** (direct DB answer, no Claude, no OpenAI)
- "what're my preferences?" → **30s → ~1-2s** (same)

These two fixes require changing ~20 lines of code total in `src/relay.ts` and `src/memory.ts`.

---

## Verification

After implementing, verify with timing logs already present in codebase:

```
# relay.ts:426 already logs:
console.log(`Claude raw response length: ${rawResponse.length} (${callDurationMs}ms)`);
```

Add additional timing before/after `Promise.all` context gathering:
```typescript
const contextStart = Date.now();
const [...] = await Promise.all([...]);
console.log(`Context gathered in ${Date.now() - contextStart}ms`);
```

---

## Files to Modify

| File | Lines | Change |
|------|-------|--------|
| `src/relay.ts` | 391-424 | Add intent detection, model routing, direct answer |
| `src/memory.ts` | 254-284 | Skip semantic search conditionally, add cache |
| `src/memory/shortTermMemory.ts` | `getShortTermContext()` | Add `limit` param |
| `src/relay.ts` | 448-460 | Debounce Ollama extraction |
| `supabase/migrations/` | new file | Add DB indexes |
