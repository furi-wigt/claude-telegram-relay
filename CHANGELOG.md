# Changelog

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
