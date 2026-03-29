#!/usr/bin/env bun

/**
 * @routine memory-cleanup
 * @description Deduplicate memory items (facts, goals, preferences) using semantic similarity
 * @schedule 0 3 * * *
 * @target General AI Assistant group
 */

/**
 * Memory Cleanup Routine — Local Stack (SQLite + Qdrant + Ollama BGE-M3)
 *
 * Schedule: 3:00 AM daily (cron: 0 3 * * *)
 * Target: General AI Assistant group
 *
 * Finds semantically duplicate memory items and removes the newer duplicates,
 * keeping the oldest item in each cluster. Sends a summary to Telegram when
 * duplicates are found.
 *
 * Run manually: bun run routines/memory-cleanup.ts
 * Dry run:      DRY_RUN=true bun run routines/memory-cleanup.ts
 */

import { getDb } from "../src/local/db.ts";
import { localEmbed, localEmbedBatch } from "../src/local/embed.ts";
import {
  search as qdrantSearch,
  deletePoints as qdrantDeletePoints,
  ensureCollection,
} from "../src/local/vectorStore.ts";
import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { sendToGroup } from "../src/utils/sendToGroup.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";

function resolveMemoryCleanupGroupKey(): string | undefined {
  for (const key of [
    process.env.MEMORY_CLEANUP_GROUP,
    "OPERATIONS",
    Object.keys(GROUPS).find((k) => (GROUPS[k]?.chatId ?? 0) !== 0),
  ]) {
    if (key && (GROUPS[key]?.chatId ?? 0) !== 0) return key;
  }
  return undefined;
}

const MEMORY_CLEANUP_GROUP_KEY = resolveMemoryCleanupGroupKey();

// ============================================================
// TYPES
// ============================================================

export interface MemoryItem {
  id: string;
  content: string;
  type: "fact" | "goal" | "preference" | "completed_goal";
  created_at: string;
  confidence: number;
  chat_id: number | null;
}

export interface SearchMatch {
  id: string;
  content: string;
  type: string;
  created_at: string;
  similarity: number;
}

export interface DeletionRecord {
  keptId: string;
  deletedId: string;
  similarity: number;
  keptSnippet: string;
  deletedSnippet: string;
  type: string;
  chatId: number | null;
}

export interface TypeStats {
  scanned: number;
  duplicatesFound: number;
  deleted: number;
}

export interface CleanupResult {
  scanned: number;
  duplicatesFound: number;
  deleted: number;
  skipped: number;
  dryRun: boolean;
  byType: Record<string, TypeStats>;
  deletions: DeletionRecord[];
  cappedAt?: number;
  demotionCandidates: number;
  demotionArchived: number;
  completedGoalsArchived: number;
  archivedPurged: number;
  messagesPurged: number;
  summariesPurged: number;
}

export interface CleanupConfig {
  dryRun: boolean;
  maxDeletes: number;
  similarityThreshold: number;
  minContentLength: number;
}

export interface DuplicateCluster {
  keeper: MemoryItem;
  duplicates: Array<{ item: MemoryItem; similarity: number }>;
}

// ============================================================
// CONFIG
// ============================================================

export function parseEnvConfig(): CleanupConfig {
  return {
    dryRun: process.env.DRY_RUN === "true",
    // Three-threshold ladder: insert=0.80 | user-review=0.85 | auto-delete=0.92
    maxDeletes: parseInt(process.env.CLEANUP_MAX_DELETES || "200", 10),
    similarityThreshold: parseFloat(
      process.env.CLEANUP_SIMILARITY_THRESHOLD || "0.92"
    ),
    minContentLength: parseInt(process.env.CLEANUP_MIN_CONTENT_LENGTH || "10", 10),
  };
}

// ============================================================
// DATA FETCHING
// ============================================================

export function fetchActiveItems(): MemoryItem[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, content, type, created_at, confidence, chat_id
       FROM memory
       WHERE type IN ('fact', 'goal', 'preference')
         AND status = 'active'
       ORDER BY created_at ASC`
    )
    .all() as Array<{
    id: string;
    content: string;
    type: string;
    created_at: string;
    confidence: number;
    chat_id: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    type: r.type as MemoryItem["type"],
    created_at: r.created_at,
    confidence: r.confidence ?? 1.0,
    chat_id: r.chat_id ? Number(r.chat_id) : null,
  }));
}

// ============================================================
// GROUPING
// ============================================================

export function groupItems(
  items: MemoryItem[]
): Map<string, MemoryItem[]> {
  const groups = new Map<string, MemoryItem[]>();

  for (const item of items) {
    // Provenance model: cluster by type only — chat_id is audit trail, not scope.
    const key = item.type;
    const existing = groups.get(key);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  return groups;
}

// ============================================================
// SEMANTIC SEARCH (Qdrant + Ollama BGE-M3)
// ============================================================

export async function searchSimilar(
  item: MemoryItem,
  config: CleanupConfig,
  precomputedVector?: number[]
): Promise<SearchMatch[]> {
  try {
    const vector = precomputedVector ?? await localEmbed(item.content);

    const results = await qdrantSearch("memory", vector, {
      limit: 10,
      threshold: config.similarityThreshold,
      filter: {
        must: [
          { key: "status", match: { value: "active" } },
          { key: "type", match: { value: item.type } },
        ],
      },
    });

    return results
      .filter((r) => r.id !== item.id)
      .map((r) => ({
        id: r.id,
        content: (r.payload.content as string) ?? "",
        type: (r.payload.type as string) ?? item.type,
        created_at: (r.payload.created_at as string) ?? "",
        similarity: r.score,
      }));
  } catch (err) {
    console.warn(
      `[memory-cleanup] searchSimilar failed for item ${item.id}:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

// ============================================================
// BATCH EMBEDDING
// ============================================================

const EMBED_CHUNK_SIZE = 100;

/**
 * Pre-compute embeddings for all items in batches.
 * Returns a Map<itemId, vector> for O(1) lookup during clustering.
 */
export async function batchEmbedItems(
  items: MemoryItem[],
  minContentLength: number
): Promise<Map<string, number[]>> {
  const eligible = items.filter((i) => i.content.length >= minContentLength);
  if (eligible.length === 0) return new Map();

  const vectorMap = new Map<string, number[]>();
  const startTime = Date.now();

  for (let i = 0; i < eligible.length; i += EMBED_CHUNK_SIZE) {
    const chunk = eligible.slice(i, i + EMBED_CHUNK_SIZE);
    const texts = chunk.map((item) => item.content);
    const vectors = await localEmbedBatch(texts);
    for (let j = 0; j < chunk.length; j++) {
      vectorMap.set(chunk[j].id, vectors[j]);
    }
    const done = Math.min(i + EMBED_CHUNK_SIZE, eligible.length);
    console.log(`[memory-cleanup] Embedded ${done}/${eligible.length} items`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[memory-cleanup] Batch embedding complete: ${vectorMap.size} vectors in ${elapsed}s`
  );
  return vectorMap;
}

// ============================================================
// DUPLICATE CLUSTERING
// ============================================================

export async function clusterDuplicates(
  items: MemoryItem[],
  config: CleanupConfig
): Promise<DuplicateCluster[]> {
  // Phase 1: Batch embed all eligible items (O(n/chunk) network calls instead of O(n))
  const vectorMap = await batchEmbedItems(items, config.minContentLength);

  // Build valid ID set — Qdrant may return orphaned vectors (deleted from SQLite
  // but not yet from Qdrant, or stale status payload). Only accept IDs that exist
  // in the current SQLite active items list. O(1) lookup per match.
  const validIds = new Set(items.map((i) => i.id));

  // Phase 2: Cluster using pre-computed vectors (Qdrant search only, no embed)
  const clusters: DuplicateCluster[] = [];
  const visitedAsKeeper = new Set<string>();
  const absorbedAsDuplicate = new Set<string>();
  let processed = 0;

  for (const item of items) {
    if (absorbedAsDuplicate.has(item.id)) continue;
    if (item.content.length < config.minContentLength) continue;
    if (visitedAsKeeper.has(item.id)) continue;

    visitedAsKeeper.add(item.id);
    processed++;

    const vector = vectorMap.get(item.id);
    if (!vector) continue;

    const matches = await searchSimilar(item, config, vector);
    if (matches.length === 0) {
      if (processed % 100 === 0) {
        console.log(
          `[memory-cleanup] Searched ${processed}/${vectorMap.size} items (${clusters.length} clusters)`
        );
      }
      continue;
    }

    // Must exist in SQLite active items (not orphaned in Qdrant) AND not already absorbed
    const freshMatches = matches.filter(
      (m) => validIds.has(m.id) && !absorbedAsDuplicate.has(m.id)
    );
    if (freshMatches.length === 0) continue;

    const cluster: DuplicateCluster = {
      keeper: item,
      duplicates: freshMatches.map((m) => ({
        item: {
          id: m.id,
          content: m.content,
          type: item.type,
          created_at: m.created_at,
          confidence: 0,
          chat_id: item.chat_id,
        },
        similarity: m.similarity,
      })),
    };

    for (const dup of cluster.duplicates) {
      absorbedAsDuplicate.add(dup.item.id);
    }

    clusters.push(cluster);

    if (processed % 100 === 0) {
      console.log(
        `[memory-cleanup] Searched ${processed}/${vectorMap.size} items (${clusters.length} clusters)`
      );
    }
  }

  console.log(
    `[memory-cleanup] Clustering complete: ${clusters.length} clusters from ${processed} items`
  );
  return clusters;
}

// ============================================================
// DELETION (SQLite + Qdrant)
// ============================================================

export async function deleteItems(
  ids: string[],
  dryRun: boolean
): Promise<number> {
  if (ids.length === 0) return 0;

  if (dryRun) {
    console.log(`[DRY RUN] Would delete ${ids.length} items: ${ids.join(", ")}`);
    return ids.length;
  }

  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const result = db
    .prepare(`DELETE FROM memory WHERE id IN (${placeholders})`)
    .run(...ids);

  try {
    await qdrantDeletePoints("memory", ids);
  } catch (err) {
    console.warn("[memory-cleanup] Qdrant deletePoints failed (non-fatal):", err instanceof Error ? err.message : err);
  }

  return result.changes;
}

// ============================================================
// REPORT BUILDERS
// ============================================================

export function buildReport(result: CleanupResult): string {
  const lines: string[] = [];
  const mode = result.dryRun ? " [DRY RUN]" : "";

  lines.push(`Memory Cleanup Report${mode}`);
  lines.push(`${"=".repeat(40)}`);
  lines.push(`Scanned:          ${result.scanned}`);
  lines.push(`Duplicates found: ${result.duplicatesFound}`);
  lines.push(`Deleted:          ${result.deleted}`);
  lines.push(`Skipped (cap):    ${result.skipped}`);
  if (result.cappedAt !== undefined) {
    lines.push(`Cap applied at:   ${result.cappedAt}`);
  }
  lines.push("");

  lines.push("By Type:");
  for (const [type, stats] of Object.entries(result.byType)) {
    lines.push(
      `  ${type}: scanned=${stats.scanned} dups=${stats.duplicatesFound} deleted=${stats.deleted}`
    );
  }
  lines.push("");

  if (result.deletions.length > 0) {
    lines.push("Deletions:");
    for (const d of result.deletions) {
      const kept = d.keptSnippet.slice(0, 60).replace(/\n/g, " ");
      const deleted = d.deletedSnippet.slice(0, 60).replace(/\n/g, " ");
      lines.push(
        `  [${d.type}] sim=${d.similarity.toFixed(3)} chat=${d.chatId ?? "null"}`
      );
      lines.push(`    kept:    ${kept}...`);
      lines.push(`    deleted: ${deleted}...`);
    }
  } else {
    lines.push("No duplicates found — memory is clean.");
  }

  lines.push("");
  lines.push("Demotion Pass:");
  lines.push(`  Candidates (>30d old): ${result.demotionCandidates}`);
  lines.push(`  Archived:              ${result.demotionArchived}`);

  lines.push("");
  lines.push(`Completed goals archived: ${result.completedGoalsArchived}`);
  lines.push(`Archived/deleted items purged (>90d): ${result.archivedPurged}`);
  lines.push(`Messages purged (>90d): ${result.messagesPurged}`);
  lines.push(`Summaries purged (>180d): ${result.summariesPurged}`);

  return lines.join("\n");
}

export function buildTelegramMessage(result: CleanupResult): string {
  const mode = result.dryRun ? " (dry run)" : "";
  const lines: string[] = [];

  lines.push(`Memory Cleanup Complete${mode}`);
  lines.push("");
  lines.push(`Scanned: ${result.scanned} items`);
  lines.push(`Removed: ${result.deleted} duplicate${result.deleted !== 1 ? "s" : ""}`);

  if (result.skipped > 0) {
    lines.push(`Skipped: ${result.skipped} (cap: ${result.cappedAt})`);
  }

  const typeLines = Object.entries(result.byType)
    .filter(([, s]) => s.duplicatesFound > 0)
    .map(([t, s]) => `  ${t}: ${s.deleted} removed`);

  if (typeLines.length > 0) {
    lines.push("");
    lines.push("By type:");
    lines.push(...typeLines);
  }

  const shown = result.deletions.slice(0, 10);
  if (shown.length > 0) {
    lines.push("");
    lines.push("Removed duplicates:");
    for (const d of shown) {
      const snippet = d.deletedSnippet.slice(0, 50).replace(/\n/g, " ");
      lines.push(`  [${d.type}] "${snippet}..." (sim ${d.similarity.toFixed(2)})`);
    }
    if (result.deletions.length > 10) {
      lines.push(`  ... and ${result.deletions.length - 10} more`);
    }
  }

  if (result.demotionCandidates > 0 || result.demotionArchived > 0) {
    lines.push("");
    lines.push(`Demotion: ${result.demotionArchived} archived of ${result.demotionCandidates} stale candidates`);
  }

  if (result.completedGoalsArchived > 0) {
    lines.push(`Completed goals archived: ${result.completedGoalsArchived}`);
  }

  if (result.messagesPurged > 0 || result.summariesPurged > 0) {
    lines.push("");
    lines.push("Data retention:");
    if (result.messagesPurged > 0) {
      lines.push(`  Messages purged (>90d): ${result.messagesPurged}`);
    }
    if (result.summariesPurged > 0) {
      lines.push(`  Summaries purged (>180d): ${result.summariesPurged}`);
    }
  }

  return lines.join("\n");
}

// ============================================================
// COMPLETED GOAL ARCHIVAL
// ============================================================

export function archiveCompletedGoals(dryRun: boolean): number {
  const db = getDb();
  const items = db
    .prepare(
      `SELECT id FROM memory WHERE type = 'completed_goal' AND status = 'active'`
    )
    .all() as Array<{ id: string }>;

  if (items.length === 0) return 0;

  if (dryRun) {
    console.log(`[DRY RUN] Would archive ${items.length} completed_goal items`);
    return items.length;
  }

  const result = db
    .prepare(
      `UPDATE memory SET status = 'archived', updated_at = datetime('now')
       WHERE type = 'completed_goal' AND status = 'active'`
    )
    .run();

  return result.changes;
}

// ============================================================
// PURGE ARCHIVED ITEMS
// ============================================================

export async function purgeArchivedItems(
  dryRun: boolean,
  retentionDays = 90
): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  // Purge both archived and soft-deleted items older than retention period
  const candidates = db
    .prepare(
      `SELECT id FROM memory WHERE status IN ('archived', 'deleted') AND updated_at < ?`
    )
    .all(cutoff) as Array<{ id: string }>;

  if (candidates.length === 0) return 0;

  const ids = candidates.map((r) => r.id);

  if (dryRun) {
    console.log(`[DRY RUN] Would purge ${ids.length} archived/deleted items older than ${retentionDays}d`);
    return ids.length;
  }

  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM memory WHERE id IN (${placeholders})`).run(...ids);

  try {
    await qdrantDeletePoints("memory", ids);
  } catch (err) {
    console.warn("[memory-cleanup] Qdrant purge failed (non-fatal):", err instanceof Error ? err.message : err);
  }

  console.log(`Purged ${ids.length} archived/deleted items older than ${retentionDays} days`);
  return ids.length;
}

// ============================================================
// PURGE OLD MESSAGES
// ============================================================

export async function purgeOldMessages(
  dryRun: boolean,
  retentionDays = 90
): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const candidates = db
    .prepare(`SELECT id FROM messages WHERE created_at < ?`)
    .all(cutoff) as Array<{ id: string }>;

  if (candidates.length === 0) return 0;

  const ids = candidates.map((r) => r.id);

  if (dryRun) {
    console.log(`[DRY RUN] Would purge ${ids.length} messages older than ${retentionDays}d`);
    return ids.length;
  }

  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);

  try {
    await qdrantDeletePoints("messages", ids);
  } catch (err) {
    console.warn("[memory-cleanup] Qdrant message purge failed (non-fatal):", err instanceof Error ? err.message : err);
  }

  console.log(`Purged ${ids.length} messages older than ${retentionDays} days`);
  return ids.length;
}

// ============================================================
// PURGE OLD CONVERSATION SUMMARIES
// ============================================================

export async function purgeOldSummaries(
  dryRun: boolean,
  retentionDays = 180
): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const candidates = db
    .prepare(`SELECT id FROM conversation_summaries WHERE created_at < ?`)
    .all(cutoff) as Array<{ id: string }>;

  if (candidates.length === 0) return 0;

  const ids = candidates.map((r) => r.id);

  if (dryRun) {
    console.log(`[DRY RUN] Would purge ${ids.length} summaries older than ${retentionDays}d`);
    return ids.length;
  }

  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM conversation_summaries WHERE id IN (${placeholders})`).run(...ids);

  try {
    await qdrantDeletePoints("summaries", ids);
  } catch (err) {
    console.warn("[memory-cleanup] Qdrant summary purge failed (non-fatal):", err instanceof Error ? err.message : err);
  }

  console.log(`Purged ${ids.length} summaries older than ${retentionDays} days`);
  return ids.length;
}

// ============================================================
// MAIN ORCHESTRATOR (exported for tests)
// ============================================================

export async function runCleanup(
  configOverride?: Partial<CleanupConfig>
): Promise<CleanupResult> {
  const config: CleanupConfig = {
    ...parseEnvConfig(),
    ...configOverride,
  };

  console.log(
    `Starting memory cleanup (dryRun=${config.dryRun}, threshold=${config.similarityThreshold}, maxDeletes=${config.maxDeletes})`
  );

  await ensureCollection("memory");

  const completedGoalsArchived = archiveCompletedGoals(config.dryRun);
  console.log(`Completed goals archived: ${completedGoalsArchived}`);

  const items = fetchActiveItems();
  console.log(`Fetched ${items.length} active memory items`);

  const byType: Record<string, TypeStats> = {
    fact: { scanned: 0, duplicatesFound: 0, deleted: 0 },
    goal: { scanned: 0, duplicatesFound: 0, deleted: 0 },
    preference: { scanned: 0, duplicatesFound: 0, deleted: 0 },
  };

  for (const item of items) {
    if (byType[item.type]) {
      byType[item.type].scanned++;
    }
  }

  const grouped = groupItems(items);
  const allClusters: DuplicateCluster[] = [];

  for (const [groupKey, groupItems_] of grouped) {
    console.log(`Clustering group "${groupKey}" (${groupItems_.length} items)`);
    const clusters = await clusterDuplicates(groupItems_, config);
    allClusters.push(...clusters);
  }

  const deletions: DeletionRecord[] = [];
  const idsToDelete: string[] = [];
  let skipped = 0;

  for (const cluster of allClusters) {
    for (const dup of cluster.duplicates) {
      if (idsToDelete.length >= config.maxDeletes) {
        skipped++;
        continue;
      }

      deletions.push({
        keptId: cluster.keeper.id,
        deletedId: dup.item.id,
        similarity: dup.similarity,
        keptSnippet: cluster.keeper.content,
        deletedSnippet: dup.item.content,
        type: cluster.keeper.type,
        chatId: cluster.keeper.chat_id,
      });

      idsToDelete.push(dup.item.id);

      if (byType[cluster.keeper.type]) {
        byType[cluster.keeper.type].duplicatesFound++;
      }
    }
  }

  const deleted = await deleteItems(idsToDelete, config.dryRun);

  for (const d of deletions.slice(0, deleted)) {
    if (byType[d.type]) {
      byType[d.type].deleted++;
    }
  }

  const demotionResult = runDemotionPass({
    dryRun: config.dryRun,
    maxArchives: 100,
  });
  console.log(`Demotion pass: ${demotionResult.archived} archived of ${demotionResult.candidates} candidates`);

  const archivedPurged = await purgeArchivedItems(config.dryRun);
  const messagesPurged = await purgeOldMessages(config.dryRun);
  const summariesPurged = await purgeOldSummaries(config.dryRun);

  const result: CleanupResult = {
    scanned: items.length,
    duplicatesFound: deletions.length + skipped,
    deleted,
    skipped,
    dryRun: config.dryRun,
    byType,
    deletions,
    demotionCandidates: demotionResult.candidates,
    demotionArchived: demotionResult.archived,
    completedGoalsArchived,
    archivedPurged,
    messagesPurged,
    summariesPurged,
    ...(skipped > 0 && { cappedAt: config.maxDeletes }),
  };

  console.log(buildReport(result));

  return result;
}

// ============================================================
// DEMOTION PASS
// ============================================================

export interface DemotionResult {
  candidates: number;
  archived: number;
  dryRun: boolean;
}

export function runDemotionPass(
  config: { dryRun: boolean; maxArchives?: number }
): DemotionResult {
  const db = getDb();
  const maxArchives = config.maxArchives ?? 100;
  const now = Date.now();
  const cutoffDate = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  const candidates = db
    .prepare(
      `SELECT id, importance, stability, created_at, last_used_at, access_count, type, category
       FROM memory
       WHERE status = 'active'
         AND (category IS NULL OR category != 'constraint')
         AND created_at < ?`
    )
    .all(cutoffDate) as Array<{
    id: string;
    importance: number | null;
    stability: number | null;
    created_at: string;
    last_used_at: string | null;
    access_count: number | null;
    type: string;
    category: string | null;
  }>;

  if (candidates.length === 0) {
    return { candidates: 0, archived: 0, dryRun: config.dryRun };
  }

  const toArchive: string[] = [];

  for (const m of candidates) {
    if (toArchive.length >= maxArchives) break;
    if (m.category === "constraint") continue;

    const ageDays = (now - new Date(m.created_at).getTime()) / (1000 * 60 * 60 * 24);
    const lastUsedDays = m.last_used_at
      ? (now - new Date(m.last_used_at).getTime()) / (1000 * 60 * 60 * 24)
      : ageDays;

    const ageFactor = Math.exp(-ageDays / 90);
    const accessBoost = Math.min(2, 1 + (m.access_count ?? 0) * 0.1);
    const recencyFactor = Math.exp(-lastUsedDays / 60);
    const effectiveScore =
      (m.importance ?? 0.7) * (m.stability ?? 0.7) * ageFactor * accessBoost * recencyFactor;

    if (effectiveScore < 0.05) {
      toArchive.push(m.id);
    }
  }

  if (!config.dryRun && toArchive.length > 0) {
    const placeholders = toArchive.map(() => "?").join(",");
    db.prepare(
      `UPDATE memory SET status = 'archived', updated_at = datetime('now')
       WHERE id IN (${placeholders})`
    ).run(...toArchive);
  }

  return {
    candidates: candidates.length,
    archived: config.dryRun ? 0 : toArchive.length,
    dryRun: config.dryRun,
  };
}

// ============================================================
// ENTRY POINT
// ============================================================

async function main(): Promise<void> {
  const result = await runCleanup();

  if (result.duplicatesFound > 0 && MEMORY_CLEANUP_GROUP_KEY && validateGroup(MEMORY_CLEANUP_GROUP_KEY)) {
    const message = buildTelegramMessage(result);
    await sendAndRecord(GROUPS[MEMORY_CLEANUP_GROUP_KEY].chatId, message, {
      routineName: "memory-cleanup",
      agentId: "general-assistant",
      topicId: GROUPS[MEMORY_CLEANUP_GROUP_KEY].topicId,
    });
    console.log(`Summary sent to ${MEMORY_CLEANUP_GROUP_KEY} group`);
  } else if (result.duplicatesFound === 0) {
    console.log("No duplicates found — no Telegram message sent");
  } else {
    console.warn("No group configured — skipping Telegram notification");
  }

  process.exit(0);
}

const _isEntry =
  import.meta.main ||
  process.env.pm_exec_path === import.meta.url?.replace("file://", "");

if (_isEntry) {
  main().catch(async (error) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Error running memory cleanup:", error);
    try {
      if (MEMORY_CLEANUP_GROUP_KEY) await sendToGroup(GROUPS[MEMORY_CLEANUP_GROUP_KEY].chatId, `⚠️ memory-cleanup failed:\n\n${msg}`);
    } catch { /* ignore secondary failure */ }
    process.exit(0);
  });
}
