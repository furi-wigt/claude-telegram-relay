# Claude Telegram Relay

A personal AI assistant on Telegram powered by Claude Code.

You message it. Claude responds. Text, photos, documents, voice. It remembers across sessions, checks in proactively, and runs in the background.

**Created by [Goda Go](https://youtube.com/@GodaGo)** | [AI Productivity Hub Community](https://skool.com/autonomee)

```
You ──▶ Telegram ──▶ Relay ──▶ Claude Code CLI ──▶ Response
                                    │
                              Supabase (memory)
```

## What You Get

- **Relay**: Send messages on Telegram, get Claude responses back
- **Memory**: Semantic search over conversation history, persistent facts and goals via Supabase
- **Proactive**: Smart check-ins that know when to reach out (and when not to)
- **Briefings**: Daily morning summary with goals and schedule
- **Voice**: Transcribe voice messages (Groq cloud or local Whisper — your choice)
- **Fallback AI**: Auto-switches to local Ollama model when Claude is down (zero-cost resilience)
- **Always On**: Runs in the background, starts on boot, restarts on crash
- **Guided Setup**: Claude Code reads CLAUDE.md and walks you through everything

## Quick Start

### Prerequisites

- **[Bun](https://bun.sh)** runtime (`curl -fsSL https://bun.sh/install | bash`)
- **[Claude Code](https://claude.ai/claude-code)** CLI installed and authenticated
- A **Telegram** account

### Option A: Guided Setup (Recommended)

```bash
git clone https://github.com/godagoo/claude-telegram-relay.git
cd claude-telegram-relay
claude
```

Claude Code reads `CLAUDE.md` and walks you through setup conversationally:

1. Create a Telegram bot via BotFather
2. Set up Supabase for persistent memory
3. Personalize your profile
4. Test the bot
5. Configure always-on services
6. Set up proactive check-ins and briefings
7. Add voice transcription (optional)

### Option B: Manual Setup

```bash
git clone https://github.com/godagoo/claude-telegram-relay.git
cd claude-telegram-relay
bun run setup          # Install deps, create .env
# Edit .env with your API keys
bun run test:telegram  # Verify bot token
bun run test:supabase  # Verify database
bun run start          # Start the bot
```

## Commands

```bash
# Run
bun run start              # Start the bot
bun run dev                # Start with auto-reload

# Setup & Testing
bun run setup              # Install dependencies, create .env
bun run test:telegram      # Test Telegram connection
bun run test:supabase      # Test Supabase connection
bun run test:fallback      # Test fallback model (optional)
bun run setup:verify       # Full health check

# Always-On Services
bun run setup:launchd      # Configure launchd (macOS)
bun run setup:services     # Configure PM2 (Windows/Linux)

# Use --service flag for specific services:
# bun run setup:launchd -- --service relay
# bun run setup:launchd -- --service all    (relay + checkin + briefing)
```

## Project Structure

```
CLAUDE.md                    # Guided setup (Claude Code reads this)
src/
  relay.ts                   # Core relay daemon
  transcribe.ts              # Voice transcription (Groq / whisper.cpp)
  memory.ts                  # Persistent memory (facts, goals, semantic search)
  agents/
    config.ts                # Agent definitions and system prompts
  routing/
    groupRouter.ts           # Chat ID → agent mapping and auto-discovery
  session/
    groupSessions.ts         # Per-group session state management
examples/
  smart-checkin.ts           # Proactive check-ins
  morning-briefing.ts        # Daily briefing
  memory.ts                  # Memory persistence patterns
config/
  profile.example.md         # Personalization template
db/
  schema.sql                 # Supabase database schema
supabase/
  functions/
    embed/index.ts           # Auto-embedding Edge Function
    search/index.ts          # Semantic search Edge Function
setup/
  install.ts                 # Prerequisites checker
  test-telegram.ts           # Telegram connectivity test
  test-supabase.ts           # Supabase connectivity test
  test-voice.ts              # Voice transcription test
  configure-launchd.ts       # macOS service setup
  configure-services.ts      # Windows/Linux service setup
  verify.ts                  # Full health check
daemon/
  launchagent.plist          # macOS daemon template
  claude-relay.service       # Linux systemd template
  README-WINDOWS.md          # Windows options
```

## How It Works

The relay does three things:
1. **Listen** for Telegram messages (via grammY)
2. **Spawn** Claude Code CLI with context (your profile, memory, time)
3. **Send** the response back on Telegram

Claude Code gives you full power: tools, MCP servers, web search, file access. Not just a model — an AI with hands.

Your bot remembers between sessions via Supabase. Every message gets an embedding (via OpenAI, stored in Supabase) so the bot can semantically search past conversations for relevant context. It also tracks facts and goals — Claude detects when you mention something worth remembering and stores it automatically.

## Multi-Agent Architecture

Instead of a single bot, you can run 5 specialized agents -- each in its own Telegram group with isolated memory and a dedicated Claude Code session.

```
AWS Group          ──▶ AWS Cloud Architect agent      ──▶ Claude Code --agent architect.md
Security Group     ──▶ Security & Compliance agent    ──▶ Claude Code --agent security.md
Docs Group         ──▶ Technical Documentation agent  ──▶ Claude Code --agent documentation-writer.md
Code Quality Group ──▶ Code Quality & TDD agent       ──▶ Claude Code --agent reviewer.md
General Group      ──▶ General AI Assistant            ──▶ Claude Code (default)
```

### The 5 Agents

| Agent | Group Name | Specialty |
|-------|-----------|-----------|
| AWS Cloud Architect | "AWS Cloud Architect" | Infrastructure design, cost optimization, AWS service recommendations |
| Security & Compliance Analyst | "Security & Compliance" | Security audits, PDPA compliance, threat modeling |
| Technical Documentation Specialist | "Technical Documentation" | ADRs, system design docs, runbooks |
| Code Quality & TDD Coach | "Code Quality & TDD" | Code reviews, test coverage, refactoring suggestions |
| General AI Assistant | "General AI Assistant" | Everything else -- meeting notes, quick questions, task breakdown |

### Group Setup

1. Create 5 Telegram groups with the exact names listed in the table above.
2. Add your bot to each group (you and the bot are the only members).
3. Start the bot -- it auto-discovers groups by matching the group title to the expected agent name.

```bash
bun run start
# Send a test message in each group
# Bot logs: "Auto-registered: "AWS Cloud Architect" → AWS Cloud Architect"
```

If auto-discovery does not work (e.g. you renamed a group), set the chat IDs explicitly in `.env`:

```bash
GROUP_AWS_CHAT_ID=-1001234567890
GROUP_SECURITY_CHAT_ID=-1001234567891
GROUP_DOCS_CHAT_ID=-1001234567892
GROUP_CODE_CHAT_ID=-1001234567893
GROUP_GENERAL_CHAT_ID=-1001234567894
```

To find a group's chat ID, run `bun run test:groups` and send a message in each group.

### Memory Isolation

Each group maintains its own:

- **Conversation history** -- messages are tagged with the group's `chat_id`
- **Stored facts and goals** -- a fact saved in the AWS group is not visible in the Security group
- **Claude Code session** -- each agent keeps its own session state on disk

This means asking "What AWS region do we use?" in the Security group returns nothing, even if you told the AWS group "We use us-east-1 for production" five minutes earlier. Isolation keeps each agent focused on its domain.

### How Routing Works

1. A message arrives from Telegram with a `chat_id`.
2. The group router looks up which agent owns that `chat_id` (via `.env` mapping or auto-discovery from the group title).
3. The matched agent's system prompt, capabilities, and Claude Code agent file are loaded.
4. Memory queries (semantic search, facts, goals) are filtered to only return results for that `chat_id`.
5. Claude Code runs with the agent-specific prompt and returns a response.
6. The response and the original message are saved to Supabase, tagged with `chat_id` and `agent_id`.

If a message arrives from an unregistered group, it falls back to the General AI Assistant.

## Environment Variables

See `.env.example` for all options. The essentials:

```bash
# Required
TELEGRAM_BOT_TOKEN=     # From @BotFather
TELEGRAM_USER_ID=       # From @userinfobot
SUPABASE_URL=           # From Supabase dashboard
SUPABASE_ANON_KEY=      # From Supabase dashboard

# Recommended
USER_NAME=              # Your first name
USER_TIMEZONE=          # e.g., America/New_York

# Optional — Voice
VOICE_PROVIDER=         # "groq" or "local"
GROQ_API_KEY=           # For Groq (free at console.groq.com)

# Optional — Multi-Agent Groups (auto-discovered if not set)
GROUP_AWS_CHAT_ID=      # "AWS Cloud Architect" group
GROUP_SECURITY_CHAT_ID= # "Security & Compliance" group
GROUP_DOCS_CHAT_ID=     # "Technical Documentation" group
GROUP_CODE_CHAT_ID=     # "Code Quality & TDD" group
GROUP_GENERAL_CHAT_ID=  # "General AI Assistant" group

# Note: OpenAI key for embeddings is stored in Supabase
# (Edge Function secrets), not in this .env file.
```

## Production Features

This relay includes production-ready features:

- **Watchdog Monitoring** — Automatically monitors all scheduled jobs (morning briefing, night summary) and alerts you via Telegram if anything fails. Runs 6x daily. See [docs/WATCHDOG.md](docs/WATCHDOG.md)
- **Service Management** — All scripts run as background services via PM2 (cross-platform) or launchd (macOS). Start on boot, restart on crash. See [docs/SERVICE-STATUS.md](docs/SERVICE-STATUS.md)
- **Semantic Memory** — Conversation history with vector search via Supabase. Bot remembers context from weeks ago.
- **Voice Transcription** — Groq (cloud) or local whisper.cpp support for voice messages.
- **Proactive AI** — Morning briefings and night summaries with context from your actual data.

## The Full Version

This free relay covers the essentials. The full version in the [AI Productivity Hub](https://skool.com/autonomee) community unlocks:

- **6 Specialized AI Agents** — Research, Content, Finance, Strategy, Critic + General orchestrator via Telegram forum topics (extends the 5-agent architecture included in the free version)
- **VPS Deployment** — Always-on cloud server with hybrid mode ($2-5/month)
- **Real Integrations** — Gmail, Calendar, Notion connected via MCP
- **Human-in-the-Loop** — Claude asks before taking actions via inline buttons
- **Voice & Phone Calls** — Bot speaks back via ElevenLabs, calls when urgent
- **Fallback AI Models** — Auto-switch to OpenRouter or Ollama when Claude is down
- **Advanced Infrastructure** — Auto-deploy from GitHub, custom domain, SSL certificates

We also help you personalize it for your business, or package it as a product for your clients.

**Subscribe on YouTube:** [youtube.com/@GodaGo](https://youtube.com/@GodaGo)
**Join the community:** [skool.com/autonomee](https://skool.com/autonomee)

## License

MIT — Take it, customize it, make it yours.

---

Built by [Goda Go](https://youtube.com/@GodaGo)
