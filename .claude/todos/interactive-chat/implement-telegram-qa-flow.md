# Interactive Chat: Telegram Q&A Flow

**Goal:** `interactive-chat`
**Branch:** `interactive_chat` (already active)
**Status:** Updated — multi-round question generation, implementing

---

## Problem Statement

Every Telegram message currently spawns a new Claude CLI process — even simple clarifying
exchanges like "what type of auth?" cost a full spawn. This is expensive and slow.

The solution: a Telegram-native Q&A flow that batches all clarifying questions into a single
conversation with inline keyboard buttons, collects answers, generates a structured plan,
then spawns Claude CLI **once** with full context.

---

## Requirements Summary

| Dimension | Decision |
|-----------|----------|
| **Trigger** | `/plan {task}` command OR Claude signals need for more info |
| **Claude signal** | Pre-prompt instructs Claude to return `{"interactive":true,"questions":[...]}` JSON when ambiguous |
| **Question batch** | Multi-round — Claude generates batch 1, sees answers, generates batch 2 if needed, signals `done:true` when it has enough context |
| **UI** | Inline keyboard buttons (a/b/c/d) + free text input + progress indicator + back/edit button |
| **State storage** | Local file: `{RELAY_DIR}/sessions/{chatId}-interactive.json` (alongside existing session files) |
| **After Q&A** | Save plan → summary card with Confirm + Edit buttons → spawn Claude CLI |
| **Plan path** | `.claude/todos/{goal}/{description}.md` |

---

## Architecture — Multi-Round Question Generation

The key design: Claude is called once per **batch** (not per question). Each batch call
receives all previous Q&A as context, so follow-up questions are aware of prior answers.
Claude signals `"done": true` when it has enough context to implement the task.

```
User: /plan add JWT auth
         │
         ▼  Round 1 — no context yet
   callClaude("generate first batch of questions for: add JWT auth")
         │ returns {goal, description, questions: [q1,q2,q3], done: false}
         ▼
   session.questions += [q1,q2,q3]
   session.currentBatchStart = 0
         │
         ▼  User answers q1, q2, q3 via buttons/text
         │
         ▼  Batch complete → show "Checking for follow-up questions..."
   callClaude("given auth=JWT, framework=React... need more questions?")
         │ returns {questions: [q4,q5], done: false}  ← branched on answers
         ▼
   session.questions += [q4,q5]
   session.completedQA += [{q1,a1},{q2,a2},{q3,a3}]
         │
         ▼  User answers q4, q5
         │
         ▼  Batch complete → check again
   callClaude("given all 5 answers... need more questions?")
         │ returns {done: true}  ← enough context
         ▼
   savePlan() → summary card → Confirm → callClaude(full context)
```

### Session Fields Added for Multi-Round

```typescript
completedQA: { question: string; answer: string }[];  // grows across rounds
currentBatchStart: number;   // index in questions[] where current round starts
round: number;               // 1-based round counter (cap at 3)
```

### Batch Generation Prompts

**Round 1 prompt:**
```
Task: {task}
Generate 2–4 clarifying questions. Return JSON: {goal, description, questions, done: false}
```

**Round 2+ prompt:**
```
Task: {task}

Answers gathered so far:
Q: What type of auth? → JWT
Q: Frontend framework? → React

Do you need more clarifying questions?
- If yes: return {done: false, questions: [...]} (2–4 more, no repeats)
- If enough context: return {done: true, questions: []}
Max 3 rounds total.
```

```
User: /plan add JWT auth
         │
         ▼
   PlanCommandHandler
         │
         ▼
   generateNextBatch(task, completedQA=[])  ← Round 1
         │ returns Question[]
         ▼
   session.questions += batch,  session.round = 1
         │
         ▼
   TelegramUI.buildQuestionMessage(Q1)
         │
         ▼ [User taps button or types]
   CallbackQueryHandler / MessageHandler
         │
         ▼
   StateMachine.handleAnswer()
         │ (loop Q1→Q2→...→Qn)
         ▼
   PlanGenerator.generate() + save()  ──→  .claude/todos/{goal}/{description}.md
         │
         ▼
   TelegramUI.buildSummaryCard() + Confirm/Edit buttons
         │
         ▼ [User confirms]
   relay.ts: callClaude() with bundled context
```

### Auto-Trigger Flow (Claude-initiated)

```
User: "I need to fix the auth bug"
         │
         ▼
   callClaude() ← system prompt includes interactive mode instructions
         │
         │  Claude returns: {"interactive":true,"questions":[...]}
         ▼
   MessageHandler detects JSON signal
         │
         ▼
   → Same Q&A flow as /plan
```

---

## File Structure

### New Files to Create

```
src/interactive/
├── types.ts                  # All shared interfaces
├── session-manager.ts        # File-based session CRUD
├── question-generator.ts     # Anthropic SDK call for questions
├── plan-generator.ts         # Markdown plan writer + file saver
├── telegram-ui.ts            # InlineKeyboard builders + text formatters
├── state-machine.ts          # Core flow control (the orchestrator)
└── __tests__/
    ├── session-manager.test.ts
    ├── question-generator.test.ts
    ├── plan-generator.test.ts
    ├── telegram-ui.test.ts
    └── state-machine.test.ts

src/handlers/
└── plan-command-handler.ts   # /plan command entry point

tests/e2e/
└── interactive-chat.test.ts  # Full E2E test suite

.claude/runtime/sessions/     # Active session JSON files (create dir)
```

### Existing Files to Modify

| File | Change |
|------|--------|
| `src/relay.ts` | Add `bot.on("callback_query:data")` routing for `iq:*` prefix |
| `src/relay.ts` | Add detection of `{"interactive":true,...}` in Claude response |
| `src/relay.ts` | Register `/plan` command |
| `src/commands/botCommands.ts` | Register `/plan` in command handler |
| `src/agents/promptBuilder.ts` | Inject interactive mode instructions into system prompt |

---

## Type Definitions (`src/interactive/types.ts`)

```typescript
export interface QuestionOption {
  label: string;   // Display text (shown on button)
  value: string;   // Stored value
}

export interface Question {
  id: string;               // q1, q2, ...
  question: string;         // The question text
  options: QuestionOption[]; // Up to 4 options (Telegram keyboard limit per row)
  allowFreeText: boolean;   // Can user type a custom answer?
  multiSelect: boolean;     // Can user pick multiple? (not in v1)
}

export type SessionState = "COLLECTING" | "CONFIRMING" | "EXECUTING" | "DONE";

export interface InteractiveSession {
  sessionId: string;
  chatId: number;
  state: SessionState;
  task: string;              // Original task description
  goal: string;              // Slugified goal name
  description: string;       // Slugified description
  questions: Question[];
  answers: (string | null)[]; // null = not yet answered
  currentQuestionIndex: number;
  planPath?: string;          // Set after plan saved
  createdAt: string;
  updatedAt: string;
}

export interface QuestionGenerationResult {
  goal: string;
  description: string;
  questions: Question[];
}
```

---

## Callback Data Format

Telegram has a 64-byte limit on `callback_data`. Use compact format:

| Action | Format | Example |
|--------|--------|---------|
| Select option | `iq:a:{qIdx}:{vIdx}` | `iq:a:0:2` (Q1, option 3) |
| Back | `iq:back` | |
| Confirm | `iq:confirm` | |
| Edit (open menu) | `iq:edit` | |
| Edit specific Q | `iq:eq:{qIdx}` | `iq:eq:2` (edit Q3) |
| Cancel | `iq:cancel` | |

All prefixed with `iq:` to distinguish from existing `code_*` and `routine_*` callbacks.

---

## Session File Format

**Path:** `{RELAY_DIR}/sessions/{chatId}-interactive.json`
(stored alongside existing `{chatId}.json` session files in the same directory)

```json
{
  "sessionId": "uuid-v4",
  "chatId": 123456789,
  "state": "COLLECTING",
  "task": "add JWT authentication",
  "goal": "jwt-auth",
  "description": "implement-jwt-auth-system",
  "questions": [
    {
      "id": "q1",
      "question": "What framework are you using?",
      "options": [
        { "label": "Express", "value": "express" },
        { "label": "Fastify", "value": "fastify" },
        { "label": "Hono", "value": "hono" }
      ],
      "allowFreeText": true,
      "multiSelect": false
    }
  ],
  "answers": [null],
  "currentQuestionIndex": 0,
  "createdAt": "2026-02-18T13:18:06Z",
  "updatedAt": "2026-02-18T13:18:06Z"
}
```

---

## UI Examples

### Question Message
```
📋 *Planning: add JWT authentication*
━━━━━━━━━━━━━━━━━━━━━━
Q1 of 4 ▓▓░░░░░░░░ 25%

What framework are you using?

[Express] [Fastify] [Hono]
[✍️ Type your own]
[← Back] [✖ Cancel]
```

### Summary Card
```
✅ *Plan Ready*
━━━━━━━━━━━━━━━━━━━━━━
**Task:** Add JWT authentication

**Q1:** What framework? → Express
**Q2:** Token storage? → HttpOnly cookies
**Q3:** Refresh tokens? → Yes, 7-day expiry
**Q4:** Existing auth? → None, greenfield

📁 Saved to: .claude/todos/jwt-auth/implement-jwt-auth-system.md

[✅ Confirm & Start] [✏️ Edit Answers]
```

---

## System Prompt Addition (`src/agents/promptBuilder.ts`)

Add to the system prompt:

```
INTERACTIVE MODE INSTRUCTIONS:
If the user's request is complex, ambiguous, or requires clarifying information before
you can execute it well, you MUST respond with ONLY the following JSON (no other text):
{
  "interactive": true,
  "goal": "short-slug-for-goal",
  "description": "short-slug-for-description",
  "questions": [
    {
      "id": "q1",
      "question": "The question text",
      "options": [{"label": "Option A", "value": "a"}, {"label": "Option B", "value": "b"}],
      "allowFreeText": false
    }
  ]
}
Generate 3–7 focused questions. Each question should have 2–4 options.
Only use allowFreeText=true when the answer truly needs custom input.
If the task is clear enough to execute directly, respond normally without this JSON.
```

---

## Implementation Steps

### Step 1 — Types & Session Manager
- [ ] Create `src/interactive/types.ts`
- [ ] Create `src/interactive/session-manager.ts` with atomic file writes
- [ ] Create `.claude/runtime/sessions/.gitkeep`
- [ ] Write `src/interactive/__tests__/session-manager.test.ts`
- [ ] Run: `bun test src/interactive/__tests__/session-manager.test.ts`

### Step 2 — Question Generator
- [ ] Create `src/interactive/question-generator.ts`
  - Uses `@anthropic-ai/sdk` directly (not CLI spawn)
  - Check if SDK already in package.json; if not `bun add @anthropic-ai/sdk`
  - Parses Claude's JSON response into `QuestionGenerationResult`
- [ ] Write `src/interactive/__tests__/question-generator.test.ts`
- [ ] Run tests

### Step 3 — Plan Generator
- [ ] Create `src/interactive/plan-generator.ts`
  - `generateMarkdown(session): string` — builds plan markdown
  - `savePlan(session): Promise<string>` — writes to `.claude/todos/{goal}/{description}.md`
  - Creates directories as needed
- [ ] Write `src/interactive/__tests__/plan-generator.test.ts`
- [ ] Run tests

### Step 4 — Telegram UI
- [ ] Create `src/interactive/telegram-ui.ts`
  - `buildQuestionMessage(q, session): {text, keyboard}`
  - `buildProgressText(current, total): string`
  - `buildSummaryCard(session): {text, keyboard}`
  - `buildEditMenu(questions, answers): InlineKeyboard`
- [ ] Write `src/interactive/__tests__/telegram-ui.test.ts`
- [ ] Run tests

### Step 5 — State Machine
- [ ] Create `src/interactive/state-machine.ts`
  - `startPlanSession(ctx, task)`: generates questions, creates session, sends Q1
  - `handleAnswer(ctx, qIdx, vIdx)`: records answer, sends next Q or summary
  - `handleFreeTextAnswer(ctx, text)`: only if current Q allows free text
  - `handleBack(ctx)`: go to previous question
  - `handleEdit(ctx, qIdx)`: jump to specific question
  - `handleConfirm(ctx)`: save plan, spawn Claude
  - `handleCancel(ctx)`: delete session, send cancellation message
- [ ] Write `src/interactive/__tests__/state-machine.test.ts`
- [ ] Run tests

### Step 6 — Command Handler
- [ ] Create `src/handlers/plan-command-handler.ts`
  - Exports `handlePlanCommand(ctx: Context, bot: Bot): Promise<void>`
  - Calls `stateMachine.startPlanSession(ctx, task)`
- [ ] Register in `src/commands/botCommands.ts`: `bot.command("plan", ...)`
- [ ] Add to `/start` and `/help` command lists

### Step 7 — Callback Routing
- [ ] In `src/relay.ts`, add to the `bot.on("callback_query:data")` handler:
  ```typescript
  if (data.startsWith("iq:")) {
    await handleInteractiveCallback(ctx, data, stateMachine);
  }
  ```
- [ ] Create callback routing that maps `iq:*` patterns to state machine methods

### Step 8 — Auto-Trigger Detection
- [ ] In `src/relay.ts` after `callClaude()`, add detection:
  ```typescript
  const trimmed = claudeResponse.trim();
  if (trimmed.startsWith("{") && trimmed.includes('"interactive":true')) {
    const parsed = JSON.parse(trimmed);
    if (parsed.interactive && parsed.questions) {
      await stateMachine.startFromParsed(ctx, parsed);
      return;
    }
  }
  ```
- [ ] Add interactive mode instructions to `src/agents/promptBuilder.ts`

### Step 9 — E2E Tests
- [ ] Create `tests/e2e/interactive-chat.test.ts` (see test cases below)
- [ ] Create `tests/helpers/test-bot.ts` — test harness for bot
- [ ] Run: `bun test tests/e2e/interactive-chat.test.ts`

### Step 10 — Integration Verification
- [ ] Run full test suite: `bun test`
- [ ] Manual test (see Verification Plan below)

---

## E2E Test Cases

### TC01: /plan command starts Q&A flow
```
Given: User sends "/plan add JWT authentication"
When:  PlanCommandHandler runs
Then:
  - Bot replies with Q1 message containing progress "Q1 of N"
  - Bot message includes inline keyboard with options
  - Session file created at .claude/runtime/sessions/{chatId}.json
  - Session state = "COLLECTING", currentQuestionIndex = 0
```

### TC02: Tapping button advances to next question
```
Given: Active session with currentQuestionIndex = 0
When:  User taps button "iq:a:0:1" (Q1, option 2)
Then:
  - Session answers[0] = option[1].value
  - Session currentQuestionIndex = 1
  - Bot replies with Q2 message, progress "Q2 of N"
  - Previous Q1 message buttons are removed (answerQuestion = edit answer text)
```

### TC03: Free text answer accepted when allowed
```
Given: Active session, currentQuestion.allowFreeText = true
When:  User sends text message "custom answer"
Then:
  - Session answers[idx] = "custom answer"
  - Advances to next question
```

### TC04: Regular text ignored when free text not allowed
```
Given: Active session, currentQuestion.allowFreeText = false
When:  User sends text message "something"
Then:
  - Bot replies "Please use the buttons to answer ☝️"
  - Session unchanged
```

### TC05: Back button returns to previous question
```
Given: Active session at Q3 (currentQuestionIndex = 2)
When:  User taps "iq:back"
Then:
  - Session currentQuestionIndex = 1
  - Session answers[2] = null (cleared)
  - Bot shows Q2 again
```

### TC06: Edit menu shown after all questions answered
```
Given: All N questions answered, state = "CONFIRMING"
When:  User taps "iq:edit"
Then:
  - Bot sends edit menu listing all N questions
  - Each question shown as a button to jump to it
```

### TC07: Confirm saves plan and spawns Claude
```
Given: state = "CONFIRMING"
When:  User taps "iq:confirm"
Then:
  - Plan file created at .claude/todos/{goal}/{description}.md
  - Plan file contains all Q&A context
  - callClaude() called with bundled prompt including all answers
  - Session deleted (or state = "DONE")
  - Bot sends "🚀 Starting..." message
```

### TC08: Session persists across restart
```
Given: Session at Q2 saved to disk
When:  Bot process restarted
And:   User taps a button
Then:
  - Session loaded from file
  - Flow continues from Q2
```

### TC09: Two users get independent sessions
```
Given: User A at Q2 of 4, User B at Q1 of 3
When:  User A answers Q2
Then:
  - User A advances to Q3
  - User B's session unchanged
```

### TC10: Cancel clears session
```
Given: Active session
When:  User taps "iq:cancel"
Then:
  - Session file deleted
  - Bot sends "❌ Planning cancelled."
  - Next message treated as normal chat
```

### TC11: Auto-trigger from Claude JSON signal
```
Given: Claude returns {"interactive":true,"questions":[...]}
When:  MessageHandler processes Claude response
Then:
  - Bot does NOT display the JSON text
  - Bot enters Q&A mode using the parsed questions
  - Session created
```

### TC12: /plan with no task shows usage
```
Given: User sends "/plan" with no text
Then:  Bot replies "Usage: /plan <task description>"
```

---

## Plan Markdown Template

When saved to `.claude/todos/{goal}/{description}.md`:

```markdown
# Plan: {task}

**Created:** {timestamp}
**Session:** {sessionId}
**Branch:** interactive_chat

## Task
{task}

## Requirements (Q&A)

{foreach question/answer}
**Q: {question.question}**
A: {answer}

## Context for Implementation

The following answers were gathered from the user to clarify requirements:
{bullet list of all Q&A pairs in natural language}

## Next Steps

Claude CLI was spawned with this full context to implement the task.
```

---

## Verification Plan

### Automated
```bash
# Unit tests
bun test src/interactive/__tests__/

# E2E tests
bun test tests/e2e/interactive-chat.test.ts

# Full suite
bun test
```

### Manual Test Checklist
- [ ] Send `/plan add dark mode to the app`
- [ ] Bot shows Q1 with buttons and "Q1 of N" progress
- [ ] Tap a button → advances to Q2
- [ ] For a free-text question, type a custom answer → advances
- [ ] Tap "← Back" → returns to previous question
- [ ] Complete all questions → summary card shown with Confirm/Edit
- [ ] Tap "✏️ Edit" → edit menu shows all questions
- [ ] Tap a specific question → jumps back to that question
- [ ] Complete again → summary shown
- [ ] Tap "✅ Confirm" → Claude spawned, "🚀 Starting..." shown
- [ ] Check `.claude/todos/dark-mode/add-dark-mode-to-the-app.md` exists
- [ ] Send a complex message (no /plan) → Claude returns interactive JSON → auto Q&A mode
- [ ] Kill and restart bot mid-session → session resumes correctly

---

## Dependencies

- **grammy** (already installed): `InlineKeyboard`, `bot.command()`, `bot.on("callback_query:data")`
- **@anthropic-ai/sdk**: Check if installed; add if not (for question generation without CLI spawn)
- **Node/Bun built-ins**: `crypto.randomUUID()`, `fs/promises` for session files

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Telegram 64-byte callback_data limit | Compact `iq:a:{qIdx}:{vIdx}` format (max ~15 bytes) |
| User types during Q&A (non-free-text Q) | Detect state → reply "Please use the buttons" |
| >4 options from Claude | Cap at 4 per question in question-generator schema |
| Session file corruption | Atomic write: write `.tmp` then rename |
| Long question text | Truncate to 200 chars in message, full text in session JSON |
| Claude returns invalid JSON | Wrap parse in try/catch, fall back to normal response |
| Existing /plan command name conflict | Check botCommands.ts first |

---

## Notes for Implementer (from Codebase Investigation)

### Exact Patterns to Reuse

1. **Multi-step state tracking** → `src/routines/pendingState.ts`
   - Already has `setPending(chatId, state)`, `getPending(chatId)`, `hasPending(chatId)`, `clearPending(chatId)`
   - Use this instead of building new state tracking from scratch

2. **Inline keyboard building** → `src/routines/routineHandler.ts` `buildTargetKeyboard()`
   - Shows exact grammy `InlineKeyboard` pattern with `.text(label, callbackData).row()`

3. **Session file storage** → `src/session/groupSessions.ts`
   - Sessions stored at `{RELAY_DIR}/sessions/{chatId}.json` (NOT `.claude/runtime/sessions/`)
   - `RELAY_DIR` from env, default `~/.claude-relay`
   - Use `loadSession()` / `saveSession()` pattern or create parallel `loadInteractiveSession()`

4. **Callback routing** → `src/relay.ts` line 302
   ```typescript
   bot.on("callback_query:data", async (ctx) => {
     const data = ctx.callbackQuery.data || "";
     if (data.startsWith("code_answer:") || ...) { ... }
     // ADD HERE: if (data.startsWith("iq:")) { ... }
   });
   ```

5. **Registering commands** → `src/commands/botCommands.ts`
   - Follow exact `bot.command("plan", async (ctx) => {...})` pattern inside `registerCommands()`

6. **Prompt builder injection** → `src/agents/promptBuilder.ts`
   - `buildAgentPrompt()` assembles all context
   - Add interactive mode instructions at the **end** of the system prompt section (lines 32-35)

### Actual File Paths (confirmed from investigation)

| What | Actual Path |
|------|-------------|
| Main entry | `src/relay.ts` |
| Command registration | `src/commands/botCommands.ts` |
| Existing callback handler | `src/relay.ts` line 302 |
| Pending state pattern | `src/routines/pendingState.ts` |
| Session files | `{RELAY_DIR}/sessions/{chatId}.json` |
| Prompt builder | `src/agents/promptBuilder.ts` |
| Agent configs | `src/agents/config.ts` |

### Existing Callback Prefixes (don't conflict)
- `code_answer:` — coding session tool use responses
- `code_plan:` — coding session planning
- `code_dash:` — coding dashboard actions
- `routine_target:` — routine group selection

Use `iq:` prefix for all interactive chat callbacks.

### Grammy `InlineKeyboard` docs: https://grammy.dev/plugins/keyboard
### Run `bun test --watch` during development for fast feedback
