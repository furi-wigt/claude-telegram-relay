/**
 * Routes Telegram replies and callback queries to the correct coding session.
 * Checks if an incoming message is a reply to a pending question or plan
 * modification prompt, and dispatches the answer to the appropriate session.
 */

import type { Context } from "grammy";
import type { CodingSessionManager } from "./sessionManager.ts";

/**
 * Tracks "custom answer" prompts: when user taps "Custom answer" on an inline
 * keyboard, the bot sends a new message ("Reply to THIS message with your answer").
 * We map that new message's ID to the session + toolUseId so we can route the reply.
 */
interface CustomReplyTracking {
  sessionId: string;
  toolUseId: string;
  type: "question" | "plan_modification";
  requestId?: string; // Only for plan modifications
}

export class InputRouter {
  /** Map of Telegram message IDs -> custom reply tracking info. */
  private customReplyMap = new Map<number, CustomReplyTracking>();

  /**
   * Check if a text message is a reply to a pending question/plan message.
   * Returns true if the message was handled (routed to a coding session).
   */
  async tryRouteReply(ctx: Context, sessionManager: CodingSessionManager): Promise<boolean> {
    const replyToMessageId = ctx.message?.reply_to_message?.message_id;
    if (!replyToMessageId) return false;

    const text = ctx.message?.text;
    if (!text) return false;

    // Check if this is a reply to a custom answer prompt we sent
    const customTracking = this.customReplyMap.get(replyToMessageId);
    if (customTracking) {
      this.customReplyMap.delete(replyToMessageId);

      if (customTracking.type === "question") {
        await sessionManager.answerQuestion(customTracking.sessionId, text);
      } else if (customTracking.type === "plan_modification" && customTracking.requestId) {
        await sessionManager.approvePlan(customTracking.sessionId, false, text);
      }
      return true;
    }

    // Check all sessions for a matching pending question or plan modification message
    const chatId = ctx.chat?.id;
    if (!chatId) return false;

    const sessions = await sessionManager.listAll(chatId);
    for (const session of sessions) {
      // Match against pending question message
      if (
        session.pendingQuestion &&
        session.pendingQuestion.questionMessageId === replyToMessageId
      ) {
        await sessionManager.answerQuestion(session.id, text);
        return true;
      }

      // Match against pending plan modification reply message
      if (
        session.pendingPlanApproval &&
        session.pendingPlanApproval.awaitingModificationReplyMessageId === replyToMessageId
      ) {
        await sessionManager.approvePlan(session.id, false, text);
        return true;
      }
    }

    return false;
  }

  /**
   * Handle callback queries for coding sessions.
   * Returns true if the callback was handled.
   */
  async handleCallbackQuery(ctx: Context, sessionManager: CodingSessionManager): Promise<boolean> {
    const data = ctx.callbackQuery?.data;
    if (!data) return false;

    const chatId = ctx.chat?.id;
    if (!chatId) return false;

    // Acknowledge the callback immediately to remove the loading indicator
    await ctx.answerCallbackQuery().catch(() => {});

    // code_answer:option:{sessionId}:{toolUseId}:{base64Option}
    if (data.startsWith("code_answer:option:")) {
      const parts = data.slice("code_answer:option:".length).split(":");
      if (parts.length < 3) return false;
      const sessionId = parts[0];
      const _toolUseId = parts[1];
      const base64Option = parts.slice(2).join(":"); // base64 may contain colons
      const option = Buffer.from(base64Option, "base64").toString("utf-8");

      await sessionManager.answerQuestion(sessionId, option);
      return true;
    }

    // code_answer:custom:{sessionId}:{toolUseId}
    if (data.startsWith("code_answer:custom:")) {
      const parts = data.slice("code_answer:custom:".length).split(":");
      if (parts.length < 2) return false;
      const sessionId = parts[0];
      const toolUseId = parts[1];

      const msg = await ctx.reply("\u270D\uFE0F Reply to THIS message with your answer", {
        reply_markup: { force_reply: true, selective: true },
      });

      this.customReplyMap.set(msg.message_id, {
        sessionId,
        toolUseId,
        type: "question",
      });

      return true;
    }

    // code_answer:skip:{sessionId}:{toolUseId}
    if (data.startsWith("code_answer:skip:")) {
      const parts = data.slice("code_answer:skip:".length).split(":");
      if (parts.length < 2) return false;
      const sessionId = parts[0];

      await sessionManager.answerQuestion(sessionId, "Use your best judgment and continue");
      return true;
    }

    // code_plan:approve:{sessionId}:{requestId}
    if (data.startsWith("code_plan:approve:")) {
      const parts = data.slice("code_plan:approve:".length).split(":");
      if (parts.length < 2) return false;
      const sessionId = parts[0];

      await sessionManager.approvePlan(sessionId, true);
      return true;
    }

    // code_plan:trust:{sessionId}:{requestId} -- same as approve
    if (data.startsWith("code_plan:trust:")) {
      const parts = data.slice("code_plan:trust:".length).split(":");
      if (parts.length < 2) return false;
      const sessionId = parts[0];

      await sessionManager.approvePlan(sessionId, true);
      return true;
    }

    // code_plan:modify:{sessionId}:{requestId}
    if (data.startsWith("code_plan:modify:")) {
      const parts = data.slice("code_plan:modify:".length).split(":");
      if (parts.length < 2) return false;
      const sessionId = parts[0];
      const requestId = parts[1];

      const msg = await ctx.reply("\u270F\uFE0F How should the plan be modified?\n\n\u21A9\uFE0F Reply to this message with your instructions", {
        reply_markup: { force_reply: true, selective: true },
      });

      this.customReplyMap.set(msg.message_id, {
        sessionId,
        toolUseId: "", // Not used for plan modifications
        type: "plan_modification",
        requestId,
      });

      return true;
    }

    // code_plan:cancel:{sessionId}
    if (data.startsWith("code_plan:cancel:")) {
      const parts = data.slice("code_plan:cancel:".length).split(":");
      if (parts.length < 1) return false;
      const sessionId = parts[0];

      await sessionManager.killSession(sessionId);
      await ctx.reply(`\u26D4 Session cancelled.`);
      return true;
    }

    // code_dash:status:{sessionId}
    if (data.startsWith("code_dash:status:")) {
      const sessionId = data.slice("code_dash:status:".length);
      const statusText = sessionManager.getStatusText(sessionId);
      await ctx.reply(statusText);
      return true;
    }

    // code_dash:logs:{sessionId}
    if (data.startsWith("code_dash:logs:")) {
      const sessionId = data.slice("code_dash:logs:".length);
      const logs = await sessionManager.getLogs(sessionId);
      await ctx.reply(logs);
      return true;
    }

    // code_dash:diff:{sessionId}
    if (data.startsWith("code_dash:diff:")) {
      const sessionId = data.slice("code_dash:diff:".length);
      const diff = await sessionManager.getDiff(sessionId);
      await ctx.reply(diff);
      return true;
    }

    // code_dash:stop:{sessionId}
    if (data.startsWith("code_dash:stop:")) {
      const sessionId = data.slice("code_dash:stop:".length);
      await sessionManager.killSession(sessionId);
      await ctx.reply("\u26D4 Session stopped.");
      return true;
    }

    return false;
  }
}
