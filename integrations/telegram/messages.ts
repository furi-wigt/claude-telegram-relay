/**
 * Telegram message type union — discriminated by `type` field.
 * Used with dispatch() so routines send structured messages.
 */

export type TelegramMessage =
  | { type: 'text'; text: string; silent?: boolean }
  | { type: 'question'; text: string; options: { label: string; value: string }[] }
  | { type: 'progress'; status: 'loading' | 'running' | 'done' | 'error'; text: string }
  | { type: 'alert'; text: string; severity: 'info' | 'warn' | 'error' };
