# New Memory Mutation Commands: /goals, /facts, /prefs, /reminders

## Goal
Add four new commands that allow direct manipulation of memory categories using +/- syntax.

## Commands

### Syntax
```
/goals +Learn TypeScript, +Ship v2, -Old goal text
/facts +I live in Singapore, -Wrong fact text
/prefs +Prefer concise answers, -Old preference
/reminders +Meeting on Friday 3pm, -Old reminder
```

- `+item` — add new item to the category
- `-item` — remove matching item from the category (fuzzy match via Ollama)
- Comma-separated items, multiple +/- in one command

## Memory Type Mapping
| Command    | type in DB | category in DB |
|------------|-----------|----------------|
| /goals     | "goal"    | "goal"         |
| /facts     | "fact"    | "personal"     |
| /prefs     | "fact"    | "preference"   |
| /reminders | "fact"    | "date"         |

## Fuzzy Matching for Deletion (callOllamaGenerate)
When user provides `-old text`, use Ollama to find the best matching stored item:

Prompt template:
```
Given these stored items:
1. "item1 text"
2. "item2 text"
3. "item3 text"

Which item best matches: "user deletion text"?
Reply with ONLY the number (1, 2, 3) or "none" if no match.
```

If Ollama is unavailable → fall back to `ilike` substring match.
If multiple close matches → show question UI (InlineKeyboard) to confirm.

## Question UI for Clarification
- If fuzzy match has multiple candidates → show InlineKeyboard with candidates and "Cancel" button
- Callback data: `mem_delete:{id}` and `mem_cancel`
- Use `callClaude` as fallback if Ollama unavailable entirely

## Implementation Plan

1. Create `src/commands/directMemoryCommands.ts`:
   - `parseAddRemoveArgs(input: string)` → `{ adds: string[], removes: string[] }`
   - `fuzzyMatchMemory(supabase, chatId, type, category, query, ollamaFn)` → matches
   - Handler for each of the 4 commands
   - Inline keyboard callbacks for confirmation

2. Register the 4 commands in `registerCommands()` in `botCommands.ts`

3. Update `/help` text to include new commands

4. Include in short-term memory (calls `saveCommandInteraction`)

## Files to Create
- `src/commands/directMemoryCommands.ts`

## Files to Modify
- `src/commands/botCommands.ts` — register new commands + update /help
