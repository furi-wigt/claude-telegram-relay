# Include Bot Commands in Short-Term Memory

## Goal
Bot command interactions should appear in the messages table as user/assistant role pairs,
so they are included in Claude's short-term memory context.

## Included Commands (user decision)

### Read commands (include)
- `/status` → user role: "/status", assistant role: session status text
- `/memory [*]` → user role: "/memory [subcommand]", assistant role: formatted memory output

### Write commands (include)
- `/remember [fact]` → user role: "/remember <fact>", assistant role: "✓ Remembered: <fact>"
- `/forget [topic]` → user role: "/forget <topic>", assistant role: confirmation text
- `/routines delete <name>` → user role: "/routines delete <name>", assistant role: confirmation
- `/goals [items]` → user role: "/goals ...", assistant role: summary of changes
- `/facts [items]` → user role: "/facts ...", assistant role: summary of changes
- `/prefs [items]` → user role: "/prefs ...", assistant role: summary of changes
- `/reminders [items]` → user role: "/reminders ...", assistant role: summary of changes

### Coding write commands (include)
- `/code new`, `/code stop`, `/code permit`, `/code revoke`, `/code answer`

## Excluded Commands
- `/help` - boilerplate
- `/history` - meta/debug
- `/summary` - meta/debug
- `/routines list` - read only
- `/new` - session reset (would pollute context with "fresh start" messages)
- All read `/code` subcommands: list, status, logs, diff, perms, scan

## Implementation Plan

1. Export `saveMessage` from relay.ts, or create a shared utility in `src/utils/saveMessage.ts`
2. Add `saveCommandInteraction(supabase, chatId, userText, assistantText)` helper
3. Call it at the end of each included command handler
4. The helper saves two rows: user role (command text) + assistant role (response text)

## Files to Modify
- `src/relay.ts` — extract/export saveMessage function
- `src/commands/botCommands.ts` — add saveCommandInteraction calls
- `src/commands/memoryCommands.ts` — add saveCommandInteraction calls
- `src/coding/codingCommands.ts` — add saveCommandInteraction for write commands
- New file: `src/utils/saveMessage.ts` (shared utility)
