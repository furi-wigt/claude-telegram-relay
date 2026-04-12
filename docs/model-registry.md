# Model Registry & Local AI

The relay uses a ModelRegistry to cascade between AI providers. Claude CLI is the primary provider for interactive chat; when it fails, the registry falls back to the next healthy provider. MLX handles embeddings exclusively.

## How Fallback Works

```
User message
    |
    v
Claude CLI (claudeStream / claudeText)
    |
    +-- Success --> respond normally
    |
    +-- Failure (network error, auth failure, timeout)
          |
          v
      ModelRegistry cascade (routine slot)
      e.g. LM Studio --> Ollama --> Claude Haiku
          |
          +-- Success --> respond with [via local] prefix
          |
          +-- Failure --> error message to user
```

Provider cascade order is defined in `~/.claude-relay/models.json` under each slot (`routine`, `classify`, etc.). First healthy provider wins. The ModelRegistry handles health checks and failover automatically.

## MLX Embed Server

MLX is used **exclusively for embeddings** (bge-m3 model, port 8801). It does not handle text generation.

| Role | Provider | Port | Always active? |
|---|---|---|---|
| **Embeddings** | MLX bge-m3 (`mlx serve-embed`) | 8801 | Always |
| **Text generation** | ModelRegistry cascade (LM Studio / Ollama / Claude) | varies | On demand |

### Install

Requires Apple Silicon (M1/M2/M3/M4) and Python 3.12+.

```bash
brew install python@3.12
uv tool install --editable tools/mlx-local --python python3.12
```

### Start

```bash
mlx serve-embed   # embedding API on localhost:8801
```

Model weights load on first request (allow ~30 seconds).

### Verify

```bash
curl http://localhost:8801/health
# --> {"status":"ok","model":"...bge-m3..."}
```

### Commands

| Command | What it does |
|---|---|
| `mlx serve-embed` | Embedding-only API on `localhost:8801` |
| `mlx info` | Show cached models and sizes |

The embed server is managed by PM2 as `mlx-embed`. Environment variable: `EMBED_URL=http://localhost:8801` (pre-configured, override in `~/.claude-relay/.env` if needed).

## ModelRegistry Configuration

The registry is configured in `~/.claude-relay/models.json` (copy from `config/models.example.json`). It defines **providers** (servers) and **slots** (use cases), where each slot has a cascade of providers tried in order.

```json
{
  "slots": {
    "routine": ["lms-chat", "ollama-chat", "claude-haiku"],
    "classify": ["lms-chat", "claude-haiku"],
    "embed": ["mlx-embed"]
  }
}
```

### Slots

- **routine** -- Used by all scheduled routines (`callRoutineModel()`)
- **classify** -- Used for message classification and routing
- **embed** -- Used for semantic embeddings (always MLX bge-m3)

### Providers

Any OpenAI-compatible server works. Common setups:

| Provider | Default Port | Example |
|---|---|---|
| LM Studio | 1234 | Gemma 4B, Qwen 2.5, Mistral |
| Ollama | 11434 | Any pulled model |
| Claude Haiku | (API) | `claude-haiku-4-5-20251001` |

## Setup

### 1. Start MLX Embed Server

```bash
mlx serve-embed   # port 8801
```

### 2. Install a Local Text Generation Server

Install [LM Studio](https://lmstudio.ai) (recommended) or Ollama:

```bash
# LM Studio: download from lmstudio.ai, load a model, start server on port 1234

# OR Ollama:
brew install ollama
ollama pull qwen2.5:4b
ollama serve
```

### 3. Configure models.json

```bash
cp config/models.example.json ~/.claude-relay/models.json
# Edit ~/.claude-relay/models.json with your provider details
```

### 4. Verify

```bash
# Embeddings
curl http://localhost:8801/health

# Text generation (LM Studio example)
curl http://localhost:1234/v1/models
```

## Key Files

| File | Purpose |
|---|---|
| `src/model-registry/ModelRegistry.ts` | Cascade logic, health checks, provider selection |
| `src/routines/routineModel.ts` | `callRoutineModel()` -- all scheduled routines use this |
| `~/.claude-relay/models.json` | Provider definitions and slot cascade order |
| `config/models.example.json` | Template for `models.json` |
| `src/local/embed.ts` | Semantic embeddings for Qdrant (calls MLX) |

## When Fallback Activates

Fallback activates when the Claude CLI subprocess fails:
- Network error (no internet)
- Authentication failure (expired key, invalid token)
- Timeout (Claude CLI hangs)
- CLI not found or crashes

Fallback does **not** activate for:
- Valid Claude responses (including refusals)
- User permission blocks

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ECONNREFUSED :8801` | MLX embed not running | `mlx serve-embed` |
| `ECONNREFUSED :1234` | LM Studio not running | Open LM Studio and start the server |
| `ECONNREFUSED :11434` | Ollama not running | `ollama serve` |
| Empty embedding response | bge-m3 model not loaded | Restart `mlx serve-embed`, wait 30s for model load |
| Slow first generation | Model loading into VRAM | Wait ~15s, subsequent calls are fast |
| Fallback not activating | No providers in `routine` slot | Check `~/.claude-relay/models.json` has at least one healthy provider |
| `curl http://localhost:8801/health` fails | MLX not installed or wrong Python | Reinstall: `uv tool install --editable tools/mlx-local --python python3.12` |

### Requirements

- **Apple Silicon** (M1/M2/M3/M4) -- MLX embed runs only on Apple Silicon
- **MLX embed server running** -- `mlx serve-embed` on port 8801
- **At least one text generation provider** -- LM Studio, Ollama, or Claude Haiku configured in `~/.claude-relay/models.json`
