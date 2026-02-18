/**
 * Question Dashboard
 *
 * Creates and edits a single Telegram card message that progresses through
 * the Q&A lifecycle: loading → question(s) → summary → done.
 *
 * Mirrors the DashboardManager pattern from src/coding/dashboardManager.ts —
 * one pinned card per session, edited in-place via editMessageText.
 *
 * Callback data prefix: "iq:"  (≤ 64 bytes per Telegram limit)
 *
 *   iq:a:{qIdx}:{oIdx}   — select option oIdx for question qIdx
 *   iq:back              — go to previous question
 *   iq:edit              — open "edit which question?" menu
 *   iq:eq:{qIdx}         — jump back to question qIdx
 *   iq:confirm           — confirm plan, spawn Claude
 *   iq:cancel            — cancel session
 */

import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { InteractiveSession, Question } from "./types.ts";

const DIVIDER = "\u2501".repeat(20);
const THIN_DIVIDER = "\u2500".repeat(21);

export class QuestionDashboard {
  constructor(private bot: Bot) {}

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  /** Send the initial "generating questions..." card. Returns message_id. */
  async createLoadingCard(chatId: number, task: string): Promise<number> {
    const text = this.formatLoading(task);
    const msg = await this.bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
    return msg.message_id;
  }

  /** Edit the card to show the current question. */
  async showQuestion(session: InteractiveSession): Promise<void> {
    if (!session.cardMessageId) return;
    const text = this.formatQuestion(session);
    const keyboard = this.buildQuestionKeyboard(session);
    await this.editCard(session.chatId, session.cardMessageId, text, keyboard);
  }

  /** Edit the card to show the summary with Confirm / Edit buttons. */
  async showSummary(session: InteractiveSession, planPath: string): Promise<void> {
    if (!session.cardMessageId) return;
    const text = this.formatSummary(session, planPath);
    const keyboard = this.buildSummaryKeyboard();
    await this.editCard(session.chatId, session.cardMessageId, text, keyboard);
  }

  /** Edit the card to show the "pick a question to edit" menu. */
  async showEditMenu(session: InteractiveSession): Promise<void> {
    if (!session.cardMessageId) return;
    const text = this.formatEditMenu(session);
    const keyboard = this.buildEditMenuKeyboard(session);
    await this.editCard(session.chatId, session.cardMessageId, text, keyboard);
  }

  /** Edit the card to show a "checking for follow-up questions" loading state. */
  async showRoundLoading(session: InteractiveSession, round: number): Promise<void> {
    if (!session.cardMessageId) return;
    const text =
      `\u{1F4CB} *plan: ${escapeMarkdown(session.task)}*\n` +
      DIVIDER +
      `\n\n\u23F3 Round ${round} complete. Checking for follow-up questions\u2026`;
    await this.editCard(session.chatId, session.cardMessageId, text, new InlineKeyboard());
  }

  /** Edit the card to "launching Claude…" and remove buttons. */
  async showExecuting(session: InteractiveSession): Promise<void> {
    if (!session.cardMessageId) return;
    const text =
      `\u{1F680} *Launching Claude...*\n` +
      DIVIDER +
      `\n\n\u{1F4CB} Task: ${session.task}\n\n` +
      `Questions answered: ${session.questions.length}\n` +
      `Plan saved \u2713`;
    await this.editCard(session.chatId, session.cardMessageId, text, new InlineKeyboard());
  }

  /** Edit the card to show a cancellation message and remove buttons. */
  async showCancelled(session: InteractiveSession): Promise<void> {
    if (!session.cardMessageId) return;
    const text =
      `\u274C *Planning cancelled*\n` +
      DIVIDER +
      `\n\n_Task: ${session.task}_`;
    await this.editCard(session.chatId, session.cardMessageId, text, new InlineKeyboard());
  }

  // ──────────────────────────────────────────────
  // Text formatters
  // ──────────────────────────────────────────────

  formatLoading(task: string): string {
    return (
      `\u{1F4CB} *plan: ${escapeMarkdown(task)}*\n` +
      DIVIDER +
      `\n\n\u23F3 Generating questions\u2026`
    );
  }

  formatQuestion(session: InteractiveSession): string {
    const { questions, answers, currentIndex, task } = session;
    const q = questions[currentIndex];
    const total = questions.length;
    const progress = buildProgressBar(currentIndex, total);

    // Previous answers shown below the question
    const prevAnswers = answers
      .slice(0, currentIndex)
      .map((a, i) => `\u2705 Q${i + 1}: ${shortText(questions[i].question)} \u2192 ${a ?? "\u2014"}`)
      .join("\n");

    let text =
      `\u{1F4CB} *plan: ${escapeMarkdown(task)}*\n` +
      DIVIDER +
      `\n\n\u2699\uFE0F Q${currentIndex + 1} of ${total}   ${progress}\n\n` +
      `*${escapeMarkdown(q.question)}*`;

    if (prevAnswers) {
      text += `\n\n${prevAnswers}`;
    }

    if (q.allowFreeText) {
      text += `\n\n_\u270D\uFE0F Type a custom answer or tap a button_`;
    }

    return text;
  }

  formatSummary(session: InteractiveSession, planPath: string): string {
    const { questions, answers, task, sessionId } = session;
    const shortId = sessionId.slice(0, 11);

    const lines = questions.map(
      (q, i) =>
        `Q${i + 1}: ${shortText(q.question)} \u2192 *${escapeMarkdown(answers[i] ?? "\u2014")}*`
    );

    return (
      `\u2705 *Plan Ready*\n` +
      DIVIDER +
      `\n\n\u{1F4CB} *${escapeMarkdown(task)}*\n\n` +
      lines.join("\n") +
      `\n\n\u{1F4C1} \`${planPath}\`` +
      `\n\n${THIN_DIVIDER}\n` +
      `\u{1F194} ${shortId}`
    );
  }

  formatEditMenu(session: InteractiveSession): string {
    const { questions, answers } = session;
    const lines = questions.map(
      (q, i) =>
        `${i + 1}. ${shortText(q.question)} \u2192 *${escapeMarkdown(answers[i] ?? "\u2014")}*`
    );

    return (
      `\u270F\uFE0F *Edit an answer*\n` +
      DIVIDER +
      `\n\nTap a question to change your answer:\n\n` +
      lines.join("\n")
    );
  }

  // ──────────────────────────────────────────────
  // Keyboard builders
  // ──────────────────────────────────────────────

  buildQuestionKeyboard(session: InteractiveSession): InlineKeyboard {
    const { questions, currentIndex } = session;
    const q = questions[currentIndex];
    const kb = new InlineKeyboard();

    // Options — max 2 per row to fit label text
    for (let i = 0; i < q.options.length; i += 2) {
      const opt1 = q.options[i];
      kb.text(opt1.label, `iq:a:${currentIndex}:${i}`);
      if (q.options[i + 1]) {
        const opt2 = q.options[i + 1];
        kb.text(opt2.label, `iq:a:${currentIndex}:${i + 1}`);
      }
      kb.row();
    }

    // Nav row
    const navRow = new InlineKeyboard();
    if (currentIndex > 0) navRow.text("\u2190 Back", "iq:back");
    navRow.text("\u2716 Cancel", "iq:cancel");
    kb.append(navRow);

    return kb;
  }

  buildSummaryKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text("\u2705 Confirm & Start", "iq:confirm")
      .text("\u270F\uFE0F Edit", "iq:edit");
  }

  buildEditMenuKeyboard(session: InteractiveSession): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (let i = 0; i < session.questions.length; i++) {
      const q = session.questions[i];
      kb.text(`Q${i + 1}: ${shortText(q.question, 20)}`, `iq:eq:${i}`).row();
    }
    kb.text("\u2190 Back to summary", "iq:edit_cancel");
    return kb;
  }

  // ──────────────────────────────────────────────
  // Internal helper
  // ──────────────────────────────────────────────

  private async editCard(
    chatId: number,
    messageId: number,
    text: string,
    keyboard: InlineKeyboard
  ): Promise<void> {
    try {
      await this.bot.api.editMessageText(chatId, messageId, text, {
        reply_markup: keyboard,
        parse_mode: "Markdown",
      });
    } catch {
      // Telegram ignores edits with identical content — safe to swallow
    }
  }
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function buildProgressBar(current: number, total: number): string {
  const pct = total === 0 ? 0 : Math.round((current / total) * 10);
  const filled = "\u2593".repeat(pct);       // ▓
  const empty = "\u2591".repeat(10 - pct);   // ░
  return `${filled}${empty}  ${total === 0 ? 0 : Math.round((current / total) * 100)}%`;
}

/** Trim question text for compact display in prev-answers list */
function shortText(text: string, maxLen = 30): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

/** Escape Markdown special characters for Telegram parse_mode: "Markdown" */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}
