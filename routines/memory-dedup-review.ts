#!/usr/bin/env bun

/**
 * @routine memory-dedup-review
 * @description Weekly interactive memory review: junk + semantic near-duplicate detection with user confirmation
 * @schedule 0 16 * * 5
 * @target General AI Assistant group
 */

/**
 * Memory Dedup Review Routine — Local Stack (SQLite + Qdrant + Ollama BGE-M3)
 *
 * Schedule: 4:00 PM every Friday (cron: 0 16 * * 5)
 * Target: OPERATIONS group (resolved dynamically from agents.json)
 *
 * Scans active memory for:
 *   1. Junk items — too short or matching known noise patterns
 *   2. Semantic near-duplicates — similarity >= SIMILARITY_THRESHOLD (0.85)
 *
 * Sends a summary to Telegram with an inline keyboard (Confirm / Skip).
 * The main relay process handles the confirmation callback (mdr_yes / mdr_no).
 * Candidate IDs are persisted to ./data/pending-dedup.json (24h TTL)
 * so the relay can execute the deletion in a separate process.
 *
 * Run manually: bun run routines/memory-dedup-review.ts
 * Dry run:      DRY_RUN=true bun run routines/memory-dedup-review.ts
 */

import { join, dirname } from "path";
import { sendToGroup } from "../src/utils/sendToGroup.ts";
import { loadEnv } from "../src/config/envLoader.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";
import { initRegistry } from "../src/models/index.ts";

function resolveMemoryDedupGroupKey(): string | undefined {
  for (const key of [
    process.env.MEMORY_DEDUP_GROUP,
    "OPERATIONS",
    Object.keys(GROUPS).find((k) => (GROUPS[k]?.chatId ?? 0) !== 0),
  ]) {
    if (key && (GROUPS[key]?.chatId ?? 0) !== 0) return key;
  }
  return undefined;
}

const MEMORY_DEDUP_GROUP_KEY = resolveMemoryDedupGroupKey();
import { ensureCollection } from "../src/local/vectorStore.ts";
import {
  fetchActiveItems,
  clusterDuplicates,
  type MemoryItem,
  type DuplicateCluster,
  type CleanupConfig,
} from "./handlers/memory-cleanup.ts";
import {
  savePendingCandidates,
  loadPendingCandidates,
  clearPendingCandidates,
  DEFAULT_PENDING_FILE,
  type PendingDedup,
} from "../src/memory/pendingDedup.ts";

const PROJECT_ROOT = join(dirname(import.meta.path), "..");

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

import { JUNK_PATTERNS } from "../src/memory/junkPatterns.ts";
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
// TELEGRAM SEND WITH INLINE KEYBOARD
// ============================================================

interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

async function sendWithKeyboard(
  chatId: number,
  text: string,
  keyboard: InlineKeyboard,
  topicId: number | null
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard,
  };
  if (topicId) body.message_thread_id = topicId;

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    if (response.status === 400 && err.includes("can't parse entities")) {
      body.parse_mode = undefined;
      const retry = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!retry.ok) {
        throw new Error(`Telegram API error (${retry.status}): ${await retry.text()}`);
      }
      return;
    }
    throw new Error(`Telegram API error (${response.status}): ${err}`);
  }
}

// ============================================================
// ENTRY POINT
// ============================================================

async function main(): Promise<void> {
  loadEnv();
  initRegistry();

  const dryRun = process.env.DRY_RUN === "true";

  const config: CleanupConfig = {
    dryRun,
    maxDeletes: 100,
    similarityThreshold: SIMILARITY_THRESHOLD,
    minContentLength: MIN_CONTENT_LENGTH,
  };

  console.log(
    `Starting memory dedup review (dryRun=${dryRun}, threshold=${SIMILARITY_THRESHOLD})`
  );

  await ensureCollection("memory");

  // 1. Fetch active items from SQLite
  const items = fetchActiveItems();
  console.log(`Fetched ${items.length} active memory items`);

  // 2. Detect junk
  const junk = detectJunkItems(items, MIN_CONTENT_LENGTH);
  console.log(`Junk items: ${junk.length}`);

  // 3. Detect near-duplicates (skip already-flagged junk items)
  const junkIds = new Set(junk.map((j) => j.id));
  const nonJunkItems = items.filter((i) => !junkIds.has(i.id));

  const clusters = await clusterDuplicates(nonJunkItems, config);
  const dupCount = clusters.reduce((n, c) => n + c.duplicates.length, 0);
  console.log(`Near-duplicate clusters: ${clusters.length} (${dupCount} items to remove)`);

  const totalCount = junk.length + dupCount;

  if (totalCount === 0) {
    console.log("Memory is clean — no candidates found. Skipping Telegram message.");
    process.exit(0);
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
    console.log(`Saved ${ids.length} candidate IDs to pending-dedup.json`);
  } else {
    console.log(`[DRY RUN] Would save ${ids.length} candidate IDs: ${ids.join(", ")}`);
  }

  // 6. Send Telegram message with inline keyboard
  if (!MEMORY_DEDUP_GROUP_KEY || !validateGroup(MEMORY_DEDUP_GROUP_KEY)) {
    console.warn("No group configured — skipping Telegram notification");
    process.exit(0);
  }

  const message = buildConfirmationMessage(junk, clusters);

  const keyboard: InlineKeyboard = {
    inline_keyboard: [
      [{ text: `🗑️ Confirm Delete (${ids.length} items)`, callback_data: "mdr_yes" }],
      [{ text: "❌ Skip", callback_data: "mdr_no" }],
    ],
  };

  if (!dryRun) {
    await sendWithKeyboard(
      GROUPS[MEMORY_DEDUP_GROUP_KEY].chatId,
      message,
      keyboard,
      GROUPS[MEMORY_DEDUP_GROUP_KEY].topicId
    );
    console.log("Review message with inline keyboard sent to General group");
  } else {
    console.log("[DRY RUN] Would send to General group:");
    console.log(message);
    console.log("Keyboard:", JSON.stringify(keyboard.inline_keyboard));
  }

  process.exit(0);
}

const _isEntry =
  import.meta.main ||
  process.env.pm_exec_path === import.meta.url?.replace("file://", "");

if (_isEntry) {
  main().catch(async (error) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Error running memory dedup review:", error);
    try {
      if (MEMORY_DEDUP_GROUP_KEY) await sendToGroup(GROUPS[MEMORY_DEDUP_GROUP_KEY].chatId, `⚠️ memory-dedup-review failed:\n\n${msg}`);
    } catch { /* ignore secondary failure */ }
    process.exit(0);
  });
}
