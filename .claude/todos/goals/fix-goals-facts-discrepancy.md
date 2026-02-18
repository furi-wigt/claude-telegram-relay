# Fix: /goals and /facts discrepancy with /memory goals and /memory facts

## Problem

From the screenshot:
- `/goals` → "No goals stored yet" ❌
- `/memory goals` → Shows 2 goals ✅
- `/facts` → Shows 1 fact (personal facts: name, age, location, job, family)
- `/memory facts` → Shows 15+ facts and preferences

## Root Causes

### Cause 1: `listItems` strict `chat_id` scoping
`directMemoryCommands.ts` `listItems` uses `.eq("chat_id", chatId)` which excludes `chat_id=null` global items.
`getMemoryFull` (used by `/memory`) uses `.or("chat_id.eq.X,chat_id.is.null")`.

### Cause 2: `listItems` strict `category` filter
`listItems` for goals queries `.eq("category", "goal")`.
Goals stored via Claude's `[GOAL:]` intent tag have `category=null` → invisible to `/goals`.
Same for facts stored via `[REMEMBER:]` tag → `category=null` → invisible to `/facts`.

### Cause 3: `processMemoryIntents` doesn't set `category`
`memory.ts` `processMemoryIntents` stores goals/facts without `category`:
- `[GOAL:]` → `{type: 'goal', category: undefined}` (should be `category: 'goal'`)
- `[REMEMBER:]` → `{type: 'fact', category: undefined}` (should be detected)

## Fix Plan

### Fix A: `src/memory.ts`
1. Add `detectMemoryCategory()` helper function
2. In `processMemoryIntents`:
   - Add `category: 'goal'` to `[GOAL:]` inserts
   - Use `detectMemoryCategory()` for `[REMEMBER:]` inserts

### Fix B: `src/commands/directMemoryCommands.ts` — `listItems`
1. Change `.eq("chat_id", chatId)` → `.or("chat_id.eq.X,chat_id.is.null")`
2. Adjust category filters per command:
   - `goals`: remove category filter (just `type='goal'`)
   - `facts`: `category='personal' OR category IS NULL`
   - `prefs`: keep `category='preference'`
   - `reminders`: keep `category='date'`

### Fix C: Tests
1. `src/memory.test.ts`: Add tests for `processMemoryIntents` setting `category`
2. `src/commands/directMemoryCommands.test.ts`:
   - Update `mockSupabaseForList` to handle `.or()`
   - Add e2e tests: goals/facts showing items without category

## Status
- [ ] Fix A: memory.ts processMemoryIntents sets category
- [ ] Fix B: directMemoryCommands.ts listItems scope and category fixes
- [ ] Fix C: Tests updated and passing
- [ ] Run all tests green
- [ ] Commit
