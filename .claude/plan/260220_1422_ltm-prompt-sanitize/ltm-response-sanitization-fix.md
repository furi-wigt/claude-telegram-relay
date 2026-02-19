# Plan: LTM Response Sanitization Fix (Option C)

**Date:** 2026-02-20
**Branch:** memorisation
**Priority:** High
**Working Directory:** /Users/furi/Documents/WorkInGovTech/01_Projects/Tools/claude-telegram-relay

---

## Problem

`extractMemoriesFromExchange()` in `longTermExtractor.ts` line 124 truncates the assistant response at **800 chars**:

```typescript
const exchangeText = assistantResponse
  ? `User: ${userMessage.slice(0, 1000)}\nAssistant: ${assistantResponse.slice(0, 800)}`
  : `User: ${userMessage.slice(0, 1000)}`;
```

When a long technical response (e.g. 3,386 chars) is truncated mid-sentence, the cut point can land inside injected prompt sections (e.g. `"You are speaking with {userName}"`), causing the LLM to misinterpret template text as user facts.

**Observed hallucination from logs (traceId: b16efefd):**
- Assistant response: 3,386 chars → truncated to 800 → cut point landed inside `"You are speaking with {userName}"`
- Ollama extracted: `{"facts": ["The user's name is userName"]}`
- Stored to DB → now polluting USER PROFILE

---

## Root Cause

Two compounding issues:

1. **Truncation limit (800 chars) is too small** for detailed technical responses — common in code-review conversations
2. **No sanitization** — injected prompt sections (USER PROFILE, CONVERSATION HISTORY separators, MEMORY MANAGEMENT text) can bleed into the assistant response string when responses echo or reference system context

---

## Fix

**File to modify:**
`/Users/furi/Documents/WorkInGovTech/01_Projects/Tools/claude-telegram-relay/src/memory/longTermExtractor.ts`

### Change 1: Sanitize assistant response before slicing (line 123–125)

Replace:
```typescript
const exchangeText = assistantResponse
  ? `User: ${userMessage.slice(0, 1000)}\nAssistant: ${assistantResponse.slice(0, 800)}`
  : `User: ${userMessage.slice(0, 1000)}`;
```

With:
```typescript
function sanitizeAssistantResponse(response: string): string {
  // Strip injected prompt section markers that can bleed in
  return response
    .replace(/═══.*?═══/gs, '')          // strip section headers (USER PROFILE, CONVERSATION HISTORY, etc.)
    .replace(/MEMORY MANAGEMENT:[\s\S]*/m, '')  // strip memory management instructions
    .replace(/\[REMEMBER:.*?\]/gi, '')    // strip any REMEMBER tags in response
    .replace(/\[GOAL:.*?\]/gi, '')        // strip GOAL tags
    .replace(/\[DONE:.*?\]/gi, '')        // strip DONE tags
    .trim();
}

const MAX_USER_CHARS = 1000;
const MAX_ASSISTANT_CHARS = 2000;   // increased from 800

const cleanedResponse = assistantResponse
  ? sanitizeAssistantResponse(assistantResponse).slice(0, MAX_ASSISTANT_CHARS)
  : undefined;

const exchangeText = cleanedResponse
  ? `User: ${userMessage.slice(0, MAX_USER_CHARS)}\nAssistant: ${cleanedResponse}`
  : `User: ${userMessage.slice(0, MAX_USER_CHARS)}`;
```

### Change 2: Strengthen the extraction prompt rules (line 145–151)

Add rule to explicitly exclude template text:
```typescript
`- Do NOT treat template placeholders like "{userName}", "{timeStr}", or section markers as user facts\n` +
```

---

## Files to Modify

| File | Absolute Path | Change |
|---|---|---|
| `longTermExtractor.ts` | `/Users/furi/Documents/WorkInGovTech/01_Projects/Tools/claude-telegram-relay/src/memory/longTermExtractor.ts` | Add `sanitizeAssistantResponse()`, increase truncation to 2000 chars, add prompt rule |

---

## Cleanup Required

Delete the hallucinated fact from the `memory` table:
```sql
DELETE FROM memory WHERE content = 'The user''s name is userName';
```

---

## Testing

**Unit tests** (`src/memory/longTermExtractor.test.ts`):
1. `sanitizeAssistantResponse()` strips `═══ ... ═══` markers
2. `sanitizeAssistantResponse()` strips `MEMORY MANAGEMENT:` block
3. `sanitizeAssistantResponse()` strips `[REMEMBER: ...]` tags
4. Long response (3000+ chars) is truncated to exactly 2000 after sanitization
5. Empty/null response handled gracefully

**Integration tests:**
1. Send a message that generates a long assistant response containing `{userName}` — verify no hallucination stored
2. Send a message with MEMORY MANAGEMENT text echoed in response — verify stripped before extraction

---

## Expected Outcome

- No more hallucinated facts from template text bleeding into extraction
- LTM extraction works correctly for responses up to 2000 chars
- Does NOT fix the case where Claude CLI is unavailable and Ollama handles extraction (addressed in Plan B)

---

## Risk

Low. Sanitization is a pure string transformation with no side effects. Worst case: a fact from a response near the 2000-char boundary is excluded. Acceptable trade-off vs. hallucination.
