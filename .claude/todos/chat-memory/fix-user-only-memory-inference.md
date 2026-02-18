# Fix: User-Only Memory Inference with Confirmation for Uncertain Items

**Branch:** `optimise_botcommands`
**Date:** 2026-02-19
**Goal:** Ensure automatic memory extraction only uses USER messages as input, and asks the user to confirm uncertain memory candidates before storing them.

---

## Problem

### Bug 1: Assistant response passed to memory extraction
In `relay.ts:536`, `extractAndStore()` receives both the user message AND the assistant response:
```typescript
await extractAndStore(supabase, chatId, userId, text, response || rawResponse);
```
In `longTermExtractor.ts:90-91`, both are fed into the extraction LLM:
```typescript
`User: ${userMessage.slice(0, 1000)}\n` +
`Assistant: ${assistantResponse.slice(0, 500)}`
```
Even though the prompt says "only extract USER-shared info", passing the assistant response risks cross-contamination from what Claude said.

### Bug 2: No confirmation for uncertain memory candidates
All extracted items are stored with hardcoded `confidence: 0.9` regardless of how explicitly the user stated them. Implied or ambiguous information is auto-stored without user awareness.

### Bug 3: Routine responses potentially leaking (verified: non-issue)
`extractAndStore` is only called in `processTextMessage()` (triggered by user messages), so routine outputs do NOT trigger extraction. However, the assistant response passed to extraction could include routine-formatted text.

---

## Solution

### Change 1: Remove `assistantResponse` from extraction pipeline

**File:** `src/memory/longTermExtractor.ts`

1. Remove `assistantResponse` parameter from `extractMemoriesFromExchange()`
2. Remove `assistantResponse` parameter from `extractAndStore()`
3. Update the extraction prompt to only use `userMessage`
4. Update prompt to classify extracted items as `certain` vs `uncertain`
5. Return `{ certain, uncertain }` from `extractMemoriesFromExchange()`
6. In `extractAndStore()`: store `certain` items immediately, return `uncertain` items to caller

### Change 2: Add memory confirmation flow

**New file:** `src/memory/memoryConfirm.ts`

- `setPendingConfirmation(chatId, memories)` — store uncertain items awaiting confirmation
- `hasPendingConfirmation(chatId)` — check if chat has pending confirmations
- `clearPendingConfirmation(chatId)` — remove pending state
- `buildMemoryConfirmMessage(memories)` — format human-readable confirmation message
- `buildMemoryConfirmKeyboard(chatId)` — inline keyboard with [Save] [Skip] buttons
- `handleMemoryConfirmCallback(data, supabase, chatId)` — handle save/skip action
- `registerMemoryConfirmHandler(bot, supabase)` — register bot callback handler

### Change 3: Wire up in relay.ts

**File:** `src/relay.ts`

1. Update `extractAndStore` call at line 536: remove `response || rawResponse` argument
2. After extraction, if `uncertain` items exist, send confirmation message via bot
3. Call `registerMemoryConfirmHandler(bot, supabase)` at startup

### Change 4: Update barrel export

**File:** `src/memory/index.ts`

Export new functions from `memoryConfirm.ts`.

---

## New Extraction Prompt (certain/uncertain)

```
Analyze this user message and extract information about the user.
Return ONLY valid JSON (no markdown, no explanation):
{
  "certain": {
    "facts": ["explicitly stated personal facts: name, age, location, job, family"],
    "preferences": ["clearly stated preferences: tools, style, communication"],
    "goals": ["clearly stated goals or projects"],
    "dates": ["explicitly mentioned important dates or deadlines"]
  },
  "uncertain": {
    "facts": ["implied or ambiguous facts that might need confirmation"],
    "preferences": ["possibly implied preferences"],
    "goals": ["possibly mentioned goals or interests"],
    "dates": ["possibly relevant dates"]
  }
}

Rules:
- ONLY analyze what the USER wrote in this message
- "certain" = user explicitly and directly stated this fact
- "uncertain" = implied, ambiguous, or could be interpreted multiple ways
- Omit keys with empty arrays
- Be specific and concrete (not vague)
- If nothing to extract, return {}

User message: ${userMessage.slice(0, 1000)}
```

---

## Confirmation UX

When uncertain items are found, the bot sends:

```
I noticed a few things you might want me to remember:

• [item 1]
• [item 2]

Save these?
```

With inline keyboard:
```
[✓ Save all]  [✗ Skip all]
```

Callback data format: `memconf:save:{chatId}` or `memconf:skip:{chatId}`

---

## Files to Change

| File | Type | Description |
|------|------|-------------|
| `src/memory/longTermExtractor.ts` | MODIFY | Remove assistantResponse, add certain/uncertain split |
| `src/memory/memoryConfirm.ts` | CREATE | Confirmation state + keyboard + callback handler |
| `src/memory/index.ts` | MODIFY | Export new memoryConfirm functions |
| `src/relay.ts` | MODIFY | Update extractAndStore call, register confirm handler |

---

## Tests to Write

### Unit tests: `src/memory/longTermExtractor.test.ts` (UPDATE)
- Update existing tests that pass 2 args to `extractMemoriesFromExchange` → 1 arg
- Update return type checks (`.facts` → `.certain.facts`)
- New: verify assistant response NOT in extraction prompt
- New: extraction returns `{ certain, uncertain }` structure
- New: `extractAndStore` returns `uncertain` items, only stores `certain` items

### Unit tests: `src/memory/memoryConfirm.test.ts` (CREATE)
- `buildMemoryConfirmMessage` formats items correctly
- `buildMemoryConfirmMessage` returns empty string for empty memories
- `buildMemoryConfirmKeyboard` has save + skip buttons
- `handleMemoryConfirmCallback` stores items on "save"
- `handleMemoryConfirmCallback` skips storage on "skip"
- `handleMemoryConfirmCallback` returns "unknown" for non-matching data
- Pending state management: set, has, clear

### E2E test: `src/memory/memoryInference.e2e.test.ts` (CREATE)
- Full flow: user message → extraction → confirmation sent
- User clicks Save → uncertain items stored
- User clicks Skip → uncertain items NOT stored
- Assistant response NOT passed to Ollama extraction prompt
- No confirmation sent when only certain items exist

---

## Implementation Order

1. `src/memory/longTermExtractor.ts` — core logic change
2. `src/memory/memoryConfirm.ts` — new confirmation module
3. `src/memory/index.ts` — export updates
4. `src/relay.ts` — wire up changes
5. Update tests in `longTermExtractor.test.ts`
6. New tests in `memoryConfirm.test.ts`
7. New e2e tests in `memoryInference.e2e.test.ts`
8. Run all tests to verify
