/**
 * Backfill Memory Script
 *
 * Populates new fields/tables added by migration 20260218120000_chat_memory.sql
 * based on existing data in the Supabase database.
 *
 * Steps:
 *   0. Show current DB state
 *   1. Backfill category column on memory table (NULL → inferred value)
 *   2. Rebuild user_profile from all categorised memories
 *   3. Summarize old messages per chat_id into conversation_summaries
 *
 * Usage:
 *   bun run scripts/backfill-memory.ts                  # full run
 *   bun run scripts/backfill-memory.ts --dry-run         # preview only
 *   bun run scripts/backfill-memory.ts --skip-summaries  # skip slow step
 *   bun run scripts/backfill-memory.ts --skip-categories --skip-profile
 */

import { createClient } from "@supabase/supabase-js";
import { rebuildProfileSummary } from "../src/memory/longTermExtractor.ts";
import { shouldSummarize, summarizeOldMessages } from "../src/memory/shortTermMemory.ts";

// ─── CLI Flags ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SKIP_CATEGORIES = args.includes("--skip-categories");
const SKIP_PROFILE = args.includes("--skip-profile");
const SKIP_SUMMARIES = args.includes("--skip-summaries");

const MAX_SUMMARY_ITERATIONS_PER_CHAT = 10;

// ─── Supabase Client ────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_ANON_KEY must be set in environment.");
  console.error("       Run: source .env  or  export $(cat .env | xargs)");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── Helpers ────────────────────────────────────────────────────────────────

function printHeader(title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

function printStep(label: string): void {
  console.log(`\n--- ${label} ---`);
}

function dryRunNote(msg: string): void {
  console.log(`  [DRY RUN] Would: ${msg}`);
}

// ─── Step 0: Current State ──────────────────────────────────────────────────

async function showCurrentState(): Promise<void> {
  printHeader("Backfill Memory: Current State");

  // Memory table stats
  const { data: memoryCategoryNull, count: nullCount } = await supabase
    .from("memory")
    .select("id", { count: "exact", head: true })
    .is("category", null);

  const { count: totalMemory } = await supabase
    .from("memory")
    .select("id", { count: "exact", head: true });

  const categorySet = (totalMemory ?? 0) - (nullCount ?? 0);

  console.log(
    `Memory rows:  ${totalMemory ?? "?"} (category=null: ${nullCount ?? "?"}, category set: ${categorySet})`
  );

  // Memory type breakdown
  const { data: typeBreakdown } = await supabase
    .from("memory")
    .select("type");

  if (typeBreakdown) {
    const typeCounts: Record<string, number> = {};
    for (const row of typeBreakdown) {
      typeCounts[(row as any).type] = (typeCounts[(row as any).type] ?? 0) + 1;
    }
    const breakdown = Object.entries(typeCounts)
      .map(([t, c]) => `${t}=${c}`)
      .join(", ");
    console.log(`              Types: ${breakdown}`);
  }

  // user_profile
  const { data: profileRows, count: profileCount } = await supabase
    .from("user_profile")
    .select("updated_at", { count: "exact" });

  const profileUpdated =
    profileRows && profileRows.length > 0
      ? new Date((profileRows[0] as any).updated_at).toLocaleString("en-SG", {
          timeZone: "Asia/Singapore",
        })
      : "never";
  console.log(`User profile: ${profileCount ?? 0} row(s) (last updated: ${profileUpdated})`);

  // conversation_summaries
  const { count: summaryCount } = await supabase
    .from("conversation_summaries")
    .select("id", { count: "exact", head: true });

  console.log(`Summaries:    ${summaryCount ?? 0} rows`);

  // messages
  const { count: totalMessages } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true });

  const { count: withChatId } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .not("chat_id", "is", null);

  console.log(
    `Messages:     ${totalMessages ?? "?"} total, ${withChatId ?? "?"} with chat_id`
  );

  // Per-chat breakdown
  const { data: chatMessages } = await supabase
    .from("messages")
    .select("chat_id")
    .not("chat_id", "is", null);

  if (chatMessages && chatMessages.length > 0) {
    const chatCounts: Record<string, number> = {};
    for (const row of chatMessages) {
      const cid = String((row as any).chat_id);
      chatCounts[cid] = (chatCounts[cid] ?? 0) + 1;
    }
    const sorted = Object.entries(chatCounts).sort((a, b) => b[1] - a[1]);
    for (const [chatId, count] of sorted) {
      console.log(`              chat_id ${chatId}: ${count} messages`);
    }
  }

  if (DRY_RUN) {
    console.log("\n[DRY RUN MODE] No changes will be written.");
  }
}

// ─── Step 1: Category Backfill ───────────────────────────────────────────────

async function backfillCategories(): Promise<void> {
  printStep("Step 1: Category Backfill");

  // Count rows that need updating
  const { count: nullCount } = await supabase
    .from("memory")
    .select("id", { count: "exact", head: true })
    .is("category", null);

  if (!nullCount || nullCount === 0) {
    console.log("  No rows with NULL category — already up to date.");
    return;
  }

  console.log(`  Found ${nullCount} memory rows with category=NULL`);

  if (DRY_RUN) {
    // Simulate what would happen by fetching data and computing categories
    const { data: rows } = await supabase
      .from("memory")
      .select("id, type, content")
      .is("category", null);

    if (rows) {
      const preview: Record<string, number> = {};
      for (const row of rows as any[]) {
        const cat = inferCategory(row.type, row.content);
        preview[cat] = (preview[cat] ?? 0) + 1;
      }
      for (const [cat, count] of Object.entries(preview)) {
        dryRunNote(`Set category='${cat}' on ${count} rows`);
      }
    }
    return;
  }

  // Use RPC to run the bulk UPDATE atomically via a raw SQL approach.
  // Supabase JS client does not support CASE in update, so we use rpc or
  // individual updates per type bucket.

  // Update 'preference' type
  const { count: prefUpdated, error: prefErr } = await supabase
    .from("memory")
    .update({ category: "preference" })
    .eq("type", "preference")
    .is("category", null)
    .select("id", { count: "exact", head: true });

  if (prefErr) console.error("  WARN: preference update error:", prefErr.message);
  else console.log(`  Updated ${prefUpdated ?? 0} preference rows → category='preference'`);

  // Update 'goal' and 'completed_goal' types
  const { count: goalUpdated, error: goalErr } = await supabase
    .from("memory")
    .update({ category: "goal" })
    .in("type", ["goal", "completed_goal"])
    .is("category", null)
    .select("id", { count: "exact", head: true });

  if (goalErr) console.error("  WARN: goal update error:", goalErr.message);
  else console.log(`  Updated ${goalUpdated ?? 0} goal/completed_goal rows → category='goal'`);

  // For 'fact' type: date heuristic first, then personal as fallback.
  // We must fetch remaining fact rows (still category=null) and categorise individually.
  const { data: factRows, error: factFetchErr } = await supabase
    .from("memory")
    .select("id, content")
    .eq("type", "fact")
    .is("category", null);

  if (factFetchErr) {
    console.error("  WARN: could not fetch fact rows:", factFetchErr.message);
    return;
  }

  if (!factRows || factRows.length === 0) {
    console.log("  No 'fact' rows with NULL category remaining.");
    return;
  }

  const dateIds: string[] = [];
  const personalIds: string[] = [];

  for (const row of factRows as any[]) {
    if (isDateContent(row.content)) {
      dateIds.push(row.id);
    } else {
      personalIds.push(row.id);
    }
  }

  if (dateIds.length > 0) {
    const { count: dateUpdated, error: dateErr } = await supabase
      .from("memory")
      .update({ category: "date" })
      .in("id", dateIds)
      .select("id", { count: "exact", head: true });

    if (dateErr) console.error("  WARN: date fact update error:", dateErr.message);
    else console.log(`  Updated ${dateUpdated ?? 0} fact rows → category='date'`);
  }

  if (personalIds.length > 0) {
    const { count: personalUpdated, error: personalErr } = await supabase
      .from("memory")
      .update({ category: "personal" })
      .in("id", personalIds)
      .select("id", { count: "exact", head: true });

    if (personalErr) console.error("  WARN: personal fact update error:", personalErr.message);
    else console.log(`  Updated ${personalUpdated ?? 0} fact rows → category='personal'`);
  }

  // Verify
  const { count: remaining } = await supabase
    .from("memory")
    .select("id", { count: "exact", head: true })
    .is("category", null);

  console.log(`  Category backfill complete. Remaining NULL: ${remaining ?? 0}`);
}

/**
 * Date heuristic: matches year patterns (20XX) or common date-related words.
 */
function isDateContent(content: string): boolean {
  if (!content) return false;
  const lower = content.toLowerCase();
  return /\b20[0-9]{2}\b/.test(content) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(lower) ||
    /\b(deadline|due date|due by|birthday|anniversary|scheduled for|expires?|by \w+ \d)\b/.test(lower);
}

/**
 * Infer category from type and content (used for dry-run preview).
 */
function inferCategory(type: string, content: string): string {
  if (type === "preference") return "preference";
  if (type === "goal" || type === "completed_goal") return "goal";
  if (type === "fact") return isDateContent(content) ? "date" : "personal";
  return "personal";
}

// ─── Step 2: Rebuild User Profile ───────────────────────────────────────────

async function backfillProfile(): Promise<void> {
  printStep("Step 2: Rebuild User Profile");

  const userId = parseInt(process.env.TELEGRAM_USER_ID ?? "0", 10);
  if (!userId) {
    console.log("  Skipped — TELEGRAM_USER_ID not set or zero.");
    return;
  }

  console.log(`  Rebuilding profile for user_id=${userId}...`);

  if (DRY_RUN) {
    dryRunNote(`Call rebuildProfileSummary(supabase, ${userId})`);
    return;
  }

  try {
    await rebuildProfileSummary(supabase, userId);
    console.log("  User profile refreshed successfully.");
  } catch (err: any) {
    console.error("  ERROR rebuilding profile:", err?.message ?? err);
  }
}

// ─── Step 3: Summarize Old Messages ─────────────────────────────────────────

async function backfillSummaries(): Promise<void> {
  printStep("Step 3: Summarize Old Messages Per Chat");

  // Find all distinct chat_ids with more than 20 messages
  const { data: chatRows, error: chatErr } = await supabase
    .from("messages")
    .select("chat_id")
    .not("chat_id", "is", null);

  if (chatErr || !chatRows) {
    console.error("  ERROR fetching chat_ids:", chatErr?.message);
    return;
  }

  // Aggregate counts in JS
  const chatCounts: Record<string, number> = {};
  for (const row of chatRows as any[]) {
    const cid = String(row.chat_id);
    chatCounts[cid] = (chatCounts[cid] ?? 0) + 1;
  }

  const eligibleChats = Object.entries(chatCounts)
    .filter(([, count]) => count > 20)
    .sort((a, b) => b[1] - a[1]); // largest first

  if (eligibleChats.length === 0) {
    console.log("  No chats with >20 messages found. Nothing to summarize.");
    return;
  }

  console.log(`  Found ${eligibleChats.length} chat(s) eligible for summarization:`);
  for (const [chatId, count] of eligibleChats) {
    console.log(`    chat_id ${chatId}: ${count} messages`);
  }

  if (DRY_RUN) {
    for (const [chatId] of eligibleChats) {
      dryRunNote(`Summarize old messages for chat_id=${chatId} (iterative chunks)`);
    }
    return;
  }

  for (const [chatIdStr] of eligibleChats) {
    const chatId = parseInt(chatIdStr, 10);
    console.log(`\n  Processing chat_id=${chatId}...`);

    let iteration = 0;
    while (iteration < MAX_SUMMARY_ITERATIONS_PER_CHAT) {
      const needsMore = await shouldSummarize(supabase, chatId);
      if (!needsMore) {
        console.log(`    Done — no more chunks to summarize (after ${iteration} iteration(s)).`);
        break;
      }

      iteration++;
      console.log(`    Summarizing chunk ${iteration}/${MAX_SUMMARY_ITERATIONS_PER_CHAT}...`);

      try {
        await summarizeOldMessages(supabase, chatId);
        console.log(`    Chunk ${iteration} stored.`);
      } catch (err: any) {
        console.error(`    ERROR on chunk ${iteration}:`, err?.message ?? err);
        console.log(`    Stopping summarization for chat_id=${chatId} due to error.`);
        break;
      }
    }

    if (iteration >= MAX_SUMMARY_ITERATIONS_PER_CHAT) {
      console.log(
        `    Safety limit reached (${MAX_SUMMARY_ITERATIONS_PER_CHAT} iterations). ` +
        `Re-run to continue.`
      );
    }
  }
}

// ─── Final State ─────────────────────────────────────────────────────────────

async function showFinalState(): Promise<void> {
  printHeader("Backfill Complete: Final State");

  const { count: totalMemory } = await supabase
    .from("memory")
    .select("id", { count: "exact", head: true });

  const { count: nullCount } = await supabase
    .from("memory")
    .select("id", { count: "exact", head: true })
    .is("category", null);

  const { data: categoryBreakdown } = await supabase
    .from("memory")
    .select("category");

  const catCounts: Record<string, number> = {};
  for (const row of (categoryBreakdown ?? []) as any[]) {
    const cat = row.category ?? "null";
    catCounts[cat] = (catCounts[cat] ?? 0) + 1;
  }

  const breakdown = Object.entries(catCounts)
    .map(([c, n]) => `${c}=${n}`)
    .join(", ");

  console.log(`Memory rows:  ${totalMemory ?? "?"} (category=null: ${nullCount ?? "?"}) [${breakdown}]`);

  const { data: profileRows } = await supabase
    .from("user_profile")
    .select("updated_at")
    .limit(1);

  const profileUpdated =
    profileRows && profileRows.length > 0
      ? new Date((profileRows[0] as any).updated_at).toLocaleString("en-SG", {
          timeZone: "Asia/Singapore",
        })
      : "none";

  console.log(`User profile: last updated ${profileUpdated}`);

  const { count: summaryCount } = await supabase
    .from("conversation_summaries")
    .select("id", { count: "exact", head: true });

  console.log(`Summaries:    ${summaryCount ?? 0} rows`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await showCurrentState();

  if (!SKIP_CATEGORIES) {
    await backfillCategories();
  } else {
    console.log("\n[SKIPPED] Step 1: Category backfill (--skip-categories)");
  }

  if (!SKIP_PROFILE) {
    await backfillProfile();
  } else {
    console.log("\n[SKIPPED] Step 2: User profile rebuild (--skip-profile)");
  }

  if (!SKIP_SUMMARIES) {
    await backfillSummaries();
  } else {
    console.log("\n[SKIPPED] Step 3: Message summarization (--skip-summaries)");
  }

  await showFinalState();

  if (DRY_RUN) {
    console.log("\n[DRY RUN] No changes were written. Re-run without --dry-run to apply.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
