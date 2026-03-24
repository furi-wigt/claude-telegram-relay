/**
 * Report QA Dashboard
 *
 * Renders Telegram inline keyboard cards for the QA session.
 * Single pinned card edited in-place via editMessageText.
 *
 * Callback data prefix: "rpq:" (report QA)
 *   rpq:sub:{chatId}:{tid}  — Submit answer
 *   rpq:skp:{chatId}:{tid}  — Skip question
 *   rpq:udo:{chatId}:{tid}  — Undo last exchange
 *   rpq:pau:{chatId}:{tid}  — Pause session
 *   rpq:end:{chatId}:{tid}  — End session
 *   rpq:prv:{chatId}:{tid}  — Preview answer buffer
 */

import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { ReportQASession } from "./types.ts";
import { RPQ_ACTIONS } from "./types.ts";

const DIVIDER = "\u2501".repeat(20);

// ── Public API ───────────────────────────────────────────────────────────────

export class ReportQADashboard {
  constructor(private bot: Bot) {}

  /** Send the initial "starting QA..." card. Returns message_id. */
  async createLoadingCard(chatId: number, slug: string, threadId: number | null): Promise<number> {
    const text = formatLoading(slug);
    const msg = await this.bot.api.sendMessage(chatId, text, {
      parse_mode: "MarkdownV2",
      ...(threadId != null && { message_thread_id: threadId }),
    });
    return msg.message_id;
  }

  /** Edit the card to show a question with action buttons. */
  async showQuestion(session: ReportQASession): Promise<void> {
    if (!session.cardMessageId) return;
    const text = formatQuestion(session);
    const keyboard = buildQuestionKeyboard(session);
    await this.editCard(session.chatId, session.cardMessageId, text, keyboard);
  }

  /** Edit the card to show "generating question..." loading state. */
  async showGenerating(session: ReportQASession): Promise<void> {
    if (!session.cardMessageId) return;
    const text =
      `\u{1F4DD} *Report QA: ${esc(session.slug)}*\n` +
      DIVIDER +
      `\n\n\u23F3 _Generating next question\u2026_`;
    await this.editCard(session.chatId, session.cardMessageId, text, new InlineKeyboard());
  }

  /** Edit the card to show answer buffer preview. */
  async showPreview(session: ReportQASession): Promise<void> {
    if (!session.cardMessageId) return;
    const bufferText = session.answerBuffer.length > 0
      ? session.answerBuffer.map((m, i) => `${i + 1}\\. ${esc(truncate(m, 200))}`).join("\n")
      : "_\\(empty\\)_";

    const text =
      `\u{1F4DD} *Report QA: ${esc(session.slug)}*\n` +
      DIVIDER +
      `\n\n\u{1F4CB} *Answer buffer* \\(${session.answerBuffer.length} parts\\):\n\n` +
      bufferText;

    const keyboard = buildQuestionKeyboard(session);
    await this.editCard(session.chatId, session.cardMessageId, text, keyboard);
  }

  /** Edit the card to show paused state. */
  async showPaused(session: ReportQASession): Promise<void> {
    if (!session.cardMessageId) return;
    const text =
      `\u23F8 *QA Paused: ${esc(session.slug)}*\n` +
      DIVIDER +
      `\n\n${session.exchanges.length} exchanges saved\\.\n` +
      `Normal chat mode restored\\.\n\n` +
      `_Resume: /report qa resume_`;
    await this.editCard(session.chatId, session.cardMessageId, text, new InlineKeyboard());
  }

  /** Edit the card to show "generating findings..." state. */
  async showEnding(session: ReportQASession): Promise<void> {
    if (!session.cardMessageId) return;
    const text =
      `\u{1F4DD} *Report QA: ${esc(session.slug)}*\n` +
      DIVIDER +
      `\n\n\u2705 QA complete \\u2014 ${session.exchanges.length} exchanges\\.\n` +
      `\u23F3 _Generating findings summary\u2026_`;
    await this.editCard(session.chatId, session.cardMessageId, text, new InlineKeyboard());
  }

  /** Edit the card to show completion. */
  async showDone(session: ReportQASession): Promise<void> {
    if (!session.cardMessageId) return;
    const text =
      `\u2705 *QA Complete: ${esc(session.slug)}*\n` +
      DIVIDER +
      `\n\n${session.exchanges.length} exchanges saved\\.\n` +
      `Findings generated\\.\n\n` +
      `_Run /report generate ${esc(session.slug)} when ready\\._`;
    await this.editCard(session.chatId, session.cardMessageId, text, new InlineKeyboard());
  }

  /** Send a standalone message (not the card). */
  async sendMessage(chatId: number, text: string, threadId: number | null): Promise<void> {
    await this.bot.api.sendMessage(chatId, text, {
      ...(threadId != null && { message_thread_id: threadId }),
    });
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async editCard(
    chatId: number,
    messageId: number,
    text: string,
    keyboard: InlineKeyboard
  ): Promise<void> {
    try {
      await this.bot.api.editMessageText(chatId, messageId, text, {
        reply_markup: keyboard,
        parse_mode: "MarkdownV2",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("message is not modified")) {
        console.error("[report-qa] editCard failed:", msg);
      }
    }
  }
}

// ── Formatters ───────────────────────────────────────────────────────────────

function formatLoading(slug: string): string {
  return (
    `\u{1F4DD} *Report QA: ${esc(slug)}*\n` +
    DIVIDER +
    `\n\n\u23F3 Starting QA session\u2026`
  );
}

function formatQuestion(session: ReportQASession): string {
  const { exchanges, currentQuestion, slug, answerBuffer } = session;
  const qNum = exchanges.length + 1;

  // Show recent exchanges (last 3 max)
  const recentExchanges = exchanges.slice(-3);
  const prevLines = recentExchanges.map((ex, i) => {
    const num = exchanges.length - recentExchanges.length + i + 1;
    return `\u2705 Q${num}: ${esc(truncate(ex.question, 40))} \u2192 ${esc(truncate(ex.answer, 60))}`;
  });

  let text =
    `\u{1F4DD} *Report QA: ${esc(slug)}*\n` +
    DIVIDER +
    `\n\nQ${qNum}: *${esc(currentQuestion ?? "…")}*`;

  if (prevLines.length > 0) {
    text += `\n\n${prevLines.join("\n")}`;
  }

  if (answerBuffer.length > 0) {
    text += `\n\n\u{1F4E5} _Buffer: ${answerBuffer.length} message\\(s\\) \\u2014 tap Submit when ready_`;
  } else {
    text += `\n\n_Type your answer \\(text, voice, or multiple messages\\), then tap Submit_`;
  }

  return text;
}

// ── Keyboard Builder ─────────────────────────────────────────────────────────

function buildQuestionKeyboard(session: ReportQASession): InlineKeyboard {
  const { chatId, threadId } = session;
  const tid = threadId ?? 0;
  const kb = new InlineKeyboard();

  // Row 1: Submit + Skip
  kb.text("\u2705 Submit", `rpq:${RPQ_ACTIONS.SUBMIT}:${chatId}:${tid}`);
  kb.text("\u23ED Skip", `rpq:${RPQ_ACTIONS.SKIP}:${chatId}:${tid}`);
  kb.row();

  // Row 2: Undo + Preview
  if (session.exchanges.length > 0) {
    kb.text("\u21A9 Undo", `rpq:${RPQ_ACTIONS.UNDO}:${chatId}:${tid}`);
  }
  kb.text("\u{1F441} Preview", `rpq:${RPQ_ACTIONS.PREVIEW}:${chatId}:${tid}`);
  kb.row();

  // Row 3: Pause + End
  kb.text("\u23F8 Pause", `rpq:${RPQ_ACTIONS.PAUSE}:${chatId}:${tid}`);
  kb.text("\u{1F3C1} End", `rpq:${RPQ_ACTIONS.END}:${chatId}:${tid}`);

  return kb;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(text: string, maxLen = 50): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

/** Escape MarkdownV2 special characters for Telegram. */
function esc(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}
