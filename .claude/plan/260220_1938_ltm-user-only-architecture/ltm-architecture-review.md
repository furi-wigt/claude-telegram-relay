# Plan: LTM Architecture Review — User-Only vs Assistant-Included Extraction

**Date:** 2026-02-20 19:38 SGT
**Branch:** refactor/unified-claude-process
**File:** `src/memory/longTermExtractor.ts`
**Working Directory:** /Users/furi/Documents/WorkInGovTech/01_Projects/Tools/claude-telegram-relay

---

## Debate Outcome

The debate was: "Should assistant response be included in LTM extraction?"

**Verdict: Code review invalidates the premise of the debate.**

The current code already implements a more sophisticated solution than either position in the debate assumed.

---

## What the Code Actually Does (As of This Audit)

### Already implemented ✅

| Fix | Location | Code |
|---|---|---|
| Strip `{placeholder}` template variables | `longTermExtractor.ts:37-39` | `_filterPlaceholders()` exported, tested |
| XML section attribution | `longTermExtractor.ts:183-187` | `<user_turn>`, `<assistant_turn>`, `<known_context>` tags |
| Prompt rule: ignore `{placeholder}` | `longTermExtractor.ts:196` | `"Ignore {placeholder} text..."` |
| Prompt rule: assistant_turn ≠ user facts | `longTermExtractor.ts:195` | `"do NOT treat it as new user facts"` |
| Prompt rule: don't re-extract known context | `longTermExtractor.ts:194` | `"<known_context> is previously retrieved system data"` |
| Pass known system context to extractor | `relay.ts:441-445` | `ltmInjectedContext = [userProfile, memoryContext, relevantContext, profileContext]` |
| Prevent CLAUDE.md loading for extraction | `longTermExtractor.ts:235` | `cwd: tmpdir()` |
| Skip extraction on memory-query turns | `longTermExtractor.ts:163-165` | `_isMemoryQuery()` |

### Critical sequencing finding ✅

**`processMemoryIntents()` (line 423) runs BEFORE `enqueueExtraction()` (line 445).**

This means:
- `[REMEMBER: fact]` tags are processed and stored FIRST
- Tags are stripped from `assistantText` by `processMemoryIntents()`
- `enqueueExtraction()` receives the tag-free response
- **The "Position D" architecture is already implemented**: `[REMEMBER:]` IS the explicit assistant channel, and LLM extraction never sees those tags

```
relay.ts execution order:
  1. rawResponse = Claude output (with [REMEMBER:] tags)
  2. response = processMemoryIntents(rawResponse)  ← [REMEMBER:] tags stored + stripped
  3. assistantText = response                       ← clean, tag-free
  4. enqueueExtraction({ assistantResponse: assistantText })  ← extraction sees tag-free text
  5. extractAndStore(userMessage, assistantText)    ← LTM LLM extraction
```

---

## What Still Needs Fixing

### Issue 1: 800-char truncation corrupts XML structure [HIGH]

**Location:** `longTermExtractor.ts:171`

```typescript
// CURRENT — BROKEN
const cleanAssistant = assistantResponse
  ? filterPlaceholders(assistantResponse.slice(0, 800))
  : undefined;
```

The truncation happens BEFORE XML wrapping. The exchange section is built at lines 185-187:
```typescript
`<exchange>\n<user_turn>\n${cleanUser}\n</user_turn>\n<assistant_turn>\n${cleanAssistant}\n</assistant_turn>\n</exchange>`
```

A 3,386-char response truncated at 800 chars produces a valid `<assistant_turn>` block — the XML is NOT corrupted by this. The risk is **semantic truncation** (content cut mid-sentence), not XML malformation.

However, 800 chars for a technical response is still too short. At 800 chars, a detailed code analysis response is cut before covering the main points, reducing signal-to-noise for extraction.

**Fix:** Increase truncation to 2000 chars. Since `<known_context>` already covers system-injected profile data, and `<assistant_turn>` tells the LLM not to extract from it, the hallucination risk of longer context is low.

```typescript
// FIXED
const MAX_ASSISTANT_CHARS = 2000;
const cleanAssistant = assistantResponse
  ? filterPlaceholders(assistantResponse.slice(0, MAX_ASSISTANT_CHARS))
  : undefined;
```

### Issue 2: Claude fallback catch block swallows errors [HIGH]

**Location:** `longTermExtractor.ts:237-240`

```typescript
// CURRENT — SILENT FAILURE
} catch {
  // Fallback to local Ollama when Claude CLI is unavailable
  raw = await callOllamaGenerate(prompt, { timeoutMs: 30_000 });
  provider = "ollama";
}
```

No error logged. 6/8 LTM calls fall back to Ollama with zero observability. Root cause (nested session detection) is invisible.

**Fix:**
```typescript
// FIXED
} catch (claudeErr) {
  trace({
    event: "ltm_claude_fallback",
    traceId: traceId ?? "no-trace",
    chatId: chatId ?? 0,
    error: claudeErr instanceof Error ? claudeErr.message : String(claudeErr),
  });
  raw = await callOllamaGenerate(prompt, { timeoutMs: 30_000 });
  provider = "ollama";
}
```

### Issue 3: Hallucinated fact still in DB [MEDIUM]

```sql
DELETE FROM memory WHERE content = 'The user''s name is userName';
```

Run via Supabase MCP or dashboard SQL editor. The `_filterPlaceholders()` fix prevents recurrence, but the existing entry needs manual removal.

---

## Architecture Decision: Keep Assistant Response in Extraction

**Decision: Keep `assistantResponse` as input to LTM extraction.**

Rationale:
1. The XML attribution (`<assistant_turn>`) + prompt rule already tell the LLM not to extract from it
2. `processMemoryIntents()` already strips `[REMEMBER:]` tags before extraction sees the text
3. Assistant turn provides useful disambiguating context (e.g., normalizes "sg timezone" → "Asia/Singapore")
4. Removing it would be a regression — the XML framing makes it safe to include

**The architecture is already correct. Only the truncation limit and error logging need fixing.**

---

## Implementation Plan

Two minimal changes to `src/memory/longTermExtractor.ts`:

### Change 1: Increase assistant truncation (line 171)

```typescript
// Before
const cleanAssistant = assistantResponse
  ? filterPlaceholders(assistantResponse.slice(0, 800))
  : undefined;

// After
const MAX_ASSISTANT_CHARS = 2000;
const cleanAssistant = assistantResponse
  ? filterPlaceholders(assistantResponse.slice(0, MAX_ASSISTANT_CHARS))
  : undefined;
```

### Change 2: Log Claude fallback error (lines 237-240)

```typescript
// Before
} catch {
  raw = await callOllamaGenerate(prompt, { timeoutMs: 30_000 });
  provider = "ollama";
}

// After
} catch (claudeErr) {
  trace({
    event: "ltm_claude_fallback",
    traceId: traceId ?? "no-trace",
    chatId: chatId ?? 0,
    error: claudeErr instanceof Error ? claudeErr.message : String(claudeErr),
  });
  raw = await callOllamaGenerate(prompt, { timeoutMs: 30_000 });
  provider = "ollama";
}
```

---

## Test Coverage Gaps

The following should be added to `src/memory/longTermExtractor.test.ts`:

```typescript
// Test filterPlaceholders integration — already unit-tested but verify integration
test("assistant response with {userName} placeholder is stripped before extraction", ...);

// Test truncation boundary — verify 2000-char limit
test("assistant response longer than 2000 chars is truncated to MAX_ASSISTANT_CHARS", ...);

// Test XML structure integrity after truncation
test("XML tags are closed correctly after assistant response truncation", ...);

// Test that [REMEMBER:] tags in assistant response don't appear in extraction input
// (they should be stripped by processMemoryIntents before reaching extractMemoriesFromExchange)
test("extractMemoriesFromExchange never receives [REMEMBER:] tagged assistant response", ...);
```

---

## Summary: What Plans C and B Need to Change

| Original Plan | Status | Action |
|---|---|---|
| Plan C: sanitize `═══...═══` markers | OBSOLETE — XML tagging already handles this | Drop |
| Plan C: increase truncation 800 → 2000 | STILL NEEDED | Implement |
| Plan C: add prompt rule for `{placeholder}` | ALREADY DONE — `filterPlaceholders()` at line 37 + prompt rule at line 196 | Drop |
| Plan C: SQL cleanup | STILL NEEDED | Run SQL |
| Plan B: error logging in catch block | STILL NEEDED | Implement |
| Plan B: `runClaudePrint` as primary | STILL RELEVANT — Claude fails 75% of time | Separate ticket |

**Minimum viable fix: 2 lines of code + 1 SQL query.**
