# Decision Journal

## 2026-04-22 — CC attachment UX hardening: G1/G2/I1/I2/I3 [pending]

**Change**: Five independent fixes to the CC attachment propagation flow identified via an adversarial 23-scenario UX pre-mortem:
- **G1 (must)**: Merged the separate `ccAlbumAccumulators` (photos) and `ccDocAlbumAccumulators` (documents) into a single `ccAttachmentAccumulators<Map>` keyed by `media_group_id`. Both `message:photo` and `message:document` handlers append to the same entry (`photoFileIds` / `docEntries`) and share a debounce timer. A mixed photo+doc album now produces a single unified dispatch with both `imageContext` and `documentContext` instead of two races.
- **G2 (must)**: Added `src/orchestration/attachmentContinuity.ts` — an in-memory TTL-bound Map (30 min, 200 cap) keyed by `${chatId}:${agentId}`. `runHarness` writes one entry per unique agent post-dispatch (imageContext, documentContext, attachmentPaths). `rerouteToAgent` reads that entry and repopulates the new `DispatchPlan` so follow-up replies like "any more concerns?" keep the original attachment context. `/new` calls `forgetAttachment(chatId)` to prevent stale context leaking into fresh conversations.
- **I1 (should)**: Replaced `filter(r => r !== null)` silent-swallow with `photosMissing`/`docsMissing` counters. A `⚠️ Partial download — failed to fetch N/M photo(s) and K/L document(s)` notice is posted before dispatch when any file fails to download, so the user knows the agent will operate on a subset.
- **I2 (should)**: New `routines/handlers/attachment-gc.ts` runs daily at 03:00 and removes directories under `~/.claude-relay/attachments/` older than `ATTACHMENT_GC_MAX_AGE_DAYS` (default 7). Silent unless something is removed or errors occur. Supports `DRY_RUN=true`. Registered in `config/routines.config.json`.
- **I3 (should)**: `formatPlanMessage` now prepends the first 8 chars of `dispatchId` to the plan header (`🎯 DISPATCH PLAN [a1b2c3d4]`) so concurrent dispatches in the same thread are visually disambiguated.

**Why**: The adversarial trace ran 23 user stories across upload patterns, retries, timing, session edges, and concurrency. Five were trivially broken by the existing code: mixed albums raced each other; the core follow-up pattern ("attach, confirm, ask more") dropped context silently; download failures were invisible; attachment dirs accumulated forever; and parallel dispatches couldn't be told apart in the CC thread. All five fixes are orthogonal and together close the real-world UX gaps without altering the contract schema or state format.

**Rejected**: (a) Cross-referencing photo/doc accumulators via a "mate pointer" instead of merging — retains the race and doubles bookkeeping. (b) Persisting attachment continuity in SQLite — 30-min TTL in memory is sufficient; DB write amplification and schema migrations not worth the durability for a UX helper that expires anyway. (c) Deleting attachment dirs on dispatch complete — breaks suspend/resume and violates the existing `attachmentPaths` contract in `DispatchState`. GC on age is strictly safer. (d) Per-dispatch emoji / color instead of dispatch-id prefix — cute but doesn't survive log grep, and forces agent output filtering to learn the mapping. Short hex is canonical and searchable. (e) Blocking dispatch on partial download failure — too aggressive; users often want to proceed with the subset. Non-blocking warning preserves agency.

**Branch**: feat/cc_attachment_ux_hardening

## 2026-04-22 — CC document attachment propagation to dispatched agents [pending]

**Change**: Added `documentContext?: string` to `DispatchPlan` parallel to the existing `imageContext`. A new CC-gated `bot.on("message:document", ...)` handler in `src/relay.ts` intercepts non-image attachments sent to the Command Center, downloads them to `~/.claude-relay/attachments/{uuid}/{safeName}`, and builds a lightweight listing (`- {name} ({mime}, {size}) → {path}`) injected as `[Attachment context — documents available at dispatch time: ...]` into every harness step's task description (stable order: images first, then documents). Album debounce reuses the 800ms `media_group_id` pattern. Existing `/doc ingest` RAG fallthrough and stateful `pendingIngestStates` flows are preserved by early `return next()`. `attachmentPaths[]` already persisted to `DispatchState`, so files survive suspend/resume.

**Why**: Photos sent to CC were already vision-analyzed and propagated to dispatched agents, but PDFs/XLSX/CSV were dropped at the CC boundary — they only reached the generic RAG pipeline or bare CC-agent Claude, never the dispatched Cloud/Security/Engineering agent. This broke flows like "review this security audit PDF with Security & Compliance". Raw file paths (not extracted content) keep CC entry O(1) per file — agents read lazily via Read/extractPdf tools with `dangerouslySkipPermissions: true`, and the contract per intent decides whether extraction is warranted.

**Rejected**: (a) Upfront content extraction at CC entry — wastes tokens for quick classifications and couples the CC hot path to PDF parser latency/failure modes. (b) Unified `attachmentContext` string field (collapsing image+document into one block) — larger blast radius, breaks existing vision-specific consumers. (c) Sending raw Telegram file_ids — agents cannot read them; file_ids are Telegram Bot API scoped. (d) Writing documents into the same `ccAlbumAccumulators` Map used by photos — conflates two independent debounce windows and breaks the photo vision fan-in.

**Branch**: feat/cc-document-propagation

## 2026-04-22 — Isolated forum topic per dispatch via contract `isolate: true` [pending]

**Change**: Added `isolate: true` frontmatter flag to NLAH contracts. When present, the command center creates a dedicated Telegram forum topic after countdown confirms, and routes all harness step outputs there instead of CC root thread. Topic name is generated by the routine model (4–6 words, Title Case), falling back to a truncated user message on model failure. Applied to `coding.md` by default since its 5-step pipeline (research → design → implement → QA → docs) is the worst offender for CC chat spam.
**Why**: Long coding dispatches (5+ step outputs, each multi-chunked) overwhelm the CC root thread, burying the dispatch plan and drowning other concurrent chat. Isolating per-dispatch into a topic keeps the audit trail intact while reclaiming CC root for quick queries and follow-ups. Opt-in per contract — not all pipelines warrant a new topic (e.g. single-agent research), so isolation is a contract-level policy rather than hardcoded.
**Rejected**: (a) Always-isolate hardcoded based on `classification.isCompound` — fails for multi-step non-compound flows; conflates two orthogonal concerns. (b) Creating the topic before countdown — would orphan topics if user cancels. (c) Naming the topic from raw user prompt — often too long or lower-case; LLM summary is ~2× more readable. Non-fatal fallback on `createForumTopic` failure so dispatch still completes in non-forum groups.
**Branch**: feat/isolated-dispatch-topic

## 2026-04-19 — NLAH loop pattern: [LOOP: <agent-id>] signal [06919a5]

**Change**: Added `[LOOP: <agent-id>]` signal to the NLAH harness enabling a QA/reviewer agent to request a re-run of an implementer agent with configurable max iterations.
**Why**: `[REDIRECT:]` prevents circular routing by blocking agents already in `triedAgents`. A dedicated `[LOOP:]` signal enables opt-in iteration with its own per-agent counter (`loopCounts`) and configurable limit (`maxLoopIterations`, default 3, overridable via `max_loop_iterations` frontmatter). This unlocks the implementer+QA TDD cycle as a contract-native pattern.
**Rejected**: Using `triedAgents` for loop detection (would block second dispatch to same agent); storing loop state outside `DispatchState` (would break resume). Agent ID `engineering-qa` not present in agents config — tests use `code-quality-coach` instead.
**Branch**: feat/nlah-loop-pattern

## 2026-04-21 — Propagate CC session cwd to NLAH dispatch agents [pending]

**Change**: Added `cwd?: string` to `DispatchPlan` and `DispatchState`. Command Center captures `session.cwd` at plan-creation time (all 3 construction sites: orchestrateMessage, picker callback, rerouteToAgent). `dispatchEngine` passes it as `cwdOverride` to the dispatch runner. The relay dispatch runner temporarily pins `session.cwd` on the target agent's session before `processTextMessage` (restored in `finally`) so `lockActiveCwd` picks up the CC cwd for that dispatch.
**Why**: When a user sets `/cwd /my/worktree` in CC and dispatches to Engineering, Engineering runs in its own session cwd (or PROJECT_DIR), not the CC user's intended directory. The cwd context is lost at dispatch boundary. `DispatchState` stores it for suspend/resume durability — matching the same pattern as `attachmentPaths`.
**Rejected**: Mutating the agent's session cwd permanently — would corrupt the agent's own config. Using `/schedule` as a CC session container (Points 2+3 from design discussion) — wrong abstraction; adds hidden coupling with no safe escape hatch. Changing `lockActiveCwd` to accept an override parameter — wider blast radius, touches non-dispatch paths.
**Branch**: feat/dispatch-cwd-propagation

## 2026-04-21 — CC photo/album orchestration + attachment harness [79121df]

**Change**: Photos sent to Command Center are intercepted before the generic photo handler; vision API describes them and the description is injected as `[Attachment context…]` into every harness step's task description. Album multi-photo messages are debounced (300ms) and combined into a single context string. `DispatchState` stores `attachmentPaths[]` so suspend/resume survives a service restart. `dangerouslySkipPermissions: true` is threaded through all CC dispatch paths.
**Why**: Without CC-specific photo handling, images sent to CC were processed by the generic vision pipeline and lost to orchestration — no context reached the dispatched agents. Storing attachment paths in state is required for `[CLARIFY:]` suspend/resume continuity.
**Rejected**: Processing only the first image of an album (user chose all images). Falling through to generic pipeline for CC photos (loses context from harness). Not storing paths in state (paths would be lost on restart, harness resume would have no files to reference).
**Branch**: feat/cc-attachment-vision

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

## 2026-04-21 — CC photo handler registered before general handler [79121df]

**Change**: New `bot.on("message:photo")` handler for CC is registered before the existing general photo handler. It calls `next()` for non-CC chats.
**Why**: Grammy processes middleware in registration order. By intercepting CC first and not calling `next()`, the existing handler is left completely unchanged for all non-CC groups. No modification of existing photo logic needed.
**Rejected**: Modifying the existing handler with an `if (isCommandCenter)` branch — would mix CC orchestration logic into the standard vision pipeline and increase coupling.
**Branch**: feat/cc-attachment-vision
