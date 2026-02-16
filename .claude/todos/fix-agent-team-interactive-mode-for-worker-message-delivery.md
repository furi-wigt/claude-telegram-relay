# Fix: Agent Team Worker Message Delivery (Interactive Mode)

**Branch:** `routines`
**Created:** 2026-02-17
**Priority:** High

---

## Problem

When `--team` flag is used, the relay spawns Claude CLI with `-p` (`--print`) / non-interactive mode:

```
claude -p --output-format stream-json --input-format stream-json --verbose --dangerously-skip-permissions
```

Agent team inter-process messaging (workers → team lead via `SendMessage`) requires the **interactive session loop** to be running. In `-p` mode, the lead's message delivery loop never processes incoming worker messages — the team lead sits idle indefinitely even though workers have finished.

**Evidence from session `d91d464a` (relay `97c1e3e7`):**
- 3 workers all completed at 14:31:54–14:32:41 UTC
- Workers sent reports to team lead via `SendMessage`
- Team lead last spoke at 14:31:30 ("Waiting for their reports...")
- Team lead (PID 43865) still in `S` (sleeping) state 7+ minutes later
- No further NDJSON output from the lead process

---

## Root Cause

`-p` / `--print` disables the interactive event loop that delivers inter-agent messages. The `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` messaging system requires interactive mode to function.

---

## Plan

### Step 1 — Explore current sessionRunner invocation

Read `src/coding/sessionRunner.ts` fully:
- Find exactly where `-p` / `--print` flag is added to args in `buildArgs()`
- Find how the NDJSON stream is currently consumed (stdout pipe)
- Understand what `-p` provides vs what interactive mode provides

### Step 2 — Understand interactive mode NDJSON stream

Run `claude --help` to check if `--output-format stream-json` works **without** `-p`.

Interactive mode (`claude --output-format stream-json --input-format stream-json`) still emits NDJSON on stdout — the difference is:
- `-p` mode: one prompt → one response → process exits
- Interactive mode: process stays alive, reads stdin for new turns, delivers inter-agent messages

The relay already uses `--input-format stream-json` which means it can write new turns to stdin. Removing `-p` should keep the NDJSON stream intact while allowing the event loop to run.

### Step 3 — Implement dual-mode spawning

In `sessionRunner.ts`, in `buildArgs()`:

```typescript
// For regular sessions: keep -p (single-shot, exits on completion)
// For agent team sessions: omit -p (interactive, stays alive for worker message delivery)
if (!options.useAgentTeam) {
  args.push("--print");  // or "-p"
}
```

The completion detection already handles both cases (from the earlier fix):
- Regular: fires on `result` event
- Agent team: fires on process `close`/`exit`

So removing `-p` for agent teams should work without further changes to completion logic.

### Step 4 — Handle stdin keep-alive for agent team sessions

In interactive mode without `-p`, the process may wait for stdin input. Ensure the relay:
- Keeps stdin open (do not close stdin immediately after sending the initial task)
- Or sends an EOF/close signal only after the process has naturally exited

Check `src/coding/sessionRunner.ts` for how stdin is managed after the initial prompt is written.

### Step 5 — Test

Run test 1.6 end-to-end:
1. Send `/code new /tmp/test-session Add a hello world function --team`
2. Observe that workers complete and the team lead receives their reports
3. Confirm Telegram receives "✅ Coding Complete" only after the lead synthesises worker results
4. Confirm the Claude session ID (`d91d464a` style) is shown — not the relay ID

Run automated tests:
```
bun test src/coding/
```

All 286 tests must pass.

### Step 6 — Handle edge cases

- **Timeout:** Agent team sessions in interactive mode may run much longer. Consider a configurable max timeout (e.g. `AGENT_TEAM_TIMEOUT_MS`, default 10 minutes) after which the relay force-kills and marks failed.
- **Stdin closure:** When the user sends `/code stop`, the relay must still be able to kill the process cleanly.
- **Multiple result events:** The lead may still emit multiple `result` events in interactive mode (one per turn). The existing deferral logic (only complete on process exit) already handles this correctly.

---

## Files to Change

| File | Change |
|---|---|
| `src/coding/sessionRunner.ts` | Conditionally omit `-p` flag when `useAgentTeam: true` in `buildArgs()` |
| `src/coding/sessionRunner.test.ts` | Add tests: agent team args do not include `--print`; regular args do |

---

## Related Context

- Experimental agent teams require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (already set in `buildEnv()`)
- Premature completion fix already in place (process exit as signal, not `result` event)
- Claude session ID display fix already in place (`waitForClaudeSessionId`)
- Workers communicate via `SendMessage` tool → requires lead's interactive loop to be running
