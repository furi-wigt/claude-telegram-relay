/**
 * Dedup Review Callback Handler
 *
 * Handles inline keyboard callbacks from the weekly memory-dedup-review routine:
 *   mdr_yes — user confirmed; delete all candidate IDs from Supabase
 *   mdr_no  — user skipped; clear pending file, leave memory unchanged
 *
 * Architecture note:
 *   The memory-dedup-review routine runs as a separate PM2 process and cannot
 *   receive Telegram callbacks. It persists candidate IDs to ./data/pending-dedup.json.
 *   This handler (running in the main relay process) reads that file when the
 *   user taps a button, executes the deletion, then clears the file.
 */

import type { Bot } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadPendingCandidates,
  clearPendingCandidates,
} from "../../routines/memory-dedup-review.ts";

/**
 * Register the mdr_yes / mdr_no callback query handlers on the bot.
 * Must be called once during relay startup.
 */
export function registerDedupReviewCallbackHandler(
  bot: Bot,
  supabase: SupabaseClient | null
): void {
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

    if (!supabase) {
      await ctx.editMessageText("❌ Supabase not configured — cannot delete.");
      return;
    }

    try {
      const { error, count } = await supabase
        .from("memory")
        .delete({ count: "exact" })
        .in("id", pending.ids);

      await clearPendingCandidates();

      if (error) {
        console.error("dedupReviewCallback: Supabase delete error:", error);
        await ctx.editMessageText(
          "❌ Delete failed. Please try manually with /facts, /goals, /prefs."
        );
        return;
      }

      const deleted = count ?? pending.count;
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
