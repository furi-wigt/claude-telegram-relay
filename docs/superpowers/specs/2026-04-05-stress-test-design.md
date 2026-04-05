# Stress Test Suite — STM / LTM / Relevance Context / Model Cascade

**Date:** 2026-04-05
**Author:** Furi
**Status:** Approved

---

## Problem

The relay bot uses LM Studio (port 1234) as its first cascade provider, with BGE-M3 via mlx-embed (port 8801) for embeddings and Qdrant (port 6333) for vector search. There is no validated evidence that the full pipeline — STM query, semantic search, LLM call, LTM write, semantic dedup — holds up under concurrent load, failure scenarios, or sustained traffic. Specific risks include:

- SQLite WAL contention under parallel writes
- Embed timeout (5s hard limit in `checkSemanticDuplicate`) firing false negatives under load
- Circuit breaker state and cascade trigger behaviour at saturation
- Memory leaks in long-running soak conditions

---

## Proposed Solution

Four TypeScript scripts in `.claude/workspace/` (gitignored, transient):

| Script | Purpose |
|---|---|
| `stress-burst.ts` | 10 concurrent full-pipeline calls, 30s window |
| `stress-saturation.ts` | Ramp 10→20→50 concurrent; stop at >20% error rate |
| `stress-soak.ts` | Semaphore(5), 3 req/s × 5min (~900 calls) |
| `stress-all.ts` | Orchestrator: runs all 3 in sequence, prints unified report |

Each script is standalone and rerunnable. `stress-all.ts` imports and invokes them in sequence.

---

## Design Details

### Per-Call Pipeline (identical across all phases)

```
1. getShortTermContext(chatId, threadId)     → STM latency
2. hybridSearch("memory_*", query, opts)    → embed latency + Qdrant latency
3. registry.chat("routine", messages)       → LM Studio latency (first slot)
4. storeExtractedMemories(chatId, payload)  → LTM write latency
5. checkSemanticDuplicate(content, type)    → dedup latency (5s timeout boundary)
```

### Data Isolation

```
Synthetic chatId:   stress_<yyyyMMdd_HHmm>   e.g. stress_20260405_1708
Synthetic userId:   stress_user_<timestamp>
```

Cleanup (in `finally`, guaranteed on SIGINT):
```sql
DELETE FROM messages WHERE chat_id LIKE 'stress_%';
DELETE FROM memory   WHERE chat_id LIKE 'stress_%';
```
Qdrant: delete all points with `payload.chat_id` matching `stress_*`.

### Metrics Collected Per Call

| Field | What it catches |
|---|---|
| `stm_ms` | SQLite query performance |
| `embed_ms` | BGE-M3 throughput under load |
| `qdrant_ms` | Vector search latency |
| `llm_ms` | LM Studio response time / timeout |
| `ltm_write_ms` | Concurrent SQLite write safety |
| `dedup_ms` | 5s timeout boundary in semanticDuplicateChecker |
| `total_ms` | End-to-end latency |
| `cascade_triggered` | Boolean: did LM Studio fail → Claude fallback? |
| `error_type` | `timeout` \| `cascade_exhausted` \| `embed_fail` \| `qdrant_fail` |

Percentiles reported: p50, p95, p99, max. Wall-clock time per phase.

### Phase Specifications

**Phase 1 — Burst**
- 10 goroutines fired simultaneously via `Promise.all`
- Timeout per call: 60s
- Pass criteria: p95 < 30s, error rate = 0%, zero data integrity violations

**Phase 2 — Saturation Ramp**
- Steps: 10 → 20 → 50 concurrent
- Each step: fire N calls, wait for all to settle, record metrics
- Early exit: if error rate > 20% at any step, halt and report
- Pass criteria: circuit breaker trips correctly before >20% error rate; cascade triggers cleanly

**Phase 3 — Soak**
- Rate: 3 req/s, sustained 5 minutes (~900 calls total)
- Concurrency cap: semaphore(5) — prevents unbounded goroutine growth
- Sampling: RSS memory recorded every 30s
- Pass criteria: RSS growth < 100MB, zero SQLite BUSY errors, p99 stable (no monotonic drift)

### Failure Injection

No mocking required — real services under load provide natural failure conditions:

| Scenario | How induced | Observable signal |
|---|---|---|
| LM Studio GPU saturation | 50 concurrent calls | `llm_ms` spike, cascade triggers |
| LM Studio unreachable | Manual: kill port 1234 between phases (optional) | Circuit breaker opens, Claude fallback fires |
| Embed overload | Concurrent embedBatch flood | 5s dedup timeout fires → `isDuplicate: false` |
| SQLite WAL contention | Concurrent `storeExtractedMemories` | WAL BUSY errors surface in error log |

### Output Format (per phase)

```
════════ PHASE 1: BURST (10 concurrent) ════════
✓ 10/10 complete  ✗ 0 errors  ⏱ wall: 8.2s

subsystem     p50      p95      p99      max
─────────────────────────────────────────────
stm           11ms     34ms     45ms     62ms
embed         91ms     180ms    234ms    310ms
qdrant        21ms     55ms     67ms     88ms
lm_studio     2.1s     8.4s     12.3s    15.1s
ltm_write     43ms     98ms     120ms    145ms
dedup         88ms     175ms    230ms    290ms
total         2.4s     9.1s     13.1s    16.0s

cascade_triggered: 0   data_errors: 0
PASS ✓  (p95 < 30s, 0 integrity errors)
```

### Pre-Mortem — 3 Predicted Failure Modes

1. **OOM during soak**: Qdrant point accumulation + unclosed SQLite statements balloon RSS. Guard: explicit `finally` cleanup + semaphore cap on concurrency.
2. **Race condition on synthetic chatId**: Two parallel calls share the same chatId prefix, causing duplicate key or cross-contamination. Guard: include call index in chatId (`stress_<ts>_<i>`).
3. **Cascade exhausted mid-soak**: LM Studio circuit breaker opens at saturation step and never resets within soak window (default `resetAfterMs: 60000`). Guard: log circuit breaker state transitions; warn if Claude fallback cost accrues.

---

## Acceptance Criteria

- [ ] Phase 1 (Burst): p95 < 30s, 0 data errors
- [ ] Phase 2 (Saturation): circuit breaker trips before >20% error; cascade works
- [ ] Phase 3 (Soak): RSS growth < 100MB over 5min; no SQLite BUSY; p99 stable
- [ ] All synthetic data cleaned up post-run
- [ ] Single command to run all phases: `bun .claude/workspace/stress-all.ts`
- [ ] Per-phase rerun works: `bun .claude/workspace/stress-burst.ts`

---

## Out of Scope

- Mocking any services (all tests hit real LM Studio, Qdrant, mlx-embed)
- Playwright/Telegram E2E (this tests the memory + model layer only, not the bot API)
- CI integration (workspace scripts are transient, not committed)
- Load testing the Telegram webhook/relay.ts message dispatch layer
