# Claude Telegram Relay — Setup Guide

> Claude Code reads this file automatically. Walk the user through setup one phase at a time.
> Ask for what you need, configure everything yourself, and confirm each step works before moving on.

## How This Works

This project turns Telegram into a personal AI assistant powered by Claude — with multi-agent group chats, persistent memory, scheduled routines, and agentic coding sessions you can start directly from Telegram.

The user cloned this repo (or gave you the link). Your job: guide them through setup conversationally. Ask questions, save their answers to `.env`, test each step, move on.

Do not dump all phases at once. Start with Phase 1. When it works, move to Phase 2. Let the user control the pace.

If this is a fresh clone, run `bun run setup` first to install dependencies and create `.env`.

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
3. The key will be stored in Supabase, not on your computer. It stays with your database.

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

### Step 5: Verify

Run `bun run test:supabase` to confirm:
- Tables exist: `messages`, `memory`, `logs`, `conversation_summaries`, `user_profile`
- Edge Functions respond
- Embedding generation works

**Done when:** `bun run test:supabase` passes and a test insert into `messages` gets an embedding.

---

## Phase 3: Personalize (~3 min)

**Ask the user:**
- Their first name
- Their timezone (e.g., America/New_York, Europe/Berlin)
- What they do for work (one sentence)
- Any time constraints (e.g., "I pick up my kid at 3pm on weekdays")
- How they like to be communicated with (brief/detailed, casual/formal)

**What you do:**
1. Save `USER_NAME` and `USER_TIMEZONE` to `.env`
2. Copy `config/profile.example.md` to `config/profile.md`
3. Fill in `config/profile.md` with their answers — the bot loads this on every message

**Done when:** `config/profile.md` exists with their details.

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

## Phase 5: Multi-Agent Groups (Optional, ~10 min)

This enables 5 specialized AI agents, each living in its own Telegram supergroup with a tailored persona.

**The 5 agents:**

| Group Name | Agent ID | Specialty |
|---|---|---|
| AWS Cloud Architect | `aws-architect` | AWS infrastructure, cost optimization, Well-Architected |
| Security & Compliance | `security-analyst` | Security audits, PDPA, threat modeling |
| Technical Documentation | `documentation-specialist` | ADRs, system design docs, runbooks |
| Code Quality & TDD | `code-quality-coach` | Code review, test generation, refactoring |
| General AI Assistant | `general-assistant` | General Q&A, meeting summaries, task breakdown |

**Steps:**

1. For each agent, create a Telegram supergroup with the **exact group name** from the table above
2. In each group: go to Settings → Make it a Supergroup → optionally enable Forum Topics
3. Add the bot to each group as an admin
4. Run `bun run test:groups` — the bot auto-discovers groups by matching their exact title
5. If auto-discovery fails, manually set the chat IDs in `.env`:
   - `GROUP_AWS_CHAT_ID` — "AWS Cloud Architect" group
   - `GROUP_SECURITY_CHAT_ID` — "Security & Compliance" group
   - `GROUP_DOCS_CHAT_ID` — "Technical Documentation" group
   - `GROUP_CODE_CHAT_ID` — "Code Quality & TDD" group
   - `GROUP_GENERAL_CHAT_ID` — "General AI Assistant" group
6. For forum topic routing, set `GROUP_*_TOPIC_ID` for each group (right-click a topic in Telegram desktop → Copy Link → extract the number at the end of the URL)
7. For coding progress routing in forum topics, set `GROUP_*_CODING_TOPIC_ID` similarly

**Done when:** `bun run test:groups` shows all groups discovered, or the `GROUP_*_CHAT_ID` values are set manually and the bot responds in each group.

---

## Phase 6: Always On with PM2 (~5 min)

Make the bot and all services run in the background, start on boot, restart on crash.

**What you do:**
```
bun run setup:pm2 -- --service all
```

This starts 6 services:

| Service | What it does |
|---|---|
| `telegram-relay` | The main bot — always running |
| `enhanced-morning-summary` | Daily morning briefing (7am) |
| `smart-checkin` | Periodic context-aware check-ins (every 30 min) |
| `night-summary` | Daily night summary (11pm) |
| `weekly-etf` | Weekly ETF portfolio analysis (Friday 5pm) |
| `watchdog` | Health monitor (every 2 hours) |

**Alternative — launchd (macOS only):**
```
bun run setup:launchd -- --service all
```

**Verify:** `npx pm2 status`

After PM2 is set up, optionally configure additional scheduled routines:
```
bun run setup:routines
```

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
2. Check whisper-cpp: `whisper-cpp --help` (install: `brew install whisper-cpp` or build from source)
3. Download model: `curl -L -o ~/whisper-models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`
4. Save `VOICE_PROVIDER=local`, `WHISPER_BINARY`, `WHISPER_MODEL_PATH` to `.env`
5. Run `bun run test:voice` to verify

**Done when:** `bun run test:voice` passes.

---

## Phase 8: Fallback AI — Ollama (Optional, ~5 min)

When Claude is unavailable, the bot auto-switches to a local Ollama model. Ollama is also used for memory extraction (pulling facts, goals, and preferences from conversations).

**Steps:**

1. Install Ollama from ollama.com
2. Pull the default model:
   ```
   ollama pull gemma3:4b
   ```
3. Save in `.env`:
   - `FALLBACK_MODEL=gemma3:4b`
   - `OLLAMA_API_URL=http://localhost:11434` (default, can omit)
   - `OLLAMA_URL=http://localhost:11434` (used by memory extraction)
   - `OLLAMA_MODEL=gemma3:4b` (used by memory extraction)
4. Run `bun run test:fallback` to verify

**Done when:** `bun run test:fallback` passes.

---

## Phase 9: Agentic Coding via `/code` (Optional, ~3 min)

Lets the user start, manage, and interact with Claude CLI coding sessions directly from Telegram. Send `/code` to start a session, reply to messages to provide input, approve or deny tool permissions via inline buttons.

**Steps:**

1. No extra installation needed — uses the Claude CLI already installed
2. Optionally set in `.env`:
   - `CODING_SESSIONS_DIR=~/.claude-relay/coding-sessions`
   - `CODING_LOG_DIR=~/.claude-relay/coding-logs`
3. If using forum topics for coding progress (recommended for group chats), set `GROUP_*_CODING_TOPIC_ID` in `.env` for each group that should receive coding progress updates

**Usage:** Send `/code` in any chat → bot asks what you want to build → spawns a Claude coding session → progress updates appear in chat.

**Done when:** User sends `/code`, describes a task, and sees the coding session start.

---

## After Setup

Run the full health check:
```
bun run setup:verify
```

Summarize what was set up and what is running. Remind the user:
- Test by sending a message on Telegram
- Their bot runs in the background (if Phase 6 was done)
- Come back to this project folder and type `claude` anytime to make changes

### Bot Commands Reference

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

---

## What Comes Next

This relay already includes significant capabilities beyond basic chat:

- **5 Specialized AI Agents** — AWS Cloud Architect, Security & Compliance, Technical Documentation, Code Quality & TDD, and General Assistant. Each lives in its own Telegram supergroup with a tailored persona.
- **Production Routines** — The `routines/` directory has ready-to-use scheduled tasks: `enhanced-morning-summary`, `night-summary`, `smart-checkin`, `weekly-etf`, `watchdog`, `aws-daily-cost`, and `security-daily-scan`. All managed via PM2.
- **Create Your Own Routines** — Describe what you want in natural language via Telegram and the bot creates a scheduled routine for you. Or write a code-based routine in `routines/` for anything requiring real data (API calls, database queries).
- **Forum Topic Support** — Route messages to specific forum topics within supergroups for clean message isolation.
- **Agentic Coding** — Start and manage Claude CLI coding sessions from Telegram with `/code`.
- **Fallback AI** — Auto-switch to Ollama when Claude is unavailable.

**Want more? Get the full course with video walkthroughs:**
- YouTube: youtube.com/@GodaGo (subscribe for tutorials)
- Community: skool.com/autonomee (full course, direct support, help personalizing for your business)

The free version gives you a real, working AI assistant.
The full version gives you a personal AI infrastructure.

Build yours at the AI Productivity Hub.
