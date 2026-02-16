# Agentic Coding via Telegram — Comprehensive Implementation Plan

**Created**: 2026-02-17
**Status**: Ready for agent team execution
**Branch**: `agentic_coding`

---

## Executive Summary

Extend the Claude Telegram Relay to spawn and manage Claude CLI coding sessions
from Telegram. The user can start, monitor, and continue agentic coding tasks
across devices — from desktop VS Code sessions to mobile Telegram.

### Design Decisions (from user input)

| Concern | Choice |
|---------|--------|
| Task model | **Hybrid** — background execution + pull-on-demand status |
| Observability | **Pinned dashboard** — one pinned message per project, edited in-place |
| Directory permissions | **Per-request** — inline Yes/No/Always buttons + persistent whitelist |
| Desktop session discovery | **Auto-scan** `~/.claude/projects/` |
| Claude permissions | **`--dangerouslySkipPermissions`** — fully autonomous |
| Agent team | **Explicit `--team` flag** in command |
| Multi-session UX | **One pinned message per project** |
| **Interactive input routing** | **Reply-to-message + inline keyboard** — unambiguous, chat unaffected |
| **Plan approval** | **Inline keyboard** — [Approve] [Modify] [Cancel] [Trust Claude] |
| **Wait timeout** | **Remind after 15 min, wait indefinitely** — user always decides |
| **Skip / AI escape hatch** | **Always present** on every question — [🤖 Claude decides] button |

---

## Architecture Overview

```
Telegram Bot (relay.ts)
    │
    ├── /code commands ──────────────────────────────────┐
    │                                                      │
    ├── CodingSessionManager                              │
    │   ├── SessionStore (JSON + optional Supabase)       │
    │   ├── PermissionManager (whitelist + inline keys)   │
    │   ├── ProjectScanner (auto-scan ~/.claude/projects) │
    │   ├── DashboardManager (pinned message per project) │
    │   └── InputRouter (reply-to-message routing)        │
    │                                                      │
    └── CodingSessionRunner                               │
        ├── spawn `claude` with stream-json (bidirectional)│
        ├── stdin pipe ← InputBridge.sendInput()          │
        ├── parse NDJSON stdout stream                    │
        ├── detect: AskUserQuestion, plan_approval        │
        ├── emit: onQuestion, onPlanApproval              │
        ├── emit: onProgress, onComplete, onError         │
        └── store: session ID, files changed, git diff    │
                                                          │
Telegram UI ◄─────────────────────────────────────────────┘
    ├── Pinned message (dashboard per project)
    ├── Inline keyboard (permission requests)
    ├── Question messages (reply-to-message + inline keys)
    ├── Plan approval messages (with Modify flow)
    ├── Reminder messages (15 min timeout)
    └── /code commands output (ephemeral)
```

---

## New File Structure

```
src/
├── coding/
│   ├── sessionManager.ts       # Manage multiple coding sessions
│   ├── sessionRunner.ts        # Spawn + stream Claude CLI (bidirectional stdin/stdout)
│   ├── inputBridge.ts          # Stdin pipe management + tool_result formatting
│   ├── inputRouter.ts          # Route Telegram replies to correct session stdin
│   ├── permissionManager.ts    # Directory whitelist + inline approval UI
│   ├── projectScanner.ts       # Auto-scan ~/.claude/projects/ for sessions
│   ├── dashboardManager.ts     # Pinned message UI per project
│   ├── reminderManager.ts      # 15-min timeout reminders for waiting sessions
│   ├── types.ts                # CodingSession, SessionStatus, PendingQuestion, etc.
│   └── codingCommands.ts       # /code command handler
├── commands/
│   └── botCommands.ts          # Extend with /code registration
```

---

## Module Specifications

### 1. `src/coding/types.ts`

```typescript
export type SessionStatus =
  | "pending_permission"  // Waiting for directory approval
  | "starting"            // Claude process being launched
  | "running"             // Active, Claude working
  | "waiting_for_input"   // Paused: Claude asked a question, awaiting Telegram reply
  | "waiting_for_plan"    // Paused: Claude proposed plan, awaiting approval
  | "paused"              // Process exists, not currently executing
  | "completed"           // Finished successfully
  | "failed"              // Exited with error
  | "killed"              // User terminated

export interface PendingQuestion {
  questionMessageId: number     // Telegram message ID of the question bot sent
  questionText: string          // The question Claude asked
  options?: string[]            // Preset options (if AskUserQuestion had options)
  toolUseId: string             // Claude's tool_use_id (needed for tool_result response)
  askedAt: string               // ISO datetime (for reminder timing)
  reminderSentAt?: string       // ISO datetime of last reminder (if sent)
}

export interface PendingPlanApproval {
  planMessageIds: number[]      // Telegram message IDs of plan messages (may be split)
  planText: string              // Full plan text
  requestId: string             // plan_approval request_id from Claude
  askedAt: string               // ISO datetime
  reminderSentAt?: string
  // When user clicks Modify, we enter this state
  awaitingModificationReplyMessageId?: number  // Message user should reply-to with modifications
}

export interface CodingSession {
  id: string                    // UUID
  chatId: number                // Telegram chat this session belongs to
  pinnedMessageId?: number      // Telegram message ID of pinned dashboard
  directory: string             // Absolute path of project
  projectName: string           // Display name (dirname)
  task: string                  // Original task description
  status: SessionStatus
  claudeSessionId?: string      // Claude's internal session ID (for --resume)
  pid?: number                  // OS process ID while running
  useAgentTeam: boolean         // --use-agent-team flag
  startedAt: string             // ISO datetime
  lastActivityAt: string        // ISO datetime
  completedAt?: string          // ISO datetime
  filesChanged: string[]        // Paths of files edited by Claude
  summary?: string              // Claude's completion summary
  errorMessage?: string         // If failed
  source: "bot" | "desktop"
  // Interactive input state (null when not waiting)
  pendingQuestion?: PendingQuestion
  pendingPlanApproval?: PendingPlanApproval
  // Reminder tracking
  questionReminderTimerId?: ReturnType<typeof setTimeout>
}

export interface PermittedDirectory {
  path: string
  type: "exact" | "prefix"      // exact = this dir only, prefix = all subdirs
  grantedAt: string
  grantedByChatId: number
}
```

---

### 2. `src/coding/permissionManager.ts`

**Responsibilities:**
- Load/save `~/.claude-relay/permitted-dirs.json`
- Check if a directory is permitted (exact match or prefix match)
- Send inline keyboard to Telegram when new directory requested
- Handle callback (Yes once / Always / No)

**Key methods:**
```typescript
class PermissionManager {
  isPermitted(dir: string): boolean
  async requestPermission(ctx, dir: string): Promise<"granted_once" | "granted_always" | "denied">
  grant(dir: string, type: "exact" | "prefix", chatId: number): void
  revoke(dir: string): void
  listPermitted(): PermittedDirectory[]
}
```

**Inline keyboard format:**
```
🔐 Permission Request

Claude wants to code in:
/Users/furi/Documents/WorkInGovTech/my-project

[✅ Allow once] [📌 Always allow] [❌ Deny]
```

**Callback data format:** `code_perm:{action}:{base64(dir)}`
- `action`: `once` | `always` | `deny`

---

### 3. `src/coding/sessionRunner.ts`

**Responsibilities:**
- Spawn `claude` with `--output-format stream-json --dangerouslySkipPermissions` and **bidirectional stdin/stdout pipes**
- Optionally `--resume <session_id>` and `--use-agent-team`
- Parse NDJSON event stream line by line
- **Detect interactive events**: AskUserQuestion tool_use, plan_approval_request
- Track files changed (from tool_use `write_file`, `edit_file` events)
- Emit structured events to caller
- Expose `InputBridge` for injecting user responses
- Handle process lifecycle (start, kill, timeout)

**Spawn command:**
```bash
claude -p "<task>" \
  --output-format stream-json \
  --dangerouslySkipPermissions \
  [--resume <session_id>] \
  [--use-agent-team]
```

**Critical: stdin must be piped, not null:**
```typescript
const proc = spawn([CLAUDE_PATH, "-p", task, "--output-format", "stream-json", "--dangerouslySkipPermissions", ...], {
  stdout: "pipe",
  stderr: "pipe",
  stdin: "pipe",    // ← MUST be piped for bidirectional communication
  cwd: directory,
  env: { ...process.env },
})
const inputBridge = new InputBridge(proc)
```

**Event types from stream-json (to verify empirically):**
```typescript
// Known event shapes (verify with: claude -p "hello" --output-format stream-json)
type StreamEvent =
  | { type: "system"; subtype: "init"; session_id: string }
  | { type: "assistant"; message: { content: ContentBlock[] } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "result"; subtype: "success"; result: string; session_id: string }
  | { type: "result"; subtype: "error"; error: string }
  | { type: "plan_approval_request"; plan: string; request_id: string }  // plan mode only

// AskUserQuestion tool_use detection:
// name === "AskUserQuestion" (or check Claude Code SDK for exact name)
// input.question: string
// input.options?: string[]
```

**Key emitted events:**
```typescript
interface RunnerEvents {
  onStart(pid: number, inputBridge: InputBridge): void
  onProgress(event: { type: string; summary: string; filesChanged: string[] }): void
  // NEW: emitted when Claude calls AskUserQuestion
  onQuestion(question: {
    toolUseId: string
    questionText: string
    options?: string[]
  }): void
  // NEW: emitted when Claude proposes a plan and waits for approval
  onPlanApproval(plan: {
    requestId: string
    planText: string
  }): void
  onComplete(result: { summary: string; filesChanged: string[]; claudeSessionId: string }): void
  onError(error: Error): void
}
```

**Stream parsing logic:**
- Each line: `JSON.parse(line)`
- `type === "system"` && `subtype === "init"` → extract `session_id`
- `type === "assistant"` → extract text content for progress summary
- `type === "tool_use"`:
  - `name === "AskUserQuestion"` (exact name TBD) → emit `onQuestion`, pause logging
  - `name` in `["write_file","edit_file","str_replace_editor","create_file"]` → add to `filesChanged`
  - `name === "bash"` → log command for progress
- `type === "plan_approval_request"` → emit `onPlanApproval`
- `type === "result"` → emit `onComplete` or `onError`

**AskUserQuestion tool name discovery:**
```bash
# Run this to find the exact tool name Claude uses:
claude -p "Ask me a question using AskUserQuestion with options A and B" \
  --output-format stream-json 2>&1 | grep '"name"'
```

---

### 3b. `src/coding/inputBridge.ts`

**Responsibilities:**
- Hold a reference to the Claude subprocess stdin pipe
- Write properly formatted input to Claude's stdin
- Format `tool_result` JSON responses (for AskUserQuestion answers)
- Format `plan_approval_response` JSON (for plan approval)
- Provide `sendText()` for raw conversational continuation

**Why a separate module:** The stdin protocol for Claude stream-json is specific.
Wrong formatting = Claude crashes or ignores input. Isolate this complexity.

```typescript
class InputBridge {
  constructor(private proc: Subprocess)

  // Answer an AskUserQuestion tool call
  sendToolResult(toolUseId: string, content: string): void
  // Format: {"type":"tool_result","tool_use_id":"...","content":"..."}

  // Approve or reject a plan
  sendPlanApproval(requestId: string, approved: boolean, modifications?: string): void
  // Format: {"type":"plan_approval_response","request_id":"...","approve":bool,"content":"..."}

  // Inject a conversational message (e.g. for free-text continuation)
  sendUserMessage(text: string): void
  // Format: {"type":"user","content":"..."}

  isAlive(): boolean
  close(): void
}
```

**stdin protocol reference** (to verify during implementation):
```
# AskUserQuestion response:
{"type":"tool_result","tool_use_id":"toolu_xxx","content":"Vitest"}

# Plan approval:
{"type":"plan_approval_response","request_id":"req_xxx","approve":true}

# Plan rejection with modifications:
{"type":"plan_approval_response","request_id":"req_xxx","approve":false,"content":"Use PostgreSQL not SQLite"}
```

> **Implementation note**: Run `claude -p "hello" --output-format stream-json` and inspect
> the exact event format before implementing. The field names above are based on
> the Claude Code SDK but must be verified against the actual CLI output.

---

### 3c. `src/coding/inputRouter.ts`

**Responsibilities:**
- Track which Telegram message IDs correspond to which pending questions/plans
- When a Telegram message arrives: check if it's a reply-to a tracked question message
- Route the answer to the correct session's `InputBridge`
- Handle the `code_answer:*` and `code_plan:*` callback queries

**Core routing logic:**
```typescript
class InputRouter {
  // Called from relay.ts message handler BEFORE normal routing
  // Returns true if message was handled as a session input
  async tryRouteReply(ctx: Context, sessionManager: CodingSessionManager): Promise<boolean>

  // Called from relay.ts callback_query handler
  async handleCallbackQuery(ctx: Context, sessionManager: CodingSessionManager): Promise<boolean>
}
```

**Reply-to-message detection in `relay.ts`:**
```typescript
bot.on("message:text", async (ctx) => {
  // Priority 1: Check if this is a reply to a pending question
  if (await inputRouter.tryRouteReply(ctx, sessionManager)) return

  // Priority 2: Check for routine creation intent
  if (await detectAndHandle(ctx, text)) return

  // Priority 3: Normal Claude AI chat
  // ...existing code...
})
```

**`tryRouteReply` logic:**
1. Get `replyToMessageId = ctx.message.reply_to_message?.message_id`
2. If null → not a reply → return false
3. Search all active sessions for `pendingQuestion.questionMessageId === replyToMessageId`
   OR `pendingPlanApproval.awaitingModificationReplyMessageId === replyToMessageId`
4. If found → call `sessionManager.answerQuestion(sessionId, text)` → return true
5. If not found → return false (may be a reply to a different bot message, not session-related)

---

### 3d. `src/coding/reminderManager.ts`

**Responsibilities:**
- Schedule 15-minute reminders for sessions in `waiting_for_input` or `waiting_for_plan`
- Send reminder message to Telegram with re-displayed options (so user doesn't have to scroll)
- Cancel reminder when question is answered
- Track `reminderSentAt` to avoid double-reminding

```typescript
class ReminderManager {
  scheduleReminder(session: CodingSession, bot: Bot, delayMs = 900000): void
  cancelReminder(sessionId: string): void
  cancelAll(): void
}
```

**Reminder message format:**
```
⏰ Reminder — my-project is still waiting

Claude asked 15 min ago:
"Which testing framework should I use?"

[Jest] [Vitest] [Bun test] [✍️ Custom] [🤖 Claude decides]

Reply to this message with a custom answer ↩️
```

The reminder message itself also has inline keyboard + reply-to capability.
`InputRouter` must track reminder message IDs too.

---

### 4. `src/coding/projectScanner.ts`

**Responsibilities:**
- Scan `~/.claude/projects/` for Claude Code session files
- Parse session metadata (directory, session ID, last modified)
- Return list of discovered sessions NOT already tracked by relay

**Claude session storage format:**
```
~/.claude/projects/<url-encoded-path>/<session-id>.jsonl
```

The directory name is the URL-encoded absolute path of the project.
e.g. `/Users/furi/Documents/WorkInGovTech/my-project`
→ `-Users-furi-Documents-WorkInGovTech-my-project` (hyphens replace slashes)

**Key methods:**
```typescript
interface DiscoveredSession {
  directory: string
  claudeSessionId: string
  lastModifiedAt: Date
  messageCount: number
  lastAssistantMessage?: string
}

class ProjectScanner {
  async scanAll(): Promise<DiscoveredSession[]>
  async getRecentSessions(sinceMinutes = 60): Promise<DiscoveredSession[]>
  decodeProjectDir(encodedName: string): string
}
```

---

### 5. `src/coding/sessionManager.ts`

**Responsibilities:**
- Central registry for all CodingSessions (both bot-started and desktop-discovered)
- Persists state to `~/.claude-relay/coding-sessions.json`
- Manages lifecycle: create → run → complete/fail
- Orchestrates: PermissionManager + SessionRunner + DashboardManager
- Exposes methods for bot commands

**Key methods:**
```typescript
class CodingSessionManager {
  // Start a new session
  async startSession(chatId: number, ctx: Context, options: {
    directory: string
    task: string
    useAgentTeam?: boolean
  }): Promise<CodingSession>

  // Attach to a discovered desktop session (shows status, enables /code status)
  async attachDesktopSession(chatId: number, discovered: DiscoveredSession): Promise<CodingSession>

  // Get session status text (for /code status)
  getStatusText(sessionId: string): string

  // Get recent log lines (for /code logs)
  async getLogs(sessionId: string, lines?: number): Promise<string>

  // Get git diff (for /code diff)
  async getDiff(sessionId: string): Promise<string>

  // List all sessions for a chat
  listForChat(chatId: number): CodingSession[]

  // List all sessions (including desktop-discovered)
  async listAll(chatId: number): Promise<CodingSession[]>

  // Kill a session
  async killSession(sessionId: string): Promise<void>

  // Update pinned dashboard message
  async refreshDashboard(sessionId: string): Promise<void>
}
```

---

### 6. `src/coding/dashboardManager.ts`

**Responsibilities:**
- Create/update/delete Telegram pinned messages as session dashboards
- Format the dashboard text based on session state
- Pin/unpin messages via Telegram API

**Dashboard format (pinned message):**

```
📁 my-project
━━━━━━━━━━━━━━━━━━━━

⚙️ Status: Running
📋 Task: Add OAuth authentication
⏱ Running: 8 min 32 sec
📝 Files changed: 4

Recent activity:
• Modified src/auth/oauth.ts
• Created src/auth/tokens.ts
• Running tests...

─────────────────────
🆔 Session: abc-123-def
📂 /Users/furi/.../my-project
[🔍 Status] [📄 Logs] [📊 Diff] [⛔ Stop]
```

**Status icons:**
- ⚙️ Running | ✅ Completed | ❌ Failed | ⏸ Paused | ⏳ Starting | 🔐 Awaiting permission

**Inline buttons on dashboard:**
- `[🔍 Status]` → sends ephemeral status message
- `[📄 Logs]` → sends last 20 log lines
- `[📊 Diff]` → sends `git diff --stat` summary
- `[⛔ Stop]` → kills the session (with confirmation)

**Callback data format:** `code_dash:{action}:{sessionId}`

---

### 7. `src/coding/codingCommands.ts`

**Bot Commands:**

#### `/code` (alias for `/code help`)
```
Agentic Coding Commands:

/code list              — List all sessions (bot + desktop)
/code new <path> <task> — Start coding session [--team for agent team]
/code status [id]       — Show session details
/code logs [id]         — Show recent Claude output
/code diff [id]         — Show git diff for changed files
/code stop [id]         — Kill a session
/code perms             — Show permitted directories
/code permit <path>     — Pre-approve a directory
/code revoke <path>     — Remove directory permission
/code scan              — Scan for desktop sessions now

[id] defaults to most recent active session
```

#### `/code list` output:
```
📋 Coding Sessions
━━━━━━━━━━━━━━━━━━━

⚙️ my-project  [running 12m]
   "Add OAuth authentication"
   ↳ /code status abc123

✅ api-service  [done 2h ago]
   "Fix query timeout bug"
   ↳ /code status def456

🖥 claude-telegram-relay  [desktop, 35m ago]
   (discovered from VS Code session)
   ↳ /code attach ghi789
```

#### `/code new` flow:
1. Parse: `/code new ~/my-project Add OAuth --team`
2. Resolve absolute path
3. Check permission → if not permitted, show inline keyboard
4. Create CodingSession record
5. Update pinned dashboard to "⏳ Starting..."
6. Start SessionRunner
7. Confirm: "✅ Started coding session for my-project. Pinned dashboard updated."

#### `/code status [id]`:
```
📁 my-project — Status
━━━━━━━━━━━━━━━━━━━━

⚙️ Running for 8 min 32 sec
Task: Add OAuth authentication
Session: abc-123-def

Files changed (4):
• src/auth/oauth.ts
• src/auth/tokens.ts
• src/config/env.ts
• tests/auth.test.ts

Last activity: 45s ago
Claude is: Running test suite...
```

#### `/code logs [id]`:
```
📄 Recent output — my-project
━━━━━━━━━━━━━━━━━━━━

[14:32:01] Created OAuth middleware
[14:32:15] Installing oauth2-client package...
[14:32:45] Writing src/auth/oauth.ts
[14:33:02] Writing tests/auth.test.ts
[14:33:20] Running: bun test
[14:33:35] ✓ 8 tests passing
[14:33:36] Session ready for review
```

#### `/code diff [id]`:
```
📊 Git diff — my-project
━━━━━━━━━━━━━━━━━━━━

 src/auth/oauth.ts      | 142 ++++++++++++++++
 src/auth/tokens.ts     |  48 +++++++
 src/config/env.ts      |   3 +
 tests/auth.test.ts     |  67 ++++++++
 4 files changed, 260 insertions(+)
```

---

---

## Interactive Input: Handling Claude Mid-Session Questions

This section describes the full UX flow when Claude pauses to ask the user a question
while a coding session is running. The user may be on mobile (Telegram) and away from desktop.

### Overview

When Claude calls `AskUserQuestion` or enters plan mode, the session transitions to
`waiting_for_input` or `waiting_for_plan`. The relay:
1. Detects the pause via stream-json event
2. Updates the pinned dashboard to show ❓ status
3. Sends a **question message** to Telegram
4. Waits for the user to respond (indefinitely)
5. Sends a **15-min reminder** if no response
6. Routes the answer to Claude's stdin via `InputBridge`
7. Session resumes, dashboard updates back to ⚙️

---

### UX Flow 1: AskUserQuestion with Preset Options

**Claude calls:** `AskUserQuestion("Which approach?", ["Full refactor", "Minimal patch", "New service"])`

**Relay sends to Telegram:**
```
❓ Claude needs your input — my-project

Which approach should I take?

[Full refactor] [Minimal patch] [New service]
[✍️ Custom answer]  [🤖 Claude decides]

↩️ Or reply to this message with a custom answer
```

- Each option button: callback `code_answer:option:{sessionId}:{toolUseId}:{base64(option)}`
- `✍️ Custom answer`: callback `code_answer:custom:{sessionId}:{toolUseId}` → bot replies "Reply to this message with your answer"
- `🤖 Claude decides`: callback `code_answer:skip:{sessionId}:{toolUseId}` → sends "Use your best judgment and continue"

**After user taps a button:**
1. `InputRouter.handleCallbackQuery` fires
2. `InputBridge.sendToolResult(toolUseId, optionText)` writes to stdin
3. Bot edits question message:
   ```
   ✅ Answered — my-project
   Q: Which approach should I take?
   A: "Full refactor" (14:32)
   ```
4. Dashboard pin updates: ⚙️ Running
5. Reminder timer cancelled

---

### UX Flow 2: AskUserQuestion Open Question (No Options)

**Claude calls:** `AskUserQuestion("What's the expected null behavior in /api/users?")`

**Relay sends to Telegram:**
```
❓ Claude needs your input — my-project

What's the expected null behavior in /api/users?

[🤖 Claude decides]

↩️ Reply to this message to answer
```

**User replies to that specific message** (Telegram reply feature):
1. `InputRouter.tryRouteReply` detects `reply_to_message.message_id === questionMessageId`
2. `InputBridge.sendToolResult(toolUseId, userText)` writes to stdin
3. Question message edited to show answer
4. Session resumes

**Fallback if user can't use reply-to:**
```
/code answer Return 404 for null user IDs
```
The `/code answer` command routes to the most recent `waiting_for_input` session.

---

### UX Flow 3: Plan Approval

**Claude enters plan mode and proposes:**
```
I'll implement OAuth in 6 steps:
1. Install oauth2-client
2. Create src/auth/oauth.ts
3. Add callback route
4. Create token refresh logic
5. Add tests
6. Update .env.example
```

**Relay sends to Telegram:**
```
📋 Plan for approval — my-project

I'll implement OAuth in 6 steps:
1. Install oauth2-client
2. Create src/auth/oauth.ts
[... full plan ...]

[✅ Approve]  [✏️ Modify]  [❌ Cancel]  [🤖 Trust Claude]
```

- Plan text may be split across multiple messages if > 4096 chars
- Buttons appear on the **last** plan message
- `✅ Approve`: → `InputBridge.sendPlanApproval(requestId, true)`
- `🤖 Trust Claude`: → same as Approve (alias for "auto-approve")
- `❌ Cancel`: → kills the session
- `✏️ Modify`: → bot sends a new message:

```
✏️ How should the plan be modified?

↩️ Reply to this message with your instructions
```

User replies → relay sends: `InputBridge.sendPlanApproval(requestId, false, modifications)`
Claude revises and re-proposes (new `onPlanApproval` event → new approval message)

---

### UX Flow 4: 15-Minute Reminder

**Trigger:** 15 minutes pass with no answer to a pending question.

**Reminder message:**
```
⏰ Reminder — my-project is still waiting

Claude asked 15 min ago:
"Which approach should I take?"

[Full refactor] [Minimal patch] [New service]
[✍️ Custom answer]  [🤖 Claude decides]

↩️ Reply to this message to answer (or original question above)
```

The reminder message itself has full inline keyboard + reply-to capability.
`InputRouter` tracks reminder message IDs alongside original question message IDs.

**Only one reminder per question** — `reminderSentAt` flag prevents repeat spam.

---

### Dashboard State During Waiting

**Pinned message when `waiting_for_input`:**
```
📁 my-project
━━━━━━━━━━━━━━━━━━━━

❓ Status: Waiting for your input (paused 3 min)
📋 Task: Add OAuth authentication
📝 Files changed so far: 3

Scroll up to answer Claude's question
or use /code answer <text>

─────────────────────
[🔍 Status] [📄 Logs] [📊 Diff] [⛔ Stop]
```

**Pinned message when `waiting_for_plan`:**
```
📁 my-project
━━━━━━━━━━━━━━━━━━━━

📋 Status: Plan approval needed (paused 1 min)
📋 Task: Add OAuth authentication

Scroll up to review and approve the plan

─────────────────────
[🔍 Status] [📄 Logs] [⛔ Cancel]
```

---

### Message Routing Priority in relay.ts

The message handler checks in this order:

```typescript
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text

  // 1. Check for /code answer command (explicit session input)
  if (text.startsWith("/code answer ")) {
    await sessionManager.answerCurrentWaiting(chatId, text.slice(13))
    return
  }

  // 2. Check if this is a reply to a pending question/plan message
  if (await inputRouter.tryRouteReply(ctx, sessionManager)) return

  // 3. Check for routine creation intent
  if (await detectAndHandle(ctx, text)) return

  // 4. Normal Claude AI chat (existing queue logic)
  queueManager.getOrCreate(chatId).enqueue({ ... })
})
```

**Disambiguation guarantee:** Normal messages (not replies) NEVER get routed to a
coding session. Only explicit replies-to-question or `/code answer` reach sessions.
This means the user can freely chat with the AI while a session waits, without
accidentally answering Claude's question.

---

### sessionManager additions for interactive input

```typescript
class CodingSessionManager {
  // ... existing methods ...

  // Called by InputRouter when a reply is matched to a question
  async answerQuestion(sessionId: string, answer: string): Promise<void>
  // 1. Find session, verify status === "waiting_for_input"
  // 2. inputBridge.sendToolResult(pendingQuestion.toolUseId, answer)
  // 3. Clear pendingQuestion, update status to "running"
  // 4. Cancel reminder timer
  // 5. Edit question message to show answer
  // 6. Refresh pinned dashboard

  // Called when plan approval buttons are tapped
  async approvePlan(sessionId: string, approved: boolean, modifications?: string): Promise<void>
  // 1. inputBridge.sendPlanApproval(pendingPlanApproval.requestId, approved, modifications)
  // 2. If approved: clear pendingPlanApproval, status = "running"
  // 3. If denied with modifications: status stays "waiting_for_plan" (new plan incoming)
  // 4. If cancel: killSession(sessionId)

  // Answer the most recently waiting session (for /code answer fallback)
  async answerCurrentWaiting(chatId: number, answer: string): Promise<void>
}
```

---

## Completion Notification

When a session completes, send a chat message (NOT just update pinned):

```
✅ Coding Complete — my-project

Task: Add OAuth authentication
Duration: 14 min 23 sec
Files changed: 4

Summary:
Implemented OAuth 2.0 authentication with GitHub provider. Created
oauth.ts middleware, token refresh logic, and 8 passing tests.
Added required env vars to .env.example.

[📊 View Diff] [📄 Full Logs] [↩️ Continue]
```

---

## Integration Points with Existing Code

### `src/commands/botCommands.ts`
- Add `/code` command registration call to `registerCommands()`
- Import `registerCodingCommands()` from `codingCommands.ts`

### `src/relay.ts`

**Initialization additions (at startup):**
```typescript
const sessionManager = new CodingSessionManager({ ... })
const inputRouter = new InputRouter()
const reminderManager = new ReminderManager()

// Start background auto-scan for desktop sessions
if (CODING_AUTO_SCAN_INTERVAL > 0) {
  setInterval(() => sessionManager.syncDesktopSessions(chatId), CODING_AUTO_SCAN_INTERVAL)
}
```

**Message handler additions (BEFORE existing handlers):**
```typescript
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text
  const chatId = ctx.chat?.id
  if (!chatId) return

  // Priority 1: /code answer explicit routing
  if (text.startsWith("/code answer ")) {
    await sessionManager.answerCurrentWaiting(chatId, text.slice(13).trim())
    return
  }

  // Priority 2: Reply-to-message routing to coding sessions
  if (await inputRouter.tryRouteReply(ctx, sessionManager)) return

  // Priority 3: Routine detection
  if (await detectAndHandle(ctx, text)) return

  // ... existing queue/AI chat logic ...
})
```

**Callback query handler additions:**
```typescript
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data

  // Coding session callbacks
  if (data.startsWith("code_answer:") || data.startsWith("code_plan:") || data.startsWith("code_dash:")) {
    await inputRouter.handleCallbackQuery(ctx, sessionManager)
    return
  }

  // Existing callback handlers (routines, permissions, etc.)
  // ...
})
```

**Graceful shutdown additions:**
```typescript
process.on('SIGINT', async () => {
  reminderManager.cancelAll()
  await sessionManager.pauseAllRunning()   // Don't kill sessions, just detach
  // ... existing shutdown ...
})
```

### `.env` additions
```
# Agentic Coding
CODING_SESSIONS_DIR=~/.claude-relay/coding-sessions
CODING_LOG_DIR=~/.claude-relay/coding-logs
CODING_AUTO_SCAN_INTERVAL=300000    # 5 min, 0 to disable
CODING_SESSION_TIMEOUT=3600000      # 1h max per session
```

---

## Data Persistence

### `~/.claude-relay/permitted-dirs.json`
```json
{
  "permitted": [
    {
      "path": "/Users/furi/Documents/WorkInGovTech",
      "type": "prefix",
      "grantedAt": "2026-02-17T16:19:22Z",
      "grantedByChatId": 123456789
    }
  ]
}
```

### `~/.claude-relay/coding-sessions.json`
```json
{
  "sessions": [
    {
      "id": "uuid-here",
      "chatId": 123456789,
      "pinnedMessageId": 456,
      "directory": "/Users/furi/.../my-project",
      "projectName": "my-project",
      "task": "Add OAuth authentication",
      "status": "completed",
      "claudeSessionId": "abc-123-def",
      "useAgentTeam": false,
      "startedAt": "2026-02-17T14:20:00Z",
      "lastActivityAt": "2026-02-17T14:34:23Z",
      "completedAt": "2026-02-17T14:34:23Z",
      "filesChanged": ["src/auth/oauth.ts", "tests/auth.test.ts"],
      "summary": "Implemented OAuth 2.0...",
      "source": "bot"
    }
  ]
}
```

### Per-session log files
`~/.claude-relay/coding-logs/<session-id>.ndjson`
- Raw NDJSON stream from Claude (for `/code logs`)
- Kept for 7 days, then pruned

---

## Security Considerations

1. **Directory traversal**: Validate all paths are absolute and normalized before use
2. **Permission check always**: Every `callClaude` in coding context MUST check `PermissionManager.isPermitted()` first
3. **Only authorized Telegram user**: Existing `ALLOWED_USER_ID` check applies
4. **dangerouslySkipPermissions**: This is intentional and scoped — only used for coding sessions in permitted directories, never for conversational prompts
5. **Log file size**: Cap per-session log at 10MB, rotating oldest lines

---

## Implementation Order (for agent team)

### Phase 1: Core Infrastructure
1. `src/coding/types.ts` — All type definitions (CodingSession, PendingQuestion, PendingPlanApproval, etc.)
2. `src/coding/permissionManager.ts` — Directory whitelist + inline approval UI
3. `src/coding/projectScanner.ts` — Auto-scan `~/.claude/projects/`

### Phase 2: Session Execution (bidirectional)
4. `src/coding/inputBridge.ts` — stdin pipe management + tool_result/plan_approval formatting
5. `src/coding/sessionRunner.ts` — Spawn Claude with stdin:"pipe", parse stream, emit onQuestion/onPlanApproval
6. `src/coding/reminderManager.ts` — 15-min reminder scheduling
7. `src/coding/sessionManager.ts` — Orchestrator / registry (include answerQuestion, approvePlan methods)

### Phase 3: Telegram UI + Routing
8. `src/coding/dashboardManager.ts` — Pinned message dashboard (includes waiting states)
9. `src/coding/inputRouter.ts` — Reply-to-message routing + callback query handling
10. `src/coding/codingCommands.ts` — `/code` command handler (include `/code answer` fallback)

### Phase 4: Integration
11. Update `src/commands/botCommands.ts` — Register `/code`
12. Update `src/relay.ts` — Wire up inputRouter BEFORE existing message handlers, callbacks for `code_answer:*` and `code_plan:*`
13. Update `.env.example` — Document new env vars

### Phase 5: Tests
14. Unit tests for `permissionManager.ts`
15. Unit tests for `inputBridge.ts` (verify stdin format)
16. Unit tests for `inputRouter.ts` (reply-to matching, callback routing)
17. Unit tests for `sessionRunner.ts` (mock Claude spawn + mock stream events)
18. Unit tests for `projectScanner.ts`
19. Integration test for full session lifecycle including question/answer flow
20. Integration test for plan approval flow (approve, modify, cancel)

---

## Agent Team Execution Instructions

When executing this plan via `agent team` in a new Claude session:

1. **Start with Phase 1** — types.ts first, it unblocks everything
2. **Phase 2 can be partially parallel**: permissionManager and projectScanner are independent
3. **Phase 3 depends on Phase 2**: dashboardManager needs sessionManager
4. **Phase 4 is sequential**: integration changes should come after all new modules exist
5. **Tests last** — after implementation is complete

### Spawn command for agent team session:
```bash
cd /Users/furi/Documents/WorkInGovTech/01_Projects/Tools/claude-telegram-relay
claude --use-agent-team -p "Read .claude/runtime/plan_execute_agentic_coding.md and implement it. Start with Phase 1. Follow the specifications exactly. Use TDD."
```

### Notes for executing agents:
- All new files go in `src/coding/`
- Keep existing `callClaude()` function intact — coding sessions use their own runner
- The existing session system (groupSessions.ts) is SEPARATE — don't touch it
- Use Bun APIs (`spawn` from `bun`) for process management, matching existing code
- All TypeScript, strict mode, matching existing code style
- Log files in `~/.claude-relay/coding-logs/` directory (create if not exists)

---

## Open Questions (Resolve During Implementation)

1. **Claude stream-json output format**: Verify the exact field names for session ID in the `result` event.
   ```bash
   claude -p "hello" --output-format stream-json 2>&1 | cat
   ```

2. **AskUserQuestion tool name**: Find the exact tool name Claude Code uses internally.
   ```bash
   claude -p "Please call AskUserQuestion and ask me what color I prefer" \
     --output-format stream-json 2>&1 | python3 -m json.tool | grep '"name"'
   ```

3. **stdin protocol for tool_result**: Verify the exact JSON format Claude expects on stdin to answer a tool_use event. This is the most critical unknown — test empirically before implementing `InputBridge`.

4. **Plan approval event name**: Verify the event type name for plan approval requests.
   ```bash
   # Create a CLAUDE.md with plan mode settings, then run a task and inspect
   claude -p "add a function" --output-format stream-json 2>&1 | head -50
   ```

5. **`~/.claude/projects/` encoding**: Verify exact encoding scheme for directory names (may use URL encoding or hyphen replacement). Test with a known project.
   ```bash
   ls ~/.claude/projects/ | head -5
   ```

6. **Pinned message limits**: Telegram limits to 1 pinned message in DMs. In group chats, multiple pins work. Confirm whether user uses DM or group with the bot.

7. **Agent team output**: Verify if `--use-agent-team` changes the stream-json format or adds additional event types.

8. **stdin blocking**: Verify whether Claude's process blocks on stdin when waiting for tool_result, or uses a different mechanism. This affects how the relay detects "Claude is waiting".

---

## Success Criteria

### Core Session Management
- [ ] `/code new ~/my-project "Add tests"` starts a session, shows pinned dashboard
- [ ] Session runs autonomously with `--dangerouslySkipPermissions`
- [ ] `/code status` shows current progress without flooding chat
- [ ] `/code list` shows both bot-started AND desktop sessions
- [ ] First use of a new directory shows inline approval keyboard
- [ ] `/code new ~/my-project "Add tests" --team` uses `--use-agent-team`
- [ ] Completion sends a summary notification to chat
- [ ] Pinned dashboard is edited (not reposted) throughout session

### Interactive Input (Mobile UX)
- [ ] When Claude calls AskUserQuestion with options → inline keyboard appears in Telegram
- [ ] When Claude calls AskUserQuestion open question → reply-to-message prompt appears
- [ ] Tapping an option button → Claude receives answer and continues
- [ ] Replying to the question message (Telegram reply) → Claude receives answer and continues
- [ ] Tapping `[🤖 Claude decides]` → Claude auto-continues with best judgment
- [ ] Normal chat messages (not replies) are NOT routed to waiting coding sessions
- [ ] `/code answer <text>` routes to the most recent waiting session
- [ ] Plan approval message appears with [Approve] [Modify] [Cancel] [Trust Claude]
- [ ] [Modify] → user types modifications as reply → Claude revises and re-proposes
- [ ] Pinned dashboard shows ❓ status when waiting, ⚙️ when running
- [ ] Question message is edited to show answer after user responds

### Reminders
- [ ] 15-min reminder sent if no answer to a pending question
- [ ] Reminder includes full inline keyboard (not just text)
- [ ] Only one reminder per question (no double-spam)
- [ ] Reminder cancelled when question is answered

### Quality
- [ ] All new code has unit tests
- [ ] No existing functionality broken
- [ ] InputBridge stdin format verified empirically before implementation

---

*Plan generated via sequential thinking + user preference gathering on 2026-02-17*
