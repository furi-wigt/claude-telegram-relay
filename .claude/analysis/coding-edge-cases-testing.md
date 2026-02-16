# Edge Case Testing: `src/coding` Module — Telegram User Scenarios

**Date:** 2026-02-17
**Scope:** Manual user testing via Telegram only (all tests done by sending messages/clicking buttons in Telegram)
**Files Analyzed:** `types.ts`, `sessionManager.ts`, `sessionRunner.ts`, `inputBridge.ts`, `inputRouter.ts`, `permissionManager.ts`, `reminderManager.ts`, `projectScanner.ts`, `codingCommands.ts`

---

## How to Use This Guide

Each test scenario shows:
- **What to type/tap in Telegram**
- **What you should see happen**
- **What may actually happen (the bug/edge case)**

Prerequisites:
- Bot is running (`bun run start` in terminal, or PM2 running)
- You have a test project directory (e.g., `/tmp/test-session`)

---

## 1. Session Start — `/code new` Command

### 1.1 Path Handling

**Test: Path with spaces in directory name**
- Type: `/code new ~/My Projects/app Add authentication`
- Expected: Session starts in `~/My Projects/app` with task "Add authentication"
- **Actual bug:** The parser splits on spaces — "My" becomes the directory path, "Projects/app Add authentication" becomes the task. No error shown.

**Test: Relative path (no ~ or /)**
- Type: `/code new myproject Add login`
- Expected: Some error or resolves to `$HOME/myproject`
- Note: Code does `resolve(homedir(), directory)` — so it resolves relative to homedir

**Test: Tilde with no slash**
- Type: `/code new ~project Add login`
- Expected: Should resolve tilde properly
- Note: `slice(2)` strips "~/" but `~project` only has `~` at index 0 — `directory.slice(2)` = `roject` — **silent path bug**

**Test: Nonexistent directory**
- Type: `/code new /tmp/does-not-exist-at-all Run the tests`
- Expected: Warning "directory doesn't exist"
- **Actual:** No validation — Claude CLI will fail when it tries to `cwd` there; you'll get a session failure notification

**Test: Root directory**
- Type: `/code new / List what you see`
- Expected: Permission request appears (since `/` not pre-approved)
- Note: If you click "Always allow", ALL subdirs are permitted — test whether you get the permission prompt

---

### 1.2 Task Description Edge Cases

**Test: Task with backticks**
- Type: `/code new /tmp/test Fix the \`config\` loading issue`
- Expected: Task stored and executed correctly
- Note: Backticks in Telegram may trigger code formatting in display

**Test: Task with emoji**
- Type: `/code new /tmp/test Add 🔐 OAuth authentication`
- Expected: Works normally; emoji stored in task

**Test: Very long task description**
- Type: `/code new /tmp/test` followed by ~500 word task
- Expected: Session starts; long task visible in status
- Note: Test `/code status` to see if task is truncated to 60 chars in list view

**Test: `--team` flag placement**
- Type: `/code new /tmp/test --team Add authentication`
- Expected: Agent team enabled, task = "Add authentication"
- Type: `/code new /tmp/test Add --team authentication`
- Expected: Agent team enabled, task = "Add authentication" (--team stripped from middle)

**Test: Only `--team`, no task**
- Type: `/code new /tmp/test --team`
- Expected: "Please provide a task description" message

---

## 2. Permission System

### 2.1 Grant Permission via Inline Keyboard

**Test: Click "Allow once"**
1. Type `/code new /tmp/newdir Run the tests` (directory NOT pre-approved)
2. Permission request appears with buttons
3. Tap **✅ Allow once**
- Expected: "Allowed once: /tmp/newdir" + session starts

**Test: Click "Always allow"**
1. Same as above but tap **📌 Always allow**
- Expected: "Always allowed (+ subdirs): /tmp/newdir"
- Then: `/code new /tmp/newdir/subproject Run more tests` should start WITHOUT asking permission

**Test: Click "Deny"**
1. Same flow, tap **❌ Deny**
- Expected: "Permission denied for: /tmp/newdir"
- Note: Session remains in `pending_permission` state — test `/code list` to see it

**Test: Stale permission buttons (click after session killed)**
1. Start session, get permission request
2. Wait — do NOT click
3. Type `/code stop` to kill the session
4. Now click "Allow once" on the old permission message
- Expected: Permission granted, but no session to launch
- What happens: "✅ Allowed once" shown, but no "Session started" message

**Test: Click deny, then pre-approve via `/code permit`**
1. Click Deny on a permission request
2. Type `/code permit /tmp/testdir`
3. Type `/code new /tmp/testdir Run a task`
- Expected: Session starts without asking permission again

### 2.2 Permission Commands

**Test: List permissions when empty**
- Type: `/code perms`
- Expected: "No directories permitted yet."

**Test: Permit a directory**
- Type: `/code permit ~/projects`
- Expected: "✅ Directory permitted: /Users/<you>/projects (includes all subdirectories)"

**Test: Revoke existing permission**
1. `/code permit /tmp/test`
2. `/code revoke /tmp/test`
- Expected: "✅ Permission revoked for: /tmp/test"

**Test: Revoke non-existent permission**
- Type: `/code revoke /tmp/neverpermitted`
- Expected: "❓ Directory was not in the permitted list: /tmp/neverpermitted"

**Test: Grant, then check subdirectory is covered**
1. `/code permit ~/projects` (prefix permission)
2. `/code new ~/projects/my-app Add a feature`
- Expected: Session starts WITHOUT asking permission (subdirectory covered)

**Test: Exact match does NOT cover subdirectory**
1. Click "Allow once" on `/tmp/test` permission request
2. Try `/code new /tmp/test/subdir Another task`
- Expected: New permission request for `/tmp/test/subdir`

---

## 3. Session Status & Management

### 3.1 Status Command

**Test: Status with no sessions**
- Type: `/code status`
- Expected: "No active session found. Provide a session ID or start a new one."

**Test: Status with running session**
1. Start a session
2. Type `/code status`
- Expected: Full status block showing project name, task, status icon, files changed, last activity

**Test: Status with partial session ID**
1. Start a session (note the 8-char ID from start confirmation)
2. Type `/code status <first 4 chars>`
- Expected: Shows that session's status

**Test: Status with ambiguous prefix**
1. Start 2 sessions with IDs beginning with same chars (very unlikely but possible)
2. Type `/code status <matching prefix>`
- Expected: Returns first match silently (no warning about ambiguity)

### 3.2 List Command

**Test: List with many sessions**
1. Start 5-10 sessions over time (let them complete)
2. Type `/code list`
- Expected: All sessions shown with icons, time, task preview, ID prefix
- Note: Very long list may approach Telegram's 4096 char limit — test with 20+ sessions

**Test: Desktop sessions via list**
1. Have a Claude Code session running in VS Code or terminal
2. Type `/code scan` then `/code list`
- Expected: Desktop sessions show `[desktop]` label

### 3.3 Stop Command

**Test: Stop running session**
1. Start a session
2. Immediately type `/code stop`
- Expected: "⛔ Session stopped."

**Test: Stop completed session**
1. Let a session complete
2. Type `/code stop <id>`
- Expected: "⛔ Session stopped." (even though already done; it's a no-op)

**Test: Stop with no active session**
- Type `/code stop`
- Expected: "No active session found to stop."

### 3.4 Logs Command

**Test: Logs immediately after start**
1. Start a session
2. Immediately type `/code logs`
- Expected: "No logs available yet." or first few NDJSON events

**Test: Logs after activity**
1. Let session run for 30+ seconds
2. Type `/code logs`
- Expected: Last 20 log entries in human-readable format

---

## 4. Question & Plan Approval Flows

### 4.1 Claude Asks a Question

When Claude runs a task that involves AskUserQuestion, you'll receive an interactive message.

**Test: Click a provided option**
1. Start a session where Claude will ask a question with choices
2. When question appears with option buttons, tap one of the options
- Expected: Button answer sent, session continues, question message updated to show answer

**Test: Click "🤖 Claude decides"**
1. Same setup — when question appears, tap "🤖 Claude decides"
- Expected: Auto-answer "Use your best judgment and continue" sent

**Test: Click "✍️ Custom answer"**
1. When question appears, tap "✍️ Custom answer"
2. Bot replies: "Reply to THIS message with your answer"
3. Reply to that message with your answer text
- Expected: Your text sent as answer, session continues

**Test: Reply DIRECTLY to the question message**
1. When question appears (not via custom answer prompt)
2. Use Telegram's reply-to feature on the question message itself
3. Type your answer
- Expected: Answer routes to the session

**Test: Ignore question for 15 minutes**
1. Start a session that asks a question
2. Wait 15 minutes without answering
- Expected: Reminder message sent with the question again (same buttons)

**Test: Answer after session completes**
1. If a session somehow completes while question is "unanswered"
2. Tap an old question button
- Expected: Error message shown in Telegram ("Session is not waiting for input")

**Test: Double-tap a button**
1. Tap "🤖 Claude decides" TWICE rapidly
- Expected: First tap sends the answer; second tap gets error ("not waiting for input")

---

### 4.2 Plan Approval

**Test: Approve plan**
1. Start a session in "plan mode" (Claude proposes plan before acting)
2. Tap **✅ Approve** on the plan message
- Expected: "✅ Plan Approved (HH:MM:SS)" shown, session continues

**Test: Trust Claude (same as approve)**
1. Same — tap **🤖 Trust Claude**
- Expected: Same as approve

**Test: Modify plan**
1. Tap **✏️ Modify**
2. Bot says "Reply to this message with your instructions"
3. Reply with: "Make it simpler, use existing auth library"
- Expected: Claude revises the plan (new plan appears for approval)

**Test: Cancel plan**
1. Tap **❌ Cancel**
- Expected: Session killed, "⛔ Session cancelled." message

**Test: Very long plan (4000+ chars)**
1. If plan text is very long (rare but possible for complex tasks)
- Expected: Plan split across multiple messages; only the LAST message has the approve/modify/cancel/trust buttons

**Test: Double-tap Approve**
1. Tap Approve twice rapidly
- Expected: First works; second gives error (no pending plan)

---

## 5. Desktop Session Discovery

### 5.1 Scan Command

**Test: Scan with no desktop sessions**
- Type: `/code scan`
- Expected: "No desktop sessions found." after scanning

**Test: Scan with active VS Code session**
1. Open a project in Claude Code via VS Code or terminal
2. Type `/code scan` in Telegram
- Expected: "Found 1 desktop session(s)" with project name listed

**Test: Scan multiple times**
1. Type `/code scan` twice in quick succession
- Expected: No duplicate sessions in `/code list`

**Test: Project with hyphenated directory name**
- Open a project in `/Users/you/my-project` via Claude Code desktop
- Type `/code scan`
- **Bug to test:** The session may show wrong directory path (e.g., `/Users/you/my/project` instead of `/Users/you/my-project`)
- Check: `/code status <id>` and look at the directory shown

---

## 6. Bot Restart Recovery

### 6.1 Sessions After Restart

**Test: Running session survives restart**
1. Start a session
2. Stop the bot (Ctrl+C in terminal or `pm2 restart relay`)
3. Restart the bot
4. Type `/code list`
- Expected: Session shows as "⏸ Paused" (not running)

**Test: Answer pending question after restart**
1. Start a session
2. Wait for Claude to ask a question
3. Restart the bot WITHOUT answering
4. Try to click the question button or reply
- Expected: "Session process is not running" error
- Note: The session is paused; there's no subprocess to receive the answer

**Test: Reminder after restart**
1. Start a session that asks a question
2. Restart the bot within 15 minutes (before reminder fires)
3. Wait past the 15-minute mark
- **Bug to observe:** Reminder will NOT fire because in-memory timers are lost on restart

---

## 7. Multi-Session Scenarios

### 7.1 Multiple Concurrent Sessions

**Test: Two sessions running simultaneously**
1. `/code new /tmp/project1 Add feature A`
2. `/code new /tmp/project2 Add feature B`
3. Both show up in `/code list`
- Expected: Both listed, independent, each with correct status

**Test: `/code answer` with two waiting sessions**
1. Start two sessions that both ask questions
2. Type `/code answer Yes please`
- Expected: Answers the most recently started waiting session (first in sorted list)
- Note: The other session stays waiting

**Test: `/code status` with no args, multiple active**
- Type: `/code status`
- Expected: Shows most recent active session

**Test: `/code stop` with no args, multiple active**
- Type: `/code stop`
- Expected: Kills most recent active session only

---

## 8. Help & Unknown Commands

**Test: Help command**
- Type: `/code help`
- Expected: Full command reference shown

**Test: No subcommand**
- Type: `/code`
- Expected: Help shown (same as `/code help`)

**Test: Unknown subcommand**
- Type: `/code foobar`
- Expected: Help shown (falls through to default)

**Test: Case variations**
- Type: `/code LIST`
- Expected: Works — subcommand lowercased before switch

---

## 9. Completion & Error Notifications

**Test: Session completes successfully**
1. Start a session with a simple task
2. Let it complete
- Expected: Completion message showing task, duration, file count, summary preview
- Expected: Inline buttons: "📊 View Diff" and "📄 Full Logs"

**Test: Tap "View Diff" after completion**
1. After completion message, tap "📊 View Diff"
- Expected: Git diff --stat output shown

**Test: Tap "Full Logs" after completion**
1. Tap "📄 Full Logs"
- Expected: Last 20 log events shown

**Test: Session fails (Claude exits with error)**
1. Start a session in a bad directory or with a broken task
- Expected: "❌ Coding Failed — <projectName>\n<error message>"

**Test: Completion message > 4096 chars**
- Very long task description + very long summary
- Expected: Message sent (or truncated — test what happens)
- **Bug to observe:** If task + summary + filenames > 4096 chars, Telegram API rejects the message silently

---

## 10. Diff & Logs Commands

**Test: Diff with no git repo**
1. Start session in a directory that is NOT a git repo
2. Let it modify files
3. Type `/code diff`
- Expected: "Could not get git diff." message

**Test: Diff with clean repo (no changes)**
1. Start session in git repo
2. Session completes but makes no changes
3. Type `/code diff`
- Expected: "No uncommitted changes."

**Test: Diff with many changed files**
1. Let Claude modify many files
2. Type `/code diff`
- Expected: Git diff --stat output; if output > 4096 chars, Telegram truncates

---

## Priority Test Matrix

| Priority | Test | What to Verify |
|----------|------|----------------|
| 🔴 Critical | Desktop session scan with hyphenated project names | Is path decoded correctly? |
| 🔴 Critical | Bot restart + answer pending question | "Not running" error shown (not crash) |
| 🔴 Critical | Completion/status message near 4096 char limit | Does bot crash silently? |
| 🟠 High | Path with spaces in `/code new` | Task/path split correctly? |
| 🟠 High | Double-tap approve/answer buttons | Graceful error, not crash |
| 🟠 High | Allow once vs Always allow behavior | Subdirectory coverage verified? |
| 🟡 Medium | 15-min reminder fires correctly | After 15 min of waiting |
| 🟡 Medium | `/code answer` with 2 waiting sessions | Correct session answered? |
| 🟡 Medium | Reminder NOT firing after bot restart | Expected behavior known? |
| 🟢 Low | Long task description display in `/code list` | Truncated to 60 chars? |
| 🟢 Low | Tilde-without-slash path `~project` | Correct path resolved? |

---

## Recording Your Test Results

When testing, note:
1. **What you typed in Telegram**
2. **What message/behavior you got**
3. **Whether it matched expected behavior**
4. **Any error messages or unexpected UI**

Share results back so bugs can be prioritized for fixes in a future session.

---

*Generated by Claude Code analysis — 2026-02-17*

---

## User-Reported Bugs (2026-02-17)

### Bug #1: Path with spaces breaks `/code new`
- **Status:** Confirmed by user
- **Symptom:** When directory path contains spaces (e.g., `~/My Projects/app`), the path is split on whitespace — "My" becomes the directory, the rest becomes the task
- **Root cause:** `codingCommands.ts:handleNew` splits args on `/\s+/` — no quoting support
- **Affected file:** `src/coding/codingCommands.ts` lines 209-213
- **Fix needed:** Quote-aware arg parsing or different command syntax (e.g., separate path and task with `|` or require path on its own line)

### Bug #2: `/code scan` does not find desktop sessions
- **Status:** Confirmed by user
- **Symptom:** `/code scan` reports "No desktop sessions found" even when Claude Code sessions exist on the desktop
- **Possible causes:**
  1. `~/.claude/projects/` directory doesn't exist or has unexpected structure
  2. `decodeProjectDir` produces wrong paths (hyphen-to-slash bug) so sessions can't be matched
  3. Sessions are older than the 60-minute cutoff used by `getRecentSessions(60)`
  4. Claude Code on this machine stores sessions in a different location
- **Affected files:** `src/coding/projectScanner.ts` (entire file), `src/coding/sessionManager.ts:syncDesktopSessions`
- **Fix needed:** Debug the actual path structure in `~/.claude/projects/`; fix the `decodeProjectDir` hyphen-to-slash naive replacement; possibly make cutoff configurable

