/**
 * Conflict Resolution Callback Handler
 *
 * Handles inline keyboard callbacks from `/memory dedup`:
 *   mcr_keep:<clusterIndex>  — keep newest entry in cluster, archive rest
 *   mcr_all:<clusterIndex>   — keep all entries in cluster (skip)
 *   mcr_skip                 — skip all conflict resolution
 */

import type { Bot } from "grammy";
import { loadPendingConflicts, clearPendingConflicts } from "./pendingConflict.ts";
import { resolveConflicts } from "./conflictResolver.ts";

export function registerConflictCallbackHandler(
  bot: Bot
): void {
  // Keep newest in a specific cluster
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("mcr_keep:")) return next();

    await ctx.answerCallbackQuery();

    const clusterIdx = parseInt(data.split(":")[1], 10);
    const pending = await loadPendingConflicts();

    if (!pending) {
      await ctx.editMessageText("⏰ This review has expired. Run /memory dedup again.");
      return;
    }

    const cluster = pending.clusters[clusterIdx];
    if (!cluster) {
      await ctx.editMessageText("❌ Cluster not found.");
      return;
    }

    try {
      // Keep the newest entry (first in list since ordered by created_at desc)
      const newest = cluster.entries[0];
      const result = await resolveConflicts([cluster], [newest.id]);
      await ctx.editMessageText(
        `✅ Kept "${newest.content.substring(0, 60)}…"\nArchived ${result.archived} conflicting entr${result.archived === 1 ? "y" : "ies"}.`
      );

      // Remove resolved cluster from pending
      pending.clusters.splice(clusterIdx, 1);
      if (pending.clusters.length === 0) {
        await clearPendingConflicts();
      }
    } catch (err) {
      console.error("[conflictCallback] resolve error:", err);
      await ctx.editMessageText("❌ Failed to resolve conflict. Try again.");
    }
  });

  // Keep all entries in a cluster (skip)
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("mcr_all:")) return next();

    await ctx.answerCallbackQuery();

    const clusterIdx = parseInt(data.split(":")[1], 10);
    const pending = await loadPendingConflicts();

    if (!pending) {
      await ctx.editMessageText("⏰ This review has expired. Run /memory dedup again.");
      return;
    }

    await ctx.editMessageText("⏭️ Kept all entries in this group.");

    pending.clusters.splice(clusterIdx, 1);
    if (pending.clusters.length === 0) {
      await clearPendingConflicts();
    }
  });

  // Skip all
  bot.callbackQuery("mcr_skip", async (ctx) => {
    await ctx.answerCallbackQuery();
    await clearPendingConflicts();
    await ctx.editMessageText("⏭️ Skipped conflict resolution. All memories unchanged.");
  });
}
