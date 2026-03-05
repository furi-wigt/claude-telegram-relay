/**
 * reportHandler.ts — Entry points called from relay.ts
 *
 * handleReportText  — returns true if text was consumed by the report workflow
 * handleReportCallback — returns true if callback data was consumed (rpt: prefix)
 */

import type { Bot, Context } from "grammy";
import { detectReportTrigger } from "./reportInterviewer.ts";
import {
  getReportSession,
  hasReportSession,
} from "./reportState.ts";
import {
  startReportWorkflow,
  advanceInterview,
  handleInterviewCallback,
  handleMoreSourcesCallback,
  handleMoreSourcesFreeText,
  handleReviewCallback,
  handleReviewFreeText,
  handleAssetCallback,
  handleConfirmCallback,
} from "./reportWorkflow.ts";

/**
 * Called at Priority 4 (after interactive.handleFreeText, before Claude queue).
 * Returns true if the text was consumed — relay must return immediately.
 */
export async function handleReportText(
  bot: Bot,
  chatId: number,
  text: string
): Promise<boolean> {
  // 1. Trigger detection — no active session needed
  const topic = detectReportTrigger(text);
  if (topic) {
    await startReportWorkflow(bot, chatId, topic);
    return true;
  }

  // 2. Active session routing
  if (!hasReportSession(chatId)) return false;

  const state = getReportSession(chatId)!;

  switch (state.step) {
    case "interviewing":
      await advanceInterview(bot, chatId, text);
      return true;

    case "awaiting_more_sources":
      await handleMoreSourcesFreeText(bot, chatId, text);
      return true;

    case "reviewing":
      await handleReviewFreeText(bot, chatId, text);
      return true;

    default:
      // Other steps are keyboard-driven; free text is ignored
      return false;
  }
}

/**
 * Called in the callback_query handler for callbacks starting with "rpt:".
 * Returns true if the callback was consumed — relay must return immediately.
 */
export async function handleReportCallback(
  bot: Bot,
  ctx: Context,
  chatId: number,
  data: string
): Promise<boolean> {
  if (!data.startsWith("rpt:")) return false;

  await ctx.answerCallbackQuery().catch(() => undefined);

  if (!hasReportSession(chatId)) {
    console.warn(`[report] rpt: callback with no active session — chatId=${chatId} data=${data}`);
    return true; // consumed but stale; don't fall through
  }

  const parts = data.split(":");
  const section = parts[1]; // audience | daterange | project | more | review | assets | confirm | skip | slug

  switch (section) {
    case "audience":
    case "daterange":
    case "project":
    case "skip":
    case "slug":
      return await handleInterviewCallback(bot, chatId, data);

    case "more":
      return await handleMoreSourcesCallback(bot, chatId, data);

    case "review":
      return await handleReviewCallback(bot, chatId, data);

    case "assets":
      return await handleAssetCallback(bot, chatId, data);

    case "confirm":
      return await handleConfirmCallback(bot, chatId, data);

    default:
      console.warn(`[report] unknown rpt: section="${section}" data=${data}`);
      return true; // consumed (prevent fall-through to other handlers)
  }
}
