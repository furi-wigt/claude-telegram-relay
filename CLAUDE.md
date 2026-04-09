# Claude Telegram Relay — Setup Guide

> Claude Code reads this file automatically. Walk the user through setup one phase at a time.
> Ask for what you need, configure everything yourself, and confirm each step works before moving on.
>
> **When a user opens this project for the first time, greet them warmly and begin Phase 1 immediately. Do not wait for them to ask.**
>
> **For LLM agents working on routines:** Read `routines/CLAUDE.md` before creating, modifying, or debugging any file in `routines/`.
>
> **For LLM agents writing or reviewing E2E/integration tests:** Read `CLAUDE.e2e.md` before writing any test that touches Telegram bot behavior.
>
> **Todos/specs location:** Save all plans and todos to `~/.claude-relay/todos/` and all specs to `~/.claude-relay/specs/`. Do NOT write to `.claude/todos/` or `.claude/specs/` — the Claude Code harness blocks writes to `.claude/**` in non-interactive (bot) sessions. This project uses `~/.claude-relay/todos/` as the single source of truth for all plans and task tracking.
>
> **Service restart confirmation (MANDATORY):** Before executing any command that restarts or reloads the `telegram-relay` service (e.g. `npx pm2 restart telegram-relay`, `npx pm2 reload telegram-relay`), you MUST ask the user for explicit confirmation via Telegram inline keyboard — two buttons: Confirm restart and Cancel. Do NOT restart without a confirmed Yes. This applies to Claude Code agents operating in this project.
>
> **Temporary and session files:** Do NOT create temporary scripts, one-off tools, or session-scoped working files in the project root or `src/`. Save all temporary/session files to `.claude/workspace/` (e.g. `.claude/workspace/my-script.ts`). This directory is gitignored and meant for transient work. Delete temp files when the session task is complete.
>
> **Testing:** Always use `bun run test` to run the full test suite (runs tests in isolation). Use `bun test <file>` only for targeted single-file runs. Never use plain `bun test` for the full suite — it does not isolate mocks between files.

## What This Is

This project turns Telegram into a personal AI assistant powered by Claude Code — with multi-agent group chats, persistent memory, scheduled routines, and agentic coding sessions you can start directly from Telegram.

**What you get:**
- 6 specialised AI agents, each in their own Telegram supergroup (Command Center, Cloud, Security, Engineering, Strategy, Operations)
- Long-term memory: facts, goals, preferences stored locally with semantic search (SQLite + Qdrant + MLX bge-m3)
- Scheduled routines: morning briefing, evening summary, proactive check-ins, health watchdog
- Document RAG: upload PDFs, ask questions, get answers grounded in your documents
- Voice transcription: send voice messages, bot transcribes and responds

**Everything runs locally.** No cloud database required. Once deployed, you talk to Claude through your phone.

## Architecture

All user data lives outside the project directory in `~/.claude-relay/`:

```
~/.claude-relay/
  .env              # User-level environment overrides
  agents.json       # Agent chat IDs and topic IDs (copied from agents.example.json by setup)
  data/
    local.sqlite    # Messages, memory, goals, logs (SQLite via Drizzle)
  logs/             # PM2 service logs
  prompts/          # Customizable agent prompts (copied from repo defaults)
    diagnostics/    # Diagnostic prompt templates
  research/         # Artifact outputs (reports, docs, security audits)
```

**Environment layering:** The bot loads `.env` from three sources in order (later values win):
1. Project `.env` (committed defaults / local dev overrides)
2. `~/.claude-relay/.env` (user-specific secrets and preferences)
3. `process.env` (runtime overrides)

**Prompt customization:** Agent prompts are loaded from `~/.claude-relay/prompts/` first, falling back to `config/prompts/` in the repo. Edit your user copy to personalize any agent without touching the repo.

**Storage stack:**
- **SQLite** (`~/.claude-relay/data/local.sqlite`) — messages, memory entries, goals, conversation summaries, logs
- **Qdrant** (local vector DB) — semantic search over messages and memory
- **MLX** — `mlx serve-embed` for embeddings (bge-m3, port 8801). Text generation is handled by LM Studio (or any OpenAI-compatible server) via ModelRegistry — see `~/.claude-relay/models.json`.

## Prerequisites

Before starting, verify you have:

- **Bun** `>= 1.0` — install from [bun.sh](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code` then `claude login`
- **Git** and a terminal (macOS or Linux)
- A **Telegram account**

## Quick Start

If this is a fresh clone, run setup first:

```bash
bun run setup
```

This installs dependencies, creates `~/.claude-relay/` directories, copies default prompts, and prepares `.env` from the template. Then come back here.

---

## How This Guide Works

Claude Code reads this file and guides you through setup conversationally. Ask for what you need, and Claude configures everything for you — saving values to `.env`, running tests, and confirming each step before moving on.

Do not rush all phases at once. Start with Phase 1. When it works, move to Phase 2. You control the pace.

---

## Phase 1: Telegram Bot (~3 min)

**You need from the user:**
- A Telegram bot token from @BotFather
- Their personal Telegram user ID

**What to tell them:**
1. Open Telegram, search for @BotFather, send `/newbot`
2. Pick a display name and a username ending in "bot"
3. Copy the token BotFather gives them
4. Get their user ID by messaging @userinfobot on Telegram

**What you do:**
1. Run `bun run setup` if `.env` does not exist yet
2. Save `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID` in `.env`
3. Run `bun run test:telegram` to verify — it sends a test message to the user

**Done when:** Test message arrives on Telegram.

---

## Phase 2: Local Memory & Search (~10 min)

Your bot's memory runs entirely locally — no cloud APIs needed. It uses SQLite for structured data, Qdrant for vector search, and MLX (bge-m3) for generating embeddings.

### Step 1: Install MLX embed (Apple Silicon — embeddings only)

MLX is used exclusively for generating embeddings (bge-m3, port 8801). Text generation for routines is handled by LM Studio or any OpenAI-compatible server configured in `~/.claude-relay/models.json`.

**What to tell them (macOS only):**
1. Ensure Python 3.12+ is installed: `brew install python@3.12`
2. Install the `mlx` CLI tool:
   ```bash
   uv tool install --editable tools/mlx-local --python python3.12
   ```

> **Cloudflare/corporate proxy:** The tool auto-injects `/etc/ssl/Cloudflare_CA.pem` if present. No manual cert config needed.

**Commands:**
| Command | What it does |
|---------|-------------|
| `mlx serve-embed` | Embedding-only API on `localhost:8801` |
| `mlx info` | Show cached models and sizes |

### Step 2: Start MLX embed server

**What to tell them:**
1. Start the embed server (model weights load on first request — allow ~30s):
   ```bash
   mlx serve-embed  # embeddings — port 8801
   ```
2. Verify it's running:
   ```bash
   curl http://localhost:8801/health   # → {"status":"ok","model":"...bge-m3..."}
   ```

**What you do:**
1. The env var is pre-configured. Optionally override in `~/.claude-relay/.env`:
   - `EMBED_URL=http://localhost:8801`

> **Apple Silicon only.** MLX requires Apple Silicon (M1/M2/M3/M4).

### Step 3: Install Qdrant

Qdrant is a local vector database for semantic search over messages and memory.

**What to tell them:**

**Option A — Binary (recommended):**
```bash
curl -L https://github.com/qdrant/qdrant/releases/latest/download/qdrant-$(uname -m)-apple-darwin.tar.gz | tar xz -C ~/.qdrant/bin/
```

**Option B — Docker:**
```bash
docker run -d --name qdrant -p 6333:6333 -v ~/.qdrant/storage:/qdrant/storage qdrant/qdrant
```

**What you do:**
1. Verify Qdrant is reachable: `curl http://localhost:6333/healthz`
2. The bot auto-creates its collections on first run — no manual schema setup needed

### Step 4: Verify

1. Confirm MLX embed server: `curl http://localhost:8801/health` → `{"status":"ok","model":"...bge-m3..."}`
2. Confirm Qdrant is reachable: `curl http://localhost:6333/healthz`
3. Confirm SQLite database path exists: `ls ~/.claude-relay/data/`

**Done when:** Embed server responds on port 8801, Qdrant responds on port 6333, and `~/.claude-relay/data/` exists.

---

## Phase 3: Personalise (~5 min)

**Ask the user:**
- Their first name
- Their timezone (e.g., America/New_York, Europe/Berlin, Asia/Singapore)
- What they do for work (one sentence)
- Any time constraints (e.g., "I pick up my kid at 3pm on weekdays")
- How they like to be communicated with (brief/detailed, casual/formal)

**What you do:**
1. Save `USER_NAME` and `USER_TIMEZONE` to `.env`
2. Copy `config/profile.example.md` to `config/profile.md`
3. Fill in `config/profile.md` with their answers — the bot loads this on every message

> **Note:** `config/profile.md` is gitignored — it stays on this machine and is never committed.
> If the file already exists, overwrite it with the new user's details.

### Step 3b: Artifact Output

Agents save research, documentation, and security reports to `~/.claude-relay/research/`:
- `~/.claude-relay/research/ai-research/` — research reports (Research Analyst)
- `~/.claude-relay/research/ai-docs/` — documentation and write-ups (Docs Specialist, General Assistant, AWS Architect)
- `~/.claude-relay/research/ai-security/` — security reports (Security Analyst)

This directory is created automatically. No `.env` configuration needed.

> Code plans and implementation todos stay in `.claude/todos/` (project-local, not affected by this setting).

**Done when:** `config/profile.md` exists with the user's details.

---

## Phase 4: Test — Single Chat (~2 min)

**What you do:**
1. Run `bun run start`
2. Tell the user to open Telegram and send a test message to their bot
3. Wait for confirmation it responded
4. Press Ctrl+C to stop

**Troubleshooting if it fails:**
- Wrong bot token → re-check with BotFather
- Wrong user ID → re-check with @userinfobot
- Claude CLI not found → `npm install -g @anthropic-ai/claude-code`
- Bun not installed → `curl -fsSL https://bun.sh/install | bash`

**Done when:** User confirms their bot responded on Telegram.

---

## Phase 5: Multi-Agent Groups (Optional, ~15 min)

This enables 6 specialised AI agents, each living in their own Telegram supergroup with a tailored persona.

**The 6 agents:**

| Group Name | Agent ID | Specialty |
|---|---|---|
| Jarvis Command Center | `command-center` | Orchestration, task routing, dispatch audit log |
| Cloud & Infrastructure | `cloud-architect` | AWS, CDK, GCC 2.0, cost optimisation, Well-Architected |
| Security & Compliance | `security-compliance` | IM8 v4, PDPA, security audits, threat modelling, runbooks |
| Engineering & Quality | `engineering` | Code review, TDD, refactoring, implementation |
| Strategy & Communications | `strategy-comms` | Proposals, BD materials, decks, research, ADRs |
| Operations Hub | `operations-hub` | General Q&A, meeting prep, task management (default) |

**Steps:**

1. For each agent, create a Telegram supergroup with the **exact group name** from the table above
2. In each group: go to Settings → Make it a Supergroup (required for forum topic routing)
3. Add the bot to each group as an admin
4. Run `bun run test:groups` — the bot auto-discovers groups by matching their exact title

### Setting Chat IDs

If auto-discovery works, the bot resolves groups at runtime. If it fails, set them manually:

**Option A — Environment variables (simpler):**
```
GROUP_COMMAND_CENTER_CHAT_ID=-100xxxxxxxxxx
GROUP_CLOUD_CHAT_ID=-100xxxxxxxxxx
GROUP_SECURITY_CHAT_ID=-100xxxxxxxxxx
GROUP_ENGINEERING_CHAT_ID=-100xxxxxxxxxx
GROUP_STRATEGY_CHAT_ID=-100xxxxxxxxxx
GROUP_OPERATIONS_CHAT_ID=-100xxxxxxxxxx
```

**Option B — agents.json (persistent, recommended for long-term use):**
1. `~/.claude-relay/agents.json` was created by `bun run setup` with all `chatId` values set to `null`
2. Fill in the `chatId` field for each agent with the real group chat ID
3. Restart the bot

> **Note:** `~/.claude-relay/agents.json` is your personal config — it lives outside the repo and survives `git clean`.
> `config/agents.example.json` is the committed clean template. Never edit it directly.

### Forum Topic Setup (Optional)

If you enable Forum Topics in your supergroups, the bot can route messages to specific topics.

To get a topic ID: right-click any topic in Telegram desktop → Copy Link → extract the trailing number from the URL.

**In agents.json:**
- `topicId` — topic where regular messages from this agent appear

**In .env (alternative):**
```
GROUP_AWS_TOPIC_ID=123
GROUP_GENERAL_TOPIC_ID=789
```

**Done when:** `bun run test:groups` shows all groups discovered, or `chatId` values are set and the bot responds in each group.

---

## Phase 6: Always On with PM2 (~5 min)

Make the bot and all services run in the background, start on boot, restart on crash.

**What you do:**
```
bun run setup:pm2 -- --service all
```

This starts several services:

| Service | What it does | Type |
|---|---|---|
| `qdrant` | Local vector database — always running | Infrastructure |
| `telegram-relay` | The main bot — always running | Core |
| `morning-summary` | Daily morning briefing (7am) | Core |
| `smart-checkin` | Periodic context-aware check-ins (every 30 min, waking hours) | Core |
| `night-summary` | Daily night summary (11pm) | Core |
| `watchdog` | Health monitor (every 2 hours) | Core |

> To start only core services: `bun run setup:pm2 -- --service core`

**macOS alternative — launchd:**
```
bun run setup:launchd -- --service all
```

**Configure additional scheduled routines interactively:**
```
bun run setup:routines
```

This lets you create natural-language routines or enable/disable individual services.

**Verify:** `npx pm2 status`

> **Morning weather areas:** To show weather for specific areas in the morning summary, set:
> `WEATHER_AREAS=Your City,Another Area` in `.env` (comma-separated).

> **Log location:** All PM2 service logs are written to `~/.claude-relay/logs/`.

> **Routine guides:** `routines/CLAUDE.md` — developer code patterns and PM2 safety rules (read this before writing any routine). `routines/user_journey.md` — complete lifecycle guide for creating, scheduling, and managing routines via Telegram.

**Done when:** `npx pm2 status` shows the relay as "online" and survives a terminal close.

---

## Phase 7: Voice Transcription (Optional, ~5 min)

Lets the bot understand voice messages sent on Telegram.

**Ask the user which option they prefer:**

### Option A: Groq (Recommended — free cloud API)
- State-of-the-art Whisper model, sub-second speed
- Free: 2,000 transcriptions per day, no credit card
- Requires internet connection

**What to tell them:**
1. Go to console.groq.com and create a free account
2. Go to API Keys, create a new key, copy it

**What you do:**
1. Save `VOICE_PROVIDER=groq` and `GROQ_API_KEY` to `.env`
2. Run `bun run test:voice` to verify

### Option B: Local Whisper (offline, private)
- Runs entirely on their computer, no account needed
- Requires ffmpeg and whisper-cpp installed
- First run downloads a 142MB model file

**What you do:**
1. Check ffmpeg: `ffmpeg -version` (install: `brew install ffmpeg` or `apt install ffmpeg`)
2. Check whisper-cpp: `whisper-cpp --help` (install: `brew install whisper-cpp`)
3. Download model: `curl -L -o ~/whisper-models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`
4. Save `VOICE_PROVIDER=local`, `WHISPER_BINARY`, `WHISPER_MODEL_PATH` to `.env`
5. Run `bun run test:voice` to verify

**Done when:** `bun run test:voice` passes.

---

## Phase 8: Local AI Fallback (~5 min)

When Claude is unavailable, the bot cascades to a local OpenAI-compatible server (LM Studio, Ollama, or any compatible provider). Providers and cascade order are configured in `~/.claude-relay/models.json`.

**Steps:**

1. Install and start an OpenAI-compatible local server, e.g. [LM Studio](https://lmstudio.ai) (port 1234) or Ollama (port 11434)
2. Load a model (e.g. Gemma 4B, Qwen 2.5, Mistral)
3. Edit `~/.claude-relay/models.json` — add the server under the `local` provider and set it in the cascade for the `chat` and `routine` slots
4. Restart the relay and send a message — if Claude is unreachable it will fall back automatically

> A template is at `config/models.example.json`. The ModelRegistry handles health checks and cascade ordering automatically.

**Done when:** Relay startup log shows the local provider is registered and responds to a test query.

---

## After Setup

Run the full health check:
```
bun run setup:verify
```

Summarise what was set up and what is running. Remind the user:
- Test by sending a message on Telegram
- Their bot runs in the background (if Phase 6 was done)
- Come back to this project folder and type `claude` anytime to make changes
- `config/profile.md` is gitignored — safe to customise freely
- `~/.claude-relay/agents.json` holds your chatIds — safe to edit, survives `git clean`
- Agent prompts can be customized at `~/.claude-relay/prompts/`

---

## Bot Commands Reference

| Command | What it does |
|---------|-------------|
| `/help` | All available commands |
| `/new` | Start a fresh conversation |
| `/status` | Session status |
| `/memory` | Browse your memory (goals, facts, prefs, dates) |
| `/remember [text]` | Save something to memory |
| `/forget [text]` | Remove something from memory |
| `/reflect [feedback]` | Save an explicit learning (confidence 0.85) |
| `/goals` | View and manage goals |
| `/goals +goal text` | Add a new goal |
| `/goals -old goal` | Remove a goal |
| `/goals *N or *text` | Mark goal as done (toggle active / done) |
| `/goals *` | View completed/archived goals |
| `/history` | Recent messages |
| `/routines` | Manage scheduled routines |
| `/doc list` | List uploaded documents |
| `/doc forget [name]` | Remove a document from memory |
| `/doc query [question]` | Search across all uploaded documents |

---

## What Comes Next

This relay already includes significant capabilities beyond basic chat:

- **6 Specialised AI Agents** — each with a tailored persona in its own Telegram supergroup (Command Center, Cloud, Security, Engineering, Strategy, Operations). Edit prompts at `~/.claude-relay/prompts/` to change any agent's focus, tone, or save paths.
- **Production Routines** — the `routines/` directory has ready-to-use scheduled tasks. Read `routines/CLAUDE.md` (code patterns and PM2 safety rules) then `routines/user_journey.md` (full lifecycle guide) before creating your own.
- **Document RAG** — upload PDFs to Telegram, query them with natural language via `/doc query`
- **Forum Topic Support** — route messages to specific topics within supergroups for clean separation
- **Fallback AI** — auto-cascade to local LM Studio / Ollama when Claude is unavailable, via ModelRegistry (`~/.claude-relay/models.json`)
- **Fully Local** — all data stays on your machine (SQLite + Qdrant + MLX embed)

**Want to personalise further?**
- Edit `~/.claude-relay/prompts/*.md` to change each agent's persona, domain focus, or save paths
- Edit `config/profile.md` to update your profile (the bot reads this on every message)
- Add new agents by creating entries in `config/agents.json` and prompts in `~/.claude-relay/prompts/`
