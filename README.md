# Claude Telegram Relay

A personal AI assistant on Telegram powered by Claude Code.

You message it. Claude responds. Text, photos, documents, voice. It remembers across sessions, checks in proactively, and runs in the background.

**Created by [Goda Go](https://youtube.com/@GodaGo)** | [AI Productivity Hub Community](https://skool.com/autonomee)

```
You ──▶ Telegram ──▶ Relay ──▶ Claude Code CLI ──▶ Response
                                    │
                      Local Memory (SQLite + Qdrant + MLX)
```

## What You Get

- **6 Specialised Agents** — each in its own Telegram supergroup with isolated sessions and scoped memory
- **Persistent Memory** — facts, goals, preferences with semantic search (SQLite + Qdrant + MLX bge-m3)
- **Scheduled Routines** — morning briefing, evening summary, smart check-ins, watchdog — config-driven
- **Document RAG** — upload PDFs, query with natural language
- **Voice Transcription** — Groq cloud or local Whisper
- **Job Queue** — persistent background jobs with priority dispatch and interventions
- **AI Fallback** — auto-cascade to local LM Studio / Ollama via ModelRegistry
- **Always On** — 4 PM2 services, starts on boot, restarts on crash
- **Guided Setup** — Claude Code reads `CLAUDE.md` and walks you through everything

## Quick Start

```bash
git clone https://github.com/godagoo/claude-telegram-relay.git
cd claude-telegram-relay
bun run setup
claude                     # Claude Code walks you through the rest
```

**Prerequisites:** [Bun](https://bun.sh) runtime, [Claude Code](https://claude.ai/claude-code) CLI, a Telegram account.

## Documentation

All documentation lives in **[CLAUDE.md](CLAUDE.md)** — architecture, setup phases, bot commands, multi-agent groups, troubleshooting, and links to deep-dive docs.

## License

MIT — Take it, customize it, make it yours.

---

Built by [Goda Go](https://youtube.com/@GodaGo)
