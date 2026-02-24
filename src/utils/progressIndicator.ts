/**
 * Non-intrusive progress indicator for long-running Claude calls.
 *
 * Sends a single "working..." message after a configurable delay,
 * edits it in-place on a timer, and cleans up when the work finishes.
 *
 * The indicator maintains a rolling buffer of the last 5 unique events.
 * Consecutive duplicate events are skipped. The buffer continues to
 * accumulate during the debounce window — the next allowed edit reflects
 * all events received since the previous edit.
 *
 * CRITICAL: Messages produced by this class must NEVER be passed to
 * saveMessage(), shortTermMemory, or any Supabase storage pipeline.
 */

import type { Bot } from "grammy";

// NOTE: All PROGRESS_* env vars are read at call-time (not module load time) to
// allow test files to override them via process.env before importing this module
// in the same Bun process. See the corresponding test file for details.

/** Format milliseconds into a human-readable elapsed string. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds < 10 ? "0" : ""}${seconds}s`;
}

/** Returns current wall-clock time as HH:MM:SS (24-hour). */
function formatTimestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Truncate a string to at most maxChars, appending "…" if cut. */
function truncate(s: string, maxChars: number): string {
  return s.length > maxChars ? s.slice(0, maxChars - 1) + "\u2026" : s;
}

export class ProgressIndicator {
  private chatId: number | null = null;
  private threadId: number | null = null;
  private bot: Bot | null = null;
  private messageId: number | null = null;
  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private editInterval: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  private finished = false;
  private lastImmediateEdit = 0;
  /** callback_data prefix for the inline Cancel button (e.g. "42:7"). Null = no button. */
  private cancelKey: string | null = null;
  /** Called once the initial progress message is sent, with its message_id. */
  private onMessageId: ((id: number) => void) | null = null;

  /**
   * Rolling buffer of the last N unique events (no consecutive duplicates).
   * Each entry is pre-formatted as "[HH:MM:SS] summary".
   * Most-recent event is at the end.
   */
  private eventBuffer: string[] = [];
  /** Raw (un-timestamped) text of the last pushed event — used for dedup. */
  private lastRawEvent = "";
  /** Short model label shown in each progress line, e.g. "Haiku", "Sonnet", "Opus". */
  private modelLabel = "Sonnet";

  /**
   * Begin the progress indicator lifecycle.
   *
   * After INDICATOR_DELAY_MS the indicator sends an initial message.
   * It then edits that message every UPDATE_INTERVAL_MS with elapsed time.
   *
   * @param threadId - Telegram forum topic thread ID. Pass to ensure the
   *   indicator appears in the correct forum topic rather than the root chat.
   * @param options.cancelKey - When set, an inline "✖ Cancel" button is
   *   attached to the initial message with callback_data `cancel:<cancelKey>`.
   * @param options.onMessageId - Called once with the message_id of the initial
   *   progress message, so callers can register it in the activeStreams entry.
   */
  async start(
    chatId: number,
    bot: Bot,
    threadId?: number | null,
    options?: { cancelKey?: string; onMessageId?: (id: number) => void }
  ): Promise<void> {
    this.chatId = chatId;
    this.threadId = threadId ?? null;
    this.bot = bot;
    this.startTime = Date.now();
    this.finished = false;
    this.cancelKey = options?.cancelKey ?? null;
    this.onMessageId = options?.onMessageId ?? null;

    const indicatorDelayMs = parseInt(
      process.env.PROGRESS_INDICATOR_DELAY_MS || "2000",
      10,
    );
    this.delayTimer = setTimeout(async () => {
      if (this.finished) return;
      await this.sendInitialMessage();
      this.startEditLoop();
    }, indicatorDelayMs);
  }

  /**
   * Push a new event into the rolling buffer and optionally trigger an
   * immediate edit of the Telegram message.
   *
   * Consecutive duplicate events are ignored (deduped). During the debounce
   * window after an immediate edit, new events still accumulate in the buffer
   * so the next allowed edit reflects all recent activity.
   *
   * @param summary - New event text to add to the buffer.
   * @param options.immediate - When true, edits the Telegram message right
   *   away (debounced to at most once per IMMEDIATE_DEBOUNCE_MS). The 2-minute
   *   heartbeat timer still fires regardless.
   */
  async update(summary: string, options?: { immediate?: boolean }): Promise<void> {
    this.pushEvent(summary);
    console.debug(`[indicator] update summary="${summary.slice(0, 60)}" messageId=${this.messageId} finished=${this.finished}`);

    if (options?.immediate && this.messageId !== null && !this.finished) {
      const now = Date.now();
      const immediateDebounceMs = parseInt(
        process.env.PROGRESS_IMMEDIATE_DEBOUNCE_MS || "3000",
        10,
      );
      if (now - this.lastImmediateEdit >= immediateDebounceMs) {
        this.lastImmediateEdit = now;
        await this.editMessage();
      }
    }
  }

  /**
   * Stop the indicator. Edits the message to a "done" state,
   * then deletes it after a short pause so it doesn't clutter the chat.
   *
   * If finish() is called before the initial message was sent (response faster
   * than INDICATOR_DELAY_MS), the pending delay timer is cancelled so no
   * orphan message is created.
   */
  async finish(success = true): Promise<void> {
    if (this.finished) return;
    this.finished = true;

    // Cancel the delay timer first — prevents orphan messages when the
    // response arrives before the indicator has had a chance to send.
    this.clearTimers();

    if (this.messageId !== null && this.chatId !== null && this.bot !== null) {
      const elapsed = formatElapsed(Date.now() - this.startTime);
      const icon = success ? "\u2705" : "\u274C";
      const label = success ? "Done" : "Failed";
      const text = `${icon} Claude \u2014 ${label} (${elapsed})`;

      try {
        await this.bot.api.editMessageText(this.chatId, this.messageId, text);
      } catch {
        // Message may have been deleted by the user — safe to ignore
      }

      // Auto-delete the indicator message after 5 seconds
      const msgId = this.messageId;
      const chatId = this.chatId;
      const botRef = this.bot;
      setTimeout(async () => {
        try {
          await botRef.api.deleteMessage(chatId, msgId);
        } catch {
          // Already deleted or permission denied — fine
        }
      }, 5000);
    }

    this.reset();
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /** Set the model label displayed in each progress line (e.g. "Haiku", "Sonnet", "Opus"). */
  setModelLabel(label: string): void {
    this.modelLabel = label;
  }

  /**
   * Push an event into the rolling buffer.
   * Skips the entry if it is identical to the most-recent event (dedup on raw text).
   * Stores entries as "[HH:MM:SS ModelLabel] summary" so each line shows when it arrived and which model is running.
   * Evicts the oldest entry when the buffer exceeds EVENT_BUFFER_SIZE.
   */
  private pushEvent(summary: string): void {
    if (this.lastRawEvent === summary) return; // consecutive duplicate — skip
    this.lastRawEvent = summary;
    this.eventBuffer.push(`[${formatTimestamp()} ${this.modelLabel}] ${summary}`);
    const eventBufferSize = parseInt(
      process.env.PROGRESS_EVENT_BUFFER_SIZE || "10",
      10,
    );
    if (this.eventBuffer.length > eventBufferSize) {
      this.eventBuffer.shift();
    }
  }

  private async sendInitialMessage(): Promise<void> {
    if (this.finished || !this.chatId || !this.bot) return;

    console.debug(`[indicator] sendInitialMessage chatId=${this.chatId} threadId=${this.threadId}`);
    const text = this.buildText();
    try {
      const msg = await this.bot.api.sendMessage(this.chatId, text, {
        ...(this.threadId != null && { message_thread_id: this.threadId }),
        ...(this.cancelKey != null && {
          reply_markup: {
            inline_keyboard: [[
              { text: "\u2716 Cancel", callback_data: `cancel:${this.cancelKey}` },
            ]],
          },
        }),
      });
      this.messageId = msg.message_id;
      console.debug(`[indicator] messageId set: ${this.messageId}`);
      this.onMessageId?.(msg.message_id);
    } catch (err) {
      // Failed to send — maybe chat is unavailable. Give up silently.
      console.debug(`[indicator] sendInitialMessage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private startEditLoop(): void {
    const updateIntervalMs = parseInt(
      process.env.PROGRESS_UPDATE_INTERVAL_MS || "60000",
      10,
    );
    this.editInterval = setInterval(async () => {
      if (this.finished) {
        this.clearTimers();
        return;
      }
      await this.editMessage();
    }, updateIntervalMs);
  }

  /**
   * Edit the in-place indicator message with the latest buffered events.
   *
   * When cancelKey is set, the inline Cancel button is preserved in every
   * heartbeat and immediate edit. Omitting reply_markup in editMessageText
   * causes Telegram to remove the existing inline keyboard — so we must
   * re-attach it on every edit while the stream is active.
   */
  private async editMessage(): Promise<void> {
    if (!this.chatId || !this.bot || this.messageId === null) return;

    const text = this.buildText();
    try {
      await this.bot.api.editMessageText(this.chatId, this.messageId, text, {
        ...(this.cancelKey != null && {
          reply_markup: {
            inline_keyboard: [[
              { text: "\u2716 Cancel", callback_data: `cancel:${this.cancelKey}` },
            ]],
          },
        }),
      });
    } catch (err: unknown) {
      // Telegram returns 400 "message is not modified" when text is identical.
      // This is expected and safe to ignore. Other errors (deleted message,
      // permission denied) are also non-fatal for an indicator.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("message is not modified")) {
        // Log non-trivial errors for observability but don't throw
        console.debug("[ProgressIndicator] editMessage error:", msg);
      }
    }
  }

  private buildText(): string {
    const elapsed = formatElapsed(Date.now() - this.startTime);
    const header = `\u2699\uFE0F Claude \u2014 working... (${elapsed})`;

    if (this.eventBuffer.length === 0) {
      return `${header}\nThinking...`;
    }

    const eventLineMaxChars = parseInt(
      process.env.PROGRESS_EVENT_LINE_MAX_CHARS || "80",
      10,
    );
    const lines = this.eventBuffer
      .map((e) => truncate(e, eventLineMaxChars))
      .join("\n");
    return `${header}\n${lines}`;
  }

  private clearTimers(): void {
    if (this.delayTimer !== null) {
      clearTimeout(this.delayTimer);
      this.delayTimer = null;
    }
    if (this.editInterval !== null) {
      clearInterval(this.editInterval);
      this.editInterval = null;
    }
  }

  private reset(): void {
    this.chatId = null;
    this.threadId = null;
    this.bot = null;
    this.messageId = null;
    this.cancelKey = null;
    this.onMessageId = null;
    this.eventBuffer = [];
    this.lastRawEvent = "";
    this.lastImmediateEdit = 0;
  }
}
