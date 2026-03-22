# Decision Journal
## 2026-03-22 — Replace Claude CLI subprocess with Ollama in smart-checkin [pending]

**Change**: `decideCheckin()` in `smart-checkin.ts` now uses `callOllamaGenerate` (Ollama HTTP, `think: false`) instead of spawning a Claude CLI subprocess (`claude -p ... --model claude-haiku-4-5-20251001`).
**Why**: Claude CLI subprocess had no timeout and hung indefinitely — OAuth init + CLI startup takes 15s+ minimum, and with no AbortController the process would block forever. Ollama responds in ~4s via local HTTP. This matches the same migration done for `atomicBreakdown.ts`.
**Rejected**: Adding a timeout to the Claude CLI subprocess — still has 15s+ startup latency per invocation (runs every 30 min), and Ollama handles the structured YES/NO decision adequately.
**Branch**: feat/smart_routines



## 2026-03-20 — Migrate memory cleanup from Supabase to local stack [fe62b53]

**Change**: Replaced all Supabase calls in memory-cleanup.ts, memory-dedup-review.ts, and dedupReviewCallbackHandler.ts with local SQLite + Qdrant + Ollama BGE-M3.
**Why**: Bot fully migrated to local memory — Supabase cleanup code was dead and caused confusion. Local stack enables faster dedup (no network latency to Edge Functions) and eliminates external dependency.
**Rejected**: (1) Keep Supabase as fallback — adds complexity for zero benefit since all writes already target local. (2) Remove routines entirely — memory dedup is essential to prevent context pollution during retrieval.
**Branch**: feat/memory_dedup_local

## 2026-03-18 — Post-filter recurring events with stale JXA startDate [pending]

**Change**: Added TypeScript-side range post-filter to `getTodayEvents`, `getUpcomingEvents`, and `getEventsInRange` in `integrations/osx-calendar/index.ts`.
**Why**: JXA's `whose()` correctly finds recurring event instances by occurrence date, but `evt.startDate()` returns the ORIGINAL base event date. A recurring event "F2F GovTech SCTD All Hands" originally scheduled Jan 28 14:00–18:00 was shown in the Mar 18 morning summary as "2pm–6pm" instead of the correct 9:00–16:30. The event's JXA `startDate` was returning the Jan 28 base date, which when converted to SGT gave 14:00.
**Rejected**: Patching the JXA script to detect recurrences (no reliable occurrence date property exposed via JXA); accepting wrong times (worse than omitting the event).
**Branch**: feat/morning_summary_swift_calendar

## 2026-03-15 — Remove isResumedSession, always inject system prompt [pending]

**Change**: Removed `isResumedSession` flag entirely. System prompt + userName now injected on every turn regardless of `--resume` state. Truncation changed from first-500-chars to last-2000-chars. Added `since` filter to short-term memory bounded by session start time.
**Why**: `--resume` silently fails (server-side session expiry) but `isResumedSession=true` skipped the system prompt, leaving Claude with no persona. Root cause of "I lost context on what option A refers to" bug. The `/new` command also leaked old context on message 2+ because `getShortTermContext` wasn't bounded by session start.
**Rejected**: Fixing resume detection before response (too complex, race-prone); keeping `isResumedSession` with better detection (the optimization saves <1K chars but creates a fragile dependency).
**Branch**: master (direct fix, critical bug)

## 2026-03-15 — Raise prompt trim limit 12K → 20K chars [30723f2]

**Change**: `trimContextParts()` threshold raised from 12_000 to 20_000 chars in `promptBuilder.ts`.
**Why**: 12K was set as a conservative "~3K tokens" estimate in the original adversary-fixes plan (260314_170900). In practice, document context (8K chars, 8 chunks) was silently stripped every time — the prompt baseline (system prompt + memory + profile) already consumed ~8K, pushing total over 12K before document context was counted. The trim function removes `<document_context>` first (lowest priority), so RAG never reached Claude. 20K preserves all context for typical queries while staying well within Claude's 200K input window.
**Rejected**: Keeping 12K (breaks document RAG for users with >20 memory facts); per-source caps instead of total cap (more complex, same problem).
**Branch**: bugfix/double-document-context-wrap

## 2026-03-13 — Phase 3: Wire all tables for dual-write (messages, documents, summaries) [pending]

**Change**: Extended storageBackend.ts with insertMessageRecord, insertDocumentRecords, insertSummaryRecord, semanticSearchDocuments, and local read helpers. Wired 6 write sites (relay.ts saveMessage, saveMessage.ts saveCommandInteraction, routineMessage.ts sendAndRecord, shortTermMemory.ts summarizeOldMessages, documentProcessor.ts ingestText+ingestDocument) and 4 read sites (getRecentMessages, getConversationSummaries, getTotalMessageCount, searchDocuments) to route through storageBackend based on STORAGE_BACKEND env var.
**Why**: Phase 3 of Supabase→local migration. With memory (Phase 2) proven stable, extending to remaining tables enables full local-first operation. storageBackend abstraction keeps call sites clean — single import change per file.
**Rejected**: Modifying each call site individually without abstraction — would create 6+ places to maintain dual-write logic. Also rejected writing bulk migration scripts first — wiring dual-write first means new data flows to both backends immediately, and bulk migration can backfill historical data later.
**Branch**: feat/ltm_overhaul

## 2026-03-13 — Local vector stack: Qdrant via PM2, not Docker [pending]

**Change**: Implemented Phase 0+1 of Qdrant+SQLite+Ollama migration. Qdrant runs as a native macOS binary managed by PM2 (not Docker). BGE-M3 (1024-dim) replaces OpenAI text-embedding-3-small (1536-dim). SQLite (WAL mode) stores relational data, Qdrant stores vectors only.

**Why**: Docker adds unnecessary overhead on macOS (hyperkit VM). Native Qdrant binary is 62MB, starts in <2s, and PM2 gives identical restart/monitoring semantics as the existing services. Qdrant requires UUID-format point IDs — hex strings (randomblob) are rejected. All IDs use `crypto.randomUUID()` for compatibility.

**Rejected**: Docker (VM overhead, another daemon dependency), Qdrant Cloud (adds network latency, defeats local-first goal), ChromaDB (less mature, no built-in filter support).

**Branch**: `feat/ltm_overhaul`

## 2026-03-13 — Fix `/forget` memory scope bug [286fb60]

**Change**: Removed `.eq("chat_id", chatId)` filters from `/forget` search queries and replaced with `.eq("status", "active")` to enable cross-chat memory deletion.

**Why**: `/forget` was scoped to current chat, but `getMemoryContext()` retrieves facts globally across all chats. This created an asymmetry: the bot could recall facts stored in other chats, but users couldn't forget them from a different chat. The memory table's documented provenance model states "facts are globally visible (chat_id is audit-only)" — this fix aligns `/forget` with that model.

**Rejected**: Alternative of scoping both systems to chat-local — would limit memory visibility and defeat the purpose of long-term memory as a unified personal knowledge base.

**Branch**: `feat/ltm_overhaul`

## 2026-03-13 — Add semantic fallback to `/forget` search [f64279d]

**Change**: `/forget <topic>` now falls back to the Supabase `search` Edge Function (vector similarity, threshold 0.65) when ILIKE substring match returns 0 results.

**Why**: "favourite ide" doesn't substring-match "IDE preference is VS Code..." — stored content uses different wording. The previous fix (chat_id scope removal) was correct but incomplete: cross-chat scope was fixed, but same-chat paraphrase mismatches still failed silently. The embedding infrastructure was already in place (`supabase.functions.invoke("search", ...)` used by `checkSemanticDuplicate`) — reused it here.

**Rejected**: Full semantic-only search (drop ILIKE) — ILIKE is faster and sufficient for exact/partial matches. Two-pass approach keeps latency low for common case.

**Branch**: `feat/ltm_overhaul`

## 2026-03-13 — Debate & refine `/forget` semantic search thresholds [983026a]

**Change**: Raised semantic search threshold 0.65 → 0.75. Added transparency label "No exact matches. Showing similar memories:" when semantic fallback triggers.

**Why**: Multi-agent debate (PERFORMANCE vs SIMPLICITY vs SECURITY) converged on strict hybrid:
- **PERFORMANCE**: ILIKE-first is optimal (sub-10ms common case). Semantic-only would penalize every call.
- **SIMPLICITY**: Hybrid is justified — Edge Function dependency + semantic approximations warrant ILIKE determinism for common case.
- **SECURITY**: `/forget` is destructive. False positives = data loss. Threshold 0.75 (vs 0.65) reduces tangential matches while keeping recall. Transparency label helps user judge confidence.

**Rejected**: Semantic-only search, ILIKE-only search, no transparency.

**Branch**: `feat/ltm_overhaul`

## 2026-03-21 — relevant_context content injection: 200-char snippet replaces topic label [pending]

**Change**: Replace 3-7 word topic label in relevant_context with first 200 chars of actual assistant content per hit.
**Why**: Topic labels are breadcrumbs ("dedup callback handler") — content snippets ("Use BEGIN IMMEDIATE + verify-count…") transfer actual reasoning. Jump from ~110 chars/hit to ~220 chars/hit, well within 20K budget.
**Rejected**: Full content injection (~1,263 chars/hit → 19% of budget) — trimming cascade risk; topic-only — insufficient signal for knowledge transfer.
**Branch**: feat/relevant_context_content_injection
