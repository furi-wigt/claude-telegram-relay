# Model Registry Design
**Date:** 2026-04-05
**Status:** Approved — ready for implementation
**Branch:** `feat/model_registry`

---

## Problem

Local AI model configuration is tightly coupled into source code:

- `src/mlx/client.ts` — hardcoded MLX URL and model name
- `src/local/embed.ts` — hardcoded single embed endpoint
- `src/routines/routineModel.ts` — MLX-only via mutex, no fallback chain
- `src/utils/modelPrefix.ts` — hardcoded `SONNET_MODEL`, `OPUS_MODEL`, etc.
- STM summarization locked to Claude Haiku; routines locked to MLX Qwen
- No cascade logic — single point of failure per operation

Changing the local provider requires code edits, not config changes. There is no fallback to cloud models if local inference goes down.

---

## Goals

1. **Provider-agnostic** — swap between LM Studio, Ollama, MLX, or Claude without touching source code
2. **Priority-ordered cascade** — each operation slot (routine, stm, classify, embed) has an ordered list of providers; tries each in order on failure
3. **Config-driven** — template in repo (`config/models.example.json`), live config at `~/.claude-relay/models.json`
4. **Embed model flexibility** — changing the embedding model doesn't break existing Qdrant data (versioned collections)
5. **GPU resource safety** — embed slot is structurally separate from chat slots

---

## Decisions

| Question | Decision |
|---|---|
| Local provider abstraction | Unified OpenAI-compat HTTP client — LM Studio, Ollama, MLX all use the same client |
| Claude API | Unchanged — existing `claudeText`/`claudeStream` in `claude-process.ts`, wrapped as a `ClaudeAdapter` |
| Failure handling | Health-check first (fast skip), then try-and-fallback on errors/timeouts |
| Circuit breaker | Optional per-provider — configurable `failureThreshold` and `resetAfterMs` |
| Mid-stream failure | Buffer internally, re-request from next provider from scratch, yield only when a provider commits cleanly |
| Embed model migration | Versioned Qdrant collection names (`memory_bge-m3_1024`). SQLite is source of truth. `bun run migrate:embeddings` re-embeds |
| Config format | JSON with Zod schema validation at startup — consistent with `agents.json` |
| Architecture | Central `ModelRegistry` class, loaded once at startup, passed via dependency injection |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Callers                              │
│  routineModel.ts │ shortTermMemory.ts │ intentClassifier.ts │
│  documentSearch  │ longTermExtractor  │ relay.ts            │
└──────────────────────────┬──────────────────────────────────┘
                           │  registry.chat(slot, messages)
                           │  registry.embed(text)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     ModelRegistry                           │
│  Loaded once at startup from ~/.claude-relay/models.json    │
│  Zod validation — hard fail on bad config                   │
│  Holds circuit breaker state (in-memory, per provider)      │
│  Exposes typed slots: routine, stm, ltm, classify, embed    │
└──────────┬──────────────────────────────┬───────────────────┘
           │ chat slots                   │ embed slot
           ▼                              ▼
┌────────────────────┐        ┌───────────────────────┐
│  CascadeExecutor   │        │    EmbedExecutor       │
│  (per chat slot)   │        │  (single provider)     │
│                    │        │                        │
│  1. circuit open?  │        │  health-check          │
│     → skip         │        │  try-and-fallback      │
│  2. health check   │        │  versioned collection  │
│     → skip if bad  │        │  name from suffix()    │
│  3. try call       │        └───────────┬────────────┘
│  4. on fail →      │                    │
│     next provider  │                    │
└────────┬───────────┘                    │
         │                               │
         ├─ OpenAICompatClient ←──────────┘
         │    POST /v1/chat/completions (SSE)
         │    POST /v1/embeddings
         │    GET  /health (or model ping)
         │
         └─ ClaudeAdapter
              claudeText() / claudeStream()
              (unchanged — existing claude-process.ts)
```

---

## Config Schema

**Template:** `config/models.example.json`
**Live:** `~/.claude-relay/models.json` (copied by setup script on first run)

```json
{
  "providers": [
    {
      "id": "lms-chat",
      "type": "openai-compat",
      "url": "http://localhost:1234",
      "model": "qwen2.5-7b-instruct",
      "timeoutMs": 120000,
      "chunkTimeoutMs": 30000,
      "maxConcurrent": 1,
      "circuitBreaker": {
        "enabled": true,
        "failureThreshold": 3,
        "resetAfterMs": 60000
      }
    },
    {
      "id": "lms-embed",
      "type": "openai-compat",
      "url": "http://localhost:1234",
      "model": "text-embedding-nomic-embed-text-v1.5",
      "dimensions": 768,
      "timeoutMs": 15000
    },
    {
      "id": "mlx-chat",
      "type": "openai-compat",
      "url": "http://localhost:8800",
      "model": "mlx-community/Qwen3.5-9B-MLX-4bit",
      "timeoutMs": 120000,
      "chunkTimeoutMs": 30000,
      "maxConcurrent": 1
    },
    {
      "id": "mlx-embed",
      "type": "openai-compat",
      "url": "http://localhost:8801",
      "model": "bge-m3",
      "dimensions": 1024,
      "timeoutMs": 15000
    },
    {
      "id": "ollama-chat",
      "type": "openai-compat",
      "url": "http://localhost:11434",
      "model": "qwen2.5:7b",
      "timeoutMs": 120000
    },
    {
      "id": "claude-haiku",
      "type": "claude",
      "model": "haiku"
    },
    {
      "id": "claude-sonnet",
      "type": "claude",
      "model": "sonnet"
    }
  ],
  "slots": {
    "routine":  ["lms-chat", "ollama-chat", "claude-haiku"],
    "stm":      ["claude-haiku"],
    "ltm":      ["claude-haiku"],
    "classify": ["lms-chat", "claude-haiku"],
    "embed":    ["lms-embed"]
  }
}
```

### Zod Validation Rules

- `providers[].id` — unique across all providers (hard fail)
- `providers[].type` — `"openai-compat" | "claude"` (hard fail)
- `slots.*` entries — must reference a valid `providers[].id` (hard fail)
- `slots.embed` — exactly one entry, must be `type: "openai-compat"` (Claude cannot embed) (hard fail)
- **Startup warning** (not error): if `slots.embed[0]` shares the same `url + model` as any chat slot provider — informational only (intentional for single-model servers)

### LM Studio Setup Notes

LM Studio ≥ 0.3 supports multiple simultaneously loaded models on the same port.
- `lms-chat` and `lms-embed` both point to `localhost:1234` — different `model` fields route to different loaded models
- No startup warning fires (different `url+model` combinations)
- VRAM constraint: both models must fit simultaneously. If not: use separate port (`localhost:1235`) for embed, or use `mlx-embed` on port 8801

### MLX Setup (existing)

- `mlx-chat` → `mlx serve` on port 8800 (Qwen3.5-9B)
- `mlx-embed` → `mlx serve-embed` on port 8801 (bge-m3)
- Two separate processes = no GPU lock contention

---

## ModelRegistry API

```typescript
// src/models/registry.ts

class ModelRegistry {
  // Factory — validates config, throws ModelConfigError on invalid schema
  static load(configPath: string): ModelRegistry

  // Non-streaming chat: cascades through slot's providers in priority order
  chat(slot: ChatSlot, messages: ChatMessage[], opts?: ChatOptions): Promise<string>

  // Streaming chat: buffers per provider; yields to caller only after clean commit
  // On mid-stream failure: discard buffer, re-request from next provider
  chatStream(slot: ChatSlot, messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<string>

  // Embed: single provider (structurally no cascade — one embedding source of truth)
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>

  // Health check all configured providers
  health(): Promise<Record<string, { healthy: boolean; latencyMs?: number }>>

  // Versioned Qdrant collection suffix — derived from embed provider model name + dimensions
  // Derived from embed provider: sanitize(model) + "_" + dimensions (from config)
  // e.g. "bge-m3_1024", "nomic-embed-text-v1.5_768"
  embedCollectionSuffix(): string
}

type ChatSlot = "routine" | "stm" | "ltm" | "classify"
```

---

## CascadeExecutor

```
chat(slot, messages)
  │
  ├─ resolve providers for slot: [lms-chat, claude-haiku]
  │
  ├─ for each provider:
  │    ├─ circuit breaker open?  → skip, log
  │    ├─ health check           → unhealthy? skip, log
  │    ├─ try: call provider
  │    │    openai-compat → POST /v1/chat/completions
  │    │    claude        → claudeText(model, prompt)
  │    ├─ success → return result; record CB success
  │    └─ catch  → record CB failure; log cascade; next provider
  │
  └─ all failed → throw CascadeExhaustedError({ attempts: [...] })
```

### chatStream Cascade (commit-then-stream)

```
chatStream(slot, messages)
  │
  ├─ for each provider:
  │    ├─ circuit breaker / health check (same as chat)
  │    ├─ open SSE stream
  │    ├─ buffer chunks — do NOT yield yet
  │    ├─ any error (connection drop, timeout, error chunk):
  │    │    → discard buffer; record CB failure; next provider
  │    └─ stream ends cleanly:
  │         → yield buffered chunks to caller
  │
  └─ all failed → throw CascadeExhaustedError
```

Caller sees no output until a provider commits. Suitable for routine/classify slots.
Claude interactive sessions bypass this via `claudeStream()` directly.

---

## Circuit Breaker

```typescript
// Stored on ModelRegistry instance — in-memory, not persisted across restarts
type BreakerState = {
  failures: number        // consecutive failures
  openUntil: number | null  // epoch ms; null = closed
}

// State machine:
// closed   : failures < threshold → allow calls
// open     : failures >= threshold → set openUntil = now + resetAfterMs; skip calls
// half-open: openUntil passed → allow one probe call
//   probe success → closed (reset failures = 0)
//   probe failure → open (extend openUntil)
```

Circuit breaker is **opt-in per provider** via `"circuitBreaker": { "enabled": true, ... }`.
Providers without `circuitBreaker` config always attempt health-check + try-fallback only.

---

## Embed Versioning

### Collection naming

```
<base>_<sanitized-model-id>_<dimensions>

Examples:
  memory_bge-m3_1024
  documents_bge-m3_1024
  messages_bge-m3_1024
  summaries_bge-m3_1024

  memory_nomic-embed-text-v1.5_768   ← after model change
  documents_nomic-embed-text-v1.5_768
```

`ModelRegistry.embedCollectionSuffix()` returns the active suffix from current config.
All Qdrant operations use this suffix at call time — no hardcoded collection names remain.

### On model change

1. Config updated in `~/.claude-relay/models.json` (new embed provider + model)
2. Bot restarts → registry computes new suffix → `ensureCollections(suffix)` creates new Qdrant collections
3. New writes go to new collections immediately
4. Old collections remain untouched — old vectors orphaned but not deleted
5. Run `bun run migrate:embeddings` to re-embed SQLite data into new collections

### Migration helper

```bash
bun run migrate:embeddings [options]

Options:
  --dry-run      Show what would be migrated; no writes
  --drop-old     Delete old collections after successful migration
  --batch=50     Records per embed batch (default: 50)
```

**Migration flow:**
1. Load ModelRegistry → get new `embedCollectionSuffix`
2. Detect old suffix by listing Qdrant collections matching `<base>_*`
3. Read all records from SQLite (memories, documents, messages, summaries)
4. Re-embed in batches via `registry.embedBatch()`
5. Upsert into new Qdrant collections
6. Verify: SQLite row count == Qdrant vector count
7. If `--drop-old`: delete old collections
8. Print summary

SQLite is the authoritative source — migration is always re-runnable.

---

## File Layout

### New files

```
src/models/
  registry.ts             ← ModelRegistry class
  openaiCompatClient.ts   ← stateless OpenAI-compat HTTP client (chat SSE + embed + health)
  circuitBreaker.ts       ← BreakerState + state machine
  types.ts                ← ChatMessage, ChatOptions, ProviderConfig, SlotConfig, etc.
  schema.ts               ← Zod schema for models.json

config/
  models.example.json     ← committed template (all supported providers commented)

scripts/
  migrate-embeddings.ts   ← bun run migrate:embeddings
```

### Modified files

```
src/routines/routineModel.ts      replace MLX mutex → registry.chat("routine")
src/memory/shortTermMemory.ts     replace claudeText(haiku) → registry.chat("stm")
src/local/embed.ts                replace hardcoded endpoint → registry.embed()
src/local/index.ts                pass registry.embedCollectionSuffix() to ensureCollections()
src/orchestration/
  intentClassifier.ts             replace callMlxGenerate → registry.chat("classify")
src/utils/modelPrefix.ts          keep SONNET/OPUS/HAIKU constants; remove LOCAL_MODEL_TOKEN
src/setup.ts                      copy models.example.json → ~/.claude-relay/models.json
package.json                      add "migrate:embeddings": "bun run scripts/migrate-embeddings.ts"
```

### Deleted files

```
src/mlx/client.ts     ← absorbed into openaiCompatClient.ts
```

### Zero-change files

```
src/claude-process.ts             no changes — Claude adapter untouched
src/memory/longTermExtractor.ts   stays on claudeText directly
```

---

## OpenAICompatClient

```typescript
// src/models/openaiCompatClient.ts
// Stateless — no connection pool. One fetch per request.
// Reuses SSE streaming logic from existing src/mlx/client.ts
// Strips Qwen thinking blocks if model name contains "Qwen" (existing behavior)

async function* chatStream(
  url: string, model: string, messages: ChatMessage[], opts: ChatOptions
): AsyncGenerator<string>

async function embed(
  url: string, model: string, texts: string[]
): Promise<number[][]>

async function health(url: string): Promise<boolean>
```

Health check strategy per provider type:
- `openai-compat`: `GET {url}/health` → `{ status: "ok" }` or `/v1/models` 200
- `claude`: `claudeText` with 1-token probe (or always-healthy if Claude CLI present)

---

## Adversary QA (Pre-Mortem)

| Risk | Guard |
|---|---|
| All providers down → infinite retry loop | `CascadeExhaustedError` thrown after linear traversal — O(n) providers, no loop |
| Circuit breaker state grows unbounded (many providers) | BreakerState is a `Map<providerId, BreakerState>` — bounded by number of providers in config |
| Mid-stream buffer OOM for very long responses | Buffer is a `string[]` of SSE chunks — cleared on fallback, released after yield. No secondary copy kept. |
| Embed collection suffix changes without migration | Old collections orphaned (not deleted). Bot starts cleanly with new collections. User runs migration explicitly. |
| Concurrent embed requests contend on single LM Studio model | LM Studio queues HTTP requests — no corruption. Contention causes latency only. `maxConcurrent` cap available per provider. |
| Zod validation error at startup crashes silently | `ModelRegistry.load()` throws `ModelConfigError` with full Zod issue list — caught at startup, process exits with message |

---

## User E2E Test Checklist

### Scenario A: LM Studio as primary provider

- [ ] Load `qwen2.5-7b-instruct` and `text-embedding-nomic-embed-text-v1.5` in LM Studio simultaneously
- [ ] Set `slots.routine[0] = "lms-chat"`, `slots.embed[0] = "lms-embed"` in `~/.claude-relay/models.json`
- [ ] Restart bot → Expected: startup log shows `[ModelRegistry] loaded 2 providers, embed: lms-embed (nomic-embed-text-v1.5_768)`
- [ ] Send a message → routine response arrives (from LM Studio)
- [ ] Save a memory item → Expected: no error, memory searchable

### Scenario B: Cascade fallback

- [ ] Stop LM Studio (primary provider offline)
- [ ] Send a message → Expected: log shows `[cascade: lms-chat unhealthy, trying claude-haiku]`, response arrives from Haiku
- [ ] Expected: no error surfaced to user in Telegram

### Scenario C: Embed model migration

- [ ] Change `slots.embed[0]` to a different embed model
- [ ] Restart bot → Expected: new versioned Qdrant collections created, old collections intact
- [ ] Run `bun run migrate:embeddings --dry-run` → Expected: shows N records to migrate
- [ ] Run `bun run migrate:embeddings` → Expected: all records migrated, count matches
- [ ] Run `bun run migrate:embeddings --drop-old` → Expected: old collections deleted

### Scenario D: Circuit breaker

- [ ] Configure `circuitBreaker.failureThreshold: 2` on `lms-chat`
- [ ] Simulate 2 consecutive failures (stop/start LM Studio mid-request)
- [ ] Expected: third request skips LM Studio immediately (no health check needed), cascades to next provider
- [ ] Wait `resetAfterMs` → Expected: LM Studio probed again, circuit closes on success

---

## Changelog Entry

```markdown
## [Unreleased] / 2026-04-05 — Model Registry

### Added
- **ModelRegistry**: Central provider registry loaded from `~/.claude-relay/models.json`.
  Supports LM Studio, Ollama, MLX, and Claude. Priority-ordered cascade per operation slot
  (routine, stm, ltm, classify, embed). Config template at `config/models.example.json`.
- **CascadeExecutor**: Health-check + try-and-fallback cascade with optional circuit breaker
  per provider (`circuitBreaker.enabled`, `failureThreshold`, `resetAfterMs`).
- **chatStream cascade**: Buffers internally; falls back to next provider on mid-stream failure;
  yields to caller only after clean commit.
- **Versioned Qdrant collections**: Embed collection names include model id + dimensions
  (e.g. `memory_bge-m3_1024`). Changing embed model auto-creates new collections.
- **migrate:embeddings script**: `bun run migrate:embeddings [--dry-run] [--drop-old] [--batch=N]`
  re-embeds all SQLite records into new Qdrant collections.
- **OpenAICompatClient**: Stateless HTTP client for all OpenAI-compat backends (LM Studio,
  Ollama, MLX). Replaces `src/mlx/client.ts`.

### Changed
- `routineModel.ts`: replaced MLX mutex calls with `registry.chat("routine")`
- `shortTermMemory.ts`: replaced `claudeText(haiku)` with `registry.chat("stm")`
- `intentClassifier.ts`: replaced `callMlxGenerate` with `registry.chat("classify")`
- `embed.ts`: replaced hardcoded endpoint with `registry.embed()`
- Qdrant collection names now include embed model suffix (migration required for existing data)

### Removed
- `src/mlx/client.ts` — absorbed into `src/models/openaiCompatClient.ts`
- `LOCAL_MODEL_TOKEN` from `modelPrefix.ts` — replaced by registry slot lookup
```
