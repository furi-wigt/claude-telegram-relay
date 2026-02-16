/**
 * Schedules and manages 15-minute reminders for coding sessions
 * waiting on user input or plan approval.
 */

import type { Bot } from "grammy";
import type { CodingSession } from "./types.ts";

const DEFAULT_DELAY_MS = 900_000; // 15 minutes

export class ReminderManager {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Schedule a reminder for a waiting session.
   * After delayMs, sends a message to Telegram with the question and inline keyboard.
   */
  scheduleReminder(session: CodingSession, bot: Bot, delayMs = DEFAULT_DELAY_MS): void {
    // Cancel any existing reminder for this session
    this.cancelReminder(session.id);

    const timerId = setTimeout(async () => {
      this.timers.delete(session.id);

      try {
        if (session.pendingQuestion && !session.pendingQuestion.reminderSentAt) {
          await this.sendQuestionReminder(session, bot);
        } else if (session.pendingPlanApproval && !session.pendingPlanApproval.reminderSentAt) {
          await this.sendPlanReminder(session, bot);
        }
      } catch {
        // Reminder send failed -- session may have ended
      }
    }, delayMs);

    this.timers.set(session.id, timerId);
  }

  /** Cancel a pending reminder for a session. */
  cancelReminder(sessionId: string): void {
    const existing = this.timers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(sessionId);
    }
  }

  /** Cancel all pending reminders. */
  cancelAll(): void {
    for (const timerId of this.timers.values()) {
      clearTimeout(timerId);
    }
    this.timers.clear();
  }

  private async sendQuestionReminder(session: CodingSession, bot: Bot): Promise<void> {
    const q = session.pendingQuestion;
    if (!q) return;

    const keyboard: { text: string; callback_data: string }[][] = [];

    // Add option buttons if available
    if (q.options && q.options.length > 0) {
      const optionRow = q.options.map((opt) => ({
        text: opt,
        callback_data: `code_answer:option:${session.id}:${q.toolUseId}:${Buffer.from(opt).toString("base64")}`,
      }));
      keyboard.push(optionRow);
    }

    // Always add custom + claude-decides row
    keyboard.push([
      {
        text: "\u270D\uFE0F Custom answer",
        callback_data: `code_answer:custom:${session.id}:${q.toolUseId}`,
      },
      {
        text: "\u{1F916} Claude decides",
        callback_data: `code_answer:skip:${session.id}:${q.toolUseId}`,
      },
    ]);

    const result = await bot.api.sendMessage(
      session.chatId,
      `\u23F0 Reminder \u2014 ${session.projectName} is still waiting\n\nClaude asked 15 min ago:\n"${q.questionText}"\n\n\u21A9\uFE0F Reply to this message with a custom answer`,
      { reply_markup: { inline_keyboard: keyboard } }
    );

    // Mark reminder as sent
    q.reminderSentAt = new Date().toISOString();

    // Store the reminder message ID so InputRouter can track it
    session.pendingQuestion = { ...q, reminderSentAt: q.reminderSentAt };

    // Return the message ID for InputRouter tracking (caller should handle)
    return void result.message_id;
  }

  private async sendPlanReminder(session: CodingSession, bot: Bot): Promise<void> {
    const plan = session.pendingPlanApproval;
    if (!plan) return;

    const planPreview = plan.planText.length > 200
      ? plan.planText.slice(0, 200) + "..."
      : plan.planText;

    const keyboard = [
      [
        { text: "\u2705 Approve", callback_data: `code_plan:approve:${session.id}:${plan.requestId}` },
        { text: "\u270F\uFE0F Modify", callback_data: `code_plan:modify:${session.id}:${plan.requestId}` },
      ],
      [
        { text: "\u274C Cancel", callback_data: `code_plan:cancel:${session.id}:${plan.requestId}` },
        { text: "\u{1F916} Trust Claude", callback_data: `code_plan:trust:${session.id}:${plan.requestId}` },
      ],
    ];

    const result = await bot.api.sendMessage(
      session.chatId,
      `\u23F0 Reminder \u2014 ${session.projectName} needs plan approval\n\nClaude proposed 15 min ago:\n${planPreview}\n\n\u21A9\uFE0F Reply to this message with modifications`,
      { reply_markup: { inline_keyboard: keyboard } }
    );

    plan.reminderSentAt = new Date().toISOString();
    session.pendingPlanApproval = { ...plan, reminderSentAt: plan.reminderSentAt };

    return void result.message_id;
  }
}
