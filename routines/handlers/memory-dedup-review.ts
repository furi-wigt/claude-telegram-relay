/**
 * @routine memory-dedup-review
 * @description Weekly interactive memory review: junk + semantic near-duplicate detection with user confirmation
 * @schedule 0 16 * * 5
 * @target General AI Assistant group
 *
 * Handler — pure logic only. No standalone entry point, no PM2 boilerplate.
 * Use ctx.send() for Telegram output and ctx.log() for console output.
 */

import type { RoutineContext } from "../../src/jobs/executors/routineContext.ts";
import { ensureCollection } from "../../src/local/vectorStore.ts";
import { initRegistry } from "../../src/models/index.ts";
import {
  fetchActiveItems,
  clusterDuplicates,
  type MemoryItem,
  type DuplicateCluster,
  type CleanupConfig,
} from "./memory-cleanup.ts";
import {
  savePendingCandidates,
  loadPendingCandidates,
  clearPendingCandidates,
  DEFAULT_PENDING_FILE,
  type PendingDedup,
} from "../../src/memory/pendingDedup.ts";

// Re-export from the extracted module so existing consumers aren't broken
export {
  savePendingCandidates,
  loadPendingCandidates,
  clearPendingCandidates,
  DEFAULT_PENDING_FILE,
  type PendingDedup,
};

// ============================================================
// CONFIG
// ============================================================

/** Lower threshold than nightly 0.92 — we confirm with user before deleting */
const SIMILARITY_THRESHOLD = 0.85;
const MIN_CONTENT_LENGTH = 10;

// ============================================================
// JUNK DETECTION
// ============================================================

import { JUNK_PATTERNS } from "../../src/memory/junkPatterns.ts";
export { JUNK_PATTERNS };

/**
 * Return items that are junk: too short or matching a noise pattern.
 */
export function detectJunkItems(
  items: MemoryItem[],
  minLength = MIN_CONTENT_LENGTH
): MemoryItem[] {
  return items.filter((item) => {
    const trimmed = item.content.trim();
    if (trimmed.length < minLength) return true;
    return JUNK_PATTERNS.some((p) => p.test(trimmed));
  });
}

// ============================================================
// CANDIDATE COLLECTION
// ============================================================

export function collectCandidateIds(
  junk: MemoryItem[],
  clusters: DuplicateCluster[]
): string[] {
  const ids = new Set<string>();

  for (const item of junk) {
    ids.add(item.id);
  }

  for (const cluster of clusters) {
    for (const { item } of cluster.duplicates) {
      ids.add(item.id);
    }
  }

  return Array.from(ids);
}

// ============================================================
// REPORT BUILDER
// ============================================================

export function buildConfirmationMessage(
  junk: MemoryItem[],
  clusters: DuplicateCluster[]
): string {
  const totalIds = collectCandidateIds(junk, clusters).length;
  const lines: string[] = [];

  const today = new Date().toLocaleDateString("en-SG", {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  lines.push(`🧹 <b>Weekly Memory Review</b> — ${today}`);
  lines.push("");

  if (totalIds === 0) {
    lines.push("✅ Memory is clean — nothing to remove.");
    return lines.join("\n");
  }

  const parts: string[] = [];
  if (junk.length > 0) {
    parts.push(`${junk.length} junk item${junk.length !== 1 ? "s" : ""}`);
  }
  const dupCount = clusters.reduce((n, c) => n + c.duplicates.length, 0);
  if (dupCount > 0) {
    parts.push(`${dupCount} near-duplicate${dupCount !== 1 ? "s" : ""}`);
  }

  lines.push(
    `Found <b>${totalIds} item${totalIds !== 1 ? "s" : ""}</b> to clean up: ${parts.join(", ")}`
  );
  lines.push("");

  if (junk.length > 0) {
    lines.push("<b>Junk items:</b>");
    for (const item of junk.slice(0, 5)) {
      const snippet = item.content.slice(0, 60).replace(/\n/g, " ");
      lines.push(`  [${item.type}] "${snippet}"`);
    }
    if (junk.length > 5) {
      lines.push(`  … and ${junk.length - 5} more`);
    }
    lines.push("");
  }

  if (clusters.length > 0) {
    lines.push("<b>Near-duplicates</b> (keeping older item):");
    const shown = clusters.slice(0, 5);
    for (const cluster of shown) {
      const keeperSnippet = cluster.keeper.content.slice(0, 40).replace(/\n/g, " ");
      for (const { item, similarity } of cluster.duplicates.slice(0, 2)) {
        const dupSnippet = item.content.slice(0, 40).replace(/\n/g, " ");
        lines.push(
          `  "<i>${dupSnippet}</i>" → dup of "${keeperSnippet}" (sim ${similarity.toFixed(2)})`
        );
      }
    }
    if (clusters.length > 5) {
      lines.push(`  … and ${clusters.length - 5} more clusters`);
    }
    lines.push("");
  }

  lines.push(
    `Tap <b>Confirm</b> to delete all ${totalIds} items, or <b>Skip</b> to leave memory unchanged.`
  );

  return lines.join("\n");
}

// ============================================================
// HANDLER ENTRY POINT
// ============================================================

export async function run(ctx: RoutineContext): Promise<void> {
  initRegistry();

  const dryRun = (ctx.params.dryRun as boolean | undefined) ?? process.env.DRY_RUN === "true";

  const config: CleanupConfig = {
    dryRun,
    maxDeletes: 100,
    similarityThreshold: SIMILARITY_THRESHOLD,
    minContentLength: MIN_CONTENT_LENGTH,
  };

  ctx.log(`Starting memory dedup review (dryRun=${dryRun}, threshold=${SIMILARITY_THRESHOLD})`);

  await ensureCollection("memory");

  // 1. Fetch active items from SQLite
  const items = fetchActiveItems();
  ctx.log(`Fetched ${items.length} active memory items`);

  // 2. Detect junk
  const junk = detectJunkItems(items, MIN_CONTENT_LENGTH);
  ctx.log(`Junk items: ${junk.length}`);

  // 3. Detect near-duplicates (skip already-flagged junk items)
  const junkIds = new Set(junk.map((j) => j.id));
  const nonJunkItems = items.filter((i) => !junkIds.has(i.id));

  const clusters = await clusterDuplicates(nonJunkItems, config);
  const dupCount = clusters.reduce((n, c) => n + c.duplicates.length, 0);
  ctx.log(`Near-duplicate clusters: ${clusters.length} (${dupCount} items to remove)`);

  const totalCount = junk.length + dupCount;

  if (totalCount === 0) {
    ctx.log("Memory is clean — no candidates found. Skipping Telegram message.");
    return;
  }

  // 4. Collect candidate IDs and build summary
  const ids = collectCandidateIds(junk, clusters);
  const parts: string[] = [];
  if (junk.length > 0) parts.push(`${junk.length} junk`);
  if (dupCount > 0) parts.push(`${dupCount} near-duplicates`);
  const summary = parts.join(", ");

  // 5. Save candidate IDs for relay callback handler
  if (!dryRun) {
    await savePendingCandidates(ids, summary);
    ctx.log(`Saved ${ids.length} candidate IDs to pending-dedup.json`);
  } else {
    ctx.log(`[DRY RUN] Would save ${ids.length} candidate IDs: ${ids.join(", ")}`);
  }

  // 6. Send Telegram message with inline keyboard
  const message = buildConfirmationMessage(junk, clusters);

  const keyboard = {
    inline_keyboard: [
      [{ text: `🗑️ Confirm Delete (${ids.length} items)`, callback_data: "mdr_yes" }],
      [{ text: "❌ Skip", callback_data: "mdr_no" }],
    ],
  };

  if (!dryRun) {
    await ctx.send(message, { parseMode: "HTML", reply_markup: keyboard });
    ctx.log("Review message with inline keyboard sent to General group");
  } else {
    ctx.log("[DRY RUN] Would send to General group:");
    ctx.log(message);
    ctx.log(`Keyboard: ${JSON.stringify(keyboard.inline_keyboard)}`);
  }
}
