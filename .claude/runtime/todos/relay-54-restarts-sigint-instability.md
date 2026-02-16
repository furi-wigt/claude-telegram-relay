# Investigation: Relay 54+ Restarts — SIGINT Instability Killing Active Sessions

**Created:** 2026-02-17
**Branch:** `routines`
**Priority:** Medium — secondary issue compounding the agent team problem

---

## Summary

The `telegram-relay` PM2 process has restarted **54 times** during today's
development session. Every restart sends SIGINT to the relay, which kills all
child processes — including any active orchestrator subprocesses. This means
even if the `SendMessage` delivery mechanism is fixed, a relay restart during
an agent team session would still corrupt it.

---

## Evidence

```
PM2 process: telegram-relay  pid=71588  uptime=3m  restarts=54  status=online
```

SIGINT events from logs (sample):
```
19:56:44  Received SIGINT, shutting down gracefully...
20:02:04  Received SIGINT, shutting down gracefully...
20:07:34  Received SIGINT, shutting down gracefully...
20:07:54  SIGINT (20 seconds later — double restart)
20:11:25  SIGINT
20:16:34  SIGINT
20:16:46  SIGINT (12 seconds later — double restart)
...
22:27:36  SIGINT → restart
22:47:58  SIGINT → restart (run 4 starts at 22:48:29)
22:53:04  SIGINT → restart (kills run 4 orchestrator, which had been
                             alive for 5 minutes with 0 result events)
```

**Pattern:** SIGINTs arrive in clusters (double-restarts 20s apart) and at
irregular intervals of 2–10 minutes. This matches manual Ctrl+C during
development — each terminal Ctrl+C sends SIGINT to the foreground process
group, which PM2 may also forward.

---

## Root Causes (Hypotheses)

### 1. Manual terminal Ctrl+C during development
Developer runs `claude` or other commands in the same terminal session where
PM2 was started. Ctrl+C kills the foreground process but SIGINT propagates to
the process group, hitting PM2's relay child.

### 2. `pm2 restart relay` / `pm2 reload relay` sending SIGINT
Standard PM2 graceful restart sends SIGINT first. Each `bun run setup:pm2` or
manual PM2 command triggers this.

### 3. `npx pm2 logs relay` subprocess leaking signals
The log-tailing process (PID 4814/4947 from earlier `ps`) may interfere.

---

## Impact on Agent Team Sessions

When the relay process exits (for any reason), Bun's `spawn()` child processes
are killed by the OS:

```
PM2 → telegram-relay (bun, PID 71588)
         └─ orchestrator (claude, PID 65806) ← killed on relay exit
               ├─ docker-mcp (PID 65815)
               ├─ workiq-mcp (PID 65816)
               └─ sequential-thinking-mcp (PID 65817)
```

An agent team session takes 2–10 minutes to complete. With restarts every 2–10
minutes, the probability of completing without interruption is very low.

**Run 4 timeline:**
- 22:47:58 — relay restarts (run 4 triggered at 22:48:29)
- 22:53:04 — relay restarts again → kills orchestrator (5 minutes into session)
- Workers finished at 22:48:57–22:49:01 — only ~4 minutes needed for delivery
- Even if SendMessage worked, the 22:53 restart would have killed it at minute 5

---

## Potential Fixes

### Fix A: Decouple orchestrator lifetime from relay (recommended)

Use `proc.unref()` after spawning the orchestrator subprocess. This makes the
orchestrator an independent process that survives its parent (relay) dying:

```typescript
// In sessionRunner.ts, after spawn():
if (options.useAgentTeam) {
  proc.unref();  // detach from relay process lifetime
}
```

**Risk:** Orphaned orchestrators if relay dies — need a separate cleanup
mechanism (e.g., write PID to file, clean up on next start).

### Fix B: Graceful shutdown waits for active sessions

In the relay's SIGINT handler, before exiting:
1. Stop accepting new `/code` requests
2. Notify active sessions via Telegram ("relay restarting, please wait")
3. Wait up to `N` seconds for active sessions to complete
4. Then exit

```typescript
// In src/index.ts SIGINT handler:
if (activeSessions.size > 0) {
  await Promise.race([
    Promise.all([...activeSessions].map(s => s.waitForCompletion())),
    sleep(GRACEFUL_SHUTDOWN_TIMEOUT_MS),
  ]);
}
```

**Risk:** Relay can't restart for up to 10 minutes if a session is hung.

### Fix C: Reduce restart frequency (developer hygiene)

Use a dedicated terminal window for PM2 logs that doesn't receive SIGINT from
Ctrl+C. Use `pm2 restart` only when needed, not via Ctrl+C on the foreground
process.

```bash
# In a dedicated terminal — won't forward SIGINT to PM2:
pm2 logs telegram-relay
```

### Fix D: Track orphaned orchestrators and resume

On relay startup, scan for orphaned orchestrator PIDs (written to a state file).
If a session was in progress, notify the user on Telegram.

---

## Files to Change

| File | Change |
|------|--------|
| `src/coding/sessionRunner.ts` | Add `proc.unref()` for agent team sessions |
| `src/index.ts` | Graceful shutdown: wait for active sessions |
| `src/coding/sessionManager.ts` | Track active sessions for graceful shutdown |

---

## Quick Verification

After fixing, run:
```bash
# Start a team session then immediately restart relay
/code new /tmp/test-session "Add hello world" --team
# Wait 10 seconds (workers should be spawning)
pm2 restart telegram-relay
# Orchestrator should survive and complete
ps aux | grep claude
```
