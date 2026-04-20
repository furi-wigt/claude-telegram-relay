# Decision Journal

## 2026-04-20 — Unify follow-up dispatch via runHarness + add kill-switch [pending]

**Change**: Picker callback in `commandCenter.ts` now delegates to `runHarness` instead of bespoke single-shot dispatch. Added an in-memory `harnessRegistry` plus three independent cancel UX paths (❌ button, `/cancel-dispatch`, `/cancel`-in-CC reroute). Harness gains `outcome: "cancelled"` and aborts in-flight streams via `abortStreamsForDispatch(dispatchId)`.
**Why**: `[REDIRECT:engineering]` tags from agent follow-ups appeared literally in CC because the picker path skipped the harness's signal-tag stripper and re-routing loop. Unifying both dispatch paths through `runHarness` is "Option B" — eliminates the divergence at its root rather than re-implementing tag handling in the picker path. Kill-switch is a forcing function for early Phase-1 surfacing of harness state ownership and a real user need (long-running multi-step dispatches).
**Rejected**: Option A (re-implement signal-tag parsing in picker callback) — duplicates harness logic, perpetuates two code paths. Persistent registry (SQLite) — cancellation is inherently a live-session concern; in-memory map is sufficient and crash-equivalent (process death cancels everything anyway). `/cd` alias — collides visually with `/cwd`.
**Branch**: bugfix/follow_up_redirect_harness

## 2026-04-19 — Infer agent from reply text as post-restart fallback [8714097]

**Change**: Added `inferAgentFromText()` as a 3rd fallback in CC reply routing: `lookupAgentReply → getLastActiveAgent → inferAgentFromText(replyText)`.
**Why**: `pendingAgentReplies` is in-memory and cleared on restart. After a PM2 restart, users replying to pre-restart engineering responses got re-classified as ops-hub. The replied-to message text always contains the agent name (postResult header or plan card), making text-based inference reliable and zero-latency.
**Rejected**: Persisting the tracking map to SQLite — heavier change with more failure surface; text inference is sufficient and simpler.
**Branch**: bugfix/cc-reply-agent-inference

## 2026-04-19 — Track plan message for CC reply-to routing [cafdb39]

**Change**: Call `trackAgentReply` with the dispatch plan message ID immediately after posting it in `orchestrateMessage`.
**Why**: Users replying to the plan card ("DISPATCH PLAN → Engineering") got routed to the wrong agent. `lookupAgentReply` returned null (plan messages were never tracked), so the fallback `getLastActiveAgent` returned the stale last-run agent — often `operations-hub`.
**Rejected**: Re-parsing the plan message text to extract the agent — fragile. Separate `pendingPlanMessages` map — unnecessary, `trackAgentReply` already does exactly what's needed.
**Branch**: bugfix/cc-reply-plan-msg-routing

## 2026-04-18 — /schedule UX: token Jaccard over embedding similarity [feat/schedule_ux_hardening]

**Change**: Similar job detection uses token Jaccard (set intersection / union on word tokens ≥3 chars) instead of embedding similarity.
**Why**: Active `claude-session` jobs are typically <10 at any time. Token Jaccard is O(n×w), deterministic, zero-latency (no MLX call), and sufficient for detecting near-duplicate prompts. Embedding similarity would require MLX to be running and add 200–500ms to every `/schedule` invocation.
**Rejected**: Exact dedup_key (hash match) — too strict, would miss paraphrases. LLM-based similarity — overkill and adds failure surface.
**Branch**: feat/schedule_ux_hardening

## 2026-04-18 — Persistent topic registry: hot map + SQLite fallback [feat/schedule_ux_hardening]

**Change**: `jobTopicRegistry.ts` now has a `initFromDb()` startup loader that rebuilds the hot Map from `jobs.metadata`, plus a SQLite `LIKE` fallback in `getJobTopic()` for individual misses after restart.
**Why**: The previous in-memory-only design silently broke `[CLARIFY:]` resume routing after a PM2 restart — user replies in CC topics were no longer routed to the suspended job. The SQLite fallback closes this gap with minimal code using data already persisted by `claudeSessionExecutor`.
**Rejected**: Writing a separate `job_topic_registry` table — redundant, `jobs.metadata` already stores `jobTopicId`.
**Branch**: feat/schedule_ux_hardening

## 2026-04-18 — Job topic UX: in-memory registry over DB query [feat/job-topic-ux]

**Change**: Job topic → job metadata mapping stored in a module-level `Map` (jobTopicRegistry.ts) rather than querying the SQLite job store.
**Why**: commandCenter.ts does not hold a jobStore reference. Adding one would require wiring through relay.ts and risking accidental coupling. The in-memory map is O(1), zero-DB overhead, and sufficient for V1 — the only downside (topics not re-registered after restart) is acceptable since jobs are typically short-lived.
**Rejected**: Querying jobStore by `metadata.jobTopicId` — would require injecting jobStore into commandCenter or making it a global singleton. Both options add complexity not justified by V1 requirements.
**Branch**: feat/job-topic-ux

## 2026-04-18 — Replace constrained mesh blackboard with NLAH thin harness [feat/nlah_harness_replacement]

**Change**: Deleted the entire blackboard/mesh/review-loop orchestration subsystem (~2500 LOC, 13 files) and replaced it with a 120-LOC NLAH thin harness backed by contract Markdown files.
**Why**: The blackboard pattern produced no measurable improvement in response quality or error reduction. Mesh agent communication was aspirational — in practice only `operations-hub` and `engineering` were used, always through direct Telegram group chats. The review loop, interview pipeline, and task decomposer added latency without visible benefit. Complexity budget was far exceeded for the actual usage pattern.
**Rejected**: Pruning individual blackboard components — the interdependencies meant partial removal would leave dead code and unclear ownership. Full replacement was cleaner and gave a clean audit trail.
**Branch**: feat/nlah_harness_replacement

## 2026-04-18 — Contract files live in ~/.claude-relay/contracts/, not in repo [feat/nlah_harness_replacement]

**Change**: NLAH contracts (`default.md`, `code-review.md`, etc.) are stored in `~/.claude-relay/contracts/` (user data directory), not `config/contracts/` in the repo.
**Why**: Contracts are user-specific routing preferences, not application code. Keeping them outside the repo means users can edit, add, or remove contracts without touching git history. Matches the pattern already used for `agents.json`, `prompts/`, and `models.json`.
**Rejected**: Bundling default contracts in `config/contracts/` with a user-copy override mechanism — adds indirection with no benefit since the default set is small and stable.
**Branch**: feat/nlah_harness_replacement

## 2026-04-12 — Intervention continue-after-resolve: set pending, not running [pending]

**Change**: Known design gap in `InterventionManager` — when an intervention is auto-resolved (auto-approve or confidence-proceed), `clearIntervention(id, "running")` is called, but the executor is not re-invoked. The job sits in `running` until `timeout_ms` elapses, then is retried.
**Why**: Current executors (`RoutineExecutor`, `ApiCallExecutor`) do not emit `awaiting-intervention` in production, so the gap is latent. Fixing it requires either (a) setting status to `pending` on confirm so the scheduler re-dispatches, or (b) calling the executor again inside the resolution callback. Option (a) is cleaner and aligns with the scheduler's existing dispatch model.
**Rejected**: Leaving as-is permanently — unacceptable once `ClaudeSessionExecutor` is implemented (it will emit intervention for user approvals). Timeout rescue is too slow (up to 30 min).
**Branch**: feat/job-queue (fix deferred to ClaudeSessionExecutor plan)

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

## 2026-04-12 — Job Queue Executors: Scheduler → Webhook single-writer pattern [43f6c59]

**Change**: `routine-scheduler` submits jobs via webhook POST, not direct SQLite write.
**Why**: Relay is the single SQLite writer. Multi-process writes to WAL-mode SQLite are safe but create contention; routing through the webhook avoids this and keeps the relay as the authoritative job source.
**Rejected**: Direct `JobStore.insert()` from scheduler — would work but couples two processes to the same DB write path.
**Branch**: feat/job-queue-executors

## 2026-04-12 — ClaudeSessionExecutor v1 re-runs from scratch on retry [43f6c59]

**Change**: `ClaudeSessionExecutor.execute()` ignores checkpoint on retry and re-runs the full dispatch.
**Why**: `executeBlackboardDispatch` has no resume API. Implementing checkpoint resume would require storing partial agent results and resuming mid-graph — deferred to v2.
**Rejected**: Partial resume — premature complexity without a resume API contract.
**Branch**: feat/job-queue-executors

## 2026-04-12 — All routines migrated to handlers/ + RoutineConfig [43f6c59]

**Change**: 11 routines moved from standalone scripts to `routines/handlers/` with `RoutineContext` injection.
**Why**: Eliminates 11× duplicated boilerplate (sendAndRecord, GROUPS, _isEntry, process.exit). Handlers are pure functions testable without Telegram or PM2. Scheduler owns all lifecycle boilerplate.
**Rejected**: Thin wrappers calling original scripts — would keep the duplication.
**Branch**: feat/job-queue-executors

## 2026-04-12 — RoutineExecutor uses lazy dynamic import [43f6c59]

**Change**: Handler modules loaded on first job execution, cached in Map.
**Why**: Avoids startup cost and hardcoded handler list. Supports hot-reload: SIGUSR2 to scheduler → fresh import on next job. Zero changes to executor registration code when adding handlers.
**Rejected**: Static import list in src/jobs/index.ts — requires code change for every new handler.
**Branch**: feat/job-queue-executors

## 2026-04-18 — sessionModel stored as alias shorthand, not full model ID [pending]

**Change**: `SessionState.sessionModel` stores `"opus"|"sonnet"|"haiku"|"local"`, not the full Claude model string.
**Why**: Keeps session files model-agnostic. If Anthropic renames a model (e.g. sonnet-4-6 → sonnet-4-7), only `AGENT_DEFAULT_MODEL_MAP` in modelPrefix.ts needs updating — session files on disk are unaffected.
**Rejected**: Storing full model ID — would require migrating all session files on model rename.
**Branch**: feat/model-session-scoped

## 2026-04-18 — Photo handler uses cache-only getSession() for sessionModel [pending]

**Change**: Photo handler calls `getSession(chatId, threadId)?.sessionModel` (cache lookup, no disk) before the full `loadGroupSession()` call, to pass sessionModel to `resolveModelPrefix()` early (needed for the progress indicator label).
**Why**: The progress indicator is started before session load. Using `getSession()` avoids a second disk read; if the session isn't in cache yet, `sessionModel` is undefined which correctly falls back to agentDefault.
**Rejected**: Moving the full `loadGroupSession()` call before `resolveModelPrefix()` — would block vision analysis start on a disk read.
**Branch**: feat/model-session-scoped
