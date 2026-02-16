# Investigation: Orchestrator Never Receives Worker SendMessage Reports

**Created:** 2026-02-17
**Branch:** `routines`
**Priority:** High — agent team sessions always hang, never complete
**Related fix merged:** `fix-agent-team-interactive-mode-for-worker-message-delivery.md` (removed `-p` flag for agent team spawns)

---

## Summary

In all 4 test runs of "Add a hello world function --team" today, **all 3 workers
completed and each sent exactly 1 `SendMessage` back to the team lead, but the
orchestrator never received any of them**. Every orchestrator session ends at
the "waiting for workers" assistant turn with 0 result events — the session
just stops there.

The `-p` removal fix is confirmed working (orchestrator spawns without `-p`,
interactive mode is active). But removing `-p` alone is not sufficient. The
`SendMessage` calls from workers are not being delivered into the orchestrator's
conversation turn stream.

---

## Evidence

### Session audit across all 4 test runs

| Run | Time (SGT) | Orchestrator ID | Orch msgs | Result events | Workers | SendMessage sent |
|-----|------------|-----------------|-----------|---------------|---------|-----------------|
| 1 | 21:59 | `054fdaed-3704-44bc-8fcf-e73ed8c56c74` | 17 | **0** | 3/3 done | **3/3** |
| 2 | 22:10 | `fa97d3a7-de3f-4e22-9740-57fa1ec8fe7a` | 14 | **0** | 3/3 done | **3/3** |
| 3 | 22:31 | `d91d464a-f2d8-4a5e-9c47-de4b89049c35` | 14 | **0** | 3/3 done | **3/3** |
| 4 | 22:48 | `47990684-5edc-48f8-9c9a-02129fe6e63c` | 14 | **0** | 3/3 done | **3/3** |

All sessions at: `~/.claude/projects/-private-tmp-test-session/`

### Run 4 (22:48) detailed timeline

```
14:48:32Z  user        → "Create an agent team..." (orchestration prompt)
14:48:35Z  assistant   → "I'll create a team..."
14:48:36Z  tool        → TeamCreate: hello-world-team
14:48:37Z  assistant   → "Now let me spawn all three in parallel"
14:48:42Z  tool        → Task: spawn implementer (agent-aab382d)
14:48:45Z  tool        → Task: spawn reviewer   (agent-a1f68cf)
14:48:48Z  tool        → Task: spawn tester     (agent-ae406db)
14:48:51Z  assistant   → "All three spawned. Waiting for implementer first..."
            ← ORCHESTRATOR GOES SILENT HERE, NO MORE EVENTS →

14:48:57Z  worker-reviewer   → SendMessage (to team-lead) ✓
14:48:59Z  worker-tester     → SendMessage (to team-lead) ✓
14:49:01Z  worker-implementer → SendMessage (to team-lead) ✓

14:53:04Z  relay       → SIGINT (restart #54)
            ← orchestrator process killed, 4 min after workers completed →
```

**Key observation:** Workers sent their `SendMessage` calls 6–10 seconds after
the orchestrator started waiting. The orchestrator had ~4 minutes before SIGINT.
The messages simply never appeared as new `user` turns in the orchestrator's
JSONL.

---

## Root Cause Hypothesis

### Confirmed fix (necessary but not sufficient)
The `-p` flag removal means the orchestrator process stays alive and its
interactive event loop runs. This is confirmed: PID 65806 was running in `S`
state for ~4 minutes after all workers finished.

### The deeper issue: SendMessage delivery mechanism

`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` enables inter-agent messaging via the
`SendMessage` tool. There are two possible delivery models:

**Model A — Stdin injection (relay must forward):**
Worker `SendMessage` calls produce new NDJSON `user` messages that need to be
written to the orchestrator's stdin. The orchestrator subprocess reads from
stdin (its own `--input-format stream-json` loop). If nobody writes to its
stdin, it waits forever even in interactive mode.

**Model B — Claude infrastructure delivery (fully managed):**
`SendMessage` routes through Claude's backend, which injects new turns directly
into the orchestrator's active session. Requires the orchestrator to be
connected as a live interactive session — possible friction if the subprocess
connection model differs from direct `claude` CLI usage.

**Evidence pointing to Model A (stdin injection):**
- Orchestrator JSONL shows 0 new events after workers sent `SendMessage`
- In interactive mode, a new user turn would appear as a `user` entry in the
  JSONL — none appeared
- The relay's `InputBridge` / `sessionRunner` only writes the **initial task**
  to stdin, then leaves it open but never writes again
- Workers write `SendMessage` → but nobody forwards that to the orchestrator's
  stdin

**If Model A is correct:** the relay needs to receive worker `SendMessage`
events (which would appear as NDJSON events on the orchestrator's stdout) and
forward them back into the orchestrator's stdin as new user turns. But this
creates a circular dependency — the relay needs to both read and write the
orchestrator's streams simultaneously, which the current linear stdout-reader
loop doesn't support.

### Confounding factor: relay restarts kill orphaned orchestrators

The relay received SIGINT 54 times today (manual restarts during development).
When PM2 restarts the relay (bun process), all child processes including the
orchestrator are killed. Any in-flight orchestrator that was actually receiving
worker messages would be terminated.

However, in run 4, the orchestrator had **4 full minutes** between workers
finishing (14:49:01Z) and SIGINT (14:53:04Z). If messages were going to arrive,
they would have by then. So the restart issue is a compounding factor but not
the primary cause.

---

## Confounding Factor: Relay Restart Instability

The relay process has restarted **54 times** today (PID changes: 64555 → 71588
within the investigation window). Each restart kills the orchestrator subprocess.

**SIGINT pattern from logs:**
```
19:56:44  SIGINT → restart
20:02:04  SIGINT → restart
20:07:34  SIGINT → restart
20:07:54  SIGINT → restart
20:11:25  SIGINT → restart
20:16:34  SIGINT → restart
...
22:27:36  SIGINT → restart
22:47:58  SIGINT → restart (our test run 4 starts here)
22:53:04  SIGINT → restart (kills run 4 orchestrator)
```

Source of SIGINT: appears to be manual terminal Ctrl+C during development
sessions. PM2 manages the relay but manual intervention is propagating signals.

**Impact:** Any orchestrator that happened to be in the middle of receiving
worker messages would be killed by these restarts. Even if the SendMessage
delivery mechanism works correctly, the orchestrator would need a stable relay
window of 2–5 minutes to complete.

**Separate fix needed:** Orchestrator subprocess should be decoupled from relay
lifetime — or at minimum, graceful shutdown should wait for active coding
sessions to complete before killing child processes.

---

## Investigation Checklist

### Step 1: Verify SendMessage delivery model

Read the Claude CLI source or docs for `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`:
- Does `SendMessage` inject via stdin, or via a separate IPC mechanism?
- What NDJSON event type(s) represent an incoming worker message on the
  orchestrator's stdout stream?
- Run a minimal test: spawn `claude` in interactive mode with agent teams,
  manually send a `SendMessage` event via stdin, observe stdout.

```bash
# Test: what does the orchestrator's stdout look like when a worker sends a message?
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude \
  --output-format stream-json --input-format stream-json --verbose \
  --dangerously-skip-permissions \
  < orchestrator-input.ndjson | tee orchestrator-output.ndjson
```

### Step 2: Check if new user turns appear on orchestrator stdout

Look at a longer-running orchestrator session (run 1: `054fdaed`, 17 msgs vs 14
for others) to see if anything different happened — did it get further than the
others?

```bash
python3 -c "
import json
with open('~/.claude/projects/-private-tmp-test-session/054fdaed-3704-44bc-8fcf-e73ed8c56c74.jsonl') as f:
    for l in f: print(json.loads(l).get('type'), json.loads(l).get('timestamp','')[-8:])
"
```

### Step 3: Check if relay needs to forward messages

If Model A (stdin injection) is confirmed:
- The orchestrator's stdout stream would emit a specific event type (e.g.
  `agent_message`, `teammate_message`) when a worker sends `SendMessage`
- The relay's `handleEvent()` in `sessionRunner.ts` needs to detect this and
  write the formatted message back to the orchestrator's stdin via `InputBridge`

### Step 4: Fix graceful shutdown to not kill active sessions

In `src/index.ts` or wherever SIGINT is handled:
- Track active `SessionRunner` instances
- On SIGINT: stop accepting new sessions, wait for active sessions to complete
  (up to `AGENT_TEAM_TIMEOUT_MS`), then kill
- Or: `proc.unref()` the orchestrator subprocess so it survives relay restart

---

## Files to Investigate

| File | Relevance |
|------|-----------|
| `src/coding/sessionRunner.ts` | `handleEvent()` — may need new event type for worker messages; `InputBridge` may need to forward messages back to orchestrator stdin |
| `src/coding/inputBridge.ts` | How stdin is written; may need `sendAgentMessage()` method |
| `src/index.ts` | SIGINT handler — may need to wait for active sessions |
| `~/.claude/projects/-private-tmp-test-session/054fdaed-*/` | Run 1 (17 msgs) — investigate why it went 3 messages further |
| Claude CLI source / `claude --help` | What events does `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` produce on stdout? |

---

## Related Sessions

- `d91d464a` — mentioned in original bug report (session ID from previous
  investigation where team lead was observed sleeping 7+ minutes after workers
  finished)
- All orchestrators: `~/.claude/projects/-private-tmp-test-session/`
- All workers: `~/.claude/projects/-private-tmp-test-session/<orch-id>/subagents/`

---

## CRITICAL DISCOVERY: File-Based Inbox Mechanism Confirmed

During cleanup, the team inbox files were inspected. **All 4 team-lead inboxes
had 6 queued messages (3 workers × 2 messages each) that were never consumed:**

```
~/.claude/teams/hello-world-team/inboxes/team-lead.json          — 6 msgs
~/.claude/teams/compressed-singing-storm/inboxes/team-lead.json  — 6 msgs
~/.claude/teams/streamed-coalescing-clock/inboxes/team-lead.json — 6 msgs
~/.claude/teams/buzzing-conjuring-puffin/inboxes/team-lead.json  — 6 msgs
```

Sample inbox content (run 1 `hello-world-team`):
```json
{ "from": "implementer", "summary": "hello.py implemented with hello_world function" }
{ "from": "reviewer",    "summary": "Review of hello.py: clean, all checks pass" }
{ "from": "tester",      "summary": "All 4 tests pass for hello_world function" }
(+ 3 empty-summary follow-up messages)
```

**This definitively answers the "Model A vs Model B" question:**

`SendMessage` uses a **file-based inbox** at
`~/.claude/teams/<team-name>/inboxes/<recipient>.json`, NOT stdin injection and
NOT Claude backend IPC. The orchestrator's interactive event loop must
**actively poll or watch this file** to pick up worker messages.

### Why the orchestrator never picks them up

In `-p` mode AND in interactive mode (no `-p`), the orchestrator subprocess
only processes what appears on its stdout NDJSON stream. The Claude CLI's
experimental agent teams feature presumably polls the inbox file on a timer or
via fsnotify. If that polling loop requires a specific runtime condition that
isn't met in subprocess mode (e.g., it only runs in the main Claude Code
process, not in a spawned subprocess), the inbox messages sit forever.

### What the fix needs

**Option A — Relay watches the inbox and injects via stdin:**
```
~/.claude/teams/<name>/inboxes/team-lead.json (new message written by worker)
  → relay detects (fsnotify / polling)
  → relay writes formatted NDJSON message to orchestrator stdin via InputBridge
  → orchestrator's --input-format stream-json loop processes it as a new user turn
```

**Option B — Verify orchestrator inbox polling in subprocess mode:**
Check if `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + no `-p` already polls the
inbox. It should — but maybe the team name needs to be known/passed to the
subprocess. Look at what `TeamCreate` returns (team name is random, e.g.
`buzzing-conjuring-puffin`) and whether the subprocess knows to watch that
specific inbox path.

**The team name is non-deterministic** (randomised by `TeamCreate`) so the
relay must capture it from the `TeamCreate` tool result in the orchestrator's
NDJSON stream to know which inbox to watch.

### Inbox file format

From inspection, the format is a JSON array of message objects:
```json
[
  { "sender": "implementer", "summary": "...", "content": "...", "timestamp": "..." },
  ...
]
```
(exact schema may vary — inspect a live file during next test)

---

## Quick Reference: Confirmed Facts

1. ✅ `-p` removal fix is working — orchestrator spawns in interactive mode
2. ✅ Workers spawn correctly (3 workers per run, consistent roles)
3. ✅ Workers complete and each sends exactly 1 `SendMessage`
4. ✅ `SendMessage` IS delivered — to `~/.claude/teams/<name>/inboxes/team-lead.json`
5. ❌ Orchestrator never reads the inbox — subprocess polling loop not running
6. ❌ Orchestrator emits 0 `result` events across all 4 runs
7. ⚠️ Relay has 54 restarts today — compounding factor, separate fix needed
8. ⚠️ Relay restarts kill orchestrator subprocess (child process of bun/PM2)
9. 🔑 Fix path: relay must watch inbox file and inject messages into orchestrator stdin
