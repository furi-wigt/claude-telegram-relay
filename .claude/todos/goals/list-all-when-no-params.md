# List All Items When Command Called Without Parameters

## Problem
`/goals`, `/facts`, `/prefs`, `/reminders` called without arguments currently show a "Usage:" message.
The expected behaviour is to **list all stored items** of that category, similar to `/memory goals`.

## Desired Behaviour
- `/goals` → list all active goals (like `/memory goals`)
- `/facts` → list all stored facts
- `/prefs` → list all preferences
- `/reminders` → list all dates/reminders
- Each command still shows usage hint **at the bottom** of the list
- If no items stored → "No {label}s stored yet." + usage hint

## Implementation

### File: `src/commands/directMemoryCommands.ts`

1. **Add `listItems()` helper** that queries Supabase for items of a given type+category
2. **Change the `if (!input)` branch** in `handleDirectMemoryCommand`:
   - Before: show Usage string
   - After: fetch and display items, append usage hint

### Test: `src/commands/directMemoryCommands.test.ts`

Add test group: `"no-args path — lists items"`:
- `/goals` no args with stored items → lists them
- `/goals` no args with no items → "No goals stored yet."
- Same for `/facts`, `/prefs`, `/reminders`
- Saves to STM via `saveCommandInteraction`

## Acceptance Criteria
- [ ] `/goals` with no args lists all goals
- [ ] Empty state returns friendly "No goals stored yet." message with usage hint
- [ ] Same for `/facts`, `/prefs`, `/reminders`
- [ ] `saveCommandInteraction` is called with the command and list output
- [ ] New tests pass
- [ ] Existing tests still pass
