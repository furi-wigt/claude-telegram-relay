# Changelog

## [Unreleased] / 2026-04-18 — /jobs CRUD: cancel, retry, detail, clear subcommands

### Added
- **`/jobs cancel <id8>`**: Cancel a pending or running job by 8-char ID prefix. Rejects done/cancelled jobs with an error message.
- **`/jobs retry <id8>`**: Re-queue a failed job to pending and clear its error. Rejects non-failed jobs.
- **`/jobs detail <id8>`**: Show full job card with contextual inline action buttons (Cancel for pending/running, Retry for failed, Refresh always).
- **`/jobs clear`**: Purge done/cancelled jobs older than `JOBS_PURGE_DAYS` days (default 7). Reports count purged.
- **`buildDetailKeyboard(job)`** (`src/jobs/telegramJobCommands.ts`): Generates status-aware inline keyboard. No cancel button on done jobs; no retry button on pending jobs.
- **Inline callbacks** `job:cancel:`, `job:retry:`, `job:detail:` resolve jobs by 8-char UUID prefix. Ambiguity (>1 match) returns an error prompt to use a longer prefix.
- **`JobStore.getJobByPrefix(prefix)`** (`src/jobs/jobStore.ts`): `LIKE` lookup returning `{ job, ambiguous }`. O(log n) via existing status index.
- **`JobStore.purgeTerminal(days)`**: Single DELETE of done/cancelled jobs past the age threshold; returns row count.
- **`JobStore.clearError(id)`**: Sets `error = NULL` atomically (used on retry).

### Changed
- **`/jobs` handler**: Subcommand routing extracts first token; bare `/jobs` and status-filter aliases (`/jobs pending`, etc.) unchanged.
- **Callback handler**: Extended to route `cancel`, `retry`, `detail` actions via prefix lookup; existing `confirm`, `skip`, `abort` intervention callbacks untouched.

## [Unreleased] / 2026-04-18 — /schedule UX hardening: confirmation, duplicate detection, persistent topics

### Added
- **Schedule confirmation** (`src/jobs/scheduleConfirmation.ts`): `/schedule <prompt>` now shows an inline `[✅ Queue] [❌ Cancel]` keyboard before submitting. Pending confirmations are stored in a TTL map (5 min expiry, 50-entry cap) and auto-expired.
- **Similar job detection**: Before showing the confirmation keyboard, active `claude-session` jobs are checked for prompt similarity using token Jaccard (threshold 0.6). If similar jobs exist, a verbose warning card is shown for each match — job number, title, status emoji, priority, elapsed time.
- **Persistent job topic registry** (`src/jobs/jobTopicRegistry.ts`): `initFromDb()` reconstructs the topic→job mapping from `jobs.metadata` on startup. A SQLite cold-path fallback also covers individual misses after restart. Ensures `[CLARIFY:]` resume routing survives PM2 restarts.

### Changed
- **`/schedule` handler** (`src/relay.ts`): Replaced immediate `submitJob()` call with the confirmation keyboard flow. `handleScheduleCommand()` is no longer called directly from the handler.
- **`jobTopicRegistry.ts`**: `getJobTopic()` now falls back to SQLite on cache miss; warms the hot cache on first DB hit (O(1) thereafter). `isJobTopic()` delegates to `getJobTopic()`.
- **`jobs/index.ts`**: Calls `initTopicRegistry(db)` at startup after `initJobBridge`.

## [Unreleased] / 2026-04-18 — job topic UX: /schedule creates a CC forum topic per job

### Added
- **Job Topic UX** (`src/jobs/executors/claudeSessionExecutor.ts`): `/schedule <prompt>` now creates a dedicated forum topic in the Command Center group on job start. Topic name: `⚙️ #NNN — <prompt[:60]>`. A job card is posted immediately with status `🔄 Running…`, updated to `✅ Done` or `❌ Failed` on completion. Agent response streams into the topic instead of the source chat.
- **Job counter** (`src/jobs/jobCounter.ts`): Sequential job number persisted to `~/.claude-relay/data/job-counter.json`. Zero-padded 3 digits (`001`, `002`, …); never resets.
- **Job topic registry** (`src/jobs/jobTopicRegistry.ts`): In-memory map of CC topic IDs → job metadata. Enables follow-up routing without a DB lookup.
- **Follow-up routing** (`src/orchestration/commandCenter.ts`): Messages in a known job topic are detected and routed through the CC classifier with the original job prompt injected as context. Supports natural multi-turn follow-ups that can route to different agents per turn.
- **`JobStore.updateMetadata()`** (`src/jobs/jobStore.ts`): Merges a patch into an existing job's metadata JSON.
- **Telegram API helpers** (`src/utils/telegramApi.ts`): `createForumTopic(chatId, name)` and `editMessage(chatId, messageId, text)` using raw Bot API fetch (same pattern as `sendToGroup`).
- **Graceful fallback**: topic creation is best-effort — if CC is not configured or the API fails, result falls back to `metadata.chatId`/`metadata.threadId` as before.

## [Unreleased] / 2026-04-18 — /model session-scoped model selection

### Added
- **`/model` command**: Set session-scoped model override per chat. Usage: `/model sonnet|opus|haiku|local` to set, `/model default` to clear. Resets on `/new`. Example: `/model opus` → all subsequent messages in this session use Opus.
- **`SessionState.sessionModel`** (`src/session/groupSessions.ts`): New optional field storing the session-scoped alias. Cleared by `resetSession()`. Persisted across bot restarts in session JSON files.
- **`setSessionModel()`** (`src/session/groupSessions.ts`): Helper to set/clear `sessionModel` atomically via existing `saveSession()`.
- **Priority chain extended** (`src/utils/modelPrefix.ts`): `[O/H/L]` prefix → `session.sessionModel` → `agent.defaultModel` → Sonnet. Signature: `resolveModelPrefix(text, agentDefault?, sessionModel?)`.

### Changed
- **`resolveModelPrefix()`** (`src/utils/modelPrefix.ts`): Added `sessionModel?` param; slots between prefix and agentDefault using `sessionModel ?? agentDefault` coalesce.
- **`processTextMessage()`** (`src/relay.ts`): Passes `session.sessionModel` to `resolveModelPrefix`.
- **Photo handler** (`src/relay.ts`): Passes `getSession()?.sessionModel` to `resolveModelPrefix` (cache-only, non-blocking).
- **`/help` text** (`src/commands/botCommands.ts`): Added `/model` usage lines.

## [Unreleased] / 2026-04-18 — Routine Separation (Core vs User)

### Changed
- **routines**: Split routines into core (repo) and user (external). Core maintenance routines (`watchdog`, `log-cleanup`, `memory-cleanup`, `memory-dedup-review`, `orphan-gc`, `weekly-retro`) stay in `routines/handlers/`. User routines (`morning-summary`, `night-summary`, `smart-checkin`, `weekly-etf`, `etf-52week-screener`) move to `~/.claude-relay/routines/`.
- **src/jobs/executors/routineExecutor.ts**: Dual-path handler resolution — checks `~/.claude-relay/routines/` first, falls back to `routines/handlers/`. Path traversal validation on handler names.
- **config/routines.config.json**: Now contains only 6 core routine entries (was 11). User routines configured in `~/.claude-relay/routines.config.json`.
- **setup/install.ts**: New `seedDefaultRoutines()` — copies example handlers to `~/.claude-relay/routines/` and seeds user config from `config/routines.user.example.json` on first run (no-clobber).
- **routines/CLAUDE.md**: Updated developer guide with core vs user distinction, dual-path resolution, separate checklists.
- **CLAUDE.md**: Updated data directory layout and job queue instructions for dual-path routines.

### Added
- **routines/handlers/examples/morning-summary.example.ts**: Annotated example — one-shot daily pattern with LLM call, date formatting, `ctx.send()`.
- **routines/handlers/examples/smart-checkin.example.ts**: Annotated example — interval pattern with `ctx.skipIfRanWithin()`, LLM decision gate, conditional send.
- **config/routines.user.example.json**: Template for user routine config (seeded to `~/.claude-relay/routines.config.json` on setup).

### Removed
- **routines/handlers/**: Removed 5 user-specific handlers (moved to `~/.claude-relay/routines/`): `morning-summary.ts`, `night-summary.ts`, `smart-checkin.ts`, `weekly-etf.ts`, `etf-52week-screener.ts`.
- **routines/*.test.ts**: Removed 6 user-routine test files (moved with handlers): `morning-summary.calendar.test.ts`, `morning-summary.calendar.e2e.test.ts`, `night-summary.test.ts`, `smart-checkin.test.ts`, `weekly-etf.test.ts`, `etf-52week-screener.test.ts`, `tests/routines/night-summary-learning.test.ts`.

## [Unreleased] / 2026-04-18 — NLAH Harness Replacement

### Added
- **src/orchestration/harness.ts**: Thin NLAH event loop (~120 LOC) — loads contract, dispatches steps sequentially, writes flat JSON state file, posts results to CC thread.
- **src/orchestration/contractLoader.ts**: Loads Markdown contracts from `~/.claude-relay/contracts/<intent>.md`, falls back to `default.md`. Parses YAML frontmatter + numbered step lists.
- **~/.claude-relay/contracts/**: Five default contracts — `default.md`, `code-review.md`, `security-audit.md`, `architecture.md`, `research.md`. Add or edit contracts here to change routing without touching code.
- **tests/orchestration/contractLoader.test.ts**: 6 unit tests covering load, fallback, step parsing.
- **tests/orchestration/harness.test.ts**: 3 unit tests covering sequential dispatch, state persistence, CC thread posts.

### Changed
- **src/orchestration/commandCenter.ts**: Removed `InterviewStateMachine`, `executeBlackboardDispatch`; replaced with `runHarness`. Simplified `buildAgentPickerKeyboard` (no longer needs `userMessage`).
- **src/orchestration/dispatchEngine.ts**: Removed `executeBlackboardDispatch`, `_executeBlackboardDispatchInner`, all blackboard session/record/topic functions. Kept `executeSingleDispatch`, dispatch runner registry, DB persistence helpers.
- **src/orchestration/types.ts**: Removed all `Bb*` types. Kept `ClassificationResult`, `DispatchPlan`, `DispatchEvent`, `DispatchRow`, `DispatchTaskRow`, etc.
- **src/orchestration/index.ts**: Exports updated — removed deleted modules, added `runHarness`, `loadContract`, `Contract`, `ContractStep`, `DispatchState`, `StepState`.
- **src/orchestration/schema.ts**: Added `DROP TABLE IF EXISTS` for all `bb_*` tables on init. Kept `dispatches` + `dispatch_tasks` for audit trail.
- **src/relay.ts**: Removed mesh notifier registration, `setInterviewStateMachine`, finalizer governance callback (~35 lines removed).
- **src/jobs/executors/claudeSessionExecutor.ts**: Replaced `executeBlackboardDispatch` with direct `runner(agentChatId, null, prompt)` call. Simpler, no DB dependency.
- **src/jobs/executors/compoundExecutor.ts**: Same simplification — sequential `runner` calls per task.

### Added (docs)
- **docs/nlah-harness.md**: New reference — contract format, built-in contracts, dispatch state schema, customisation guide, key file map.

### Changed (docs)
- **CLAUDE.md**: Updated architecture diagram (Orchestration subgraph), Component Map (+5 NLAH entries), Data Directory (contracts/ and harness/state/), Agent Directory CC description, Deep Dive table.
- **docs/features-job-queue.md**: Updated `claude-session` and `compound` executor descriptions — removed stale "blackboard dispatch" references; clarified CompoundExecutor as sequential runner.
- **docs/superpowers/specs/2026-04-12-job-queue-design.md**: Added superseded note — blackboard/roundtrip references were aspirational; v1 is a thin sequential runner.

### Removed
- **13 orchestration source files deleted**: `blackboard.ts`, `blackboardSchema.ts`, `boardDispatch.ts`, `controlPlane.ts`, `meshPolicy.ts`, `agentComms.ts`, `reviewLoop.ts`, `finalizer.ts`, `interviewPipeline.ts`, `taskDecomposer.ts`, `responseAggregator.ts`, `tagParser.ts` (~2500 LOC removed)
- **15 orchestration test files deleted** (all tested removed modules)
- **SQLite**: Dropped `bb_mesh_links`, `dispatches`, `dispatch_tasks` tables (2026-04-18)

## [Unreleased] / 2026-04-12 — Documentation Consolidation

### Changed
- **CLAUDE.md**: Rewritten as the single comprehensive project document — absorbs architecture.md, user-guide.md, and chat-groups.md. Includes system overview diagram, component map, session lifecycle, multi-agent groups, bot usage guide, all 8 setup phases (updated to 4 PM2 services), commands reference, troubleshooting, and deep-dive doc index.
- **README.md**: Trimmed to elevator pitch pointing to CLAUDE.md for all details.
- **docs/memory-system.md**: Consolidated from 3 files (memory-system.md + memory-system-user-guide.md + prompt_builder.md).
- **docs/routines-system.md**: Rewritten to reflect config-driven architecture (4 PM2 services, routine-scheduler, RoutineContext API). Absorbs ROUTINES_USER_JOURNEY.md and ADDING-NEW-JOBS.md.
- **docs/features-job-queue.md**: Updated to absorb testing-job-queue.md pre-merge testing guide.
- **docs/observability.md**: Updated to absorb WATCHDOG.md monitoring details.

### Added
- **docs/weather.md**: New consolidated weather reference (from WEATHER_INTEGRATION.md + WEATHER_QUICK_REFERENCE.md + WEATHER_UPDATE_SUMMARY.md + integrations/weather.md).
- **docs/model-registry.md**: New consolidated ModelRegistry + MLX embed + fallback reference (from FALLBACK.md + mlx-local-inference.md).

### Removed
- **docs/architecture.md** — absorbed into CLAUDE.md
- **docs/user-guide.md** — absorbed into CLAUDE.md
- **docs/chat-groups.md** — absorbed into CLAUDE.md
- **docs/memory-system-user-guide.md** — absorbed into docs/memory-system.md
- **docs/prompt_builder.md** — absorbed into docs/memory-system.md
- **docs/WATCHDOG.md** — absorbed into docs/observability.md
- **docs/WEATHER_INTEGRATION.md** — absorbed into docs/weather.md
- **docs/WEATHER_QUICK_REFERENCE.md** — absorbed into docs/weather.md
- **docs/WEATHER_UPDATE_SUMMARY.md** — absorbed into docs/weather.md
- **docs/FALLBACK.md** — absorbed into docs/model-registry.md
- **docs/mlx-local-inference.md** — absorbed into docs/model-registry.md
- **docs/ROUTINES_USER_JOURNEY.md** — absorbed into docs/routines-system.md
- **docs/ADDING-NEW-JOBS.md** — absorbed into docs/routines-system.md
- **docs/testing-job-queue.md** — absorbed into docs/features-job-queue.md
- **docs/claude-skills-reference.md** — generic Claude Code reference, not project-specific
- **integrations/weather.md** — absorbed into docs/weather.md

## [Unreleased] / 2026-04-12 — Job Queue Executors: Full Executor Suite

### Added
- **RoutineExecutor**: lazy handler loading from `routines/handlers/<name>.ts` via dynamic import; no startup cost; handler registration optional
- **RoutineContext**: injected into all routine handlers — `send()`, `llm()`, `log()`, `skipIfRanWithin()` replace standalone boilerplate
- **RoutineConfig**: `config/routines.config.json` defines all 11 routines; user overrides via `~/.claude-relay/routines.config.json`
- **routine-scheduler**: new PM2 service — reads config, registers cron jobs, fires jobs via webhook; replaces 11 per-routine PM2 entries
- **Prompt-type routines**: add `"type": "prompt"` + `"prompt": "..."` to routines.config.json — zero handler code needed
- **ClaudeSessionExecutor**: `claude-session` jobs invoke orchestration layer (classifyIntent → executeBlackboardDispatch); posts result back to originating chat
- **CompoundExecutor**: `compound` jobs run multi-step blackboard dispatch with agent-overlap guard (awaiting-intervention if target agents busy)
- **/schedule command**: `/schedule <prompt>` enqueues a claude-session job from Telegram; result posted back to originating chat/thread
- **auto-approve.default.json**: maintenance routines (log-cleanup, orphan-gc, memory-cleanup, memory-dedup-review) auto-approve approval interventions; cron jobs skip budget interventions
- **interpolate utility**: `src/routines/interpolate.ts` — `{{VAR_NAME}}` substitution for prompt templates

### Changed
- All 11 routines migrated from standalone `routines/*.ts` scripts to `routines/handlers/*.ts` handlers
- `ecosystem.config.cjs`: per-routine cron entries removed; `routine-scheduler` is now sole cron dispatcher

## [Unreleased] / 2026-04-12 — Job Queue System

### Added
- **jobs**: Persistent job queue subsystem (`src/jobs/`) for background work scheduling and tracking.
- **jobs/store**: SQLite-backed job persistence with dedup keys, checkpoints, and intervention state.
- **jobs/queue**: Event-driven scheduler with priority lanes (urgent/normal/background) and per-type concurrency caps.
- **jobs/intervention**: Automation-first intervention cascade: auto-approve rules → confidence auto-proceed → auto-resolve policies → human fallback.
- **jobs/executors**: RoutineExecutor (handler registry) and ApiCallExecutor (HTTP with retry/backoff).
- **jobs/webhook**: HTTP server for external job submission with bearer auth and optional per-token ACL.
- **jobs/cli**: `bun run relay:jobs` CLI for listing, inspecting, approving, retrying, and submitting jobs.
- **jobs/telegram**: `/jobs` command with filtered views and inline keyboard callbacks for intervention resolution.
- **config**: `~/.claude-relay/auto-approve.json` for zero-touch approval of safe operations.

### Fixed
- **commands**: Restored `/status` command dropped in earlier refactor — replies with session duration, message count, and last activity.

## [Unreleased] / 2026-04-12 — Fix: Markdown markers literal in table cells; language class dropped

### Fixed
- **htmlFormat**: `markdownTableToPreAscii` now strips inline markdown markers (`**`, `*`, `__`, `_`, `~~`, backticks) from table cell content before rendering the `<pre>` ASCII block. Previously `*0 idle*` and `**~12 GB**` appeared as literal asterisks — Telegram does not render HTML inside `<pre>`.
- **htmlFormat**: Fenced code blocks with a language tag (e.g. ` ```typescript `) now emit `<code class="language-typescript">` instead of a bare `<code>`. Enables syntax highlighting in Telegram clients that support it.

## [Unreleased] / 2026-04-09 — Fix: Document Query Collection Mismatch

### Fixed
- **searchService**: `hybridSearch()` now queries the embed-suffixed Qdrant collection (e.g. `documents_bge-m3_1024`) instead of the bare `documents` collection. This fixes `/doc query` returning no results for recently ingested documents — vectors were stored in `documents_bge-m3_1024` by `insertDocumentRecords()` but searched in the wrong collection. Affects all hybrid search: memory, messages, documents, summaries.
- **vectorStore**: `initEmbedCollections()` now sets `_activeEmbedSuffix` so `getActiveEmbedSuffix()` returns the correct suffix at search time. New `getActiveEmbedSuffix()` export avoids circular dependency between `searchService` and `storageBackend`.

## [Unreleased] / 2026-04-05 — P3: Mesh Topic Routing

### Added
- **agentComms**: `meshTopicId` field on `AgentDefinition` and `AgentConfig` — dedicated forum topic ID per agent for receiving direct mesh messages. Isolates agent-to-agent traffic from user-facing dispatch topics.
- **agentComms**: `MeshNotifier` DI slot (`setMeshNotifier()`) — fire-and-forget Telegram notification to target agent's `(chatId, meshTopicId)` on every successful `sendAgentMessage()`. Notification failures are logged but never block the send.
- **relay.ts**: Registers mesh notifier at startup using `bot.api.sendMessage()` with Markdown parse mode.
- **agents.example.json**: All 9 agents now include `meshTopicId: null` (set per-group in `~/.claude-relay/agents.json`).
- **tests**: 4 new tests — notification fires on send, skipped when notifier unset, failure doesn't block send, meshTopicId config validation.

## [Unreleased] / 2026-04-05 — Dynamic Dispatch Topics

### Added
- **dispatchEngine**: Dynamic forum topic creation per dispatch session. Each agent group gets a dedicated Telegram forum topic per session, providing visual separation and traceability. Topics are cached per `(sessionId, chatId)` — no duplicate creation within a session.
- **dispatchEngine**: `setTopicCreator()` and `setDispatchNotifier()` DI slots — registered at startup by relay.ts using `bot.api.createForumTopic()` and `bot.api.sendMessage()`.
- **dispatchEngine**: Dispatch header messages (`📨 Dispatched from Command Center`) now posted to agent groups in the blackboard dispatch path (previously only in single-agent dispatch).
- **dispatchEngine**: Review and security gate dispatches now create their own topic in the reviewer's group with descriptive titles.
- **relay.ts**: Registers topic creator and notifier at startup.
- **tests**: 6 new tests covering topic caching, graceful fallback, call ordering, and cache cleanup.

### Changed
- **dispatchEngine**: `executeBlackboardDispatch()` wraps inner logic in try-finally to guarantee topic cache cleanup even on unexpected errors.
- **dispatchEngine**: Runner now receives dynamically created `topicId` instead of static `agent.topicId` from config.

## [Unreleased] / 2026-04-05 — Mesh Gaps Tier 1+2: Correctness, Observability, Resilience

### Added
- **blackboard**: Status transition validation — `updateRecordStatus()` and `updateSessionStatus()` now enforce valid state machine transitions. Invalid transitions throw `InvalidTransitionError`. Idempotent self-transitions are allowed.
- **blackboard**: `VALID_RECORD_TRANSITIONS` and `VALID_SESSION_TRANSITIONS` maps exported for inspection and testing.
- **blackboardSchema**: `bb_audit_log` table — captures every board write, status transition, trigger firing, and orphan reap with timestamps, agent, old/new status, and JSON metadata.
- **blackboard**: `writeAuditEntry()` — fire-and-forget audit writer (never blocks parent operation). Called automatically from `writeRecord()`, `updateRecordStatus()`, `updateSessionStatus()`.
- **blackboard**: `getAuditEntries()` — query audit log by session for debugging.
- **blackboard**: `reapOrphanRecords()` — detects and fails stale `active` records on active sessions (default threshold: 10 min with no update). Returns count of reaped records.
- **dispatchEngine**: Wall-clock timeout for blackboard dispatch — hard exit at 10 min with `DISPATCH_TIMEOUT_MS`, soft warning logged at 80%. Prevents hung dispatches from blocking indefinitely.
- **dispatchEngine**: Trigger firing persistence — every `selectNextAgents()` result is written to `bb_audit_log` with rule, agent, reason, and round number. Enables post-mortem debugging of control flow decisions.
- **finalizer**: Bulk retry audit — `handleFinalAction("final_retry")` now writes audit entry for the bulk `failed→pending` reset.

### Changed
- **blackboard**: `updateRecordStatus()` reads current status before writing (one extra query) to validate transitions and emit accurate audit entries.
- **blackboard**: `updateSessionStatus()` reads current status before writing for the same reason.

## [Unreleased] / 2026-04-04 — Fix: Governance Keyboard Never Sent

### Fixed
- **interviewPipeline**: `handleOrchestrationComplete` now sends the Approve/Archive inline keyboard after posting the dispatch synthesis. The keyboard was built and the callback handler was registered, but `buildFinalKeyboard()` was never called — Step 5 of the E2E flow was silently skipped.
- **dispatchEngine**: `executeBlackboardDispatch` now returns `sessionId` in the result so callers can attach the governance keyboard to the correct session.

## [Unreleased] / 2026-04-04 — Fix: Dispatch Engine Error Resilience

### Fixed
- **dispatchEngine**: Runner calls wrapped in try-catch — `claudeStream: exit 1` exceptions no longer crash the dispatch loop. Failed tasks are marked `failed` and the loop continues to FINALIZE.
- **dispatchEngine**: Reviewer and security reviewer runner calls wrapped in try-catch — reviewer failures no longer interrupt artifact dispatch.
- **dispatchEngine**: Loop exit fallback now attempts `finalizeSynthesis()` before marking session `done` — ensures governance keyboard fires even when FINALIZE trigger doesn't reach from controlPlane.

## [Unreleased] / 2026-04-04 — Fix: Mesh Interview Trigger

### Fixed
- **intentClassifier**: Added `detectCompound()` heuristic so compound tasks trigger the interview path even when MLX is unavailable or under-classifies. Uses conjunction counting, action verb detection, and multi-agent capability matching.
- **intentClassifier**: MLX classification result is now OR'd with heuristic — MLX saying `isCompound: false` no longer blocks interview for clearly compound messages.
- **intentClassifier**: MLX timeout increased from 15s → 30s for intent classification.
- **intentClassifier**: `AbortError` from MLX timeout now logs a clean one-liner instead of dumping the full DOMException object.

## [Unreleased] / 2026-04-04 — Phase 6: Relay + DispatchEngine Wiring

### Added
- **relay.ts**: Wire interview state machine into CC orchestration — `setInterviewStateMachine()` + `setOrchestrationHandler()` called after interactive SM creation. Compound/ambiguous tasks now flow through interview pipeline automatically.
- **relay.ts**: Register finalizer governance callback handler — `orch:final_*` callbacks (Approve & Archive, Override, Retry Failed, Discard) parsed and routed to `handleFinalAction()`.
- **dispatchEngine.ts**: Review loop integration in blackboard dispatch — after each artifact is written, `buildReviewRequest()` triggers code-quality-coach review; `checkSecurityReviewNeeded()` triggers security-compliance review for infra/code artifacts.
- **dispatchEngine.ts**: Finalizer synthesis in FINALIZE branch — `finalizeSynthesis()` called before aggregation, producing structured final summary with task/artifact/review/conflict data.
- **tests/orchestration/meshIntegration.test.ts**: 12 integration tests covering SM injection, review loop creation, security gate bypass, finalizer governance callbacks, backward compatibility, and progress snapshots.

## [Unreleased] / 2026-04-04 — Phase 5: Finalizer & Governance

### Added
- **orchestration/finalizer**: Complete end-of-dispatch lifecycle with 4 subsystems:
  - **P5.1 Synthesis**: `finalizeSynthesis()` — reads all board state, produces final summary record in `"final"` space. Excludes superseded artifacts, includes review verdicts and conflict resolutions. Session transitions to `"finalizing"`.
  - **P5.2 Board compaction**: `compactBoard()` — archives done records, cleans stale pending/active records (>72h). `compactAllSessions()` for scheduled global cleanup.
  - **P5.3 Governance UI**: `buildFinalKeyboard()` with `[Approve & Archive][Override][Retry Failed][Discard]`. `parseFinalCallback()` + `handleFinalAction()` for callback handling.
  - **P5.4 CC progress dashboard**: `buildProgressSnapshot()` — throttled (3s) single-pass O(n) progress snapshots with visual progress bar, task counters, artifact/review/conflict counts.

## [Unreleased] / 2026-04-04 — Phase 4: Review & Critique Loop

### Added
- **orchestration/reviewLoop**: Full review lifecycle module with 4 subsystems:
  - **P4.1 Review trigger**: `buildReviewRequest()` → `code-quality-coach` reviews unreviewed artifacts with structured prompts. `recordReviewVerdict()` writes approved/revision_needed/rejected verdicts.
  - **P4.2 Revision loop**: `handleRevisionNeeded()` returns revise (re-activate original agent with feedback) or escalate (max 3 iterations). `recordRevisedArtifact()` supersedes previous versions.
  - **P4.3 Security gate**: `checkSecurityReviewNeeded()` triggers `security-compliance` review for infra/code artifacts (producer-based + keyword-based detection). Skips docs/general artifacts.
  - **P4.4 Conflict resolution**: `raiseConflict()` → `buildConflictCase()` → `resolveConflict()` with evidence gathering. CC buttons: `[Keep A][Keep B][Neither]`. Loser artifacts auto-superseded.
- **orchestration/reviewLoop**: Escalation UI — `buildEscalationKeyboard()` with `[Accept Anyway][Override][Cancel Task]` for max-iteration breaches. `formatConflictSummary()` and `formatEscalationMessage()` for CC display.

## [Unreleased] / 2026-04-04 — Phase 3: Interview + Plan Generation

### Added
- **orchestration/interviewPipeline**: Interview-to-board pipeline — decomposes interview Q&A into blackboard task and evidence records. Supports MLX-based compound task decomposition with heuristic fallback. Governance UI with `[Approve][Edit][Cancel][Skip Review][Force Security]` buttons.
- **interactive/stateMachine**: `startOrchestrationInterview()` — new entry point for CC interview flow. `setOrchestrationHandler()` for registering post-interview callback. `mode: 'plan' | 'orchestrate'` on `InteractiveSession`.
- **commandCenter**: Interview trigger branch — `isCompound OR confidence < 0.8` routes to interview instead of direct dispatch. `setInterviewStateMachine()` for DI of state machine.

### Changed
- **interactive/types**: `InteractiveSession` gains `mode`, `classification`, `threadId` fields for orchestration context.
- **interactive/stateMachine**: `confirm()` now branches on `mode` — `plan` spawns Claude TDD, `orchestrate` calls board dispatch pipeline.

## [Unreleased] / 2026-04-04 — Constrained Mesh + Blackboard Orchestration

### Added
- **orchestration/blackboardSchema**: SQLite-backed blackboard with sessions (`bb_sessions`), records (`bb_records`), and mesh links (`bb_mesh_links`). Full CRUD: `createSession`, `writeRecord`, `getRecords`, `updateRecordStatus`.
- **orchestration/controlPlane**: `selectNextAgents()` — pure function evaluating 6 trigger rules (INIT, EXECUTE, REVIEW, CONFLICT, FINALIZE, ESCALATE) against blackboard state. O(n) complexity.
- **orchestration/meshPolicy**: Constrained mesh with whitelisted agent pairs. `canCommunicateDirect(from, to)` — O(1) Set lookup.
- **orchestration/taskDecomposer**: Claude Haiku-based compound task decomposition. Falls back to single-task on any failure.
- **orchestration/responseAggregator**: Collects completed task artifacts from blackboard into structured CC summary.
- **orchestration/dispatchEngine**: `executeBlackboardDispatch()` — wraps existing dispatch runner in a blackboard session loop. Backward compatible with single-agent dispatch.
- **promptBuilder**: `<blackboard_context>` injection — active session evidence and decisions injected into agent prompts.

### Changed
- **orchestration/schema**: `initOrchestrationSchema()` now also calls `initBlackboardSchema()` for bb_* tables.
- **orchestration/commandCenter**: `executeAndReport()` now uses `executeBlackboardDispatch` instead of `executeSingleDispatch`.

## [Unreleased] / 2026-04-03 — fix(mlx): switch to streaming SSE with per-chunk timeout

### Fixed
- **src/mlx/client.ts**: `callMlxGenerate` now uses `stream: true` with incremental SSE parsing instead of buffered `stream: false`. Bun's `fetch` `AbortController` does not terminate idle HTTP/1.0 connections — the previous non-streaming mode caused 60+ minute hangs when the MLX server generated large responses (4096 tokens at ~1 tok/s). With streaming, tokens arrive incrementally and a `Promise.race`-based per-chunk inactivity timeout (default 30s) detects stalls immediately.

### Added
- **src/mlx/client.test.ts**: 11 new unit tests covering streaming SSE parsing, thinking block stripping, chunk timeout, HTTP errors, split SSE boundaries, `[DONE]` sentinel, keepalive handling, and AbortController propagation.

## [Unreleased] / 2026-03-29 — fix(orchestration): restore model prefix routing for /new [o] in CC

### Fixed
- **commandCenter.ts**: Strip `[O]/[H]/[Q]` model prefix before `classifyIntent()` so intent routing isn't confused by model selectors. Previously `[o] review code` would fail keyword classification because no capability matched the `[o]` token.
- **commandCenter.ts**: Restored `pendingPickerMessages` Map — prevents message truncation in the low-confidence agent picker flow for messages >100 chars. This was a regression introduced in `feat/orchestration_layer` when the map was removed in favour of `extractUserMessageFromPlan()` alone.
- **commandCenter.ts**: Dispatch plan now shows `Model: 🧠 Opus` (or Haiku/Qwen) line when a non-Sonnet model prefix is detected, giving the user visual confirmation the model choice was captured.
- **tests/orchestration/commandCenter.test.ts**: Restored deleted test file + 10 new tests covering model prefix preservation through truncation and `pendingPickerMessages` Map lifecycle.

## [Unreleased] / 2026-03-29 — Command Center Orchestration Layer (Phase 0 + Phase 1)

### Added
- **src/orchestration/**: New orchestration module with 7 files:
  - `intentClassifier.ts` — MLX-based intent classification with keyword fallback. Routes CC messages to the best-fit agent.
  - `commandCenter.ts` — CC message handler: classify → show routing plan → 5s countdown → dispatch to agent group.
  - `dispatchEngine.ts` — Single-agent dispatch via `bot.api.sendMessage()`, DB persistence, response monitoring.
  - `interruptProtocol.ts` — 5s countdown timer with Pause/Edit/Cancel inline keyboard. Immediate promise settlement on interrupt.
  - `schema.ts` — `dispatches` + `dispatch_tasks` SQLite tables with indexes.
  - `types.ts` — Shared interfaces (ClassificationResult, DispatchPlan, SubTask, etc.).
  - `index.ts` — Barrel export.
- **src/commands/botCommands.ts**: `/agents` command — lists all 6 agents with capabilities and connection status. `/search <query>` — cross-group message search with agent/topic attribution.
- **routines/morning-summary.ts**: Cross-agent activity digest section using `getYesterdayActivity()` from dispatch data.
- **tests/orchestration/**: 31 new tests (intentClassifier: 13, interruptProtocol: 12, schema: 6).

### Changed
- **src/relay.ts**: CC group messages now route through `orchestrateMessage()` instead of `processTextMessage()`. Orchestration callback handlers registered at startup.
- **src/local/db.ts**: `initSchema()` now calls `initOrchestrationSchema()` to create dispatch tables.

## [Unreleased] / 2026-03-28 — Fix 101 test failures (mock isolation + bug fixes)

### Fixed
- **src/local/embed.test.ts**: Updated test server from deprecated Ollama-style `/api/embed` to OpenAI-compatible `/v1/embeddings` endpoint with correct response shape `{data: [{object, index, embedding}]}`. Fixes 5 test failures.
- **src/memory.ts**: Fixed greedy regex in REMEMBER/REMEMBER_GLOBAL tag parsing — `.+` spanned across multiple tags. New balanced bracket pattern `(?:[^\[\]]*|\[[^\]]*\])*` handles inner brackets (e.g. `[kebab-case]`) without over-matching.
- **src/claude/integration.test.ts**: Updated stale assertion — `longTermExtractor.ts` now imports from `routineModel.ts` (refactored from `claude-process.ts`).

### Added
- **scripts/test-isolated.ts**: Process-isolated test runner — runs each test file in its own `bun test` subprocess (6 concurrent). Eliminates Bun v1.3.9 `mock.module()` cross-file contamination that caused ~94 false failures. Usage: `bun run test:isolated`.
- **package.json**: Added `test:isolated` script.

## [Unreleased] / 2026-03-28 — Memory read-side isolation by chatId

### Fixed
- **src/local/db.ts**: `getActiveMemories()` now returns scoped + global (NULL chat_id) items when chatId is provided, instead of only exact matches. When chatId is omitted, returns all items (backward compat for routines/DMs).
- **src/local/storageBackend.ts**: `getMemoryFacts()`, `getMemoryGoals()`, `getExistingMemories()` now pass chatId through to `getActiveMemories()`. `semanticSearchMemory()` accepts and forwards chatId.
- **src/local/searchService.ts**: `buildFilter()` adds Qdrant `should` clause for chatId — matches scoped OR null (global) items.
- **src/memory.ts**: `getMemoryContext()` and `getRelevantContext()` now pass chatId to goals and semantic search calls.

### Added
- **src/local/memoryIsolation.test.ts**: 5 tests validating chatId isolation (scoped + global, cross-group exclusion, unknown chatId fallback, goals filtering).

## [Unreleased] / 2026-03-28 — Model prefix [Q] and per-agent defaultModel

### Added
- **src/utils/modelPrefix.ts**: Extracted `resolveModelPrefix()` into a standalone utility module. Adds `[Q]` prefix for explicit local Qwen routing and accepts an `agentDefault` parameter for per-agent model defaults. Priority chain: `[O/H/Q]` user prefix → `agent.defaultModel` → Sonnet.
- **src/utils/modelPrefix.test.ts**: 17 unit tests covering all prefix tags, agent defaults, priority override, and edge cases.
- **src/agents/config.ts**: `AgentDefinition` and `AgentConfig` extended with optional `defaultModel` field, passed through at startup.

### Changed
- **config/agents.example.json**: `defaultModel` field added per agent — specialist groups default to `sonnet`, general-assistant defaults to `haiku`.
- **src/relay.ts**: `resolveModelPrefix()` call sites now pass `agent.defaultModel` as the fallback. `[Q]` messages bypass `callClaude()` entirely and call `callRoutineModel()` directly. Photo handler silently degrades `[Q]` → Sonnet (local Qwen has no vision capability).
- **src/relay.handler-consistency.test.ts**: Updated to reflect constants moving to `modelPrefix.ts`; tests now verify import rather than inline declaration.

## [Unreleased] / 2026-03-28 — Agent Lineup Redesign (Option C: 5+1)

### Changed
- **config/agents.example.json**: Redesigned from 6 generic agents to 6 role-aligned agents (5 specialists + 1 orchestrator). New agents: `command-center`, `cloud-architect`, `security-compliance`, `engineering`, `strategy-comms`, `operations-hub`. Replaces: `aws-architect`, `security-analyst`, `documentation-specialist`, `code-quality-coach`, `research-analyst`, `general-assistant`.
- **config/prompts/cloud-architect.md**: Broader scope — GCC 2.0, SGTS, multi-cloud (replaces AWS-only `aws-architect.md`).
- **config/prompts/security-compliance.md**: Singapore jurisdiction — IM8 v4, PDPA, CSA, AIAS (replaces generic GDPR/HIPAA `security-analyst.md`).
- **config/prompts/engineering.md**: Renamed from `code-quality-coach.md`, same TDD/correctness-by-construction scope.
- **config/prompts/operations-hub.md**: PM-focused identity with Calendar/Things 3 integration (replaces generic `general-assistant.md`).
- **CLAUDE.md**: Updated Phase 5 agent table, group names, and env var references.

### Added
- **config/prompts/command-center.md**: Orchestrator system prompt — intent classification, dispatch protocol, interrupt handling.
- **config/prompts/strategy-comms.md**: New agent merging documentation-specialist + research-analyst + BD/proposal capabilities. Handles proposals, decks, research, ADRs, stakeholder comms.
- **config/prompts/diagnostics/cloud-architect.md**: Diagnostic extraction prompt (renamed from aws-architect).
- **config/prompts/diagnostics/security-compliance.md**: Diagnostic extraction prompt with IM8 compliance support (renamed from security-analyst).
- **config/prompts/diagnostics/engineering.md**: Diagnostic extraction prompt (renamed from code-quality-coach).

### Removed
- Old agent prompts archived to `config/prompts/_archived/` (aws-architect, security-analyst, documentation-specialist, code-quality-coach, general-assistant, research-analyst + their diagnostic variants).

## [Unreleased] / 2026-03-28 — Jarvis Self-Learning System Phase 1

### Added
- **learning/correctionDetector**: Inline correction pattern matcher — detects negation, re-statement, override, and frustration patterns in user messages following assistant responses.
- **learning/sessionGrouper**: Reads session state files from `~/.claude-relay/sessions/`, queries messages within session boundaries for precise session-aware analysis.
- **learning/learningExtractor**: Core extraction engine — converts correction pairs into learning entries (type="learning") with confidence scoring and evidence citation.
- **routines/weekly-retro**: PM2 cron job (Sundays 9am SGT) that surfaces high-confidence learnings for human-gated promotion to CLAUDE.md via Telegram inline keyboard.
- **callbacks/learningRetroCallbackHandler**: Handles Promote/Reject/Later button presses from weekly retro. Promote appends rule to `~/.claude/CLAUDE.md`; Reject lowers confidence by 0.2.
- **callbacks/reflectCommandHandler**: `/reflect` command for explicit user feedback stored with confidence 0.85. Usage: `/reflect Always use TDD for utilities`.
- **db.ts**: Added `evidence` (TEXT) and `hit_count` (INTEGER) columns to memory table, plus `idx_memory_learning` index for retro queries.

### Changed
- **routines/night-summary**: Now runs learning extraction after day analysis — scans today's sessions for correction pairs, stores learnings, and appends a "Learnings Captured Today" section to the night summary message.

## [Unreleased] / 2026-03-26 — Morning calendar gap-fill & meeting tasks

### Added
- **src/utils/atomicBreakdown.ts**: `computeFreeBlocks()` — computes available time windows between calendar events with 15-min buffers.
- **src/utils/atomicBreakdown.ts**: `injectMeetingTasks()` — generates structural pre-meeting ("Prep block reserved") and post-meeting ("Process notes") tasks for meetings >30min.
- **src/utils/atomicBreakdown.ts**: `formatDevTodosMessage()` — formats dev todos as a standalone reference message.
- **src/utils/atomicBreakdown.ts**: `getMaxAtomicTasks()` — reads `MAX_ATOMIC_TASKS` env var (default 20, replaces hardcoded 12).
- **src/utils/atomicBreakdown.ts**: Visual tiering — Priority section + "If time allows" section in task rendering.
- **src/utils/atomicBreakdown.ts**: Meeting-task markers: `🔜` pre-meeting, `📝` post-meeting.
- **src/utils/atomicBreakdown.test.ts**: 24 unit tests covering all new functions.

### Changed
- **src/utils/atomicBreakdown.ts**: `AtomicTask` interface extended with optional `taskType` and `tier` fields (backward compatible).
- **src/utils/atomicBreakdown.ts**: `formatCalendarForPrompt()` now includes event notes (truncated to 200 chars).
- **src/utils/atomicBreakdown.ts**: `breakdownTasks()` prompt rewritten — LLM now fills free time blocks between meetings with deadline-first priority.
- **routines/morning-summary.ts**: Dev todos sent as separate Telegram message after main briefing. Dev todos no longer passed to LLM for time-slotting.

## [Unreleased] / 2026-03-26 — Fix MLX Metal OOM via KV cache and allocator limits

### Fixed
- **mlx-local/server**: Metal GPU OOM crashes after long-running sessions caused by unbounded KV cache growth. Root cause: `prompt_cache_bytes=None` → `LRUPromptCache` held unlimited memory across 10 cached sequences. Fix: reduced `prompt_cache_size` to 4 sequences, capped `prompt_cache_bytes` at 3 GB, and called `mx.set_cache_limit()` on both generation (1 GB) and embed (512 MB) servers to prevent allocator free-tensor accumulation. Total Metal budget: 10.1 GB < 13.3 GB recommended ceiling on M3 Pro 18 GB.

## [Unreleased] / 2026-03-26 — Switch routines back to Qwen3.5-9B

### Changed
- **ecosystem.config.cjs**: `mlx` service now starts `mlx serve -m mlx-community/Qwen3.5-9B-MLX-4bit` (reverts 4B model selection).
- **src/mlx/client.ts**: `DEFAULT_LOCAL_MODEL` updated to 9B. Applies when `LOCAL_LLM_MODEL` env var is not set.

## [Unreleased] / 2026-03-26 — Routine robustness: think-block stripping, local-only LLM

### Fixed
- **src/mlx/client.ts**: Strip `</think>` blocks from Qwen3.5 responses. The model always emits thinking content regardless of `enable_thinking:false`, which consumed max_tokens budget and caused truncated output in routines (recap narratives, task breakdowns, night reflections).
- **src/mlx/client.ts**: Increased `DEFAULT_MAX_TOKENS` from 2048 to 4096. With thinking blocks consuming 500-1500 tokens, 2048 left insufficient headroom for actual content, causing truncated task decomposition JSON and incomplete night reflections.

### Changed
- **routines/night-summary.ts**: Removed Claude Haiku fallback — now uses local LLM (Osaurus/Qwen3.5-4B) exclusively. Simplified `analyzeWithProviders` → `analyzeWithLocalLLM` (single provider, no fallback chain). Night summary now passes `maxTokens: 4096` explicitly to accommodate the 500-700 word reflection prompt.

## [Unreleased] / 2026-03-26 — Split MLX into separate generation + embedding servers

### Added
- **tools/mlx-local**: `mlx serve-embed` command — standalone embedding-only server on port 8801. Runs as a separate process with its own Metal command queue, eliminating GPU lock contention with text generation.
- **ecosystem.config.cjs**: `mlx-embed` PM2 service — always-on, auto-restart, dedicated logs.

### Changed
- **src/local/embed.ts**: Uses `EMBED_URL` env var (default `http://localhost:8801`) instead of `MLX_URL`. Embedding requests now route to the dedicated server, never blocked by generation.
- **tools/mlx-local/server.py**: Extracted shared `_handle_embeddings()` and `_send_json()` helpers used by both unified and standalone servers.

## [Unreleased] / 2026-03-26 — Switch embed model to mlx-community/bge-m3-mlx-fp16

### Changed
- **tools/mlx-local**: `DEFAULT_EMBED_MODEL` changed from `BAAI/bge-m3` (PyTorch) to `mlx-community/bge-m3-mlx-fp16` (native MLX). Model ships with safetensors in MLX format — no one-time conversion step required.
- **tools/mlx-local**: Removed `_ensure_bge_m3_safetensors()` and the `snapshot_download` conversion block in `run_server()` — dead code now that the model is natively MLX.
- **tools/mlx-local/pyproject.toml**: Removed `torch` and `safetensors` dependencies (~2 GB reduction in install size). Only `mlx-lm`, `mlx-embeddings`, and `click` required.
- `set_dtype(mx.float16)` retained as a no-op guard for `--embed-model` overrides at runtime. Mean-pooling still computed in fp32 for numerical stability.

## [Unreleased] / 2026-03-25 — Streaming progress for /report generate

### Changed
- **src/report/index.ts**: `/report generate` now streams per-section progress in real-time via Telegram message editing. Sends initial message immediately, detects `✓ Section` completion markers as stdout arrives, edits live progress (rate-limited to 1 edit/2s), and updates to final summary on completion. Replaces buffered fire-and-forget pattern.

## [Unreleased] / 2026-03-24 — Report Generator QA integration + embedding resilience

### Added
- **src/report/**: New module for Report Generator integration — run report commands from Telegram chat
- **QA session**: Conversational Q&A via Telegram with pause/resume mode switching (`/report qa <slug>`)
  - Multi-message answer batching (text + voice + photos)
  - Inline keyboard controls: Submit, Skip, Undo, Pause, End, Preview
  - Session persistence: checkpoint to disk, resume across sessions
  - Writes transcript in exact Report Generator format for compatibility
  - Claude generates questions dynamically based on report archetype, sections, and existing research
  - Findings summary auto-generated on session end
- **CLI proxy**: Non-interactive commands via Telegram (`/report list`, `status`, `project`, `check`, `auth`)
- **Fire-and-forget**: Long-running commands with completion notification (`/report generate`, `publish`)
- **Voice capture**: Voice messages in QA mode are transcribed and buffered as answer parts

### Changed
- **relay.ts**: Added `rpq:*` callback routing, report QA free-text intercept, voice interception

### Fixed
- **embed.ts**: Increased default embed timeout from 8s to 15s (configurable via `EMBED_TIMEOUT_MS` env var). Added retry-once with 2x timeout when MLX server is busy with text generation (single-threaded Python blocks embeddings behind `/v1/chat/completions`).
- **storageBackend.ts**: Isolated SQLite message insert from embed+Qdrant upsert — SQLite write always succeeds even when embedding times out. Distinct log messages: `[storage] SQLite message insert failed` vs `[storage] Vector upsert skipped`.

---

## 2026-03-23 — Documentation overhaul: purge Ollama refs, update to MLX-only

### Changed
- **docs/architecture.md**: Replaced all Ollama references with MLX — diagrams, component table, tech stack, directory structure
- **docs/FALLBACK.md**: Complete rewrite — now documents MLX fallback system instead of Ollama (gemma3-4b)
- **docs/memory-system.md**: Updated all embedding refs from "Ollama BGE-M3" to "MLX BGE-M3", fixed sequence diagrams
- **docs/memory-system-user-guide.md**: Fixed Ollama embedding reference to MLX bge-m3
- **docs/observability.md**: Replaced Ollama health checks with MLX health endpoint, updated diagnostic commands and flowcharts
- **docs/prompt_builder.md**: Replaced "nomic-embed-text" with "bge-m3 via MLX", updated all sequence diagrams
- **docs/ADDING-NEW-JOBS.md**: Complete rewrite — launchd instructions replaced with PM2/ecosystem.config.cjs patterns
- **docs/WATCHDOG.md**: Complete rewrite — launchd labels replaced with PM2 watchdog routine

### Removed
- **docs/SERVICE-STATUS.md**: Deleted — launchd service status doc is obsolete (PM2-SETUP.md is the source of truth)

---

## 2026-03-22 — MLX-only local inference: remove Ollama dependency

### Changed
- **MLX client** (`src/mlx/client.ts`): Rewritten from subprocess spawning (`mlx-qwen generate`) to HTTP client calling `mlx serve` on port 8800 via OpenAI-compatible `/v1/chat/completions`. `isMlxAvailable()` is now async (HTTP health check). New export: `getMlxBaseUrl()`.
- **Embeddings** (`src/local/embed.ts`): Switched from Ollama `/api/embed` to MLX `/v1/embeddings` (OpenAI format). Same bge-m3 model, same 1024-dim vectors — no re-embedding needed.
- **Routine model** (`src/routines/routineModel.ts`): Simplified to MLX-only (removed Ollama fallback cascade). `RoutineModelProvider` type is now just `"mlx"`.
- **Relay fallback** (`src/relay.ts`): Startup check uses `isMlxAvailable()` instead of `checkOllamaAvailable()`. Chat fallback label now shows "Qwen3.5-9B (MLX)".
- **Short-term memory** (`src/memory/shortTermMemory.ts`): Summarization uses `callRoutineModel()` instead of direct Ollama HTTP fetch.
- **Context relevance** (`src/session/contextRelevance.ts`): `checkContextRelevanceWithOllama()` renamed to `checkContextRelevanceWithMLX()`, uses `callMlxGenerate()`. Smart check returns `method: "mlx"` instead of `"ollama"`.
- **Night summary** (`routines/night-summary.ts`): Provider interface renamed from `ollama` to `mlx`. All log/error messages updated. Footer label is now dynamic — shows the last path segment of `MLX_MODEL` (e.g. `Qwen3.5-9B-MLX-4bit`) when MLX ran, `Claude Haiku` on fallback, `Unknown` if both failed. No hardcoded model names.

### Removed
- **`src/ollama/`** module — `client.ts`, `models.ts`, `index.ts`, `models.test.ts` deleted entirely. Ollama is no longer a dependency.
- **`setup/test-fallback.ts`** — Ollama-specific test script removed.

### Notes
- **MLX server required**: `mlx serve` must be running (port 8800) for text generation and embeddings. Add as PM2 service for production.
- **No Qdrant schema change**: bge-m3 via MLX produces identical 1024-dim vectors — existing Qdrant collections work without re-embedding.
- **Env vars**: `MLX_URL` (default `http://localhost:8800`) replaces `OLLAMA_URL` for all local inference.
- **mlx-local server fixes** (`~/.claude/tools/mlx-qwen/mlx_local/server.py`): (a) `BrokenPipeError` caught at both the embeddings path and the generation `do_POST` path — no more traceback spam when clients disconnect mid-response. (b) Module-level `_gpu_lock` serializes all Metal operations — prevents `A command encoder is already encoding to this command buffer` crash when embedding and generation requests hit the GPU concurrently.

---

## 2026-03-22 — Smart Routines: Calendar-aware check-in, Ollama atomic task breakdown, Things 3 inline keyboard

### Added
- **Atomic Task Breakdown Engine** (`src/utils/atomicBreakdown.ts`): MLX/Ollama-powered decomposition of complex tasks into sequential sub-tasks (each ≤2h). Complex tasks (vague, multi-action, or >2h) are auto-decomposed into ordered steps with `parentTitle` grouping and `stepOrder` sequencing. Example: "Discuss with Alice on Project X" → 1. Research status, 2. Schedule meeting, 3. Write summary. Output groups sub-tasks under their parent with indented numbering. Pulls from Things 3, `.claude/todos/`, calendar, and goals.
- **Things 3 CLI wrapper** (`src/utils/t3Helper.ts`): Subprocess wrapper for `t3` CLI. Fetches tasks from any Things 3 view with JSON parsing and UUID deduplication. 10s timeout. Fixed: removed erroneous `--json` flag (`t3` outputs JSON by default).
- **Task Suggestion Callback Handler** (`src/callbacks/taskSuggestionHandler.ts`): In-memory session store (1h TTL) and Grammy callback handler for `ts:all:{sessionId}` / `ts:skip:{sessionId}` inline keyboard buttons. Confirmed tap batch-adds tasks to Things 3 via URL scheme.
- **`sendToGroup` / `sendAndRecord`**: Accept `reply_markup?: unknown`, attached to last chunk only. Return `message_id`.

### Changed
- **Morning Summary** (`routines/morning-summary.ts`): Replaced `suggestTasks()` with `breakdownTasks()` + `formatAtomicTaskBlock()`. Shows numbered "Today's Action Plan" with time slots, durations, source attribution, and "Add All to Things 3" inline keyboard. Recap Ollama timeout raised 30s → 90s for qwen3.5:4b.
- **Smart Check-in** (`routines/smart-checkin.ts`): Complete rewrite. Calendar-aware context with meeting prep reminders (30min before start), post-meeting debrief suggestions, Things 3 task context. Decision engine uses local Ollama (`callOllamaGenerate` with `think: false`) for YES/NO check-in decisions — replaced Claude CLI subprocess (Haiku) which hung due to OAuth/startup latency with no timeout. Schedule guard: Mon–Sat 06–22, Sun 12–23.
- **Ollama client** (`src/ollama/client.ts`): `callOllamaGenerate` accepts `think?: boolean`. When `false`, routes to `/api/chat` with `think: false` (required for `qwen3.x` thinking models — `/api/generate` does not support this flag). All routine Ollama calls now pass `think: false`.
- **Bot startup** (`src/relay.ts`): Registers `registerTaskSuggestionHandler(bot)` for `ts:*` callback queries.

### Removed
- `suggestTasks()`, `getFallbackTasks()`, `scheduleTaskReminders()`, `SuggestedTask` type, `BOT_TOKEN` constant from `morning-summary.ts`.

### Notes
- **Ollama model**: `OLLAMA_ROUTINE_MODEL=qwen3.5:4b` in `~/.claude-relay/.env`. Controls both recap and atomic breakdown.
- **qwen3.5:4b thinking**: Extended thinking disabled via `think: false` in all routine Ollama calls. Without it the model enters a multi-minute thinking loop and times out at any reasonable threshold.
- **Calendar + PM2/launchd**: `calendar-helper` TCC access is granted to the spawning process. PM2 starts under launchd with no UI context — calendar degrades gracefully to `null`. Fix: run `calendar-helper check-access` from an interactive terminal session once to register TCC for that terminal app, then start PM2 from that session.

---

### Added
- Structured observability system for debugging message flow and LTM extraction (`src/utils/tracer.ts`)
- JSON Lines logging to `~/.claude-relay/logs/YYYY-MM-DD.jsonl` with 30-day retention
- Trace events: `message_received`, `claude_start`, `claude_complete`, `ltm_enqueued`, `ltm_llm_call`, `ltm_parse_result`, `ltm_store_result`
- Standalone e2e test suite: `bun run test:observability`

### Changed
- `src/relay.ts`: instrumented `processTextMessage()` and `callClaude()` with trace spans
- `src/memory/longTermExtractor.ts`: instrumented `extractMemoriesFromExchange()` and `storeExtractedMemories()` with LTM debug logging (prompt sent, raw LLM response, parse result, DB write outcome)

### Notes
- Observability is **opt-in**: set `OBSERVABILITY_ENABLED=1` in `.env` to enable
- Primary use case: diagnosing silent LTM extraction failures

### Changed
- LTM extraction now analyzes the full conversation exchange (user message + assistant
  reply) rather than only the user's message. The assistant's restatements or
  confirmations of user facts improve extraction quality. Bot command responses
  (/help, /status, /memory, etc.) remain excluded by architecture — extraction
  only runs for conversational messages.

### Added
- **PM2 Process Manager Support**: Cross-platform service management with cron scheduling
  - Works on macOS, Linux, and Windows (replaces platform-specific solutions)
  - Built-in cron scheduling for periodic jobs (smart check-ins, briefings, watchdog)
  - Real-time monitoring dashboard with `npx pm2 monit`
  - Centralized log management with `npx pm2 logs`
  - Auto-restart on crash with memory limits
  - Startup scripts for auto-start on boot
  - New setup script: `setup/configure-pm2.ts`
  - New npm command: `bun run setup:pm2 -- --service all`
  - Documentation: `docs/PM2-SETUP.md`
  - Example configuration: `ecosystem.config.example.js`

### Added
- **Watchdog Monitoring System**: Comprehensive job monitoring with automatic failure detection
  - Monitors all scheduled jobs (morning briefing, night summary, custom jobs)
  - Runs 6 times daily to catch issues quickly
  - Smart alert throttling (max 1 alert per 6 hours per issue)
  - Checks service status, execution time, and log errors
  - Telegram alerts when jobs fail or are overdue
  - Self-monitoring health checks
  - Persistent state tracking in `logs/watchdog-state.json`
  - New script: `setup/watchdog.ts`
  - Documentation: `docs/WATCHDOG.md`, `docs/ADDING-NEW-JOBS.md`

- **Night Summary Service**: Daily reflection at 11 PM
  - Reviews today's activities and accomplishments
  - Tracks progress on active goals
  - Identifies insights and areas for improvement
  - Generates tomorrow's priorities
  - Claude-powered analysis of the day
  - Script: `examples/night-summary.ts`
  - Automatically monitored by watchdog

- **Production-Ready Service Management**
  - Updated launchd configuration for all services
  - Centralized service status documentation
  - Quick reference for service commands
  - Documentation: `docs/SERVICE-STATUS.md`

- **Fallback AI Model Support**: Bot now automatically falls back to local Ollama model when Claude API is unavailable
  - Graceful degradation ensures bot stays responsive during Claude outages
  - Supports any Ollama model (recommended: gemma3-4b for balance of speed/quality)
  - Zero-cost resilience - fallback runs entirely locally
  - Automatic detection and switching with clear labeling in responses
  - New environment variables: `FALLBACK_MODEL`, `OLLAMA_API_URL`
  - New test script: `bun run test:fallback`
  - Documentation: `docs/FALLBACK.md`

### Changed
- Updated `setup/configure-launchd.ts` to include watchdog and night summary services
- Enhanced README.md with production features section
- Updated `.env.example` to include fallback configuration options
- Enhanced `callClaude()` function to attempt fallback on any Claude failure
- Startup now checks fallback availability and logs status

### Documentation
- Added comprehensive watchdog documentation
- Added guide for adding new scheduled jobs
- Added service status quick reference
- Updated README with production features

## [1.0.0] - 2024-01-XX

### Initial Release
- Telegram relay connecting to Claude Code CLI
- Local persistent memory (SQLite + Qdrant + Ollama embeddings)
- Semantic search over conversation history
- Voice transcription (Groq and local Whisper support)
- Smart check-ins and morning briefings
- Always-on background service configuration
- Guided setup via Claude Code
