# Chat Memory Implementation Plan
**Branch**: `chat_memory`
**Goal**: Implement short-term rolling window + long-term user profile memory
**Created**: 2026-02-18

---

## Requirements Summary

| Dimension | Requirement |
|-----------|------------|
| Short-term | **Summarized rolling window** — last 20 messages verbatim + compressed summaries of older chunks |
| Long-term | Auto-extract **personal facts, preferences, goals, and important dates** from every exchange |
| Retrieval | **Profile + semantic search** — always include profile summary AND use embeddings for relevant past context |
| Scope | **Single user** (filtered by `TELEGRAM_USER_ID`) |
| Commands | `/memory`, `/forget [topic]`, `/remember [fact]`, `/summary` |
| Extraction timing | **After every message** (async, non-blocking) |
| Window size | **20 messages** verbatim; summarize when buffer exceeds threshold |
| Summarization trigger | **Every 20 messages** (when verbatim buffer fills up) |
| **Routine messages** | **All proactive bot messages (PM2 routines) saved as `role: 'assistant'`** so they appear in short-term memory window |

---

## Current State Analysis

### What Already Exists
- ✅ `messages` table with OpenAI embeddings (auto-generated via webhook)
- ✅ `memory` table (type: fact, goal, completed_goal, preference)
- ✅ Semantic search via `search` Edge Function + `match_messages()`/`match_memory()` RPCs
- ✅ Memory intent tags (`[REMEMBER]`, `[GOAL]`, `[DONE]`) — Claude adds them to responses
- ✅ Per-group session state (`groupSessions.ts`)
- ✅ `/memory` command skeleton (need to verify completeness)
- ✅ `getMemoryContext()` — fetches facts/goals (but doesn't filter by chat_id)
- ✅ `getRelevantContext()` — semantic search (but no chat_id filtering)

### What's Missing (Gap Analysis)
- ❌ **Conversation history injection** — current prompt only gets semantic hits, not chronological last-N messages
- ❌ **Conversation summarization** — no mechanism to compress old message chunks
- ❌ **Automatic fact extraction** — facts only saved when Claude explicitly tags them
- ❌ **User profile summary** — no distilled profile document built from all stored memories
- ❌ **`chat_id` scoping** — `getMemoryContext()` fetches ALL facts (not group-scoped)
- ❌ **`/forget` command** — not implemented
- ❌ **`/summary` command** — not implemented
- ❌ **`/remember` command** — not implemented
- ❌ **Routine message persistence** — `sendToGroup()` sends via Telegram API but **never saves to Supabase**. When a user replies to a morning briefing, Claude has no memory of what was in it.

---

## Architecture Design

```
Message Flow with Memory:

User Message
     │
     ├─► [1] CONTEXT LOADING (parallel)
     │       ├─ Short-term: getConversationHistory(chatId, last=20)
     │       ├─ Long-term: getUserProfileSummary(userId)
     │       └─ Semantic: getRelevantContext(query, chatId)
     │
     ├─► [2] PROMPT ASSEMBLY
     │       └─ profile + conversation_history + semantic_hits + new_message
     │
     ├─► [3] CLAUDE CALL
     │       └─ Response
     │
     ├─► [4] STORAGE (parallel)
     │       ├─ Save user message + assistant response to messages table
     │       └─ Trigger embeddings via webhook
     │
     └─► [5] ASYNC MEMORY EXTRACTION (non-blocking, after response sent)
             ├─ extractAndStoreFacts(exchange) → memory table
             ├─ checkSummarizationNeeded(chatId) → summarize if >20 verbatim
             └─ rebuildProfileSummary(userId) → update profile in memory table
```

---

## Implementation Plan

### Phase 1: Database Schema (Migration)

**File**: `db/migrations/001_chat_memory.sql`

```sql
-- 1. Add conversation_summaries table
CREATE TABLE IF NOT EXISTS conversation_summaries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  chat_id BIGINT NOT NULL,
  summary TEXT NOT NULL,
  message_count INTEGER NOT NULL,       -- How many messages this summarizes
  from_message_id UUID,                 -- Oldest message in range
  to_message_id UUID,                   -- Newest message in range
  from_timestamp TIMESTAMPTZ,
  to_timestamp TIMESTAMPTZ,
  embedding VECTOR(1536)                -- For semantic search on summaries too
);

CREATE INDEX idx_summaries_chat_id ON conversation_summaries(chat_id);
CREATE INDEX idx_summaries_created_at ON conversation_summaries(created_at DESC);

-- 2. Add user_profile table (single user, updated profile document)
CREATE TABLE IF NOT EXISTS user_profile (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE,       -- Telegram user ID
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  profile_summary TEXT,                 -- Distilled profile narrative
  raw_facts JSONB DEFAULT '[]',         -- Array of {fact, category, extracted_at}
  raw_preferences JSONB DEFAULT '[]',   -- Communication/content preferences
  raw_goals JSONB DEFAULT '[]',         -- Active goals
  raw_dates JSONB DEFAULT '[]'          -- Important dates/events
);

-- 3. Add extraction metadata to memory table (if not exists)
ALTER TABLE memory ADD COLUMN IF NOT EXISTS extracted_from_exchange BOOLEAN DEFAULT FALSE;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS confidence FLOAT DEFAULT 1.0;
ALTER TABLE memory ADD COLUMN IF NOT EXISTS category TEXT; -- 'personal', 'preference', 'goal', 'date'

-- 4. Add webhook trigger for summaries embedding generation
-- (Add to supabase webhook config via dashboard after migration)
```

**Supabase webhook**: Add `conversation_summaries` to `embed` Edge Function webhook triggers.

---

### Phase 2: Short-Term Memory Module

**New File**: `src/memory/shortTermMemory.ts`

```typescript
/**
 * Short-term memory: rolling window of recent messages with summarization.
 *
 * Strategy:
 * - Keep last VERBATIM_LIMIT messages as full text
 * - When buffer exceeds threshold, summarize oldest chunk → store in conversation_summaries
 * - Inject both verbatim + summaries into prompt
 */

const VERBATIM_LIMIT = 20;           // Messages kept as-is
const SUMMARIZE_CHUNK_SIZE = 20;     // Messages to compress at once

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  id: string;
}

interface ShortTermContext {
  verbatimMessages: ConversationMessage[];
  summaries: Array<{ summary: string; period: string }>;
  totalMessages: number;
}

export async function getShortTermContext(
  supabase: SupabaseClient,
  chatId: number
): Promise<ShortTermContext>;

// Fetch last 20 messages chronologically
export async function getRecentMessages(
  supabase: SupabaseClient,
  chatId: number,
  limit: number = VERBATIM_LIMIT
): Promise<ConversationMessage[]>;

// Fetch all conversation summaries for a chat (ordered oldest first)
export async function getConversationSummaries(
  supabase: SupabaseClient,
  chatId: number
): Promise<Array<{ summary: string; period: string; createdAt: string }>>;

// Check if we have enough messages to trigger summarization
export async function shouldSummarize(
  supabase: SupabaseClient,
  chatId: number
): Promise<boolean>;

// Summarize oldest chunk of messages using Claude
export async function summarizeOldMessages(
  supabase: SupabaseClient,
  chatId: number
): Promise<void>;

// Format short-term context into prompt section
export function formatShortTermContext(ctx: ShortTermContext): string;
```

**Summarization logic** (in `summarizeOldMessages`):
1. Count verbatim messages for chat_id
2. If count > VERBATIM_LIMIT:
   a. Fetch oldest `SUMMARIZE_CHUNK_SIZE` messages
   b. Call Claude with: "Summarize this conversation excerpt concisely, preserving key facts, decisions, and action items"
   c. Insert into `conversation_summaries` table
   d. Do NOT delete the original messages (they are the source of truth for embeddings)
3. Track last summarized message ID to avoid re-summarizing

---

### Phase 2.5: Routine Message Storage

**Root cause**: `sendToGroup()` in `src/utils/sendToGroup.ts` calls the Telegram Bot API directly. The bot's own outgoing messages are **not echoed back** through the relay's `bot.on("message")` handler — Telegram does not deliver a bot's own messages to itself. So routine messages vanish from Supabase's perspective.

**Fix**: Create `sendAndRecord()` — a wrapper that sends to Telegram AND immediately saves to Supabase with `role: 'assistant'`. All routines switch to this wrapper.

**Decision**: Routine messages are stored **verbatim** in Supabase (full fidelity for embeddings/semantic search) but injected into the rolling window as a **2-3 sentence summary** with a metadata label. Summary is generated **at insert time** (once, when the routine fires) so there is zero added latency when loading context for user replies.

**New File**: `src/utils/routineMessage.ts`

```typescript
/**
 * Send a routine message to Telegram AND save it to Supabase messages table
 * so it appears in the short-term memory window (role: 'assistant').
 *
 * Storage:   Full content saved (for embeddings + semantic search)
 * Injection: 2-3 sentence summary in rolling window (saves token budget)
 * Label:     [routine-name @ HH:MM] so user knows they can ask for more
 *
 * All proactive routine messages MUST use this instead of sendToGroup().
 */

import { createClient } from "@supabase/supabase-js";
import { sendToGroup } from "./sendToGroup.ts";
import { callOllama } from "../fallback.ts";

// Model used for summarization — same local model as context relevance checks.
// Reuses CONTEXT_RELEVANCE_MODEL or FALLBACK_MODEL (default: gemma3:4b).
// No network call, no API cost, runs in ~1-2s on local machine.
const SUMMARIZE_MODEL =
  process.env.CONTEXT_RELEVANCE_MODEL ||
  process.env.FALLBACK_MODEL ||
  "gemma3:4b";

const OLLAMA_API_URL = process.env.OLLAMA_API_URL || "http://localhost:11434";

interface RoutineMessageOptions {
  parseMode?: "Markdown" | "HTML";
  routineName: string;    // e.g. 'smart-checkin', 'morning-summary'
  agentId?: string;       // e.g. 'general-assistant', 'aws-architect'
}

/**
 * Summarize a long routine message into 2-3 sentences using Ollama (gemma3:4b).
 * Called at insert time so summary is cached in metadata forever.
 *
 * Uses the existing local model — free, fast (~1-2s), no API dependency.
 * Falls back to 300-char truncation if Ollama is unavailable.
 */
async function summarizeRoutineMessage(content: string, routineName: string): Promise<string> {
  const prompt =
    `Summarize this ${routineName} message in 2-3 concise sentences. ` +
    `Preserve key facts, numbers, and action items. Plain text only, no markdown.\n\n` +
    content;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000); // 8s hard timeout

    const response = await fetch(`${OLLAMA_API_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: SUMMARIZE_MODEL, prompt, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const data = await response.json() as { response: string };
    const summary = data.response?.trim();
    return summary || content.slice(0, 300) + (content.length > 300 ? "..." : "");
  } catch (err) {
    console.warn(`summarizeRoutineMessage: Ollama unavailable (${err}), using truncation fallback`);
    return content.slice(0, 300) + (content.length > 300 ? "..." : "");
  }
}

/**
 * Send a routine message and persist it to Supabase as role='assistant'.
 *
 * The full content is stored for embeddings. A pre-computed summary is stored
 * in metadata.summary for efficient injection into the rolling window.
 */
export async function sendAndRecord(
  chatId: number,
  message: string,
  options: RoutineMessageOptions
): Promise<void> {
  const sentAt = new Date();

  // 1. Send to Telegram first (fast — don't block on Supabase)
  await sendToGroup(chatId, message, { parseMode: options.parseMode });

  // 2. Generate summary at insert time (async, routine already fired)
  const summary = await summarizeRoutineMessage(message, options.routineName);

  // 3. Persist full content + summary to Supabase
  const supabase = (() => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) return null;
    return createClient(url, key);
  })();

  if (!supabase) {
    console.warn("sendAndRecord: Supabase not configured — message not persisted");
    return;
  }

  try {
    await supabase.from("messages").insert({
      role: "assistant",
      content: message,           // Full content — embedded by webhook for semantic search
      channel: "telegram",
      chat_id: chatId,
      agent_id: options.agentId ?? null,
      metadata: {
        source: "routine",
        routine: options.routineName,
        summary,                  // Pre-computed summary for rolling window injection
        // NOTE: sentAt is stored for reference but created_at (set by Supabase) is the
        // authoritative timestamp used by formatMessage() for all rendering.
        // Do NOT store sentAtFormatted — formatting is done dynamically at read time
        // in USER_TIMEZONE so it stays correct even if timezone config changes.
        sentAt: sentAt.toISOString(),
      },
    });
    console.log(`sendAndRecord: Persisted [${options.routineName}] summary: ${summary.slice(0, 80)}...`);
  } catch (err) {
    console.error("sendAndRecord: Failed to persist routine message:", err);
  }
}
```

**Timestamp Context Design** (critical for time-based routines):

Routine messages are time-anchored events. Claude must know not just *what* was said but *when*, so it can judge information currency (a 7am weather briefing is stale by 3pm; last week's ETF report is outdated). The plan stores `sentAt` ISO timestamp in metadata — but `sentAtFormatted` was `HH:MM` only, which loses date context across multi-day conversations.

**Fixed `sentAtFormatted`** — store full date + time + relative:

```typescript
// In sendAndRecord() — compute at insert time, in user's timezone
const tz = process.env.USER_TIMEZONE || "Asia/Singapore";
const sentAtFormatted = sentAt.toLocaleString("en-SG", {
  weekday: "short",          // "Mon"
  month: "short", day: "numeric",  // "Feb 18"
  hour: "2-digit", minute: "2-digit",
  timeZone: tz,
});
// → "Mon, Feb 18, 07:02 AM"
```

**How `getShortTermContext()` injects all messages**:

Every message in the window (both user/assistant and routine) includes a timestamp so Claude has temporal context. Day boundaries are made explicit with separator headers.

```typescript
// In shortTermMemory.ts — formatShortTermContext()

function relativeTime(isoStr: string, tz: string): string {
  const diffMs = Date.now() - new Date(isoStr).getTime();
  const diffH = diffMs / 3600000;
  if (diffH < 1) return "just now";
  if (diffH < 24) return `${Math.round(diffH)}h ago`;
  if (diffH < 48) return "yesterday";
  return `${Math.round(diffH / 24)} days ago`;
}

function formatDateHeader(isoStr: string, tz: string): string {
  return new Date(isoStr).toLocaleDateString("en-SG", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: tz,
  });
  // → "Monday, 18 February 2026"
}

function formatMessage(msg: ConversationMessage, tz: string): string {
  const timeStr = new Date(msg.created_at).toLocaleTimeString("en-SG", {
    hour: "2-digit", minute: "2-digit", timeZone: tz,
  }); // → "07:02 AM"

  const rel = relativeTime(msg.created_at, tz);

  if (msg.metadata?.source === 'routine') {
    const label = msg.metadata.routine ?? 'routine';
    const summary = msg.metadata.summary ?? msg.content.slice(0, 300);
    // Include: routine type, full date+time, relative age → staleness visible to Claude
    return `[${label} | ${timeStr}, ${rel}]: ${summary}`;
  }

  const speaker = msg.role === 'user' ? 'User' : 'Assistant';
  return `[${timeStr}] ${speaker}: ${msg.content}`;
}

function formatShortTermContext(ctx: ShortTermContext, tz: string): string {
  const lines: string[] = [];

  // Older summaries with date range
  for (const s of ctx.summaries) {
    lines.push(`[Summary | ${s.period}]: ${s.summary}`);
  }

  // Verbatim messages — group by date with day-boundary headers
  let currentDate = "";
  for (const msg of ctx.verbatimMessages) {
    const msgDate = formatDateHeader(msg.created_at, tz);
    if (msgDate !== currentDate) {
      lines.push(`\n─── ${msgDate} ───`);  // Day separator
      currentDate = msgDate;
    }
    lines.push(formatMessage(msg, tz));
  }

  return lines.join("\n");
}
```

**Resulting prompt section**:

```
═══ CONVERSATION HISTORY ═══

[Summary | Feb 15–16]: Discussed AWS Lambda architecture. Agreed on
  event-driven design with SQS. Action: create CDK stack.

─── Monday, 18 February 2026 ───
[morning-summary | 07:02 AM, 8h ago]: Briefed on partly cloudy weather (29°C),
  SingPass integration due Q2, team offsite this Friday. Three tasks suggested.
[09:15 AM] User: Can you add the API design task to my goals?
[09:17 AM] Assistant: Added "Complete API design doc" to your active goals.
[09:45 AM] User: What else should I focus on?

─── Tuesday, 19 February 2026 ───
[smart-checkin | 10:30 AM, 2h ago]: Checked in — SingPass deadline approaching
  (6 weeks), 3 hours since last message. Suggested focusing on API design.
[12:33 PM] User: Good point, let me start the API doc now.
```

This format gives Claude:
- **Date headers** — day boundaries visible, no ambiguity across multi-day windows
- **Absolute time** — `[07:02 AM]` for precise reference ("what did you say at 7am?")
- **Relative time** — `8h ago` lets Claude judge information currency automatically
- **Routine staleness** — a routine tagged `8h ago` signals its data (weather, costs) may be outdated without Claude needing to reason about calendar math
- **Routine label** — `[morning-summary | ...]` vs `[smart-checkin | ...]` vs `[User]` makes the conversational structure clear

The summary slot is compact (~30-60 tokens vs 500+ for a full morning briefing), leaving room for all 20 verbatim slots.

**`metadata.sentAt` must be the authoritative timestamp** (ISO string, stored at insert time in `sendAndRecord()`). `sentAtFormatted` is removed — all formatting happens dynamically in `formatMessage()` using `msg.created_at` (from Supabase) so regular messages and routine messages use the same rendering path.

**Full content retrieval paths** (user can always get the full briefing):
- **Semantic search**: Full content is embedded — "what did my morning briefing say about weather?" retrieves the full message
- **`/summary` command**: Lists all routine messages sent today with their summaries + timestamp
- **Explicit recall**: User asks "what was in my morning briefing?" → semantic search retrieves full content and Claude quotes it
- **Label in window**: `[morning-summary @ 07:02]` signals to user (and Claude) that more detail is available on request

**Routines to update** (replace `sendToGroup()` with `sendAndRecord()`):

| File | `routineName` | `agentId` |
|------|--------------|-----------|
| `routines/smart-checkin.ts` | `'smart-checkin'` | `'general-assistant'` |
| `routines/enhanced-morning-summary.ts` | `'morning-summary'` | `'general-assistant'` |
| `routines/night-summary.ts` | `'night-summary'` | `'general-assistant'` |
| `routines/aws-daily-cost.ts` | `'aws-daily-cost'` | `'aws-architect'` |
| `routines/security-daily-scan.ts` | `'security-daily-scan'` | `'security-analyst'` |
| `routines/weekly-etf.ts` | `'weekly-etf'` | `'general-assistant'` |

**Note on LLM-based routines**: Routines that use Claude to generate content (like `smart-checkin`) already produce the final message string before calling `sendToGroup()`. The switch to `sendAndRecord()` only changes the send call — generation logic is untouched.

---

### Phase 3: Long-Term Memory Extractor

**New File**: `src/memory/longTermExtractor.ts`

```typescript
/**
 * Long-term memory: automatic extraction of facts, preferences, goals, dates
 * from each conversation exchange. Runs async after response sent.
 */

interface ExtractedMemories {
  facts: string[];        // "User works as a Solution Architect at GovTech"
  preferences: string[];  // "Prefers concise responses with bullet points"
  goals: string[];        // "Launch SingPass integration by Q2 2026"
  dates: string[];        // "Team offsite on March 15"
}

// Main extraction function - call after each exchange
export async function extractAndStore(
  supabase: SupabaseClient,
  chatId: number,
  userId: number,
  userMessage: string,
  assistantResponse: string
): Promise<void>;

// Call Claude (small model) to extract memories from exchange
async function extractMemoriesFromExchange(
  userMessage: string,
  assistantResponse: string
): Promise<ExtractedMemories>;

// Store extracted items in memory table (deduplicated)
async function storeExtractedMemories(
  supabase: SupabaseClient,
  chatId: number,
  memories: ExtractedMemories
): Promise<void>;

// Rebuild profile summary from all stored facts
export async function rebuildProfileSummary(
  supabase: SupabaseClient,
  userId: number
): Promise<void>;

// Get full user profile for prompt injection
export async function getUserProfile(
  supabase: SupabaseClient,
  userId: number
): Promise<string>; // Returns formatted profile narrative
```

**Extraction prompt** (sent to Claude with small model like haiku):
```
Analyze this conversation exchange and extract any new information about the user.
Return JSON only:
{
  "facts": ["..."],        // Personal facts (name, age, location, job, family)
  "preferences": ["..."],  // How they prefer things (communication style, tools, methods)
  "goals": ["..."],        // Goals or projects they mentioned
  "dates": ["..."]         // Important dates or deadlines mentioned
}

Rules:
- Only extract NEW information about the USER (not Claude's statements)
- Omit empty arrays
- Be specific and concrete
- If nothing new, return {}

User: <userMessage>
Assistant: <assistantResponse>
```

**Deduplication**: Before storing, check semantic similarity against existing facts (> 0.9 cosine similarity = duplicate, skip).

---

### Phase 4: Prompt Builder Updates

**File**: `src/agents/promptBuilder.ts` — update `buildAgentPrompt()`

**New prompt structure**:
```
[Agent System Prompt]

═══ ABOUT YOU ═══
You are speaking with {userName}. Current time: {timeStr}

═══ USER PROFILE ═══
{userProfileSummary}      ← Always injected (long-term)

═══ CONVERSATION HISTORY ═══
[Older summaries]
  Summary (Feb 15-16): {summary1}
  Summary (Feb 17): {summary2}

[Recent messages verbatim]
  User: {msg1}
  Assistant: {response1}
  ...
  User: {msg20}
  Assistant: {response20}
                          ← Short-term rolling window

═══ RELEVANT CONTEXT ═══
{semanticSearchResults}   ← Semantic hits (supplementary)

═══ MEMORY MANAGEMENT ═══
{memoryInstructions}

{userMessage}             ← Current message
```

**Key changes**:
- Add `shortTermContext: string` parameter to `buildAgentPrompt()`
- Add `userProfile: string` parameter
- Remove duplicate `memoryContext` (facts/goals now in userProfile)
- Keep semantic search results as supplementary context

---

### Phase 5: Command Handlers

**File**: `src/commands/memoryCommands.ts`

#### `/memory` — Show current profile
```
📋 YOUR PROFILE

👤 Personal Facts:
  • Solution Architect at GovTech Singapore
  • Works on AWS infrastructure for government agencies

⚙️ Preferences:
  • Prefers TDD and systematic approaches
  • Likes concise responses with bullet points

🎯 Active Goals:
  • Launch SingPass API integration (Q2 2026)
  • Complete AWS CDK migration

📅 Important Dates:
  • Team offsite: March 15

💬 Conversation: 47 messages (2 summaries, 20 verbatim)
```

#### `/forget [topic]` — Delete memories
- If no topic: confirm before wiping all memories for chat
- If topic given: semantic search for matching facts, show list with inline keyboard
- Inline keyboard: [Forget this] [Keep] for each match
- Confirmation step before deletion

#### `/remember [fact]` — Explicit fact storage
- Parse message after `/remember`
- Detect category automatically (fact/preference/goal/date)
- Store in memory table with `extracted_from_exchange=false`
- Update profile summary
- Confirm: "✓ Remembered: {fact}"

#### `/summary` — Show conversation summary
```
📜 CONVERSATION SUMMARY

📅 Feb 15-16 (32 messages):
  Discussed AWS Lambda architecture for citizen feedback system.
  Decided on event-driven design with SQS. Action: create CDK stack.

📅 Feb 17 (20 messages):
  Reviewed security compliance requirements for PDPA.
  Identified 3 gaps in current architecture.

💬 Current session (12 messages, ongoing):
  Planning SingPass integration design...
```

**File**: Update `src/commands/index.ts` to register new handlers

---

### Phase 6: Integration in relay.ts

**File**: `src/relay.ts` — update `handleTextMessage()` and similar handlers

**Changes**:

```typescript
// BEFORE CLAUDE CALL: Load all context in parallel
const [shortTermCtx, userProfile, semanticCtx] = await Promise.all([
  getShortTermContext(supabase, chatId),
  getUserProfile(supabase, userId),
  getRelevantContext(supabase, text, chatId),
]);

// BUILD PROMPT with new context
const tz = process.env.USER_TIMEZONE || "Asia/Singapore";
const prompt = buildAgentPrompt(agent, text, {
  shortTermContext: formatShortTermContext(shortTermCtx, tz), // tz required for timestamps
  userProfile,
  relevantContext: semanticCtx,
  userName,
  timeStr,
});

// AFTER RESPONSE SENT: async extraction (non-blocking)
setImmediate(async () => {
  try {
    await extractAndStore(supabase, chatId, userId, text, cleanedResponse);
    if (await shouldSummarize(supabase, chatId)) {
      await summarizeOldMessages(supabase, chatId);
    }
    await rebuildProfileSummary(supabase, userId);
  } catch (err) {
    console.error('Async memory extraction failed:', err);
  }
});
```

---

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `db/migrations/001_chat_memory.sql` | **CREATE** | Add conversation_summaries + user_profile tables |
| `src/memory/shortTermMemory.ts` | **CREATE** | Rolling window + summarization logic |
| `src/memory/longTermExtractor.ts` | **CREATE** | Auto-extraction of facts/preferences/goals/dates |
| `src/memory/index.ts` | **CREATE** | Barrel export for memory modules |
| `src/agents/promptBuilder.ts` | **MODIFY** | Add shortTermContext + userProfile parameters |
| `src/commands/memoryCommands.ts` | **CREATE** | `/memory`, `/forget`, `/remember`, `/summary` handlers |
| `src/commands/index.ts` | **MODIFY** | Register new command handlers |
| `src/relay.ts` | **MODIFY** | Wire up context loading + async extraction |
| `src/memory.ts` | **MODIFY** | Update `getMemoryContext()` to use chat_id scoping |
| `supabase/functions/embed/index.ts` | **MODIFY** | Handle `conversation_summaries` table |
| **`src/utils/routineMessage.ts`** | **CREATE** | `sendAndRecord()` — send to Telegram + save to Supabase as `role: 'assistant'` |
| **`routines/smart-checkin.ts`** | **MODIFY** | Replace `sendToGroup()` with `sendAndRecord()` |
| **`routines/enhanced-morning-summary.ts`** | **MODIFY** | Replace `sendToGroup()` with `sendAndRecord()` |
| **`routines/night-summary.ts`** | **MODIFY** | Replace `sendToGroup()` with `sendAndRecord()` |
| **`routines/aws-daily-cost.ts`** | **MODIFY** | Replace `sendToGroup()` with `sendAndRecord()` |
| **`routines/security-daily-scan.ts`** | **MODIFY** | Replace `sendToGroup()` with `sendAndRecord()` |
| **`routines/weekly-etf.ts`** | **MODIFY** | Replace `sendToGroup()` with `sendAndRecord()` |

---

## End-to-End Telegram Testing Steps

### Pre-Test Setup
1. Ensure bot is running: `npx pm2 restart relay` or `bun run start`
2. Open Telegram and find your bot
3. Check Supabase dashboard is accessible for verification

---

### Test 1: Short-Term Memory — Conversation History

**Objective**: Verify bot remembers recent messages in current conversation.

**Steps**:
1. Send: "My name is [YourName] and I'm working on a SingPass integration project"
2. ✅ Bot responds (first message, no prior context)
3. Send: "What project did I mention just now?"
4. ✅ **Expected**: Bot says "You mentioned you're working on a SingPass integration project"
5. ❌ **Failure**: Bot says "I don't know" or asks for clarification

**Verify in Supabase**:
- Check `messages` table has 2 rows with `chat_id` = your chat ID

---

### Test 2: Rolling Window — 20+ Messages

**Objective**: Verify conversation history is maintained across 20+ messages.

**Steps**:
1. Send 22 consecutive short messages (e.g., "Message 1", "Message 2", ... "Message 22")
2. Wait for all responses
3. Send: "What was message number 3?"
4. ✅ **Expected**: Bot references message 3 (it's still in verbatim window of last 20 = msgs 3-22)
5. Send: "What was message number 1?"
6. ✅ **Expected**: Bot either recalls from summary OR says it was summarized
7. Run `/summary` command
8. ✅ **Expected**: Shows 1 summary entry + recent messages

**Verify in Supabase**:
- `conversation_summaries` has 1 row for this chat_id
- `messages` table has all 22+ messages stored

---

### Test 3: Long-Term Memory — Fact Extraction

**Objective**: Verify facts are automatically extracted and stored.

**Steps**:
1. Send: "I work as a Solution Architect at GovTech, mainly doing AWS infrastructure"
2. ✅ Bot responds naturally
3. Wait ~3 seconds (async extraction runs)
4. Send: "What do you know about my job?"
5. ✅ **Expected**: Bot mentions "Solution Architect at GovTech" and "AWS infrastructure"
6. Run `/memory` command
7. ✅ **Expected**: Profile shows "Solution Architect at GovTech Singapore" under Personal Facts

**Verify in Supabase**:
- `memory` table has new row with `type='fact'` and `extracted_from_exchange=true`
- `user_profile` table has updated `profile_summary`

---

### Test 4: Long-Term Memory — Preference Extraction

**Objective**: Verify communication preferences are remembered.

**Steps**:
1. Send: "Please always give me concise responses with bullet points, I hate long paragraphs"
2. ✅ Bot responds (likely acknowledges preference)
3. Wait ~3 seconds
4. Send: "Explain microservices to me"
5. ✅ **Expected**: Response uses bullet points and is concise (bot applied stored preference)
6. Run `/memory` command
7. ✅ **Expected**: Preferences section shows "Prefers concise bullet-point responses"

---

### Test 5: Long-Term Memory — Goals

**Objective**: Verify goals are tracked across conversations.

**Steps**:
1. Send: "I need to launch the SingPass API integration by Q2 2026"
2. ✅ Bot responds
3. Wait ~3 seconds
4. Start a NEW conversation the next day (close and reopen Telegram)
5. Send: "What are my current goals?"
6. ✅ **Expected**: Bot mentions "SingPass API integration by Q2 2026" (from long-term memory)

**Verify in Supabase**:
- `memory` table has `type='goal'` row with deadline
- OR `user_profile.raw_goals` contains the goal

---

### Test 6: Important Dates

**Objective**: Verify dates are captured and recalled.

**Steps**:
1. Send: "Don't forget my team offsite is on March 15"
2. ✅ Bot responds acknowledging
3. Wait ~3 seconds
4. Send: "When is my team offsite?"
5. ✅ **Expected**: Bot says "Your team offsite is on March 15"
6. Run `/memory` command
7. ✅ **Expected**: Important Dates shows "Team offsite: March 15"

---

### Test 6b: Timestamp Context — Claude Understands Temporal Ordering

**Objective**: Verify that timestamps enable Claude to reason about time correctly.

**Steps**:
1. Have a conversation now (e.g. "Let's plan the API design")
2. Wait until tomorrow (or manually set a test message timestamp to yesterday via Supabase SQL editor)
3. Send a new message: "Continuing from yesterday — what was the plan?"
4. ✅ **Expected**: The prompt contains a `─── [Yesterday's date] ───` separator, and Claude says "Yesterday we discussed X" — not "just now" or without time context
5. ✅ **Expected**: Claude correctly uses past tense for yesterday's messages

**Timestamp staleness test (routine)**:
1. Trigger morning briefing at 07:00
2. At 15:00 (8 hours later), send: "Is the weather forecast still accurate?"
3. ✅ **Expected**: Claude says something like "The weather was briefed 8 hours ago — it may have changed"
4. ✅ Claude sees `[morning-summary | 07:02 AM, 8h ago]` in the window and uses the relative time to reason about currency
5. ❌ **Failure**: Claude says "The weather is partly cloudy 29°C" as if the briefing is current

**Cross-timezone test**:
1. Ensure `USER_TIMEZONE=Asia/Singapore` in `.env`
2. Check that timestamps in the prompt show SGT times, not UTC
3. Send: "What time did you send the morning briefing?"
4. ✅ **Expected**: Claude answers with SGT time (e.g. "7:02 AM Singapore time"), not UTC

---

### Test 7: Routine Message — Storage and Summarization

**Objective**: Verify that a proactive routine message is stored verbatim in Supabase with a pre-computed summary in metadata.

**Steps**:
1. Trigger the smart check-in manually: `bun run routines/smart-checkin.ts`
   - If it decides not to check in (NO decision), temporarily edit the prompt to force YES
2. ✅ The check-in message appears in Telegram
3. **Immediately check Supabase** `messages` table:
   - ✅ New row with `role='assistant'`, `metadata.source='routine'`, `metadata.routine='smart-checkin'`
   - ✅ `content` = full check-in message (for semantic search)
   - ✅ `metadata.summary` = 2-3 sentence condensed version (for rolling window)
   - ✅ `metadata.sentAtFormatted` = formatted time (e.g. "09:30 AM")
4. ✅ **Expected**: `metadata.summary` is meaningfully shorter than `content` (not just truncation)
5. ❌ **Failure**: `metadata.summary` is missing or equals full content

---

### Test 7b: Routine Message in Rolling Window (Summary Injected)

**Objective**: Verify the summary (not full content) is injected into the rolling window prompt.

**Steps**:
1. After Test 7 (check-in sent and stored)
2. Reply to the check-in: "Yes, I'm available. What should I focus on today?"
3. ✅ **Expected**: Claude references the *gist* of the check-in (e.g., mentions the goals or context it cited)
4. ✅ **Expected**: The prompt sent to Claude contains `[smart-checkin @ HH:MM]: <summary>` — not the full check-in text
5. ❌ **Failure**: Claude says "I don't know what you're referring to" or prompt contains full 600-word briefing

**Check PM2 logs** for the formatted prompt section to verify:
```
Assistant [smart-checkin @ 09:30 AM]: Checked in — 2 upcoming goal deadlines,
  3 hours since last message, suggested a focus session on SingPass integration.
```
(~60 tokens vs ~500 for verbatim)

---

### Test 7c: Full Routine Content via Explicit Recall

**Objective**: Verify the full routine content is retrievable on demand via semantic search.

**Steps**:
1. After Test 7b, ask: "What exactly did you say in this morning's check-in? Give me the full message."
2. ✅ **Expected**: Claude retrieves and quotes the full check-in content (via semantic search on `messages` table)
3. ✅ **Not expected**: Claude makes up content or says it doesn't have details

---

### Test 7d: Morning Briefing — Summary in Window, Full via Recall

**Objective**: End-to-end test with the longest routine (morning briefing ~600 words).

**Steps**:
1. Trigger: `bun run routines/enhanced-morning-summary.ts`
2. ✅ Full briefing appears in Telegram (~600 words)
3. Check Supabase: `metadata.summary` should be 2-3 sentences summarizing key points
4. Reply: "Can you add one more item to my task list based on what you briefed me on?"
5. ✅ **Expected**: Claude references the briefing summary accurately (goals, suggested tasks)
6. Ask: "What was today's weather forecast in the briefing?"
7. ✅ **Expected**: Claude retrieves the exact weather from the full content via semantic search

---

### Test 7e: Multiple Routine Messages — Token Efficiency

**Objective**: Verify multiple routine messages don't crowd out conversation history.

**Steps**:
1. Trigger morning briefing + smart check-in (force YES) — 2 routine messages
2. Have a 15-message conversation about a topic
3. Check that **all 15 conversation messages + 2 routine summaries** appear in context (total < 20 verbatim slots)
4. ✅ **Expected**: Rolling window has `[morning-summary @ 07:02]: <summary>` + `[smart-checkin @ 09:30]: <summary>` + 15 conversation messages
5. ❌ **Failure (old behavior)**: Full 600-word briefing takes up most of the token budget, conversation messages crowded out

---

### Test 8: `/remember` Command — Explicit Fact Storage

**Objective**: Manually store a specific fact.

**Steps**:
1. Send: `/remember I prefer Singapore Standard Time (UTC+8) for all scheduling`
2. ✅ **Expected**: Bot responds "✓ Remembered: I prefer Singapore Standard Time (UTC+8) for all scheduling"
3. Run `/memory` command
4. ✅ **Expected**: Fact appears in profile with no delay

---

### Test 8: `/forget` Command — Delete Memories

**Objective**: Remove specific memories.

**Steps**:
1. First ensure you have at least 2-3 facts stored (from previous tests)
2. Send: `/forget SingPass`
3. ✅ **Expected**: Bot shows matching memories with [Forget this] / [Keep] buttons
4. Tap [Forget this]
5. ✅ **Expected**: Bot confirms "✓ Forgotten"
6. Send: "What are my current goals?"
7. ✅ **Expected**: SingPass goal no longer mentioned

---

### Test 9: `/summary` Command

**Objective**: View compressed conversation history.

**Steps**:
1. After running Tests 1-8 (should have many messages)
2. Send: `/summary`
3. ✅ **Expected**: Shows 1+ summaries with date ranges + message counts
4. Summaries should mention topics discussed (SingPass, GovTech, offsite, etc.)

---

### Test 10: Cross-Session Memory Persistence

**Objective**: Verify long-term memory survives bot restart.

**Steps**:
1. After Tests 1-9, run: `npx pm2 restart relay`
2. Wait 5 seconds
3. Send: "What do you know about me?"
4. ✅ **Expected**: Bot recalls facts from earlier in the day (Solution Architect, GovTech, etc.)
5. ✅ **Profile + Supabase data persists across restarts** (unlike in-memory session)

---

### Test 11: `/memory` Command — Full Profile View

**Objective**: Comprehensive profile view.

**Steps**:
1. Send: `/memory`
2. ✅ **Expected output structure**:
   ```
   📋 YOUR PROFILE

   👤 Personal Facts:
     • [Facts from tests]

   ⚙️ Preferences:
     • Concise bullet-point responses
     • Singapore Standard Time

   🎯 Active Goals:
     • [Goals from tests]

   📅 Important Dates:
     • Team offsite: March 15

   💬 Conversation: X messages (Y summaries)
   ```

---

### Test 12: Profile + Semantic Search Together

**Objective**: Verify both memory types work together.

**Steps**:
1. In a fresh part of conversation, mention a very specific detail: "My AWS account number is 123456789012 for the dev environment"
2. ✅ Bot responds
3. Wait ~3 seconds
4. Send: "What's my AWS dev account number?"
5. ✅ **Expected**: Bot recalls "123456789012" — either from conversation history (if < 20 msgs ago) OR from semantic search (if older)

---

## Implementation Checklist

### Phase 1: Schema
- [ ] Create `db/migrations/001_chat_memory.sql`
- [ ] Apply migration via Supabase MCP or SQL editor
- [ ] Update embed Edge Function webhook to include `conversation_summaries`

### Phase 2: Short-Term Memory
- [ ] Create `src/memory/shortTermMemory.ts`
- [ ] Implement `getRecentMessages()`
- [ ] Implement `getConversationSummaries()`
- [ ] Implement `shouldSummarize()`
- [ ] Implement `summarizeOldMessages()` — calls Claude haiku
- [ ] Implement `relativeTime(isoStr, tz)` — "just now" / "3h ago" / "yesterday" / "N days ago"
- [ ] Implement `formatDateHeader(isoStr, tz)` — "Monday, 18 February 2026"
- [ ] Implement `formatMessage(msg, tz)`:
  - Routine messages → `[routine-name | HH:MM, Xh ago]: <summary>`
  - Regular messages → `[HH:MM] User/Assistant: <content>`
- [ ] Implement `formatShortTermContext(ctx, tz)`:
  - Date-boundary separator headers between messages from different days
  - Older summaries with `from_timestamp`–`to_timestamp` date range
  - `USER_TIMEZONE` passed from relay.ts
- [ ] Unit test: rolling window behavior
- [ ] Unit test: day boundary headers appear when messages span multiple days
- [ ] Unit test: relative time labels ("8h ago", "yesterday") computed correctly

### Phase 2.5: Routine Message Storage
- [ ] Create `src/utils/routineMessage.ts` with `sendAndRecord()` function
  - [ ] `summarizeRoutineMessage()` — Ollama `gemma3:4b` via `OLLAMA_API_URL/api/generate`, 8s timeout, fallback to 300-char truncation
  - [ ] Store full content in `messages.content` (for embedding webhook)
  - [ ] Store summary + label in `messages.metadata.summary` (for window injection)
- [ ] Update `routines/smart-checkin.ts` — replace `sendToGroup()` with `sendAndRecord()`
- [ ] Update `routines/enhanced-morning-summary.ts`
- [ ] Update `routines/night-summary.ts`
- [ ] Update `routines/aws-daily-cost.ts`
- [ ] Update `routines/security-daily-scan.ts`
- [ ] Update `routines/weekly-etf.ts`
- [ ] Update `formatMessage()` in `shortTermMemory.ts` to use `metadata.summary` for routine messages
- [ ] Verify: Trigger routine manually → Supabase row has `role='assistant'`, `metadata.source='routine'`, `metadata.summary` populated
- [ ] Verify: Next user message prompt contains `[routine-name @ HH:MM]: <summary>` not full content

### Phase 3: Long-Term Extractor
- [ ] Create `src/memory/longTermExtractor.ts`
- [ ] Implement extraction prompt + JSON parsing
- [ ] Implement deduplication check (semantic similarity)
- [ ] Implement `storeExtractedMemories()`
- [ ] Implement `rebuildProfileSummary()`
- [ ] Implement `getUserProfile()`
- [ ] Unit test: extraction from sample exchanges

### Phase 4: Prompt Builder
- [ ] Update `buildAgentPrompt()` signature
- [ ] Add profile section to prompt template
- [ ] Add conversation history section
- [ ] Keep semantic search as supplementary section
- [ ] Test: prompt includes all context sections

### Phase 5: Commands
- [ ] Create `src/commands/memoryCommands.ts`
- [ ] Implement `/memory` handler
- [ ] Implement `/forget [topic]` with inline keyboard
- [ ] Implement `/remember [fact]` handler
- [ ] Implement `/summary` handler
- [ ] Register all handlers in `src/commands/index.ts`

### Phase 6: Integration
- [ ] Update `handleTextMessage()` in relay.ts
- [ ] Add parallel context loading (shortTermCtx + userProfile + semantic)
- [ ] Add async extraction after response sent
- [ ] Add async summarization check after extraction
- [ ] Test: full message flow with all memory components

### Phase 7: End-to-End Testing
- [ ] Test 1: Conversation history recall
- [ ] Test 2: Rolling window (20+ messages)
- [ ] Test 3: Fact extraction
- [ ] Test 4: Preference extraction
- [ ] Test 5: Goal tracking across sessions
- [ ] Test 6: Date tracking
- [ ] Test 7: Routine message in short-term memory (smart-checkin)
- [ ] Test 7b: Morning briefing context recall
- [ ] Test 7c: Multiple routine messages in window
- [ ] Test 8: `/remember` command
- [ ] Test 9: `/forget` command
- [ ] Test 10: `/summary` command
- [ ] Test 11: Cross-session persistence
- [ ] Test 12: Full `/memory` profile view
- [ ] Test 13: Profile + semantic search combined

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Extraction cost (Claude haiku per message) | API costs | Use smallest model (haiku); cache profile for 5 min |
| Latency (extraction adds delay) | UX | Run extraction async AFTER sending response |
| Duplicate facts | Profile clutter | Semantic deduplication before storage |
| Summarization loses context | Memory quality | Keep original messages; summarize only for prompt injection |
| Large profile bloats prompt | Cost/quality | Cap profile summary at ~500 tokens; refresh periodically |
| Extraction hallucination | Wrong facts | Use structured JSON output with strict prompt |
| Timestamps shown in wrong timezone | Confusing to user and Claude | All timestamp formatting uses `USER_TIMEZONE` env var; no UTC leakage |
| Routine data treated as current | Claude gives stale weather/costs as fact | Relative time label ("8h ago") in window header prompts Claude to caveat time-sensitive data |
| Routine summary inaccurate | Wrong context injected | Fallback: if Ollama fails or returns empty, truncate to 300 chars; full content always in semantic search |
| Ollama not running when routine fires | Summary skips, truncation used | Graceful fallback to 300-char truncation; PM2 watchdog keeps Ollama available |
| Routine messages crowd window | Token budget exceeded | Routine messages inject only summary (~60 tokens each) not full content; 20-message slot count unchanged |
| User confused by summary label | Poor UX | `/summary` command and explicit recall ("what was in my briefing?") always available for full content |

---

## Technical Notes

### Model Usage
- **Main responses**: `claude` (default configured model)
- **Extraction**: `claude-haiku-4-5-20251001` (cheapest, fastest for JSON extraction)
- **Conversation summarization** (old messages → compressed summary): `claude-haiku-4-5-20251001`
- **Routine message summarization** (morning briefing → 2-3 sentence window entry): **Ollama `gemma3:4b`** — local, free, no API cost, ~1-2s. Uses `CONTEXT_RELEVANCE_MODEL` or `FALLBACK_MODEL` env var. Falls back to 300-char truncation if Ollama is down.

### Performance Budget
- Context loading: < 200ms (Supabase queries)
- Extraction: ~ 1-2s (async, invisible to user)
- Summarization: ~ 2-5s (async, invisible to user)
- Profile rebuild: ~ 1-2s (async, invisible to user)

### Token Budget per Message
| Section | Max Tokens |
|---------|-----------|
| Agent system prompt | ~500 |
| User profile summary | ~400 |
| Conversation history (20 msgs) | ~2000 |
| Summaries (2-3 entries) | ~600 |
| Semantic search results | ~800 |
| Current message | variable |
| **Total context** | **~4300** |

This leaves ample room for Claude's response within 32k context limit.
