#!/usr/bin/env bun

/**
 * @routine memory-dedup-review
 * @description Weekly interactive memory review: junk + semantic near-duplicate detection with user confirmation
 * @schedule 0 16 * * 5
 * @target General AI Assistant group
 */

/**
 * Memory Dedup Review Routine
 *
 * Schedule: 4:00 PM every Friday (cron: 0 16 * * 5)
 * Target: General AI Assistant group (GROUPS.GENERAL), topic #General
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

import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { GROUPS, validateGroup } from "../src/config/groups.ts";
import {
  fetchActiveItems,
  clusterDuplicates,
  type MemoryItem,
  type DuplicateCluster,
  type CleanupConfig,
} from "./memory-cleanup.ts";

const PROJECT_ROOT = join(dirname(import.meta.path), "..");
const DEFAULT_PENDING_FILE = join(PROJECT_ROOT, "data", "pending-dedup.json");

// ============================================================
// CONFIG
// ============================================================

/** Lower threshold than nightly 0.92 — we confirm with user before deleting */
const SIMILARITY_THRESHOLD = 0.85;
const MIN_CONTENT_LENGTH = 10;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ============================================================
// TYPES
// ============================================================

export interface PendingDedup {
  ids: string[];
  count: number;
  expiresAt: string; // ISO
  summary: string;
}

// ============================================================
// JUNK DETECTION
// ============================================================

export const JUNK_PATTERNS: RegExp[] = [
  /^fact$/i,
  /^fact to store$/i,
  /^age:\s*not specified$/i,
  /^unknown$/i,
  /^n\/a$/i,
  /^test$/i,
  /^\s*$/,
  /^none$/i,
  /^not specified$/i,
  /^no information$/i,
];

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

/**
 * Collect all IDs to be deleted:
 *   - All junk items
 *   - Duplicate items from clusters (NOT the keeper)
 *
 * Deduplicates in case the same item appears in both lists.
 */
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

/**
 * Build the Telegram message body with a summary of candidates.
 * Inline keyboard is added at send time (relay_markup injected by main()).
 */
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
// PENDING STATE (cross-process file)
// ============================================================

export async function savePendingCandidates(
  ids: string[],
  summary: string,
  filePath = DEFAULT_PENDING_FILE
): Promise<void> {
  const data: PendingDedup = {
    ids,
    count: ids.length,
    expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
    summary,
  };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export async function loadPendingCandidates(
  filePath = DEFAULT_PENDING_FILE
): Promise<PendingDedup | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as PendingDedup;
    if (new Date(data.expiresAt) < new Date()) {
      return null; // expired
    }
    return data;
  } catch {
    return null;
  }
}

export async function clearPendingCandidates(
  filePath = DEFAULT_PENDING_FILE
): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // file doesn't exist — that's fine
  }
}

// ============================================================
// TELEGRAM SEND WITH INLINE KEYBOARD
// ============================================================

interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/**
 * Send a message with an inline keyboard directly via Telegram Bot API.
 * Used because sendToGroup() does not support reply_markup.
 */
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
    // Retry without parse_mode on parse error
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
// ENV LOADER (standalone routine process)
// ============================================================

function loadEnv(): void {
  try {
    const envPath = join(PROJECT_ROOT, ".env");
    const envFile = readFileSync(envPath, "utf-8");
    for (const line of envFile.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        const value = valueParts.join("=").trim();
        if (!process.env[key.trim()]) {
          process.env[key.trim()] = value;
        }
      }
    }
  } catch {
    // .env might not exist
  }
}

// ============================================================
// ENTRY POINT
// ============================================================

async function main(): Promise<void> {
  loadEnv();

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
  const dryRun = process.env.DRY_RUN === "true";

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error(
      "Missing required env vars: SUPABASE_URL and SUPABASE_ANON_KEY must be set"
    );
    process.exit(0); // graceful skip
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  const config: CleanupConfig = {
    dryRun,
    maxDeletes: 100,
    similarityThreshold: SIMILARITY_THRESHOLD,
    minContentLength: MIN_CONTENT_LENGTH,
    supabaseUrl,
    supabaseAnonKey,
  };

  console.log(
    `Starting memory dedup review (dryRun=${dryRun}, threshold=${SIMILARITY_THRESHOLD})`
  );

  // 1. Fetch active items
  const items = await fetchActiveItems(supabase);
  console.log(`Fetched ${items.length} active memory items`);

  // 2. Detect junk
  const junk = detectJunkItems(items, MIN_CONTENT_LENGTH);
  console.log(`Junk items: ${junk.length}`);

  // 3. Detect near-duplicates (skip already-flagged junk items)
  const junkIds = new Set(junk.map((j) => j.id));
  const nonJunkItems = items.filter((i) => !junkIds.has(i.id));

  const clusters = await clusterDuplicates(nonJunkItems, config, supabase);
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
  if (!validateGroup("GENERAL")) {
    console.warn("GENERAL group not configured — skipping Telegram notification");
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
      GROUPS.GENERAL.chatId,
      message,
      keyboard,
      GROUPS.GENERAL.topicId
    );
    console.log("Review message with inline keyboard sent to General group");
  } else {
    console.log("[DRY RUN] Would send to General group:");
    console.log(message);
    console.log("Keyboard:", JSON.stringify(keyboard.inline_keyboard));
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("Error running memory dedup review:", error);
  process.exit(0); // exit 0 so PM2 does not immediately restart
});
