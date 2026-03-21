/**
 * Telegram Integration — Extended message types for routines.
 *
 * Builds on the existing sendToGroup.ts and routineMessage.ts without replacing them.
 * All dispatch() calls persist via sendAndRecord() so messages appear in memory.
 *
 * Usage:
 *   const tg = createTelegramClient();
 *   await tg.dispatch(chatId, { type: 'text', text: 'Hello!' }, 'morning-summary');
 *   await tg.sendSilent(chatId, 'Quiet update');
 *   await tg.sendAutoDelete(chatId, 'Gone in 10s', 10_000);
 */

import type { TelegramMessage } from "./messages.ts";
import { sendAndRecord } from "../../src/utils/routineMessage.ts";
import { loadEnv } from "../../src/config/envLoader.ts";

export type { TelegramMessage } from "./messages.ts";

loadEnv();

export interface TelegramRoutineAPI {
  // High-level — use these in routines
  dispatch(chatId: number, msg: TelegramMessage, routineName: string): Promise<{ messageId: number }>;
  sendSilent(chatId: number, text: string): Promise<{ messageId: number }>;
  sendAutoDelete(chatId: number, text: string, afterMs: number): Promise<void>;

  // Low-level — for power users
  sendWithKeyboard(
    chatId: number,
    text: string,
    buttons: Array<{ label: string; callbackData: string }>
  ): Promise<{ messageId: number }>;
  editMessage(chatId: number, messageId: number, newText: string): Promise<void>;
  answerCallback(queryId: string, text: string, isAlert?: boolean): Promise<void>;
}

// ── Progress emoji map ────────────────────────────────────────────────────────

const PROGRESS_EMOJI: Record<string, string> = {
  loading: '⏳',
  running: '🔄',
  done: '✅',
  error: '❌',
};

const SEVERITY_EMOJI: Record<string, string> = {
  info: 'ℹ️',
  warn: '⚠️',
  error: '🚨',
};

// ── Raw Bot API helper ────────────────────────────────────────────────────────

async function botRequest(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; result?: { message_id?: number } }> {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram API ${method} error (${response.status}): ${text}`);
  }

  return response.json() as Promise<{ ok: boolean; result?: { message_id?: number } }>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createTelegramClient(): TelegramRoutineAPI {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";

  if (!token) {
    console.warn("createTelegramClient: TELEGRAM_BOT_TOKEN not set — messages will throw");
  }

  function requireToken(): string {
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
    return token;
  }

  async function sendRaw(
    chatId: number,
    text: string,
    extra?: Record<string, unknown>
  ): Promise<{ messageId: number }> {
    const t = requireToken();
    const result = await botRequest(t, "sendMessage", {
      chat_id: chatId,
      text,
      ...extra,
    });
    return { messageId: result.result?.message_id ?? 0 };
  }

  return {
    async dispatch(chatId, msg, routineName) {
      let text: string;
      let extra: Record<string, unknown> = {};

      switch (msg.type) {
        case 'text':
          text = msg.text;
          if (msg.silent) extra.disable_notification = true;
          break;

        case 'question': {
          const optionLines = msg.options.map(o => `  • ${o.label}`).join('\n');
          text = `${msg.text}\n\n${optionLines}`;
          extra.reply_markup = {
            inline_keyboard: [
              msg.options.map(o => ({
                text: o.label,
                callback_data: o.value,
              })),
            ],
          };
          break;
        }

        case 'progress': {
          const emoji = PROGRESS_EMOJI[msg.status] ?? '⏳';
          text = `${emoji} ${msg.text}`;
          break;
        }

        case 'alert': {
          const emoji = SEVERITY_EMOJI[msg.severity] ?? 'ℹ️';
          text = `${emoji} ${msg.text}`;
          break;
        }

        default:
          // exhaustive check
          text = String((msg as { text?: string }).text ?? '');
      }

      const { messageId } = await sendRaw(chatId, text, extra);

      // Persist via sendAndRecord for memory/rolling window
      await sendAndRecord(chatId, text, {
        routineName,
        agentId: undefined,
      }).catch(err => {
        console.warn(`dispatch: sendAndRecord failed (${err}) — message was sent`);
      });

      return { messageId };
    },

    async sendSilent(chatId, text) {
      return sendRaw(chatId, text, { disable_notification: true });
    },

    async sendAutoDelete(chatId, text, afterMs) {
      const { messageId } = await sendRaw(chatId, text);
      setTimeout(() => {
        const t = requireToken();
        botRequest(t, "deleteMessage", {
          chat_id: chatId,
          message_id: messageId,
        }).catch(err => {
          console.warn(`sendAutoDelete: failed to delete message ${messageId}:`, err);
        });
      }, afterMs);
    },

    async sendWithKeyboard(chatId, text, buttons) {
      return sendRaw(chatId, text, {
        reply_markup: {
          inline_keyboard: [
            buttons.map(b => ({
              text: b.label,
              callback_data: b.callbackData,
            })),
          ],
        },
      });
    },

    async editMessage(chatId, messageId, newText) {
      const t = requireToken();
      await botRequest(t, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: newText,
      });
    },

    async answerCallback(queryId, text, isAlert = false) {
      const t = requireToken();
      await botRequest(t, "answerCallbackQuery", {
        callback_query_id: queryId,
        text,
        show_alert: isAlert,
      });
    },
  };
}
