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
          ├─ Success → respond with [via local] prefix
          │
          └─ Failure → error message to user
```

The relay checks MLX availability at startup via `isMlxAvailable()`, which calls `GET /v1/models` on the MLX server. If reachable, the startup log shows:

```
Fallback model available: MLX (Qwen3.5-9B)
```

## MLX Roles

MLX serves two distinct purposes in the relay:

| Role | Description | Always active? |
|------|-------------|----------------|
| **Fallback model** | Text generation when Claude CLI is down | Only when Claude fails |
| **Routine model** | All scheduled routines (morning-summary, night-summary, smart-checkin) use MLX exclusively via `callRoutineModel()` | Always |

Embeddings are handled separately by **MLX bge-m3** (port 8801, `mlx serve-embed`) — always active, no cloud dependency.

## Setup

### 1. Start MLX Servers

```bash
mlx serve        # text generation — port 8800
mlx serve-embed  # embeddings — port 8801 (separate terminal)
```

### 2. Configure Environment

Add to `~/.claude-relay/.env` (optional — defaults shown):

```bash
MLX_URL=http://localhost:8800
MLX_MODEL=mlx-community/Qwen3.5-9B-MLX-4bit
EMBED_URL=http://localhost:8801
```

### 3. Verify

```bash
curl http://localhost:8800/v1/models
# → {"object":"list","data":[...]}

curl http://localhost:8801/health
# → {"status":"ok","model":"...bge-m3..."}
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

- **Apple Silicon** (M1/M2/M3/M4) — MLX runs only on Apple Silicon
- **MLX generation server running** — `mlx serve` on port 8800
- **MLX embed server running** — `mlx serve-embed` on port 8801
- **Model weights downloaded** — via `mlx pull` (~5.6 GB for 9B-4bit)

## Disable Fallback

Unset or comment out `MLX_URL` in `~/.claude-relay/.env`. The relay will still use the MLX embed server for memory/search features.
