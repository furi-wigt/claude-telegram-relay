# Telegram User Testing Guide — `src/coding` Module

**Generated:** 2026-02-17
**Test suite baseline:** 182 automated tests, 0 failures (7 test files)
**Purpose:** This guide covers scenarios that CANNOT be automated — they require real Telegram interaction, live Claude CLI, and human observation.

---

## Before You Start

**Prerequisites:**
- Bot is running (`bun run start` or PM2 active)
- You have a test directory ready (create `/tmp/test-session` if needed)
- Claude CLI is installed (`claude --version` works in your terminal)

**Create the test directory once:**
```
(in your terminal, not Telegram)
mkdir -p /tmp/test-session
echo "# Test Project" > /tmp/test-session/README.md
git init /tmp/test-session
```

**Log your results** — after each test, note:
- ✅ Passed as expected
- ❌ Failed — what happened instead
- ⚠️ Partially worked — describe what was different

---

## PART 1 — Session Start (`/code new`)

### TEST 1.1 — Basic session start
**Steps:**
1. Send: `/code new /tmp/test-session List the files in this project`

**Expected:**
- Bot replies: `⏳ Starting coding session for test-session...`
- Then: `✅ Started coding session for test-session. Session ID: XXXXXXXX`
- Eventually: `✅ Coding Complete — test-session`

**What to note:** Did both messages arrive? How long did it take?

---

### TEST 1.2 — No args (usage message)
**Steps:**
1. Send: `/code new`

**Expected:**
- Bot replies with usage instructions mentioning `<path> <task>`
- No session started

---

### TEST 1.3 — Path only, no task
**Steps:**
1. Send: `/code new /tmp/test-session`

**Expected:**
- Bot replies: `Please provide a task description.`
- No session started

---

### TEST 1.4 — Tilde path expansion
**Steps:**
1. Send: `/code new ~/Desktop Describe what you see`
   *(Replace `~/Desktop` with a real directory on your machine)*

**Expected:**
- Bot expands `~` to your home directory
- Session starts for that project

**Check:** Does `/code status` show the correct absolute path?

---

### TEST 1.5 — ⚠️ KNOWN BUG: Path with spaces
**Steps:**
1. Create a directory with spaces: `mkdir "/tmp/my test project"` (in terminal)
2. Send: `/code new /tmp/my test project List files`

**Expected (CORRECT behavior):** Session starts in `/tmp/my test project` with task "List files"

**Actual (BUGGY behavior):**
- Bot treats `/tmp/my` as the directory
- `test project List files` becomes the task
- You may see: `✅ Started coding session for my`

**Log:** Does this match the bug description? What session name appears?

---

### TEST 1.6 — `--team` flag
**Steps:**
1. Send: `/code new /tmp/test-session Add a hello world function --team`

**Expected:**
- Session starts with agent team enabled
- Start confirmation mentions: `Agent team: enabled`

---

### TEST 1.7 — `--team` only, no task
**Steps:**
1. Send: `/code new /tmp/test-session --team`

**Expected:**
- Bot replies: `Please provide a task description.`

---

### TEST 1.8 — Nonexistent directory
**Steps:**
1. Send: `/code new /tmp/this-directory-does-not-exist Run tests`

**Expected:**
- Session may start (no validation at start)
- Then fails with: `❌ Coding Failed — this-directory-does-not-exist`

**What error message appears?**

---

## PART 2 — Permission System

### TEST 2.1 — Permission prompt appears
**Steps:**
1. Send: `/code new /tmp/new-unpermitted-dir Some task`
   *(Use a directory NOT previously permitted)*

**Expected:**
- Bot sends permission request message with 3 buttons:
  - `✅ Allow once`
  - `📌 Always allow`
  - `❌ Deny`

---

### TEST 2.2 — Click "Allow once" → session starts
**Steps:**
1. From TEST 2.1 (or new request), tap **✅ Allow once**

**Expected:**
- Bot replies: `✅ Allowed once: /tmp/new-unpermitted-dir`
- Then: `⚙️ Started coding session for new-unpermitted-dir...`
- Session starts

---

### TEST 2.3 — Click "Always allow" → subdirs covered
**Steps:**
1. Request permission for `/tmp/test-root`
2. Tap **📌 Always allow**
3. Send: `/code new /tmp/test-root/subproject Another task`

**Expected:**
- Second session starts WITHOUT asking permission (subdirectory is covered)
- No permission prompt for the subdirectory

---

### TEST 2.4 — Click "Deny"
**Steps:**
1. Request permission for `/tmp/denied-dir`
2. Tap **❌ Deny**

**Expected:**
- Bot replies: `❌ Permission denied for: /tmp/denied-dir`
- No session started

**Then:** Check `/code list` — does the pending session appear?

---

### TEST 2.5 — Pre-approve with `/code permit`
**Steps:**
1. Send: `/code permit /tmp/pre-approved`
2. Then: `/code new /tmp/pre-approved/project Run tests`

**Expected:**
- Step 1: `✅ Directory permitted: /tmp/pre-approved (includes all subdirectories)`
- Step 2: Session starts immediately without permission prompt

---

### TEST 2.6 — List permissions
**Steps:**
1. Send: `/code perms`

**Expected:**
- Lists all permitted directories
- Shows `(+ subdirs)` for prefix-type permissions

---

### TEST 2.7 — Revoke permission
**Steps:**
1. Add permission: `/code permit /tmp/to-revoke`
2. Revoke it: `/code revoke /tmp/to-revoke`
3. Check: `/code perms`

**Expected:**
- Step 2: `✅ Permission revoked for: /tmp/to-revoke`
- Step 3: `/tmp/to-revoke` no longer listed

---

### TEST 2.8 — Revoke non-existent
**Steps:**
1. Send: `/code revoke /tmp/never-was-here`

**Expected:**
- `❓ Directory was not in the permitted list: /tmp/never-was-here`

---

### TEST 2.9 — Stale permission button
**Steps:**
1. Request permission for a directory
2. WAIT — do not click any button
3. Kill the pending session: `/code list` → get ID → `/code stop <id>`
4. Now tap **✅ Allow once** on the OLD permission message

**Expected:**
- Permission granted message appears
- But NO new session start message (session was already killed)

**What happens? Is there any error message?**

---

## PART 3 — Session Management

### TEST 3.1 — List sessions
**Steps:**
1. Start 2-3 sessions (let some complete, leave one running)
2. Send: `/code list`

**Expected:**
- All sessions shown with status icons
- Format: `⚙️ project-name  [Xm Xs]`
- Each has: task preview (truncated to 60 chars) + `/code status <short-id>`
- Desktop sessions show `[desktop]` label

---

### TEST 3.2 — Status of running session
**Steps:**
1. Start a session with a long task
2. Immediately send: `/code status`

**Expected:**
- Shows project name, `⚙️ Running for Xs`, task, session ID, files changed so far

---

### TEST 3.3 — Status with short ID
**Steps:**
1. Start a session, note the 8-char ID from the start message
2. Send: `/code status <first 4 chars of ID>`

**Expected:**
- Shows status for that session

---

### TEST 3.4 — Stop a running session
**Steps:**
1. Start a long-running session
2. Immediately send: `/code stop`

**Expected:**
- `⛔ Session stopped.`
- Status changes to `⛔ Stopped`

---

### TEST 3.5 — Stop with no active session
**Steps:**
1. Send: `/code stop` when no sessions are running

**Expected:**
- `No active session found to stop.`

---

### TEST 3.6 — Logs command
**Steps:**
1. Start a session, wait 15-20 seconds
2. Send: `/code logs`

**Expected:**
- Shows recent Claude output events with timestamps
- Format: `[HH:MM:SS] <event summary>`

---

### TEST 3.7 — Diff command
**Steps:**
1. Start a session that modifies files (e.g., "Add a comment to README.md")
2. After completion, send: `/code diff`

**Expected:**
- Shows git diff --stat output
- Example: `README.md | 1 +`

---

### TEST 3.8 — Diff with no git repo
**Steps:**
1. Start a session in a non-git directory (e.g., `/tmp/test-session` if not git-init'd)
2. Send: `/code diff`

**Expected:**
- `Could not get git diff.`

---

## PART 4 — Question & Plan Approval Flows

> **Setup:** These require tasks that will trigger Claude's AskUserQuestion tool.
> Use a task like: `Ask me what language to use before writing anything`

---

### TEST 4.1 — Question with option buttons
**Steps:**
1. Send: `/code new /tmp/test-session Ask me whether to use TypeScript or JavaScript before writing any file`
2. Wait for Claude to ask the question

**Expected:**
- Bot sends question message with inline buttons (if Claude provides options)
- Buttons like: `TypeScript`, `JavaScript`
- Plus: `✍️ Custom answer` and `🤖 Claude decides`

---

### TEST 4.2 — Click an option button
**Steps:**
1. From TEST 4.1, tap one of the option buttons (e.g., `TypeScript`)

**Expected:**
- Session continues with your choice
- Original question message updates to: `✅ Answered — <project>`
- Shows: Q and A with timestamp

---

### TEST 4.3 — Click "🤖 Claude decides"
**Steps:**
1. When question appears, tap **🤖 Claude decides**

**Expected:**
- Auto-answer "Use your best judgment and continue" sent
- Session continues without your direct input

---

### TEST 4.4 — Click "✍️ Custom answer"
**Steps:**
1. When question appears, tap **✍️ Custom answer**
2. Bot replies: `✍️ Reply to THIS message with your answer` (with force_reply)
3. Reply to THAT message with: `Use Python please`

**Expected:**
- Your reply routes to the session
- Session continues with your answer

---

### TEST 4.5 — Reply directly to question message
**Steps:**
1. When question appears, DON'T tap buttons
2. Use Telegram's reply-to feature on the question message itself
3. Type your answer

**Expected:**
- Answer routes to the session (same as button click)
- Session continues

---

### TEST 4.6 — Ignore question for 15+ minutes
**Steps:**
1. Get a question from Claude
2. Wait 15 minutes without answering

**Expected:**
- Reminder message arrives: `⏰ Reminder — <project> is still waiting`
- Same buttons appear in the reminder

**Note time:** Did it arrive at roughly 15 minutes?

---

### TEST 4.7 — Double-tap approve/answer
**Steps:**
1. Get a question, tap **🤖 Claude decides**
2. Immediately tap **🤖 Claude decides** again on the same message

**Expected:**
- First tap: works normally
- Second tap: error message `❌ Session is not waiting for input` (or similar)

**What error message appears?**

---

### TEST 4.8 — Plan approval: Approve
**Steps:**
1. Start a session that generates a plan (requires Claude in plan mode)
2. When plan appears, tap **✅ Approve**

**Expected:**
- Last plan message updates to: `✅ Plan Approved (HH:MM:SS)`
- Session continues executing the plan

---

### TEST 4.9 — Plan approval: Modify
**Steps:**
1. When plan appears, tap **✏️ Modify**
2. Bot asks: `Reply to this message with your instructions`
3. Reply with: `Also add unit tests`

**Expected:**
- Claude revises the plan
- New plan approval message appears with the same buttons

---

### TEST 4.10 — Plan approval: Cancel
**Steps:**
1. When plan appears, tap **❌ Cancel**

**Expected:**
- `⛔ Session cancelled.`
- Session is killed

---

### TEST 4.11 — Plan approval: Trust Claude
**Steps:**
1. When plan appears, tap **🤖 Trust Claude**

**Expected:**
- Same behavior as Approve
- Session continues

---

## PART 5 — Completion & Error Notifications

### TEST 5.1 — Successful completion message
**Steps:**
1. Start a session with a simple task that will complete
2. Wait for completion

**Expected message contains:**
- `✅ Coding Complete — <project>`
- Task description
- Duration
- Files changed count
- Summary (if any)
- Buttons: `📊 View Diff` and `📄 Full Logs`

---

### TEST 5.2 — Tap "View Diff" on completion message
**Steps:**
1. After completion, tap **📊 View Diff**

**Expected:**
- Git diff --stat shown

---

### TEST 5.3 — Tap "Full Logs" on completion message
**Steps:**
1. After completion, tap **📄 Full Logs**

**Expected:**
- Last 20 log events shown with timestamps

---

### TEST 5.4 — ⚠️ POTENTIAL BUG: Very long completion message
**Steps:**
1. Start a session that changes MANY files (10+) AND has a long summary
2. Observe the completion message

**Expected (CORRECT):** Message sent successfully
**Potential bug:** If the combined text exceeds 4096 characters, Telegram silently rejects the message and you get NO completion notification

**Log:** Did the message arrive? How many files were changed?

---

### TEST 5.5 — Session fails (bad directory)
**Steps:**
1. Send: `/code new /root/no-access-here Do anything`
   *(Or any directory Claude can't access)*

**Expected:**
- `❌ Coding Failed — no-access-here`
- Error message follows

---

## PART 6 — Desktop Session Discovery

### TEST 6.1 — Scan with no desktop sessions
**Steps:**
1. Send: `/code scan`
2. (No Claude Code sessions open on desktop)

**Expected:**
- `🔍 Scanning for desktop sessions...`
- `No desktop sessions found.`

---

### TEST 6.2 — ⚠️ KNOWN BUG: Scan with hyphenated project name
**Steps:**
1. Open a project in a directory with hyphens in the name via Claude Code desktop
   Example: `/Users/<you>/my-api` or `/Users/<you>/claude-telegram-relay`
2. Send: `/code scan`

**Expected (CORRECT):** Shows `my-api` or `claude-telegram-relay` as project name
**Actual (BUGGY behavior):** Path decoded incorrectly — hyphens in directory name become slashes

**Log:** What project name and directory does it show?

---

### TEST 6.3 — Scan finds recent session
**Steps:**
1. Open a project in Claude Code (VS Code or terminal: `claude` command)
2. Do a few interactions
3. Within 60 minutes, send: `/code scan` in Telegram

**Expected:**
- `Found 1 desktop session(s):`
- Shows project name
- Shows `/code status <id>` link

---

### TEST 6.4 — Check status of discovered desktop session
**Steps:**
1. After TEST 6.3, use the suggested `/code status <id>`

**Expected:**
- Shows session info with `[desktop]` source indicator

---

## PART 7 — Bot Restart Scenarios

> ⚠️ These tests require you to restart the bot.
> If using PM2: `pm2 restart relay`
> If running directly: `Ctrl+C` then `bun run start`

### TEST 7.1 — Running session marked as paused after restart
**Steps:**
1. Start a session
2. Restart the bot WHILE session is running
3. Send: `/code list`

**Expected:**
- Session shows as `⏸ Paused` (NOT `⚙️ Running`)
- Session data preserved (project name, task, files changed)

---

### TEST 7.2 — ⚠️ KNOWN ISSUE: Can't answer question after restart
**Steps:**
1. Start a session that asks a question
2. Wait for question message to appear
3. Restart the bot WITHOUT answering
4. Try tapping a button or replying to the question

**Expected (CORRECT behavior):** Some helpful error message
**Actual:** Error message like `Session process is not running`

**Log:** What exact message appears?

---

### TEST 7.3 — ⚠️ KNOWN ISSUE: Reminder lost after restart
**Steps:**
1. Start a session that asks a question
2. Restart the bot within 15 minutes (before reminder fires)
3. Wait 20+ minutes total (past the 15-minute mark)

**Expected (CORRECT):** Reminder should fire at 15 minutes
**Actual:** Reminder will NOT fire (in-memory timer lost on restart)

**Log:** Did you receive a reminder?

---

## PART 8 — Multi-Session Scenarios

### TEST 8.1 — Two concurrent sessions
**Steps:**
1. Send: `/code new /tmp/test-session Task A`
2. Send: `/code new /tmp/test-session Task B`
3. Send: `/code list`

**Expected:**
- Both sessions listed independently
- Different session IDs
- `/code status` defaults to most recent

---

### TEST 8.2 — `/code answer` with two waiting sessions
**Steps:**
1. Start two sessions that both trigger questions
2. Once both are waiting, send: `/code answer Yes please`

**Expected:**
- Answers the most recently started waiting session
- The other session remains waiting

**Which session got the answer?**

---

### TEST 8.3 — Stop by session ID when multiple active
**Steps:**
1. Start 3 sessions
2. Get IDs from `/code list`
3. Send: `/code stop <short-id-of-second-session>`

**Expected:**
- ONLY the specified session stops
- Other two continue running

---

## PART 9 — Help & Edge Commands

### TEST 9.1 — Help command
**Steps:**
1. Send: `/code help`

**Expected:**
- Full command reference with all subcommands listed

---

### TEST 9.2 — No subcommand
**Steps:**
1. Send: `/code`

**Expected:**
- Same as `/code help`

---

### TEST 9.3 — Unknown subcommand
**Steps:**
1. Send: `/code foobar`

**Expected:**
- Same as `/code help` (falls through to default)

---

### TEST 9.4 — Uppercase subcommand
**Steps:**
1. Send: `/code LIST`

**Expected:**
- Works correctly (subcommand is lowercased)

---

## PART 10 — Answer via Direct Text

### TEST 10.1 — `/code answer` fallback
**Steps:**
1. Start a session that asks a question
2. Instead of tapping a button, send: `/code answer My custom text response`

**Expected:**
- `✅ Answer sent.`
- Session continues with your answer

---

### TEST 10.2 — `/code answer` when nothing is waiting
**Steps:**
1. Send: `/code answer something` when no session is waiting

**Expected:**
- `❌ No sessions are currently waiting for input`

---

## Results Tracking Template

Copy this template for each test:

```
TEST X.X — [Test Name]
Status: ✅ / ❌ / ⚠️
What happened:
Expected vs actual:
Error message (if any):
Notes:
```

---

## Known Bugs Confirmed by Automated Tests

These bugs are verified by the automated test suite and DO NOT need manual verification — they are confirmed broken:

| Bug | Location | Automated Test |
|-----|----------|----------------|
| Hyphenated directory names decoded incorrectly by `decodeProjectDir` | `projectScanner.ts:27` | `KNOWN BUG: hyphenated directory names decoded incorrectly` |
| `e2e-tests` becomes `e2e/tests/app` | `projectScanner.ts:27` | `KNOWN BUG: e2e-tests directory name corrupted` |

These bugs explain why `/code scan` may fail to find your desktop sessions if your projects have hyphens in their names.

---

## What the Automated Tests Already Cover (No Manual Testing Needed)

The following are fully covered by 182 automated tests:

- All NDJSON event types (system init, assistant text, tool_use, plan_approval, result)
- All inline keyboard callback routing (`code_answer:option`, `code_answer:skip`, `code_plan:approve`, etc.)
- All customReplyMap flows (custom answer prompt, plan modification reply)
- Permission grant/revoke/check logic (exact vs prefix matching)
- Session file JSONL parsing (empty files, malformed lines, multiple assistant messages)
- InputBridge stdin writing (tool_result, plan_approval_response, user messages)
- ReminderManager scheduling, cancellation, and reminder message content
- File change tracking across all 7 FILE_CHANGE_TOOLS

---

*Generated 2026-02-17 — Automated test baseline: 182 tests, 0 failures*
