# Doc Command Enhancements

**Date:** 2026-03-08
**Branch:** feat/doc-enhancements
**Priority:** Medium
**Working Directory:** /Users/furi/Documents/WorkInGovTech/01_Projects/Tools/claude-telegram-relay

---

## Design Decisions

- **`/doc save` is removed.** The paste-first-then-command workflow is unintuitive and fragile. Replaced by two explicit, intentional flows below.
- **Three save paths:**
  1. `/doc ingest [title]` alone → await-content state → expects text paste (large clipboard, Telegram-split fragments)
  2. `/doc ingest [title]` + file attached in same message → single-shot file KB ingest, no await-content state
  3. `[💾 Save to KB]` single-row inline keyboard button — one-tap save of the last bot response
- **Bare file attachment (no `/doc ingest` pending) → routed to Claude only.** No KB path, no intent keyboard. Simple and unambiguous.
- **`/doc ingest` is the single command for all KB ingestion** — text paste and file attachment both use it.
- **Shared confirmation flow** (inline keyboard only, no free-text state) used by both paths.
- **Collision keyboard is always 2-button:** `[✅ Overwrite] [❌ Cancel]` — no "New title" option at collision stage.

---

## Tasks

### 1. `/doc ingest [title]` — command-first ingestion (text paste or file attachment)

Title is **optional**. Behaviour branches on whether a file is attached to the `/doc ingest` message.

**Path A — text paste (no file attached):**
Bot enters `await-content` state. Existing `TextBurstAccumulator` assembles Telegram-split fragments on 600ms flush.

```
User:  /doc ingest IM8 SSP Notes
Bot:   📋 Ready. Paste your content now. (/cancel to abort)
User:  [pastes 10KB — Telegram splits into N fragments]
       [600ms silence → flush → dedup check passes]
Bot:   ✅ Saved: "IM8 SSP Notes" (10,240 chars)

User:  /doc ingest
Bot:   📋 Ready. Paste your content now. (/cancel to abort)
User:  [pastes 10KB]
Bot:   Suggested title: "RAG Chunking Strategies"
       [✔ Use this title]  [✏️ Enter new title]  [❌ Cancel]
```

**Path B — file attached in same message as `/doc ingest` (single-shot):**
No `await-content` state entered. Bot extracts file text immediately and proceeds to title confirmation.

```
User:  /doc ingest IM8 SSP Notes  [+ IM8_SSP.pdf attached]
Bot:   📄 Reading IM8_SSP.pdf…
       → dedup check passes
Bot:   ✅ Saved: "IM8 SSP Notes" (48,320 chars)

User:  /doc ingest  [+ IM8_SSP.pdf attached]
Bot:   📄 Reading IM8_SSP.pdf…
       Suggested title: "IM8 SSP"
       [✔ Use this title]  [✏️ Enter new title]  [❌ Cancel]
```

**Supported file types (Path B):**

| Extension | Extraction |
|---|---|
| `.pdf` | Claude CLI `pdf` skill |
| `.docx` | Claude CLI `docx` skill |
| `.pptx` | Claude CLI `pptx` skill |
| `.xlsx` | Claude CLI `xlsx` skill |
| `.txt`, `.md` | `bun.file().text()` |

Unsupported type → `❌ Unsupported file type. Supported: PDF, DOCX, PPTX, XLSX, .md, .txt`
File > 20 MB → `❌ File too large (max 20 MB).`
Empty extraction → `❌ Could not extract text from this file.`

**Title collision (both paths):**
```
Bot:   ⚠️ "IM8 SSP Notes" already exists.
       [✅ Overwrite]  [❌ Cancel]
```

**State machine (`pendingIngestStates`):**
- Type: `Map<string, PendingIngestState>`
- `PendingIngestState = { stage: 'await-content' | 'await-title' | 'await-title-text' | 'await-dedup-resolution', title?: string, body?: string, expiresAt: number }`
- **Path A** (`/doc ingest` alone): stage `await-content`, store optional title, TTL 2 min
  - Incoming text → fed to `TextBurstAccumulator`; NOT routed to Claude
  - On debouncer flush: if title → `checkTitleCollision()` → save or collision; if no title → suggest → stage `await-title`
- **Path B** (`/doc ingest` + file): skip `await-content` entirely — extract immediately, proceed to title confirm or save
- `[✏️ Enter new title]` → stage `await-title-text`; next free-text captured as title (not routed to Claude)
- On title confirmed → `checkTitleCollision(title)` → save or collision
- Collision: `[✅ Overwrite] [❌ Cancel]` only
- `/cancel` at any stage → abort, clear state, reply "Cancelled."
- TTL expiry on `await-content` before flush → "Timed out. Send `/doc ingest` again."

**Implementation Checklist:**
- [x] `/doc ingest` (no file) → enter `await-content`, reply "📋 Ready. Paste your content now. (/cancel to abort)"
- [x] `/doc ingest <title>` (no file) → enter `await-content` with title stored, same reply
- [x] `/doc ingest` + file attached → skip `await-content`; extract file via Claude CLI skill; proceed to title confirm
- [x] `/doc ingest <title>` + file attached → skip `await-content`; extract file; fast-path to dedup + save
- [x] Type/size guards on Path B: reject unsupported type, reject > 20 MB, reject empty extraction
- [x] `ctx.replyWithChatAction("typing")` before file download + extraction (Path B)
- [x] Skill dispatch: `.pdf` → `pdf`, `.docx` → `docx`, `.pptx` → `pptx`, `.xlsx` → `xlsx`, `.txt`/`.md` → `bun.file().text()`
- [x] Incoming text in `await-content` bypasses Claude routing, feeds `TextBurstAccumulator`
- [x] On flush with title: `checkTitleCollision()` → save immediately or collision keyboard
- [x] On flush without title: suggest title → stage `await-title` → `[✔ Use this title] [✏️ Enter new title] [❌ Cancel]`
- [x] `[✏️ Enter new title]`: stage `await-title-text`; next free-text = new title (not routed to Claude)
- [x] On title confirmed: `checkTitleCollision()` → if clear → `saveDocument()` → `✅ Saved: "<title>" (N chars)`
- [x] Collision: `[✅ Overwrite] [❌ Cancel]`
- [x] TTL expiry on `await-content`: "Timed out. Send `/doc ingest` again." and clear state
- [x] `/cancel` clears state at any stage

**Unit Tests:** `src/documents/ingestFlow.test.ts` — 41 tests · `src/documents/docIngestCallbacks.test.ts` — 20 tests
- [x] text-no-title path: flush → title suggestion shown
- [x] text-title-fast-path: flush → `checkTitleCollision()` → save
- [ ] file-no-title: extract → title suggestion shown (relay-level; covered by ingestFlow.ts determineFlushOutcome + extractFileText.test.ts dispatch)
- [ ] file-title-fast-path: extract → dedup → save (relay-level; covered by fast-path outcome + extractFileText.test.ts)
- [ ] unsupported file type → error message (relay-level guard; SUPPORTED_DOC_EXTS tested in extractFileText.test.ts)
- [ ] oversized file → error message (relay-level guard; not unit-testable without Grammy mock)
- [ ] empty extraction → error message (relay-level guard; not unit-testable without Grammy mock)
- [x] title override (`[✏️ Enter new title]`) captured, not routed to Claude — stage transition verified
- [x] TTL expiry on `await-content` — injected clock tests in determineFlushOutcome
- [x] collision → overwrite: `handleDocOverwrite` extracted to `docIngestCallbacks.ts`, 9 tests: no-state/no-body/no-title → answerExpired; valid state → delete+save+reply+scheduleVerification; operation order verified
- [x] title confirmed → collision path: `handleIngestTitleConfirmed` extracted to `docIngestCallbacks.ts`, 11 tests: no-state/no-body early exit; no-collision → delete+save; collision → stage=await-dedup-resolution, title stored, keyboard shown
- [ ] collision cancel (`di_cancel`) — still inline in relay.ts; relay-level; requires Grammy mock or further extraction
- [ ] cancel mid-flow at each stage — relay-level; map.delete verified by state management tests

---

### 2. `[💾 Save to KB]` inline button — save last bot response

Every bot response gets a single-row `[💾 Save to KB]` inline keyboard button appended below the last message of the turn. User taps it to save that response to the knowledge base. No command needed. No confirmation step — tapping the button goes straight to title suggestion.

**`lastAssistantResponses` map:**
- Type: `Map<string, string[]>` — key = chat context key (chatId + topicId); value = ordered message parts for the last assistant turn
- Separate from all paste/ingest state maps
- Populated: append each outgoing bot message part; reset on each new incoming user message (except messages intercepted by `pendingIngestStates` or `pendingSaveStates`)

**Save flow (triggered by link/callback tap):**
1. Stitch `string[]` parts into one body
2. Suggest title immediately → `[✔ Use this title] [✏️ Enter new title] [❌ Cancel]`
3. On title confirmed: run `checkTitleCollision()` (Task 4) → save or collision flow

**`pendingSaveStates` map:**
- Type: `Map<string, PendingSaveState>`
- `PendingSaveState = { stage: 'await-title' | 'await-title-text' | 'await-dedup-resolution', body: string, suggestedTitle: string, expiresAt: number }`
- TTL: 2 min
- Note: `await-confirm` stage removed — link tap goes directly to `await-title`

**Content:** Save raw — no formatting strip.

**Implementation Checklist:**
- [x] Append `[💾 Save to KB]` single-row inline keyboard button to last message of every bot response
- [x] Add `lastAssistantResponses: Map<string, string[]>` in relay.ts; populate on outgoing bot messages; reset on new user messages not intercepted by pending state maps
- [x] Button tap: stitch parts, create `pendingSaveStates` entry at `await-title`, show title suggestion + `[✔ Use this title] [✏️ Enter new title] [❌ Cancel]` immediately (no confirm step)
- [x] `[✏️ Enter new title]` → stage `await-title-text`; capture next free-text as title
- [x] Dedup check → `[✅ Overwrite] [❌ Cancel]` (Task 4)
- [x] On confirmed save: `saveDocument()` → `✅ Saved: "<title>"`
- [x] `/cancel` or `[❌ Cancel]` clears state at any stage

**Unit Tests:** `src/documents/ingestFlow.test.ts` — covered in buildSaveState + appendAssistantPart tests
- [x] Button tap → stitch parts → `pendingSaveStates` at `await-title` — buildSaveState stage='await-title', parts stitched
- [x] Title suggestion shown immediately (no confirm step) — stage='await-title' not 'await-confirm'
- [x] Title override captured, not routed to Claude — stage transition to 'await-title-text' tested
- [x] TTL expiry on `pendingSaveStates` — expiresAt and overrideable TTL tested
- [ ] Dedup collision → overwrite — `ks_overwrite` callback is still inline in relay.ts; requires extraction or Grammy mock (pattern available from `handleDocOverwrite` in docIngestCallbacks.ts)
- [ ] Dedup collision → cancel (`ks_cancel`) — inline in relay.ts; relay-level
- [ ] Cancel at each stage — relay-level; map.delete not testable without Grammy mock

---

### 3. `/doc list` — numbered list with title and date

**Example output:**
```
Your documents (3):

1. IM8 Low Risk Cloud SSP — 2026-03-07
2. Claude Skills Reference — 2026-02-14
3. RAG Chunking Strategies 2025 — 2026-01-30
```

Date format: `YYYY-MM-DD` (UTC, from `created_at` column). Most recent first.

**Implementation Checklist:**
- [x] Render numbered list with count header; each line: `N. <title> — <YYYY-MM-DD>`
- [x] Sort by `created_at` descending (most recent first)

**Unit Tests:**
- [x] 0 docs → "No documents saved yet."
- [x] 1 doc → correct format
- [x] N docs → sorted descending by date

---

### 4. Pre-save title dedup check (shared gate)

Before any `saveDocument()` call from any path (`/doc ingest`, inline button save, file attachment), check for title collision.

**Behaviour:**
- Collision detected → inline keyboard: `[✅ Overwrite] [❌ Cancel]` (2 buttons only — no "New title" option)
- No collision → save immediately

**Implementation Checklist:**
- [x] `checkTitleCollision(title): Promise<{ exists: boolean, existingTitle?: string }>` — exact + ilike check
- [x] All save paths call this before `saveDocument()`
- [x] Collision shows 2-button inline keyboard: `[✅ Overwrite] [❌ Cancel]`

**Unit Tests:**
- [x] No collision → save proceeds
- [x] Exact collision → keyboard shown
- [x] Case-insensitive collision → keyboard shown
- [x] Overwrite → existing doc replaced
- [x] Cancel → state cleared, no save

---

### 5. Bare file attachment handler — Claude-only path

A file sent **without** `/doc ingest` is routed directly to Claude. No KB ingestion, no intent keyboard, no choice. This keeps the handler trivially simple and eliminates all ambiguity.

To save a file to KB: use `/doc ingest [title]` with the file attached (Task 1 Path B).

**UX flow:**
```
User:  [sends IM8_SSP.pdf]              ← no /doc ingest pending
Bot:   📄 Reading IM8_SSP.pdf…
       [Claude responds with analysis]
       [💾 Save to KB]   ← standard Task 2 button on Claude's response

User:  [sends IM8_SSP.pdf] "What are the controls in section 4?"
Bot:   📄 Reading IM8_SSP.pdf…
       [Claude answers the question]
       [💾 Save to KB]
```

Caption (if present) is used as the prompt to Claude. No caption → Claude summarises the file.

**Extraction** (same skill dispatch as Task 1 Path B):

| Extension | Extraction |
|---|---|
| `.pdf` | Claude CLI `pdf` skill |
| `.docx` | Claude CLI `docx` skill |
| `.pptx` | Claude CLI `pptx` skill |
| `.xlsx` | Claude CLI `xlsx` skill |
| `.txt`, `.md` | `bun.file().text()` |

Unsupported type → `❌ Unsupported file type. To save to KB: send with /doc ingest`
File > 20 MB → `❌ File too large (max 20 MB).`
Empty extraction → `❌ Could not extract text from this file.`

**State:** None. Extracted text passed directly to Claude as context. No maps, no TTL, no pending states. Claude response gets `[💾 Save to KB]` via Task 2 if user wants to save it.

**Note on PPTX collision with visual DNA extraction:** If a future `/dna` or `/design` command is added for visual DNA extraction, it will be a separate explicit command. Bare PPTX attachment routes to Claude only (text extraction + analysis), not visual DNA. No collision.

**Dependency:** None added. Shares the skill dispatch logic with Task 1 Path B — extract to shared `extractFileText(filePath, ext)` utility function.

**Implementation Checklist:**
- [x] Grammy `on("message:document")` handler: if `pendingIngestStates` has entry for this chat → hand off to Task 1 Path B; else → bare-file Claude path
- [x] Type detection: MIME + extension; reject unsupported
- [x] File size check: reject > 20 MB
- [x] `ctx.replyWithChatAction("typing")` before download + extraction
- [x] Download + extract via `extractFileText()` shared utility (returns `{ text, filename }`)
- [x] Empty-text guard
- [x] Caption present → use as Claude prompt; no caption → "Summarise this file: [content]"
- [x] Prepend `[Attached: <filename>]\n<text>` to Claude context
- [x] Claude response gets standard `[💾 Save to KB]` button (Task 2)

**Unit Tests:** `src/documents/extractFileText.test.ts` — 22 tests
- [x] Supported types: pdf, docx, pptx, xlsx, txt, md → correct skill dispatched — all 6 types tested
- [ ] Unsupported type → error message (relay-level guard before extractFileText; SUPPORTED_DOC_EXTS membership tested)
- [ ] Oversized file → error message (relay-level guard; not unit-testable without Grammy mock)
- [ ] No caption → summary prompt constructed (relay-level; not unit-testable without Grammy mock)
- [ ] Caption present → used as Claude prompt (relay-level; not unit-testable without Grammy mock)
- [ ] Empty text extraction → error message (relay-level guard; not unit-testable without Grammy mock)
- [ ] `pendingIngestStates` entry present → hands off to Task 1 Path B (relay-level routing; not unit-testable without Grammy mock)

---

## User E2E Test Checklist

> Run these manually against the live bot after deployment. Tick each item only when the expected outcome is confirmed. Do not run until all unit tests pass.

### Scenario: `/doc ingest` — text paste, title provided (Path A fast path)

- [x] **Step 1** — Send `/doc ingest My Test Doc` → Expected: bot replies "📋 Ready. Paste your content now."
- [x] **Step 2** — Paste ~8KB of text → Expected: bot replies `✅ Saved: "My Test Doc" (N chars)` after ~600ms
- [x] **Step 3** — Send `/doc list` → Expected: "My Test Doc" appears with today's date at top of list
- [x] **Step 4** — Send `/doc query what is this doc about` → Expected: relevant content returned

### Scenario: `/doc ingest` — text paste, no title (Path A with title confirmation)

- [x] **Step 1** — Send `/doc ingest` (no title) → Expected: bot replies "📋 Ready. Paste your content now."
- [x] **Step 2** — Paste text → Expected: bot shows suggested title + `[✔ Use this title] [✏️ Enter new title] [❌ Cancel]`
- [x] **Step 3** — Tap `[✏️ Enter new title]` → Expected: bot prompts for new title — fixed: catch-all `bot.on("callback_query:data")` now calls `next()` for unrecognised prefixes
- [x] **Step 4** — Type custom title → Expected: `✅ Saved: "<custom title>"`

### Scenario: `/doc ingest` — file attached, title provided (Path B fast path)

- [x] **Step 1** — Send `/doc ingest IM8 SSP` with a PDF attached → Expected: bot replies "📄 Reading…" then `✅ Saved: "IM8 SSP" (N chars)`
- [x] **Step 2** — Send `/doc list` → Expected: "IM8 SSP" appears with today's date
- [x] **Step 3** — Send `/doc query what controls are in section 4` → Expected: relevant content returned

### Scenario: `/doc ingest` — file attached, no title (Path B with title confirmation)

- [x] **Step 1** — Send `/doc ingest` with a DOCX/PPTX/XLSX file attached → Expected: "📄 Reading…" then title suggestion keyboard
- [x] **Step 2** — Tap `[✔ Use this title]` → Expected: `✅ Saved: "<filename-derived title>"`

### Scenario: Title collision

- [x] **Step 1** — Send `/doc ingest IM8 SSP` (title already exists) → paste or attach content → Expected: `⚠️ "IM8 SSP" already exists. [✅ Overwrite] [❌ Cancel]`
- [x] **Step 2** — Tap `[✅ Overwrite]` → Expected: `✅ Saved: "IM8 SSP"` (updated)
- [x] **Step 3** — Repeat Step 1 → tap `[❌ Cancel]` → Expected: "Cancelled." no save

### Scenario: `[💾 Save to KB]` — save last bot response

- [x] **Step 1** — Ask the bot any question, get a response → Expected: `[💾 Save to KB]` button appears below response
- [x] **Step 2** — Tap `[💾 Save to KB]` → Expected: title suggestion keyboard appears immediately
- [x] **Step 3** — Tap `[✔ Use this title]` → Expected: `✅ Saved: "<title>"`
- [x] **Step 4** — Send `/doc list` → Expected: saved entry appears

### Scenario: Bare file → Claude only (Task 5)

- [x] **Step 1** — Send a PDF with no `/doc ingest` pending → Expected: "📄 Reading…" then Claude analysis response with `[💾 Save to KB]` button
- [x] **Step 2** — Send same PDF with a question as caption → Expected: Claude answers the question, `[💾 Save to KB]` on response
- [x] **Step 3** — Tap `[💾 Save to KB]` on Claude's response → Expected: title suggestion → save flow

### Scenario: Error handling

- [x] **Step 1** — During `/doc ingest` await-content, wait 2+ minutes without pasting → Expected: "⏱ Timed out. Send /doc ingest again." — fixed: proactive setTimeout now fires at TTL expiry
- [x] **Step 2** — During any pending flow, send `/cancel` → Expected: "Cancelled." and state cleared
- [x] **Step 3** — Send `/doc ingest` with an unsupported file type (e.g. `.zip`) → Expected: `❌ Unsupported file type.`
