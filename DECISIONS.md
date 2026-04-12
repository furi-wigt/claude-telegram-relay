# Decision Journal

## 2026-04-12 — Strip markdown markers from table cells; add language class to fenced code [pending]

**Change**: (1) `markdownTableToPreAscii` now strips `**`, `*`, `__`, `_`, `~~`, backticks from cell content before padding into `<pre>` ASCII table. (2) Fenced code blocks now emit `class="language-{lang}"` when a language tag is present.
**Why**: Telegram does not render HTML tags inside `<pre>` — so `*0 idle*` and `**~12 GB**` appeared as literal asterisks in table cells. Language class was being captured but discarded (`_lang` unused), silently dropping Telegram client syntax highlighting.
**Rejected**: Converting table cells to HTML-formatted text — Telegram `<pre>` does not render inner HTML; stripping is the only viable option.
**Branch**: bugfix/table_pre_markdown_strip

## 2026-04-07 — Fix HTML entity literal display and bracket-span split in Telegram fallback [pending]

**Change**: (1) Added `decodeHtmlEntities()` to all plain-text fallback paths so `&lt;` / `&gt;` / `&amp;` never appear literally. (2) Added `findBracketSpans` + `isInsideBracketSpan` to `smartBoundary.ts`; `smartSplit` and `findBestCutoff` now skip break points inside `[...]` spans.
**Why**: When `markdownToHtml` escapes `<timestamp>` → `&lt;timestamp&gt;` and Telegram rejects the HTML (400 "can't parse entities"), the fallback stripped HTML tags but left entities intact — users saw `&lt;` literally. Separately, `smartSplit` was splitting at `\n` inside `[TBC\n fields in Plan.md]` because it had no awareness of bracket spans, producing broken fragments across two messages.
**Rejected**: (A) Sending plain text from the start — loses formatting for 99% of messages that are valid HTML. (B) Pre-processing to remove angle brackets before `markdownToHtml` — changes semantics; filenames like `output-<timestamp>.md` are user-visible content. (C) Making `scanBreakPoints` bracket-aware — better to keep scanning cheap and filter at selection time in `findBestCutoff`.
**Branch**: bugfix/html-entity-decode-bracket-split
## 2026-04-03 — Streaming SSE over buffered HTTP/1.0 for MLX client [pending]

**Change**: Switched `callMlxGenerate` from `stream: false` (buffered) to `stream: true` (SSE) with `Promise.race`-based per-chunk inactivity timeout.
**Why**: Bun's `fetch` `AbortController.abort()` does not terminate idle HTTP/1.0 TCP connections. With `stream: false`, MLX generates all tokens (60+ min for 4096 tokens) before writing the response — the client hangs the entire time, ignoring the 5-min abort timeout. Night summary failed every night since the MLX prompt grew beyond ~80s generation time. Streaming mode delivers tokens incrementally, and `Promise.race` on `reader.read()` vs a 30s inactivity timeout detects stalls immediately.
**Rejected**: (A) `AbortSignal.timeout()` — same underlying issue; bun's fetch doesn't abort idle HTTP/1.0 connections. (B) Reduce `maxTokens` to 1024 — band-aid; still fails on busy days. (C) `stream: true` without chunk timeout — doesn't catch MLX freezes mid-generation.
**Branch**: bugfix/mlx_streaming_timeout


## 2026-03-29 — pendingPickerMessages map to fix agent-picker dispatch truncation [6885356]

**Change**: Added `pendingPickerMessages: Map<string, string>` in commandCenter.ts to preserve the full user message through the low-confidence agent-picker flow.
**Why**: The `op:` callback reconstructed `userMessage` by parsing the plan display text, which truncated the query at 100 chars via `formatPlanMessage`. Messages over 100 chars were dispatched to agents with only 97 chars — silent data loss.
**Rejected**: Storing in SQLite dispatches table — over-engineered; the map is in-memory, entries live only until dispatch/cancel, and the fallback to `extractUserMessageFromPlan` handles the restart edge case.
**Branch**: bugfix/orch-dispatch-truncation


## 2026-03-28 — Self-learning: pattern-based correction detection over pure LLM [dc055c2]

**Change**: Implemented correction detection as pure regex pattern matcher (4 patterns: negation, restatement, override, frustration) rather than LLM-based semantic analysis.
**Why**: Regex patterns are deterministic, testable, and run at zero latency. LLM-based detection would require a blocking async call per message pair, consume GPU during the nightly routine (which already calls the LLM for the summary), and would itself need correction if it misclassified. Pattern coverage is sufficient — user corrections are almost always syntactically distinguishable.
**Rejected**: LLM semantic analysis for correction detection — deferred. The LLM is still used for synthesizing generalizable rules from 2+ corrections in a session (batch, async, optional).
**Branch**: feat/jarvis-self-learning-phase1

## 2026-03-28 — Confidence tier: 0.70 inline / 0.40 LLM-synthesized / 0.85 explicit [dc055c2]

**Change**: Three distinct confidence tiers for learning entries based on signal origin.
**Why**: Human-originated signals (user explicitly says "no, don't do that") are more reliable than LLM inferences. The 0.70 threshold for retro promotion gates out all LLM-synthesized learnings (0.40) by default — they accumulate evidence via hit_count before becoming candidates. Explicit /reflect feedback (0.85) bypasses the pattern detector entirely and goes straight to retro.
**Rejected**: Uniform confidence for all learnings — would flood the weekly retro with low-quality LLM guesses.
**Branch**: feat/jarvis-self-learning-phase1

## 2026-03-26 — Morning calendar gap-fill: structural over prescriptive [pending]

**Change**: Rewrote atomicBreakdown to compute free time blocks between calendar events, inject structural pre/post meeting tasks, and use visual tiering.
**Why**: Multi-perspective debate concluded that a 9B local model with only calendar title+notes would produce generic/obvious meeting prep suggestions ("Review agenda for X"), eroding trust in the entire briefing within days. Structural approach (tell WHEN, not HOW) is reliable because it depends on calendar data, not LLM judgment quality.
**Rejected**: Context-aware LLM-generated meeting prep — deferred until model can access email/Slack/doc context. Flat task list of 20 — replaced with tiered Priority + "If time allows" sections to respect cognitive load research (3-5 meaningful tasks/day).
**Branch**: feat/morning_calendar_gapfill

## 2026-04-05 — Persist (chatId, threadId) in bb_sessions and dispatches [pending]

**Change**: Added `origin_chat_id` and `origin_thread_id` columns to `bb_sessions` and `dispatches` tables. All dispatch paths (orchestrateMessage, agent-picker, interview pipeline) now set these on the plan and persist them through to the session.
**Why**: Without persisted Telegram coordinates, the session return address exists only on the async call stack. If the bot restarts mid-dispatch, the return address is lost — results cannot be posted back to the correct CC thread. Additionally, sessions cannot be queried by originating thread ("show me all dispatches from this topic").
**Rejected**: (A) Storing in metadata JSON — loses queryability (can't index JSON in SQLite efficiently). (B) Separate mapping table — over-engineered for a 1:1 relationship. (C) In-memory map of sessionId→coordinates — same restart-loss problem as the call stack.
**Branch**: feat/session_telegram_namespace

## 2026-04-05 — Mid-dispatch progress poster as DI callback [pending]

**Change**: Added `DispatchProgressPoster` type and `setProgressPoster()` DI slot. After each blackboard round, `buildProgressSnapshot()` is called and posted to `(origin_chat_id, origin_thread_id)`.
**Why**: `buildProgressSnapshot()` existed but nothing called it. Users had no visibility into multi-round dispatch progress. DI pattern matches existing `setDispatchNotifier()` / `setTopicCreator()` — keeps dispatchEngine free of Telegram/Bot dependencies.
**Rejected**: Directly importing `bot` in dispatchEngine — breaks testability and the pure-logic-module pattern established in finalizer.ts.
**Branch**: feat/session_telegram_namespace

## 2026-04-05 — Dead thread fallback on dispatch [f90f713]

**Change**: Add dead-thread fallback in dispatchEngine, dispatchRunner, and progressIndicator when `meshTopicId` thread is deleted in Telegram.
**Why**: Research Analyst meshTopicId=175 was deleted. CC dispatched → `sendInitialMessage` failed silently (debug log only) → Claude ran 120s → `ctx.reply` to dead thread also silently swallowed → 7534-char response never delivered. User saw nothing.
**Rejected**: Hard-abort on `sendInitialMessage` failure — indicator is cosmetic; Claude should still run and deliver to root chat instead.
**Branch**: bugfix/dead_thread_fallback
