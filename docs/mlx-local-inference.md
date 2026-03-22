# MLX Local Inference — Unified Stack

**Date**: 2026-03-22 | **Status**: Active

---

## Overview

All local AI inference runs on **Apple MLX** — a single, unified stack replacing the previous Ollama dependency. Two models are served from one process:

| Function | Model | Size | Dimensions |
|----------|-------|------|------------|
| **Text generation** | `mlx-community/Qwen3.5-9B-MLX-4bit` | 5.6 GB | — |
| **Embeddings** | `BAAI/bge-m3` (via mlx-embeddings) | 2.2 GB | 1024 |

Total VRAM: ~7.8 GB — fits on any Apple Silicon Mac (M1 16 GB+).

---

## Architecture

```
mlx serve --port 8800
  ├── POST /v1/chat/completions  → Qwen3.5-9B (text generation)
  ├── POST /v1/embeddings        → bge-m3 (semantic search vectors)
  ├── GET  /v1/models            → list loaded models
  └── GET  /health               → health check
```

Single PM2 service (`mlx`) runs the server. All relay components connect via HTTP to `localhost:8800`.

---

## Models

### Qwen3.5-9B-MLX-4bit (Text Generation)

- **Use**: Routine summaries, topic generation, intent extraction, atomic breakdown, chat fallback
- **Source**: `mlx-community/Qwen3.5-9B-MLX-4bit` (HuggingFace)
- **Thinking**: Disabled via prefilled empty `<think>` block
- **Timeout**: Callers with <10s timeout skip MLX and fail gracefully (no cold-start-safe model available below 10s)

### bge-m3 (Embeddings)

- **Use**: Semantic search over messages, memory, documents, conversation summaries
- **Source**: `BAAI/bge-m3` (HuggingFace)
- **Architecture**: XLM-RoBERTa (568M params, 24 layers, 1024 hidden)
- **Output**: 1024-dimensional dense vectors
- **Languages**: 100+ (English, Chinese, multilingual)
- **Context**: 8,192 tokens max
- **MLX runtime**: Loaded via `mlx-embeddings` library (XLM-RoBERTa path)

#### Smoke Test Results (2026-03-22)

```
Model load:        2.4s (cached, first load ~15s)
Inference (3 texts): 0.004s (sub-millisecond per text)
Output shape:      (3, 1024) ✓
cos("Hello world", "What is ML?"):        0.631
cos("Hello world", "Singapore is a..."):  0.550
```

#### Setup Notes

bge-m3 is distributed as `pytorch_model.bin` on HuggingFace (no safetensors). Requires one-time conversion:

```bash
# Automatic: mlx tool handles this on first use
mlx pull --embed

# Manual: convert pytorch weights to safetensors
python3 -c "
import torch
from safetensors.torch import save_file
state = torch.load('pytorch_model.bin', map_location='cpu', weights_only=True)
save_file(state, 'model.safetensors')
"
```

---

## Qdrant Vector Compatibility

bge-m3 on MLX produces the **same 1024-dimensional vectors** as bge-m3 on Ollama. The underlying model weights are identical — only the inference runtime differs (MLX vs ONNX/PyTorch). Minor floating-point differences between backends are within cosine similarity tolerance.

Existing Qdrant collections (`messages`, `memory`, `documents`, `summaries`) continue working without re-embedding.

---

## Why MLX Over Ollama

| Aspect | Ollama | MLX |
|--------|--------|-----|
| **Runtime** | HTTP server (Go) + ONNX/llama.cpp | Native Apple Silicon (Metal) |
| **Setup** | Separate install + model pulls | uv tool + HuggingFace cache |
| **VRAM management** | Automatic model loading/unloading | Explicit — models stay loaded |
| **Cold start** | Fast (models cached) | 8-15s first load, then warm |
| **Inference speed** | Good | Better (native Metal acceleration) |
| **Embedding support** | Built-in `/api/embed` | Via `mlx-embeddings` library |
| **Maintenance** | Separate daemon, separate updates | Single uv tool, pip dependencies |
| **Dependencies** | Ollama binary + models | Python 3.12 + mlx + mlx-lm + mlx-embeddings |

**Key motivation**: Eliminate the need to maintain two local inference stacks. One `mlx serve` process handles both text generation and embeddings.

---

## PM2 Service Configuration

```javascript
// ecosystem.config.cjs
{
  name: "mlx",
  script: "mlx",
  args: "serve --port 8800",
  interpreter: "none",
  autorestart: true,
  max_restarts: 5,
  restart_delay: 10000,  // 10s — allow model to unload
}
```

---

## Environment Variables

```bash
# .env
MLX_URL=http://127.0.0.1:8800          # MLX serve endpoint
MLX_EMBED_MODEL=BAAI/bge-m3            # Embedding model (1024-dim)
MLX_GEN_MODEL=mlx-community/Qwen3.5-9B-MLX-4bit  # Text generation model
```

---

## Relay Integration Points

| Component | What it calls | Endpoint |
|-----------|--------------|----------|
| `src/routines/routineModel.ts` | Text generation (routine tasks) | `/v1/chat/completions` |
| `src/relay.ts` | Chat fallback when Claude fails | `/v1/chat/completions` |
| `src/local/embed.ts` | Semantic embeddings for Qdrant | `/v1/embeddings` |
| `src/memory/topicGenerator.ts` | Message topic labels | `/v1/chat/completions` |
| `src/memory/longTermExtractor.ts` | Profile summary rebuild | `/v1/chat/completions` |
| `src/memory/conflictResolver.ts` | Memory conflict detection | `/v1/chat/completions` |
| `src/utils/routineMessage.ts` | Message summarization | `/v1/chat/completions` |
| `src/utils/atomicBreakdown.ts` | Task decomposition | `/v1/chat/completions` |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ECONNREFUSED :8800` | MLX serve not running | `npx pm2 start mlx` |
| Exit code 143 on short timeout | AbortController kills subprocess | Increase `timeoutMs` or use serve mode (HTTP) |
| `No safetensors found` | bge-m3 not converted | Run `mlx pull --embed` |
| SSL cert error on model download | Cloudflare WARP proxy | Tool auto-injects `/etc/ssl/Cloudflare_CA.pem` |
| High memory after long runtime | Models stay loaded in VRAM | Expected (~7.8 GB); restart `mlx` service to reclaim |
