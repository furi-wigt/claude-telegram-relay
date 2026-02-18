# Fix: Wrong items shown in disambiguation keyboard for -remove commands

## Bug Report

When running `/facts -pm2 cron, -Claude relay, -claude session status`, the
disambiguation keyboard showed completely wrong items:

- "pm2 cron" → showed "Phase 3 involves 'rebalancer.py'" and "Phase 5 involves
  'xlwings Python'" (should show "pm2 cron implementation")
- "Claude relay" → showed "bug 1: `editMessageText` throws" and "bug 2:
  completion message not shown" (should show "Claude relay status")
- "claude session status" → showed "name: user" and "personal facts: name, age,
  locat" (should show "claude session status")

## Root Cause

In `findMatchingItems` (`src/commands/directMemoryCommands.ts`):

1. Fetches all candidates (up to 20) from DB
2. **Sends numbered list to Ollama FIRST**: `"1. Phase 3...", ..., "7. pm2 cron..."`
3. Ollama (gemma3-4b) fails to follow instructions → returns `"1, 2"` regardless
4. `parseInt` parses those → returns `candidates[0]` and `candidates[1]`
5. **Wrong items** appear in the keyboard

## Scope

All four commands share `findMatchingItems`:
- `/facts` — category: personal
- `/goals` — category: goal
- `/prefs` — category: preference
- `/reminders` — category: date

## Fix

**Swap strategy in `findMatchingItems`:**

1. **ilike/substring match FIRST** (fast, reliable, always correct for typical use)
2. Only call Ollama if ilike returns **0 results** (semantic fallback for fuzzy
   user descriptions like "that pm2 thing" → "pm2 cron implementation")

## Implementation

File: `src/commands/directMemoryCommands.ts`

Change `findMatchingItems` to:
1. Fetch all candidates
2. Run substring filter on all candidates → `substringMatches`
3. If `substringMatches.length > 0`, return those immediately (skip Ollama)
4. If `substringMatches.length === 0`, try Ollama semantic match as before

## Tests Required

Add e2e tests in `directMemoryCommands.test.ts`:

1. **Bug regression test**: 11 candidates where pm2 items are at positions 7-8,
   query is "-pm2 cron". Verify keyboard buttons have IDs `dmem_del:f7` and
   `dmem_del:f8`, NOT `dmem_del:f1` or `dmem_del:f2`.

2. **Single correct match**: candidates with "Claude relay status" at position 4,
   query "-Claude relay" → direct delete of f4, not disambiguation.

3. **Ollama fallback still works**: ilike returns 0 results, mock Ollama to return
   "2" → returns candidates[1] (semantic match).

## Status

- [ ] Fix `findMatchingItems` logic
- [ ] Add regression e2e tests
- [ ] Run all tests pass
- [ ] Commit
