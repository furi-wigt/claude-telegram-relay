# Fallback AI — Osaurus Local Inference

When Claude CLI is unavailable, the relay automatically falls back to a local Osaurus model running on Apple Silicon. No cloud dependency, no API keys.

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
      Osaurus local inference (Qwen3.5-4B-MLX-4bit)
          │
          ├─ Success → respond with [via local] prefix
          │
          └─ Failure → error message to user
```

The relay checks Osaurus availability at startup via `isMlxAvailable()`, which calls `GET /v1/models` on the Osaurus server. If reachable, the startup log shows:

```
Fallback model available: Osaurus (Qwen3.5-4B)
```

## Osaurus Roles

Osaurus serves two distinct purposes in the relay:

| Role | Description | Always active? |
|------|-------------|----------------|
| **Fallback model** | Text generation when Claude CLI is down | Only when Claude fails |
| **Routine model** | All scheduled routines (morning-summary, night-summary, smart-checkin) use Osaurus exclusively via `callRoutineModel()` | Always |

Embeddings are handled separately by **Ollama bge-m3** (port 11434) — always active, no cloud dependency.

## Setup

### 1. Install and Start Osaurus

```bash
brew install --cask osaurus
# Open Osaurus.app → Model Manager → download Qwen3.5-4B-MLX-4bit
osaurus serve
```

### 2. Configure Environment

Add to `.env` (optional — defaults shown):

```bash
LOCAL_LLM_URL=http://localhost:1337
LOCAL_LLM_MODEL=mlx-community/Qwen3.5-4B-MLX-4bit
```

### 3. Verify

```bash
curl http://localhost:1337/v1/models
# → {"object":"list","data":[...]}
```

Restart the relay and check the startup log for the fallback confirmation message.

## Key Files

| File | Purpose |
|------|---------|
| `src/mlx/client.ts` | Osaurus client — `callMlxGenerate()` for text, OpenAI-compatible API calls |
| `src/routines/routineModel.ts` | `callRoutineModel()` — all scheduled routines use this to call Osaurus |

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

- **Apple Silicon** (M1/M2/M3/M4) — Osaurus runs only on Apple Silicon
- **Osaurus running** — `osaurus serve` on port 1337
- **Model downloaded** — via Osaurus.app Model Manager (~2.5 GB for 4B-4bit)

## Disable Fallback

Remove or comment out `LOCAL_LLM_URL` in `.env`. The relay will still use Ollama for embeddings if memory/search features are enabled.
