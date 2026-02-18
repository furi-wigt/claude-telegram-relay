# /new Command with Optional Prompt Parameter

## Goal
Modify `/new` to accept an optional parameter:
- `/new` — resets session (existing behaviour)
- `/new do this and that` — resets session AND immediately processes "do this and that" as a user prompt

## Implementation Plan

1. In `botCommands.ts`, the `/new` handler at line 179:
   - Read `ctx.match` (already available) for the optional text
   - If text is present:
     a. Reset the session
     b. Send "Starting fresh conversation..." message
     c. Route the text through the normal message processing pipeline (same as regular user messages)
2. The message routing pipeline is in `relay.ts` — the `processMessage` or equivalent function
   - Need to expose a callable function from relay.ts or emit a synthetic message event
   - Simplest approach: export a `processUserMessage(chatId, text, ctx)` function from relay.ts

## Files to Modify
- `src/commands/botCommands.ts` — modify `/new` handler
- `src/relay.ts` — export processUserMessage or equivalent

## Acceptance Criteria
- `/new` alone behaves exactly as before
- `/new write me a poem` resets context, confirms reset, then immediately gets Claude response to "write me a poem"
- The follow-up message should be saved as user role in messages table
