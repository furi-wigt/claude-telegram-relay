/**
 * Creates, updates, and manages pinned Telegram dashboard messages
 * for coding sessions. One pinned message per active session,
 * edited in-place as the session progresses.
 */

import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { CodingSession, SessionStatus } from "./types.ts";

export class DashboardManager {
  constructor(private bot: Bot) {}

  /**
   * Create a new dashboard message for a session and pin it.
   * Returns the message_id of the pinned message.
   */
  async createDashboard(session: CodingSession): Promise<number> {
    const text = this.formatDashboard(session);
    const keyboard = this.getDashboardKeyboard(session);

    const msg = await this.bot.api.sendMessage(session.chatId, text, {
      reply_markup: keyboard,
      parse_mode: undefined,
    });

    // Attempt to pin -- may fail in DMs or if bot lacks permission
    try {
      await this.bot.api.pinChatMessage(session.chatId, msg.message_id, {
        disable_notification: true,
      });
    } catch {
      // Pinning not supported or permission denied -- continue without pin
    }

    return msg.message_id;
  }

  /**
   * Update an existing dashboard message in-place.
   */
  async updateDashboard(session: CodingSession): Promise<void> {
    if (!session.pinnedMessageId) return;

    const text = this.formatDashboard(session);
    const keyboard = this.getDashboardKeyboard(session);

    try {
      await this.bot.api.editMessageText(
        session.chatId,
        session.pinnedMessageId,
        text,
        { reply_markup: keyboard }
      );
    } catch {
      // Edit may fail if text is unchanged or message was deleted
    }
  }

  /**
   * Remove the dashboard: unpin and optionally delete.
   */
  async removeDashboard(session: CodingSession): Promise<void> {
    if (!session.pinnedMessageId) return;

    try {
      await this.bot.api.unpinChatMessage(session.chatId, session.pinnedMessageId);
    } catch {
      // Unpin failed -- may already be unpinned
    }
  }

  /**
   * Format the dashboard text based on current session state.
   */
  formatDashboard(session: CodingSession): string {
    const icon = statusIcon(session.status);
    const label = statusLabel(session.status);
    const elapsed = formatElapsed(session.startedAt);
    const fileCount = session.filesChanged.length;
    const shortId = session.id.slice(0, 11);

    let text = `\u{1F4C1} ${session.projectName}\n`;
    text += "\u2501".repeat(20) + "\n\n";

    // Status line -- special states for waiting
    if (session.status === "waiting_for_input") {
      const pausedMin = formatElapsed(session.pendingQuestion?.askedAt || session.lastActivityAt);
      text += `${icon} Status: ${label} (paused ${pausedMin})\n`;
    } else if (session.status === "waiting_for_plan") {
      const pausedMin = formatElapsed(session.pendingPlanApproval?.askedAt || session.lastActivityAt);
      text += `${icon} Status: ${label} (paused ${pausedMin})\n`;
    } else if (session.status === "running" || session.status === "starting") {
      text += `${icon} Status: ${label}\n`;
      text += `\u23F1 Running: ${elapsed}\n`;
    } else {
      text += `${icon} Status: ${label}\n`;
    }

    text += `\u{1F4CB} Task: ${session.task}\n`;

    if (fileCount > 0) {
      text += `\u{1F4DD} Files changed: ${fileCount}\n`;
    }

    // Waiting-state-specific instructions
    if (session.status === "waiting_for_input") {
      text += `\nScroll up to answer Claude's question\nor use /code answer <text>\n`;
    } else if (session.status === "waiting_for_plan") {
      text += `\nScroll up to review and approve the plan\n`;
    }

    // Recent activity -- show last few changed files
    if (session.filesChanged.length > 0 && session.status === "running") {
      text += "\nRecent activity:\n";
      const recent = session.filesChanged.slice(-3);
      for (const f of recent) {
        text += `\u2022 ${f}\n`;
      }
    }

    // Summary for completed sessions
    if (session.summary && (session.status === "completed" || session.status === "failed")) {
      text += `\n${session.summary.slice(0, 300)}\n`;
    }

    // Error message
    if (session.errorMessage) {
      text += `\n\u274C ${session.errorMessage.slice(0, 200)}\n`;
    }

    // Footer
    text += "\n" + "\u2500".repeat(21) + "\n";
    text += `\u{1F194} Session: ${shortId}\n`;
    text += `\u{1F4C2} ${abbreviatePath(session.directory)}`;

    return text;
  }

  /**
   * Build the inline keyboard for the dashboard based on session state.
   */
  getDashboardKeyboard(session: CodingSession): InlineKeyboard {
    const id = session.id;
    const keyboard = new InlineKeyboard();

    if (
      session.status === "running" ||
      session.status === "starting" ||
      session.status === "waiting_for_input" ||
      session.status === "waiting_for_plan"
    ) {
      keyboard
        .text("\u{1F50D} Status", `code_dash:status:${id}`)
        .text("\u{1F4C4} Logs", `code_dash:logs:${id}`)
        .text("\u{1F4CA} Diff", `code_dash:diff:${id}`)
        .text("\u26D4 Stop", `code_dash:stop:${id}`);
    } else if (session.status === "completed" || session.status === "failed" || session.status === "killed") {
      keyboard
        .text("\u{1F4CA} Diff", `code_dash:diff:${id}`)
        .text("\u{1F4C4} Logs", `code_dash:logs:${id}`);
    }

    return keyboard;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusIcon(status: SessionStatus): string {
  const icons: Record<SessionStatus, string> = {
    pending_permission: "\u{1F510}",
    starting: "\u23F3",
    running: "\u2699\uFE0F",
    waiting_for_input: "\u2753",
    waiting_for_plan: "\u{1F4CB}",
    paused: "\u23F8",
    completed: "\u2705",
    failed: "\u274C",
    killed: "\u26D4",
  };
  return icons[status] || "\u2754";
}

function statusLabel(status: SessionStatus): string {
  const labels: Record<SessionStatus, string> = {
    pending_permission: "Awaiting permission",
    starting: "Starting...",
    running: "Running",
    waiting_for_input: "Waiting for your input",
    waiting_for_plan: "Plan approval needed",
    paused: "Paused",
    completed: "Completed",
    failed: "Failed",
    killed: "Stopped",
  };
  return labels[status] || status;
}

function formatElapsed(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return `${minutes} min ${remSeconds < 10 ? "0" : ""}${remSeconds} sec`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Abbreviate a long path for display:
 * /Users/furi/Documents/WorkInGovTech/my-project -> /Users/furi/.../my-project
 */
function abbreviatePath(fullPath: string): string {
  const parts = fullPath.split("/").filter(Boolean);
  if (parts.length <= 4) return fullPath;
  return "/" + parts[0] + "/" + parts[1] + "/.../" + parts[parts.length - 1];
}
