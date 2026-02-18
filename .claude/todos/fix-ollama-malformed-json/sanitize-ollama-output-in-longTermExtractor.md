# Fix: Sanitize Ollama Output in longTermExtractor.ts

## Problem

The service has 124+ restarts due to unhandled TypeErrors when Ollama returns malformed JSON.

### Errors Observed
- `Line 89: TypeError: s?.trim is not a function` in `isJunk()` — receives non-string (object)
- `Line 100: TypeError: {} is not iterable` in `storeExtractedMemories()` — iterating object instead of array

### Root Cause

`extractMemoriesFromExchange` at line 74 blindly casts `JSON.parse()` output without validating structure:

```typescript
return JSON.parse(jsonMatch[0]) as ExtractedMemories;  // line 74 — no validation
```

When Ollama returns malformed JSON like:
```json
{ "facts": {}, "preferences": {} }    // objects instead of arrays
{ "facts": [{}, 123, "valid string"] } // non-string array items
```

This causes:
1. `for (const fact of memories.facts ?? [])` fails — `{}` is truthy so `?? []` doesn't apply, and `{}` is not iterable
2. `isJunk(fact)` fails — `fact` is `{}` object, `.trim()` doesn't exist on objects

## Fix Plan

### File: `src/memory/longTermExtractor.ts`

#### Change 1: Add `sanitizeMemories()` helper

Insert after the `ExtractedMemories` interface (around line 20):

```typescript
/**
 * Normalize Ollama output to ensure all fields are string arrays.
 * Ollama sometimes returns objects {} instead of arrays [], or arrays
 * containing non-string items. This sanitizes the raw parsed JSON.
 */
function sanitizeMemories(raw: unknown): ExtractedMemories {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const obj = raw as Record<string, unknown>;
  const toStringArray = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v.filter((item): item is string => typeof item === 'string');
  };

  const result: ExtractedMemories = {};
  const facts = toStringArray(obj.facts);
  const preferences = toStringArray(obj.preferences);
  const goals = toStringArray(obj.goals);
  const dates = toStringArray(obj.dates);

  if (facts.length > 0) result.facts = facts;
  if (preferences.length > 0) result.preferences = preferences;
  if (goals.length > 0) result.goals = goals;
  if (dates.length > 0) result.dates = dates;

  return result;
}
```

#### Change 2: Apply sanitizeMemories at line 74

Replace:
```typescript
return JSON.parse(jsonMatch[0]) as ExtractedMemories;
```
With:
```typescript
const parsed = JSON.parse(jsonMatch[0]);
return sanitizeMemories(parsed);
```

#### Change 3: Make `isJunk` type-safe (defensive second layer)

Replace at line 89:
```typescript
const isJunk = (s: string) => !s?.trim() || s.trim().length < 5;
```
With:
```typescript
const isJunk = (s: unknown): boolean => typeof s !== 'string' || !s.trim() || s.trim().length < 5;
```

### File: `src/memory/longTermExtractor.test.ts`

#### New test suite: `storeExtractedMemories - malformed input`

```typescript
describe("storeExtractedMemories - malformed Ollama output", () => {
  test("handles facts as object {} without throwing", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    await storeExtractedMemories(sb, 123, { facts: {} as any });
    expect(insertFn).not.toHaveBeenCalled();
  });

  test("handles mixed-type array items, only inserts strings", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    await storeExtractedMemories(sb, 123, { facts: [{}, 123, null, "Valid fact"] as any });
    const rows = insertFn.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Valid fact");
  });

  test("handles all fields as objects {} without throwing", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    await storeExtractedMemories(sb, 123, {
      facts: {} as any,
      preferences: {} as any,
      goals: {} as any,
      dates: {} as any,
    });
    expect(insertFn).not.toHaveBeenCalled();
  });
});
```

#### New test suite: `extractMemoriesFromExchange - malformed JSON from Ollama`

```typescript
describe("extractMemoriesFromExchange - sanitization", () => {
  test("returns empty object when Ollama returns objects instead of arrays", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: '{"facts": {}, "preferences": {}}' }),
      })
    ) as any;

    const result = await extractMemoriesFromExchange("hello", "hi");
    expect(result).toEqual({});
  });

  test("filters non-string items from arrays", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            response: '{"facts": [{}, "Works at GovTech", 123]}',
          }),
      })
    ) as any;

    const result = await extractMemoriesFromExchange("hello", "hi");
    expect(result.facts).toEqual(["Works at GovTech"]);
  });
});
```

## Acceptance Criteria

- [ ] `bun test src/memory/longTermExtractor.test.ts` passes with all new tests
- [ ] Service no longer crashes on malformed Ollama JSON
- [ ] Malformed fields are silently discarded (not logged as errors)
- [ ] Valid fields in a partially-malformed response are still processed

## Priority

HIGH — service is restarting 124+ times, current uptime only 28 minutes
