# Claude Telegram Relay — Setup Guide

> Claude Code reads this file automatically. Walk the user through setup one phase at a time.
> Ask for what you need, configure everything yourself, and confirm each step works before moving on.
>
> **When a user opens this project for the first time, greet them warmly and begin Phase 1 immediately. Do not wait for them to ask.**
>
> **For LLM agents working on routines:** Before creating, modifying, or debugging any file in `routines/`, read `routines/CLAUDE.md` first. It defines required code patterns (PM2/bun `_isEntry` guard, `process.exit(0)` error handling), deployment safety rules (never ecosystem-wide restart), and a pre-commit checklist. `routines/user_journey.md` covers the user-facing lifecycle and Telegram interface.

## What This Is

This project turns Telegram into a personal AI assistant powered by Claude Code — with multi-agent group chats, persistent memory, scheduled routines, and agentic coding sessions you can start directly from Telegram.

**What you get:**
- 5 specialised AI agents, each in their own Telegram supergroup (AWS Architect, Security, Documentation, Code Quality, General)
- Long-term memory: facts, goals, preferences stored in Supabase with semantic search
- Scheduled routines: morning briefing, evening summary, proactive check-ins, health watchdog
- Document RAG: upload PDFs, ask questions, get answers grounded in your documents
- Voice transcription: send voice messages, bot transcribes and responds
- Agentic coding: start and manage Claude Code sessions from Telegram with `/code`

**Everything is controlled from Telegram.** Once deployed, you talk to Claude through your phone.

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

This installs dependencies and creates `.env` from the template. Then come back here.

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

## Phase 2: Database & Memory — Supabase (~15 min)

Your bot's memory lives in Supabase: conversation history, facts, goals, and semantic search.

### Step 1: Create Supabase Project

**You need from the user:**
- Supabase Project URL
- Supabase anon public key

**What to tell them:**
1. Go to supabase.com, create a free account
2. Create a new project (any name, any region close to them)
3. Wait ~2 minutes for it to provision
4. Go to Project Settings > API
5. Copy: Project URL and anon public key

**What you do:**
1. Save `SUPABASE_URL` and `SUPABASE_ANON_KEY` to `.env`

### Step 2: Connect Supabase MCP

This lets Claude Code manage the database directly — run queries, deploy functions, apply migrations.

**What to tell them:**
1. Go to supabase.com/dashboard/account/tokens
2. Create an access token, copy it

**What you do:**
```
claude mcp add supabase -- npx -y @supabase/mcp-server-supabase@latest --access-token ACCESS_TOKEN
```

### Step 3: Create Tables

Use the Supabase MCP to run the complete schema:
1. Read `db/schema.sql`
2. Execute it via `execute_sql` (or tell the user to paste it in the SQL Editor)
3. Run `bun run test:supabase` to verify tables exist

### Step 4: Set Up Semantic Search

This gives your bot real memory — it finds relevant past conversations automatically.

**You need from the user:**
- An OpenAI API key (for generating text embeddings)

**What to tell them:**
1. Go to platform.openai.com, create an account
2. Go to API keys, create a new key, copy it
3. The key will be stored in Supabase, not on your computer

**What you do:**
1. Deploy the embed Edge Function via Supabase MCP (`deploy_edge_function` with `supabase/functions/embed/index.ts`)
2. Deploy the search Edge Function (`supabase/functions/search/index.ts`)
3. Tell the user to store their OpenAI key in Supabase:
   - Go to Supabase dashboard > Project Settings > Edge Functions
   - Under Secrets, add: `OPENAI_API_KEY` = their key
4. Set up database webhooks so embeddings are generated automatically:
   - Go to Supabase dashboard > Database > Webhooks > Create webhook
   - Name: `embed_messages`, Table: `messages`, Events: INSERT
   - Type: Supabase Edge Function, Function: `embed`
   - Create a second webhook: `embed_memory`, Table: `memory`, Events: INSERT
   - Same Edge Function: `embed`
   - Create a third webhook: `embed_documents`, Table: `documents`, Events: INSERT
   - Same Edge Function: `embed`

### Step 5: Verify

Run `bun run test:supabase` to confirm:
- Tables exist: `messages`, `memory`, `logs`, `conversation_summaries`, `user_profile`, `documents`
- Edge Functions respond
- Embedding generation works

**Done when:** `bun run test:supabase` passes.

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

### Step 3b: Set Artifact Output Path

Agents save research, documentation, and security reports to a configurable base path.

**What you do:**
1. Set `ARTIFACTS_PATH` in `.env` to the folder where outputs should be saved:
   ```
   ARTIFACTS_PATH=~/Documents/jarvis-outputs
   ```
2. The following subfolders will be used automatically:
   - `$ARTIFACTS_PATH/ai-research/` — research reports (Research Analyst)
   - `$ARTIFACTS_PATH/ai-docs/` — documentation and write-ups (Docs Specialist, General Assistant, AWS Architect)
   - `$ARTIFACTS_PATH/ai-security/` — security reports (Security Analyst)
3. Create the base folder if it doesn't exist: `mkdir -p $ARTIFACTS_PATH`

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

This enables 5 specialised AI agents, each living in their own Telegram supergroup with a tailored persona.

**The 5 agents:**

| Group Name | Agent ID | Specialty |
|---|---|---|
| AWS Cloud Architect | `aws-architect` | AWS infrastructure, cost optimisation, Well-Architected |
| Security & Compliance | `security-analyst` | Security audits, threat modelling, compliance |
| Technical Documentation | `documentation-specialist` | ADRs, system design docs, runbooks |
| Code Quality & TDD | `code-quality-coach` | Code review, test generation, refactoring |
| General AI Assistant | `general-assistant` | General Q&A, meeting summaries, task breakdown |

**Steps:**

1. For each agent, create a Telegram supergroup with the **exact group name** from the table above
2. In each group: go to Settings → Make it a Supergroup (required for forum topic routing)
3. Add the bot to each group as an admin
4. Run `bun run test:groups` — the bot auto-discovers groups by matching their exact title

### Setting Chat IDs

If auto-discovery works, the bot resolves groups at runtime. If it fails, set them manually:

**Option A — Environment variables (simpler):**
```
GROUP_AWS_CHAT_ID=-100xxxxxxxxxx
GROUP_SECURITY_CHAT_ID=-100xxxxxxxxxx
GROUP_DOCS_CHAT_ID=-100xxxxxxxxxx
GROUP_CODE_CHAT_ID=-100xxxxxxxxxx
GROUP_GENERAL_CHAT_ID=-100xxxxxxxxxx
```

**Option B — agents.json (persistent, recommended for long-term use):**
1. `config/agents.json` already exists with all `chatId` values set to `null`
2. Fill in the `chatId` field for each agent with the real group chat ID
3. Restart the bot

> **Note:** `config/agents.json` is gitignored — your real chat IDs stay local.
> `config/agents.example.json` is the committed clean template — never modify it directly.

### Forum Topic Setup (Optional)

If you enable Forum Topics in your supergroups, the bot can route messages to specific topics.

To get a topic ID: right-click any topic in Telegram desktop → Copy Link → extract the trailing number from the URL.

**In agents.json:**
- `topicId` — topic where regular messages from this agent appear
- `codingTopicId` — topic where `/code` coding session progress appears

**In .env (alternative):**
```
GROUP_AWS_TOPIC_ID=123
GROUP_AWS_CODING_TOPIC_ID=456
GROUP_GENERAL_TOPIC_ID=789
GROUP_GENERAL_CODING_TOPIC_ID=012
```

**Done when:** `bun run test:groups` shows all groups discovered, or `chatId` values are set and the bot responds in each group.

---

## Phase 6: Always On with PM2 (~5 min)

Make the bot and all services run in the background, start on boot, restart on crash.

**What you do:**
```
bun run setup:pm2 -- --service all
```

This starts 6 services:

| Service | What it does | Type |
|---|---|---|
| `telegram-relay` | The main bot — always running | Core |
| `enhanced-morning-summary` | Daily morning briefing (7am) | Core |
| `smart-checkin` | Periodic context-aware check-ins (every 30 min, waking hours) | Core |
| `night-summary` | Daily night summary (11pm) | Core |
| `watchdog` | Health monitor (every 2 hours) | Core |
| `weekly-etf` | Weekly ETF portfolio analysis (Friday 5pm) | Optional — investment-specific |

> **Optional routines:** `weekly-etf` and `etf-52week-screener` are investment screening tools
> designed for a specific ETF portfolio strategy. They may not be relevant for your use case.
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
> If unset, the summary shows a Singapore-wide forecast by default.

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

## Phase 8: Fallback AI — Ollama (Optional, ~5 min)

When Claude is unavailable, the bot auto-switches to a local Ollama model. Ollama is also used as a fallback for memory extraction.

**Steps:**

1. Install Ollama from ollama.com
2. Pull the default model:
   ```
   ollama pull gemma3:4b
   ```
3. Save in `.env`:
   - `FALLBACK_MODEL=gemma3:4b`
   - `OLLAMA_API_URL=http://localhost:11434`
   - `OLLAMA_URL=http://localhost:11434`
   - `OLLAMA_MODEL=gemma3:4b`
4. Run `bun run test:fallback` to verify

**Done when:** `bun run test:fallback` passes.

---

## Phase 9: Agentic Coding via `/code` (Optional, ~3 min)

Lets the user start, manage, and interact with Claude Code coding sessions directly from Telegram. Send `/code` to start a session, reply to messages to provide input, approve or deny tool permissions via inline buttons.

**Steps:**

1. No extra installation needed — uses the Claude CLI already installed
2. Optionally set in `.env`:
   - `CODING_SESSIONS_DIR=~/.claude-relay/coding-sessions`
   - `CODING_LOG_DIR=~/.claude-relay/coding-logs`
3. If using forum topics for coding progress, set `codingTopicId` in `agents.json` or `GROUP_*_CODING_TOPIC_ID` in `.env`

**Usage:** Send `/code` in any chat → bot asks what you want to build → spawns a Claude Code session → progress updates appear in chat.

**Done when:** User sends `/code`, describes a task, and sees the coding session start.

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
- `config/profile.md` and `config/agents.json` are gitignored — safe to customise freely

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
| `/goals` | View and manage goals |
| `/goals +goal text` | Add a new goal |
| `/goals -old goal` | Remove a goal |
| `/goals *N or *text` | Mark goal as done (toggle active / done) |
| `/goals *` | View completed/archived goals |
| `/history` | Recent messages |
| `/routines` | Manage scheduled routines |
| `/plan [task]` | Interactive clarification Q&A before Claude starts |
| `/code` | Start an agentic coding session |
| `/doc list` | List uploaded documents |
| `/doc forget [name]` | Remove a document from memory |
| `/doc query [question]` | Search across all uploaded documents |

---

## What Comes Next

This relay already includes significant capabilities beyond basic chat:

- **5 Specialised AI Agents** — each with a tailored persona in its own Telegram supergroup. Edit `config/prompts/*.md` to change any agent's focus, tone, or save paths.
- **Production Routines** — the `routines/` directory has ready-to-use scheduled tasks. Read `routines/CLAUDE.md` (code patterns and PM2 safety rules) then `routines/user_journey.md` (full lifecycle guide) before creating your own.
- **Document RAG** — upload PDFs to Telegram, query them with natural language via `/doc query`
- **Forum Topic Support** — route messages to specific topics within supergroups for clean separation
- **Agentic Coding** — start and manage Claude Code sessions from Telegram
- **Fallback AI** — auto-switch to Ollama when Claude is unavailable

**Want to personalise further?**
- Edit `config/prompts/*.md` to change each agent's persona, domain focus, or save paths
- Edit `config/profile.md` to update your profile (the bot reads this on every message)
- Add new agents by creating entries in `config/agents.json` and prompts in `config/prompts/`
