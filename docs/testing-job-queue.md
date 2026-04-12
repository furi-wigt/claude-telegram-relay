# Job Queue — Pre-Merge Testing Guide

> Run all sections in order. Each section has a pass/fail verdict. All must pass before merging to master.

**Branch:** `feat/job-queue`  
**Worktree (for CLI commands):** `.claude/worktrees/feat/job-queue`  
**Bot worktree toggle:** run the relay from the worktree to test Telegram features in isolation.

---

## Section 1: Automated Test Suite

Run from the worktree (or main repo — same codebase):

```bash
cd .claude/worktrees/feat/job-queue
bun run test
```

**Expected:**
```
2546 pass | 2 fail | 48 skip
```

The 2 failures are pre-existing (`tests/local/local-stack.test.ts`, MLX embed server not running). **Ignore them.** All other tests must be green.

**Pass criteria:** 2546 pass, no new failures compared to master baseline.

---

## Section 2: Schema Smoke Test

Confirm the new tables are created correctly against your real database.

```bash
# Point at your actual relay database
sqlite3 ~/.claude-relay/data/local.sqlite ".tables" | tr ' ' '\n' | sort
```

**Expected output includes:**
```
job_checkpoints
jobs
```

Then spot-check the schema:

```bash
sqlite3 ~/.claude-relay/data/local.sqlite ".schema jobs"
sqlite3 ~/.claude-relay/data/local.sqlite ".schema job_checkpoints"
```

**Pass criteria:** Both tables present with all expected columns. No errors.

> **Note:** The schema is applied by `initJobSchema()` called from `initSchema()` inside `getDb()`. If the tables are missing, run `bun run start` once (bot init triggers schema creation) and re-check.

---

## Section 3: CLI — Basic Operations

Run each command against the real database. The relay does NOT need to be running for these.

```bash
cd .claude/worktrees/feat/job-queue
```

### 3a. List jobs (empty state)

```bash
bun run relay:jobs
```

**Expected:** `No jobs found.` or an empty table. No errors.

### 3b. Submit a test job

```bash
bun run relay:jobs run "CLI smoke test" --type routine --executor test-cli
```

> The title/prompt must come immediately after `run`, before any flags.

**Expected:** Job is inserted. Re-run `bun run relay:jobs` and confirm a row appears with status `⏳ pending`.

### 3c. View job detail

```bash
bun run relay:jobs <first-8-chars-of-id>
```

Copy the 8-char ID from the list output.

**Expected:** Detail view shows title, type=routine, executor=test-cli, source=cli, status=pending.

### 3d. Cancel a pending job

```bash
bun run relay:jobs cancel <id>
```

**Expected:** `🚫 Cancelled: <id>`. Re-run list — status shows `🚫 cancelled`.

### 3e. Status filter

```bash
bun run relay:jobs --status pending
bun run relay:jobs --status cancelled
bun run relay:jobs --intervention
```

**Expected:** Each returns filtered results. `--intervention` should show no results (no awaiting-intervention jobs yet).

### 3f. JSON output

```bash
bun run relay:jobs --json
```

**Expected:** Valid JSON array printed to stdout. No human-readable table formatting.

### 3g. Short-ID prefix lookup

Submit another job, then use a 3-4 char prefix:

```bash
bun run relay:jobs <short-prefix>
```

**Expected:** Resolves to detail view if prefix is unambiguous. Prints "Ambiguous prefix" error if multiple match.

---

## Section 4: Relay Boot — Job Queue Starts

Start the relay from the worktree and confirm the job queue boots cleanly.

```bash
cd .claude/worktrees/feat/job-queue
bun run start 2>&1 | grep -E "\[jobs\]|\[relay\] job queue|job queue"
```

**Expected log lines (in order):**
```
[jobs] registered /jobs command and job:* callback handler
[relay] job queue started
```

Confirm the relay is fully up by sending any message to your bot — it should respond normally.

**Pass criteria:** Both log lines appear. Bot responds. No crash or error on boot.

---

## Section 5: Telegram — /jobs Command

With the relay running from the worktree, open Telegram.

### 5a. Empty state

Send to your bot (or any configured group):
```
/jobs
```

**Expected:** Reply with `No jobs found.` and 3 inline keyboard buttons: `⚠️ Needs attention`, `▶️ Running`, `📜 History`.

### 5b. Filter buttons

Tap each button and verify:
- `⚠️ Needs attention` → shows jobs with `awaiting-intervention` status (empty is OK)
- `▶️ Running` → shows running jobs (empty is OK)
- `📜 History` → shows done jobs (empty is OK)

**Pass criteria:** Tapping a button edits the message (no "loading" spinner stuck). Each tap responds within 3 seconds.

### 5c. With jobs visible

First submit a job via CLI (from another terminal):

```bash
bun run relay:jobs run "Telegram visibility test" --type routine --executor test-tg
```

Then send `/jobs` to your bot again.

**Expected:** The job appears in the list with `⏳` emoji, title "Telegram visibility test", and `pending` status.

### 5d. /jobs with filter argument

```
/jobs pending
/jobs failed
```

**Expected:** Filtered list returned, or "No jobs found." — not an error.

---

## Section 6: Intervention Keyboard

This tests the inline keyboard callback data. Create a job manually in `awaiting-intervention` state via the CLI path, then use the Telegram keyboard to resolve it.

### 6a. Set up awaiting-intervention job

```bash
# Submit a job
bun run relay:jobs run "Approval Test" --type routine --executor approval-test
```

Get the job ID, then manually set it to awaiting-intervention using sqlite:

```bash
sqlite3 ~/.claude-relay/data/local.sqlite \
  "UPDATE jobs SET status='awaiting-intervention', intervention_type='approval', intervention_prompt='Do you approve this action?' WHERE executor='approval-test';"
```

### 6b. View it in Telegram

Send:
```
/jobs
```

Tap `⚠️ Needs attention`. The job should appear.

### 6c. Resolve via Telegram keyboard

The notification callback format requires the full job ID. Since the `/jobs` list doesn't show intervention keyboards directly, send the detail view by looking it up. (In production, the intervention card appears when the job first enters `awaiting-intervention` with chatId in metadata.)

For now, verify the callback data format is correct by checking what buttons appear when tapping "Needs attention":

**Expected:** The jobs list shows the job. Tapping it does not crash — "No jobs found" or a list response is acceptable.

**Pass criteria for this section:** Buttons do not leave a stuck loading spinner. Callback queries are answered within 3 seconds.

---

## Section 7: Webhook Server

Test the optional webhook endpoint. First add to `.env` (or run inline):

```bash
JOBS_WEBHOOK_PORT=8900 JOBS_WEBHOOK_SECRET=test-secret-1234 bun run start &
sleep 2
```

### 7a. Health check

```bash
curl -s http://localhost:8900/health | jq .
```

**Expected:** `{"status":"ok","timestamp":"..."}` with HTTP 200.

### 7b. Submit a job via webhook

```bash
curl -s -X POST http://localhost:8900/jobs \
  -H "Authorization: Bearer test-secret-1234" \
  -H "Content-Type: application/json" \
  -d '{"type":"routine","executor":"webhook-test","title":"Webhook smoke test"}' \
  | jq .
```

**Expected:** HTTP 201 with `{"id":"...","status":"pending"}`.

Confirm it appears in the CLI:

```bash
bun run relay:jobs --status pending
```

### 7c. Unauthenticated request

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8900/jobs \
  -H "Content-Type: application/json" \
  -d '{"type":"routine","executor":"test","title":"Unauthorized"}'
```

**Expected:** `401`

### 7d. Wrong secret

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8900/jobs \
  -H "Authorization: Bearer wrong-secret" \
  -H "Content-Type: application/json" \
  -d '{"type":"routine","executor":"test","title":"Wrong auth"}'
```

**Expected:** `401`

### 7e. Missing required fields

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8900/jobs \
  -H "Authorization: Bearer test-secret-1234" \
  -H "Content-Type: application/json" \
  -d '{"executor":"test","title":"Missing type"}'
```

**Expected:** `400`

### 7f. Dedup rejection

Submit the same job twice with a dedup_key:

```bash
curl -s -X POST http://localhost:8900/jobs \
  -H "Authorization: Bearer test-secret-1234" \
  -H "Content-Type: application/json" \
  -d '{"type":"routine","executor":"dup-test","title":"First","dedup_key":"dedup:test:1"}'

curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:8900/jobs \
  -H "Authorization: Bearer test-secret-1234" \
  -H "Content-Type: application/json" \
  -d '{"type":"routine","executor":"dup-test","title":"Second","dedup_key":"dedup:test:1"}'
```

**Expected:** First returns 201, second returns 409.

Kill the background relay when done: `pkill -f "bun run start"` or Ctrl+C.

---

## Section 8: Relay Shutdown — Clean Stop

Verify the job queue drains cleanly on SIGTERM without leaving jobs stuck in `running`.

```bash
cd .claude/worktrees/feat/job-queue
bun run start &
RELAY_PID=$!
sleep 3
kill -TERM $RELAY_PID
wait $RELAY_PID
echo "Exit code: $?"
```

**Expected:** Process exits cleanly (exit code 0 or 143). No `uncaughtException` or `UnhandledPromiseRejection` in the output.

Check logs don't show any job stuck in `running`:
```bash
sqlite3 ~/.claude-relay/data/local.sqlite "SELECT id, status, executor FROM jobs WHERE status='running';"
```

**Expected:** Empty result (no orphaned running jobs).

---

## Section 9: Auto-Approve Rules (Optional — if you want to test)

Create the auto-approve config:

```bash
cat > ~/.claude-relay/auto-approve.json << 'EOF'
[
  { "executor": "log-cleanup", "intervention_types": ["approval"], "action": "confirm" }
]
EOF
```

Start the relay. Confirm it boots without error and the rules file is loaded (no warning in logs about malformed config).

Remove the file after testing:
```bash
rm ~/.claude-relay/auto-approve.json
```

---

## Section 10: Regression — Existing Bot Functionality

Confirm the 4 changes to `relay.ts` did not break existing bot behaviour.

With the relay running from the worktree:

- [ ] Send a regular chat message to your bot → receives a Claude response
- [ ] Send `/status` → bot replies with session info
- [ ] Send `/help` → bot replies with command list
- [ ] Send `/memory` → bot replies with memory browser
- [ ] (If using groups) Send a message in an agent group → correct agent responds

**Pass criteria:** All commands work as before. No regressions.

---

## Go/No-Go Checklist

Check each section before marking ready to merge:

- [ ] **Section 1** — 2546 automated tests pass
- [ ] **Section 2** — `jobs` and `job_checkpoints` tables present in SQLite
- [ ] **Section 3** — All CLI commands work (list, submit, cancel, detail, filter, JSON, prefix lookup)
- [ ] **Section 4** — Relay boots with job queue log lines, bot responds normally
- [ ] **Section 5** — `/jobs` command renders and inline buttons work without stuck spinners
- [ ] **Section 6** — Intervention state visible in Telegram, callbacks respond promptly
- [ ] **Section 7** — Webhook: health, submit 201, unauth 401, missing fields 400, dedup 409
- [ ] **Section 8** — Relay shuts down cleanly on SIGTERM, no orphaned running jobs
- [ ] **Section 9** — Auto-approve.json loads without error (optional)
- [ ] **Section 10** — All existing bot commands still work (regression check)

**All 10 checked → ready to merge.**

---

## Known Gap (Logged, Not Blocking)

The final code review identified that when an intervention is auto-resolved (auto-approve or confidence-proceed), the job status is set to `running` but the executor is not re-invoked. The job will timeout and be re-queued, but the turnaround delay equals the job's `timeout_ms` (up to 30 min for claude-session). This does not affect any current executor because neither `RoutineExecutor` nor `ApiCallExecutor` emits `awaiting-intervention` in production. Track this before implementing `ClaudeSessionExecutor`.

See `DECISIONS.md` entry `2026-04-12 — intervention continue-after-resolve` for design context.
