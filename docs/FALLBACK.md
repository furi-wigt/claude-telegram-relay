# Fallback AI — ModelRegistry Cascade

When Claude CLI is unavailable, the relay automatically falls back to the next healthy provider in the ModelRegistry cascade. No single point of failure.

## How It Works

```
User message
    │
    ▼
Claude CLI (claudeStream / claudeText)
    │
    ├─ Success → respond normally
    │
    └─ Failure (network error, auth failure, timeout)
          │
          ▼
      ModelRegistry cascade (routine slot)
      e.g. LM Studio → Ollama → Claude Haiku
          │
          ├─ Success → respond with [via local] prefix
          │
          └─ Failure → error message to user
```

Provider cascade order is defined in `~/.claude-relay/models.json` under each slot (`routine`, `classify`, etc.). First healthy provider wins. The ModelRegistry handles health checks and failover automatically.

## MLX Role

MLX is used **exclusively for embeddings** (bge-m3, port 8801, `mlx serve-embed`):

| Role | Provider | Always active? |
|------|----------|----------------|
| **Embeddings** | MLX bge-m3 (port 8801, `mlx serve-embed`) | Always |
| **Text generation** | ModelRegistry cascade (LM Studio / Ollama / Claude) | On demand |

MLX text generation (`mlx serve`, port 8800) has been removed. Text generation now routes through the ModelRegistry configured in `~/.claude-relay/models.json`.

## Setup

### 1. Start MLX Embed Server (embeddings only)

```bash
mlx serve-embed  # embeddings — port 8801
```

### 2. Configure ModelRegistry

Edit `~/.claude-relay/models.json` (copy from `config/models.example.json`):

```json
{
  "slots": {
    "routine": ["lms-chat", "ollama-chat", "claude-haiku"],
    "embed":   ["mlx-embed"]
  }
}
```

### 3. Verify

```bash
curl http://localhost:8801/health
# → {"status":"ok","model":"...bge-m3..."}
```

## Key Files

| File | Purpose |
|------|---------|
| `src/routines/routineModel.ts` | `callRoutineModel()` — all scheduled routines use this |
| `src/model-registry/ModelRegistry.ts` | Cascade logic, health checks, provider selection |
| `~/.claude-relay/models.json` | Provider definitions and slot cascade order |

## When Fallback Activates

Fallback activates when the Claude CLI subprocess fails:
- Network error (no internet)
- Authentication failure (expired key, invalid token)
- Timeout (Claude CLI hangs)
- CLI not found or crashes

Fallback does **not** activate for:
- Valid Claude responses (including refusals)
- User permission blocks

## Requirements

- **Apple Silicon** (M1/M2/M3/M4) — MLX embed runs only on Apple Silicon
- **MLX embed server running** — `mlx serve-embed` on port 8801
- **ModelRegistry configured** — `~/.claude-relay/models.json` with at least one healthy provider in the `routine` slot
