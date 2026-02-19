# Changelog

## [Unreleased]

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
- Supabase integration for persistent memory
- Semantic search over conversation history
- Voice transcription (Groq and local Whisper support)
- Smart check-ins and morning briefings
- Always-on background service configuration
- Guided setup via Claude Code
