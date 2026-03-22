# Fallback AI — MLX Local Inference

When Claude CLI is unavailable, the relay automatically falls back to a local MLX model running on Apple Silicon. No cloud dependency, no API keys.

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
      MLX local inference (Qwen3.5-9B-MLX-4bit)
          │
          ├─ Success → respond with [via MLX] prefix
          │
          └─ Failure → error message to user
```

The relay checks MLX availability at startup via `isMlxAvailable()`, which calls `GET /health` on the MLX server. If reachable, the startup log shows:

```
Fallback model available: MLX (Qwen3.5-9B)
```

## MLX Roles

MLX serves two distinct purposes in the relay:

| Role | Description | Always active? |
|------|-------------|----------------|
| **Fallback model** | Text generation when Claude CLI is down | Only when Claude fails |
| **Embeddings** | bge-m3 vectors for memory and semantic search via `/v1/embeddings` | Always (no cloud dependency) |
| **Routine model** | All scheduled routines (morning-summary, night-summary, smart-checkin) use MLX exclusively via `callRoutineModel()` | Always |

## Setup

### 1. Start the MLX Server

```bash
mlx serve
```

This starts an OpenAI-compatible API on port 8800, serving both Qwen3.5-9B (text generation) and bge-m3 (embeddings).

### 2. Configure Environment

Add to `.env` (these are the defaults — only needed if you want to override):

```bash
MLX_URL=http://localhost:8800
MLX_MODEL=mlx-community/Qwen3.5-9B-MLX-4bit
```

### 3. Verify

```bash
curl http://localhost:8800/health
# → {"status":"ok"}
```

Restart the relay and check the startup log for the fallback confirmation message.

## Key Files

| File | Purpose |
|------|---------|
| `src/mlx/client.ts` | MLX client — `callMlxGenerate()` for text, OpenAI-compatible API calls |
| `src/routines/routineModel.ts` | `callRoutineModel()` — all scheduled routines use this to call MLX |

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

- **Apple Silicon** (M1/M2/M3/M4) — MLX does not run on Intel Macs or Linux
- **MLX server running** — `mlx serve` on port 8800
- **Model weights downloaded** — run `mlx-qwen pull` once (~5.6 GB)

## Disable Fallback

Remove or comment out `MLX_URL` in `.env`. The relay will still need MLX for embeddings if you use memory/search features.
