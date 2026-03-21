# Plan: Night Summary — Full Day History

**Branch:** `feat/night-summary-full-day-history`
**Date:** 2026-02-25
**Goal:** Night summary should reflect the entire day (~200 messages across all groups), not just the last 30 messages.

---

## Problem

`buildReflectionPrompt()` applies two hard caps:
1. `.slice(-30)` — drops everything except the last 30 messages
2. `.substring(0, 150)` — truncates each message to 150 characters

`getTodaysMessages()` already fetches **all** of today's messages with no DB LIMIT.
The data exists; it is thrown away before reaching the LLM.

Additionally:
- Today's `conversation_summaries` are never consulted
- Messages have no group attribution (`agent_id` not selected)
- All 5 groups' messages are fetched but indistinguishable

---

## Constraints & Scale

- ~200 messages/day across 5 groups
- Claude Haiku 4.5 context: 200K tokens
- Target history section: ≤ 10K tokens (safe margin)
- 10 summaries × 300 chars + 60 verbatim msgs × 500 chars ≈ 8K tokens ✅

---

## Solution: Two-Tier Day Timeline

```
┌─────────────────────────────────────────────────────────────┐
│              TODAY'S CONVERSATIONS                          │
│                                                             │
│  TIER 1: SUMMARIES  (generated during the day by          │
│           shortTermMemory.summarizeOldMessages)            │
│  ─ Covers morning/afternoon when conversations were active │
│  ─ Fetched from conversation_summaries                     │
│  ─ to_timestamp >= startOfToday()                          │
│                                                             │
│  TIER 2: RECENT VERBATIM (last 60 messages)               │
│  ─ Full content (500 char cap, up from 150)                │
│  ─ Tagged with agent group (via agent_id)                  │
│  ─ No arbitrary 30-message cap                             │
└─────────────────────────────────────────────────────────────┘
```

**Prompt output structure:**
```
## Today's Conversations (all groups)

### Earlier Today — Summarised
[09:15–10:30 | General]: Discussed relay bot architecture...
[11:00–12:30 | Security]: Reviewed IM8 compliance findings...

### Recent Conversations
─── Wednesday, 25 February 2026 ───
[14:22] User (aws-architect): What are the EC2 cost optimisation options?
[14:24] Assistant (aws-architect): Here are three approaches...
...
```

---

## Checklist

- [ ] Add `DaySummary` type (exported for tests)
- [ ] Add `agent_id?: string | null` to `DayMessage`
- [ ] Add `buildDayTimeline(messages, summaries)` — pure, exported, testable
- [ ] Update `buildReflectionPrompt` — add optional `summaries` 5th param, use `buildDayTimeline`
- [ ] Add `getTodaysConversationSummaries()` — fetches all groups, no chat_id filter
- [ ] Update `getTodaysMessages()` — include `agent_id` in select
- [ ] Update `buildSummary()` — fetch summaries, pass to `analyzeDay` → `buildReflectionPrompt`
- [ ] Update existing test that asserts 30-message truncation (behavior changed)
- [ ] Add new unit tests for `buildDayTimeline` and summaries in `buildReflectionPrompt`
- [ ] All tests pass

---

## Data Model

### New type: DaySummary
```typescript
export interface DaySummary {
  summary: string;
  message_count: number;
  from_timestamp: string | null;
  to_timestamp: string | null;
  chat_id?: number | null;
}
```

### Extended DayMessage
```typescript
export interface DayMessage {
  content: string;
  role: "user" | "assistant";
  created_at: string;
  agent_id?: string | null;   // ← NEW: "general-assistant", "aws-architect", etc.
}
```

---

## Function Signatures

```typescript
// NEW — pure, exported for tests
export function buildDayTimeline(
  messages: DayMessage[],
  summaries: DaySummary[]
): string

// UPDATED — summaries is optional 5th param (backward-compatible)
export function buildReflectionPrompt(
  messages: DayMessage[],
  facts: DayFact[],
  goals: DayGoal[],
  userName?: string,
  summaries?: DaySummary[]      // ← NEW
): string

// NEW fetcher
async function getTodaysConversationSummaries(): Promise<DaySummary[]>
```

---

## TDD Tests (write BEFORE implementation)

### Tests to ADD (new behavior)
1. `buildDayTimeline` — with summaries, shows "Earlier Today" section
2. `buildDayTimeline` — with summaries, includes summary text
3. `buildDayTimeline` — with summaries, formats timestamp range (HH:mm–HH:mm)
4. `buildDayTimeline` — no summaries, includes all messages (not just 30)
5. `buildDayTimeline` — includes agent_id label in message line
6. `buildDayTimeline` — shows "No conversations today" for empty inputs
7. `buildReflectionPrompt` — with summaries param, includes summary content
8. `buildReflectionPrompt` — with summaries param, uses timeline structure

### Tests to UPDATE (behavior change)
- Old: "truncates to last 30 messages when more are provided"
- New: "includes all messages when no summaries (no arbitrary cap)"

---

## Backward Compatibility

- `buildReflectionPrompt(msgs, facts, goals)` — still works (summaries defaults to [])
- `buildReflectionPrompt(msgs, facts, goals, name)` — still works
- All existing tests still pass (only the truncation test needs updating)
- `getTodaysMessages` — adding `agent_id` to select is additive, callers still work

---

## Rollout

No DB schema changes needed. `conversation_summaries` and `agent_id` already exist.
Deploy: `pm2 restart night-summary`
