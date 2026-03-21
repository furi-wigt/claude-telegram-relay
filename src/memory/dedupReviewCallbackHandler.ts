/**
 * Dedup Review Callback Handler
 *
 * Handles inline keyboard callbacks from the weekly memory-dedup-review routine:
 *   mdr_yes — user confirmed; delete all candidate IDs from SQLite + Qdrant
 *   mdr_no  — user skipped; clear pending file, leave memory unchanged
 *
 * Architecture note:
 *   The memory-dedup-review routine runs as a separate PM2 process and cannot
 *   receive Telegram callbacks. It persists candidate IDs to ./data/pending-dedup.json.
 *   This handler (running in the main relay process) reads that file when the
 *   user taps a button, executes the deletion, then clears the file.
 */

import type { Bot } from "grammy";
import { getDb } from "../local/db.ts";
import { deletePoints } from "../local/vectorStore.ts";
import {
  loadPendingCandidates,
  clearPendingCandidates,
} from "./pendingDedup.ts";

/**
 * Register the mdr_yes / mdr_no callback query handlers on the bot.
 * Must be called once during relay startup.
 */
export function registerDedupReviewCallbackHandler(bot: Bot): void {
  // ── Confirm: delete all candidates ────────────────────────────────────────
  bot.callbackQuery("mdr_yes", async (ctx) => {
    await ctx.answerCallbackQuery(); // acknowledge immediately to prevent timeout

    const pending = await loadPendingCandidates();

    if (!pending) {
      await ctx.editMessageText(
        "⏰ This review has expired (>24h). The next review runs on Friday at 4 PM."
      );
      return;
    }

    try {
      const db = getDb();
      const placeholders = pending.ids.map(() => "?").join(", ");

      // Use BEGIN IMMEDIATE to ensure the write transaction sees all committed
      // WAL data before executing — prevents stale-snapshot 0-changes on a
      // long-running relay connection.
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`DELETE FROM memory WHERE id IN (${placeholders})`).run(...pending.ids);
        db.exec("COMMIT");
      } catch (txErr) {
        db.exec("ROLLBACK");
        throw txErr;
      }

      // Verify actual deletion count — don't trust .changes on long-lived connections
      const remaining = (
        db.prepare(`SELECT COUNT(*) as n FROM memory WHERE id IN (${placeholders})`).get(...pending.ids) as { n: number }
      ).n;
      const deleted = pending.ids.length - remaining;

      console.log(
        `dedupReviewCallback: ids=${pending.ids.join(",")}, deleted=${deleted}, remaining=${remaining}`
      );

      // Also remove from Qdrant (non-fatal if Qdrant is down)
      try {
        await deletePoints("memory", pending.ids);
      } catch (qdrantErr) {
        console.warn(
          "dedupReviewCallback: Qdrant deletePoints failed (non-fatal):",
          qdrantErr instanceof Error ? qdrantErr.message : qdrantErr
        );
      }

      await clearPendingCandidates();

      await ctx.editMessageText(
        `✅ Memory cleaned! Deleted ${deleted} item${deleted !== 1 ? "s" : ""} (${pending.summary}).`
      );

      console.log(
        `dedupReviewCallback: Deleted ${deleted} items via mdr_yes (${pending.summary})`
      );
    } catch (err) {
      console.error("dedupReviewCallback: Unexpected error:", err);
      await ctx.editMessageText("❌ Unexpected error. Please try again.");
    }
  });

  // ── Skip: clear pending file, leave memory unchanged ──────────────────────
  bot.callbackQuery("mdr_no", async (ctx) => {
    await ctx.answerCallbackQuery();
    await clearPendingCandidates();
    await ctx.editMessageText("⏭️ Skipped. Memory left unchanged.");
    console.log("dedupReviewCallback: User skipped dedup review (mdr_no)");
  });
}
