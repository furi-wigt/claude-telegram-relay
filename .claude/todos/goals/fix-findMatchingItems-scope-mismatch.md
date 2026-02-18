# Fix: findMatchingItems scope mismatch with listItems

## Problem

`/facts -pm2 cron` shows ❓ Not found even though `/facts` displays "pm2 cron implementation".
`/facts -Claude` wrongly deletes "personal facts: name, age, location, job, family".

## Root Cause

`findMatchingItems` uses **strict** filtering:
- `.eq("chat_id", chatId)` — excludes global items (`chat_id=null`)
- `.eq("category", "personal")` — excludes `category=null` items

But `listItems` uses **inclusive** filtering:
- `.or("chat_id.eq.chatId,chat_id.is.null")` — includes global items
- `.or("category.eq.personal,category.is.null")` for `/facts` — includes uncategorised items

Items stored via `[REMEMBER:]` intent tags get `category=null`. These appear in `/facts` display
but cannot be found by the deletion search. When ilike finds nothing in the restricted set,
Ollama fallback fires on wrong candidates → deletes wrong item.

## Fix

Change `findMatchingItems` to accept `CommandConfig` instead of separate `type`/`category`,
and use the **same query scope as `listItems`**:

```typescript
async function findMatchingItems(
  supabase: SupabaseClient,
  chatId: number,
  config: CommandConfig,   // ← was: type: string, category: string
  query: string
): Promise<MemoryItem[]>
```

Apply same filters:
- `scope = "chat_id.eq.chatId,chat_id.is.null"` (includes global)
- For `facts`: `.or("category.eq.personal,category.is.null")` (includes null-category)
- For `goals`: no category filter
- For `prefs`/`reminders`: strict `.eq("category", config.category)` (unchanged)

Update the call site: `findMatchingItems(supabase, chatId, config, query)`.

## New Tests

In `directMemoryCommands.test.ts`:

1. `findMatchingItems scope: facts search includes category=null items`
   - Candidates include items with `category=null` (simulated via mock)
   - `/facts -pm2 cron` should find "pm2 cron implementation" stored with null category

2. `findMatchingItems scope: no false Ollama match when item exists with null category`
   - "Claude" should NOT match "personal facts" when "claude session status" exists (null cat)

3. `findMatchingItems scope: global item (chat_id=null) is findable for deletion`
   - (Requires updating mockSupabaseWithCandidates to also return global items)

## Files Changed

- `src/commands/directMemoryCommands.ts` — fix `findMatchingItems` signature and query
- `src/commands/directMemoryCommands.test.ts` — add new regression tests

## Status

- [x] Fix implemented
- [x] Tests written (6 new regression tests + updated mock to support .or())
- [x] All tests pass (685 pass, 0 fail)
