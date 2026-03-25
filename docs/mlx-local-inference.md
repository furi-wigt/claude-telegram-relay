# Local Inference — Osaurus + Ollama

**Date**: 2026-03-25 | **Status**: Active

---

## Overview

Local AI inference uses two separate servers on Apple Silicon:

| Function | Server | Model | Port |
|----------|--------|-------|------|
| **Text generation** | Osaurus | `mlx-community/Qwen3.5-4B-MLX-4bit` | 1337 |
| **Embeddings** | Ollama | `bge-m3` (1024-dim) | 11434 |

---

## Architecture

```
Osaurus (port 1337)
  └── POST /v1/chat/completions  → Qwen3.5-4B (text generation)

Ollama (port 11434)
  └── POST /api/embed            → bge-m3 (semantic search vectors)
```

Both run as standalone apps — no PM2 management needed.

---

## Setup

### Osaurus (text generation)

```bash
brew install --cask osaurus
# Open Osaurus.app → Model Manager → download Qwen3.5-4B-MLX-4bit
osaurus serve
```

Verify: `curl http://localhost:1337/v1/models`

### Ollama (embeddings)

```bash
brew install ollama
ollama pull bge-m3
ollama serve
```

Verify: `curl -s http://localhost:11434/api/embed -d '{"model":"bge-m3","input":"test"}' | head -c 100`

---

## Environment Variables

```bash
# .env (all optional — defaults shown)
LOCAL_LLM_URL=http://localhost:1337
LOCAL_LLM_MODEL=mlx-community/Qwen3.5-4B-MLX-4bit
EMBED_URL=http://localhost:11434
EMBED_MODEL=bge-m3
```

---

## Relay Integration Points

| Component | What it calls | Server |
|-----------|--------------|--------|
| `src/routines/routineModel.ts` | Text generation (routine tasks) | Osaurus |
| `src/relay.ts` | Chat fallback when Claude fails | Osaurus |
| `src/local/embed.ts` | Semantic embeddings for Qdrant | Ollama |
| `src/memory/topicGenerator.ts` | Message topic labels | Osaurus |
| `src/memory/conflictResolver.ts` | Memory conflict detection | Osaurus |
| `src/utils/atomicBreakdown.ts` | Task decomposition | Osaurus |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ECONNREFUSED :1337` | Osaurus not running | Open Osaurus.app or `osaurus serve` |
| `ECONNREFUSED :11434` | Ollama not running | `ollama serve` |
| Empty embedding response | bge-m3 not pulled | `ollama pull bge-m3` |
| Slow first generation | Model loading into VRAM | Wait ~15s, subsequent calls are fast |
