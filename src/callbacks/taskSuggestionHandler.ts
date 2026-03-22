/**
 * Task Suggestion Callback Handler
 *
 * Handles inline keyboard callbacks from routine-generated task suggestions.
 * When a routine suggests atomic tasks, users can tap buttons to add them to Things 3.
 *
 * Callback data format:
 *   ts:all:{sessionId}    — add all suggested tasks
 *   ts:skip:{sessionId}   — dismiss suggestions
 *
 * Task data is stored in a short-lived in-memory cache keyed by sessionId.
 * Sessions expire after 1 hour (routines are ephemeral, user acts quickly).
 */

import type { Bot, Context } from "grammy";
import { addTasksViaURL } from "../../integrations/things/url-scheme.ts";
import type { NewThingsTask } from "../../integrations/things/types.ts";

interface TaskSession {
  tasks: NewThingsTask[];
  createdAt: number;
}

// In-memory cache — routines create sessions, callbacks consume them
const sessions = new Map<string, TaskSession>();
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Generate a short unique session ID */
function generateSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Store tasks for a session. Called by routines after generating suggestions.
 * Returns the sessionId to embed in callback_data.
 */
export function storeTaskSession(tasks: NewThingsTask[]): string {
  // Cleanup expired sessions
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }

  const sessionId = generateSessionId();
  sessions.set(sessionId, { tasks, createdAt: now });
  return sessionId;
}

/**
 * Build the inline keyboard JSON for Telegram API (raw format, not Grammy).
 * Used by routines that send via sendToGroup (not ctx.reply).
 */
export function buildTaskKeyboardJSON(sessionId: string): unknown {
  return {
    inline_keyboard: [
      [
        { text: "✅ Add All to Things 3", callback_data: `ts:all:${sessionId}` },
        { text: "❌ Skip", callback_data: `ts:skip:${sessionId}` },
      ],
    ],
  };
}

/**
 * Register callback handlers on the bot instance.
 * Called once at startup in relay.ts.
 */
export function registerTaskSuggestionHandler(bot: Bot<Context>): void {
  bot.callbackQuery(/^ts:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(":");
    if (parts.length < 3) {
      await ctx.answerCallbackQuery({ text: "Invalid callback" });
      return;
    }

    const action = parts[1]; // "all" or "skip"
    const sessionId = parts[2];

    const session = sessions.get(sessionId);

    if (!session) {
      await ctx.answerCallbackQuery({ text: "⏰ Session expired — run the routine again" });
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch { /* message may have been deleted */ }
      return;
    }

    if (action === "skip") {
      sessions.delete(sessionId);
      await ctx.answerCallbackQuery({ text: "Skipped" });
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch { /* ignore */ }
      return;
    }

    if (action === "all") {
      const tasks = session.tasks;
      try {
        await addTasksViaURL(tasks);
        sessions.delete(sessionId);
        await ctx.answerCallbackQuery({ text: `✅ Added ${tasks.length} tasks to Things 3` });
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        } catch { /* ignore */ }
      } catch (err) {
        console.error("[taskSuggestionHandler] Failed to add tasks:", err);
        await ctx.answerCallbackQuery({ text: "❌ Failed to add tasks — is Things 3 running?" });
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: "Unknown action" });
  });

  console.log("[taskSuggestionHandler] Registered ts:* callback handler");
}
