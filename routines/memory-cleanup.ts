#!/usr/bin/env bun

/**
 * @routine memory-cleanup
 * @description Deduplicate memory items (facts, goals, preferences) using semantic similarity
 * @schedule 0 3 * * *
 * @target General AI Assistant group
 */

/**
 * Memory Cleanup Routine
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

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";

// ============================================================
// TYPES
// ============================================================

export interface MemoryItem {
  id: string;
  content: string;
  type: "fact" | "goal" | "preference";
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
}

export interface CleanupConfig {
  dryRun: boolean;
  maxDeletes: number;
  similarityThreshold: number;
  minContentLength: number;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export interface DuplicateCluster {
  keeper: MemoryItem;
  duplicates: Array<{ item: MemoryItem; similarity: number }>;
}

// ============================================================
// CONFIG
// ============================================================

export function parseEnvConfig(): CleanupConfig {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error(
      "Missing required env vars: SUPABASE_URL and SUPABASE_ANON_KEY must be set"
    );
    process.exit(1);
  }

  return {
    dryRun: process.env.DRY_RUN === "true",
    maxDeletes: parseInt(process.env.CLEANUP_MAX_DELETES || "50", 10),
    similarityThreshold: parseFloat(
      process.env.CLEANUP_SIMILARITY_THRESHOLD || "0.92"
    ),
    minContentLength: parseInt(process.env.CLEANUP_MIN_CONTENT_LENGTH || "10", 10),
    supabaseUrl,
    supabaseAnonKey,
  };
}

// ============================================================
// DATA FETCHING
// ============================================================

export async function fetchActiveItems(
  supabase: SupabaseClient
): Promise<MemoryItem[]> {
  const { data, error } = await supabase
    .from("memory")
    .select("id,content,type,created_at,confidence,chat_id")
    .in("type", ["fact", "goal", "preference"])
    .eq("status", "active")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("fetchActiveItems: Supabase error:", error);
    return [];
  }

  return (data || []) as MemoryItem[];
}

// ============================================================
// GROUPING
// ============================================================

export function groupItems(
  items: MemoryItem[]
): Map<string, MemoryItem[]> {
  const groups = new Map<string, MemoryItem[]>();

  for (const item of items) {
    const key = `${item.type}::${item.chat_id ?? "null"}`;
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
// SEMANTIC SEARCH
// ============================================================

export async function searchSimilar(
  supabase: SupabaseClient,
  item: MemoryItem,
  config: CleanupConfig
): Promise<SearchMatch[]> {
  try {
    const body: Record<string, unknown> = {
      query: item.content,
      table: "memory",
      match_count: 10,
      match_threshold: config.similarityThreshold,
      ...(item.chat_id != null && { chat_id: item.chat_id }),
    };

    const result = await Promise.race([
      supabase.functions.invoke("search", { body }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("search timeout")), 10_000)
      ),
    ]);

    const { data, error } = result as {
      data: Array<{
        id: string;
        content: string;
        type?: string;
        created_at?: string;
        similarity: number;
      }> | null;
      error: unknown;
    };

    if (error || !data?.length) {
      return [];
    }

    // Post-filter: same type, exclude self
    return data
      .filter((m) => m.type === item.type && m.id !== item.id)
      .map((m) => ({
        id: m.id,
        content: m.content,
        type: m.type ?? item.type,
        created_at: m.created_at ?? "",
        similarity: m.similarity,
      }));
  } catch {
    // Fail open — don't block cleanup on search errors
    return [];
  }
}

// ============================================================
// DUPLICATE CLUSTERING
// ============================================================

export async function clusterDuplicates(
  items: MemoryItem[],
  config: CleanupConfig,
  supabase: SupabaseClient
): Promise<DuplicateCluster[]> {
  const clusters: DuplicateCluster[] = [];
  // Union-find via visited set — any item that appears as a duplicate is skipped as a keeper
  const visitedAsKeeper = new Set<string>();
  const absorbedAsDuplicate = new Set<string>();

  for (const item of items) {
    // Skip items already absorbed as duplicates in another cluster
    if (absorbedAsDuplicate.has(item.id)) continue;
    // Skip if content is too short
    if (item.content.length < config.minContentLength) continue;
    // Skip if already processed as a keeper
    if (visitedAsKeeper.has(item.id)) continue;

    visitedAsKeeper.add(item.id);

    const matches = await searchSimilar(supabase, item, config);

    if (matches.length === 0) continue;

    // Filter out items already absorbed elsewhere
    const freshMatches = matches.filter((m) => !absorbedAsDuplicate.has(m.id));

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

    // Mark duplicates so they're not re-processed as keepers
    for (const dup of cluster.duplicates) {
      absorbedAsDuplicate.add(dup.item.id);
    }

    clusters.push(cluster);
  }

  return clusters;
}

// ============================================================
// DELETION
// ============================================================

export async function deleteItems(
  supabase: SupabaseClient,
  ids: string[],
  dryRun: boolean
): Promise<number> {
  if (ids.length === 0) return 0;

  if (dryRun) {
    console.log(`[DRY RUN] Would delete ${ids.length} items: ${ids.join(", ")}`);
    return ids.length;
  }

  const { error, count } = await supabase
    .from("memory")
    .delete({ count: "exact" })
    .in("id", ids);

  if (error) {
    console.error("deleteItems: Supabase error:", error);
    return 0;
  }

  return count ?? ids.length;
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

  return lines.join("\n");
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

  // Per-invocation client — NOT imported from src/utils/supabase.ts
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

  console.log(
    `Starting memory cleanup (dryRun=${config.dryRun}, threshold=${config.similarityThreshold}, maxDeletes=${config.maxDeletes})`
  );

  const items = await fetchActiveItems(supabase);
  console.log(`Fetched ${items.length} active memory items`);

  // Initialise per-type stats
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

  // Group by type + chat_id, then cluster per group
  const grouped = groupItems(items);
  const allClusters: DuplicateCluster[] = [];

  for (const [groupKey, groupItems_] of grouped) {
    console.log(`Clustering group "${groupKey}" (${groupItems_.length} items)`);
    const clusters = await clusterDuplicates(groupItems_, config, supabase);
    allClusters.push(...clusters);
  }

  // Collect all duplicates to delete, respecting maxDeletes cap
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

  // Execute deletion
  const deleted = await deleteItems(supabase, idsToDelete, config.dryRun);

  // Update byType deleted counts
  for (const d of deletions.slice(0, deleted)) {
    if (byType[d.type]) {
      byType[d.type].deleted++;
    }
  }

  // Run demotion pass after dedup
  const demotionResult = await runDemotionPass(supabase, {
    dryRun: config.dryRun,
    maxArchives: 100,
  });
  console.log(`Demotion pass: ${demotionResult.archived} archived of ${demotionResult.candidates} candidates`);

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

export async function runDemotionPass(
  supabase: SupabaseClient,
  config: { dryRun: boolean; maxArchives?: number }
): Promise<DemotionResult> {
  const maxArchives = config.maxArchives ?? 100;
  const now = Date.now();
  // Only consider items created more than 30 days ago
  const cutoffDate = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: candidates, error } = await supabase
    .from("memory")
    .select("id, importance, stability, created_at, last_used_at, access_count, type, category")
    .eq("status", "active")
    .neq("category", "constraint") // never auto-demote hard constraints
    .lt("created_at", cutoffDate);

  if (error || !candidates?.length) {
    return { candidates: 0, archived: 0, dryRun: config.dryRun };
  }

  const toArchive: string[] = [];

  for (const m of candidates) {
    if (toArchive.length >= maxArchives) break;
    if (m.category === "constraint") continue; // safety net — DB filter may not apply in all call paths

    const ageDays = (now - new Date(m.created_at).getTime()) / (1000 * 60 * 60 * 24);
    const lastUsedDays = m.last_used_at
      ? (now - new Date(m.last_used_at).getTime()) / (1000 * 60 * 60 * 24)
      : ageDays; // treat "never used" same as age

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
    const { error: archiveError } = await supabase
      .from("memory")
      .update({ status: "archived" })
      .in("id", toArchive);
    if (archiveError) {
      console.error("runDemotionPass: archive error:", archiveError);
      return { candidates: candidates.length, archived: 0, dryRun: config.dryRun };
    }
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

  if (result.duplicatesFound > 0 && validateGroup("GENERAL")) {
    const message = buildTelegramMessage(result);
    await sendAndRecord(GROUPS.GENERAL.chatId, message, {
      routineName: "memory-cleanup",
      agentId: "general-assistant",
    });
    console.log("Summary sent to General group");
  } else if (result.duplicatesFound === 0) {
    console.log("No duplicates found — no Telegram message sent");
  } else {
    console.warn(
      "GENERAL group not configured — skipping Telegram notification"
    );
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("Error running memory cleanup:", error);
  process.exit(1);
});
