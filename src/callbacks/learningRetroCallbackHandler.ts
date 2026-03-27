/**
 * Learning Retro Callback Handler
 *
 * Handles inline keyboard callbacks from weekly-retro routine.
 * Users can Promote (→ CLAUDE.md), Reject (confidence -= 0.2), or defer (Later).
 *
 * Callback data format:
 *   lr:promote:{sessionId}:{index}
 *   lr:reject:{sessionId}:{index}
 *   lr:later:{sessionId}:{index}
 */

import type { Bot, Context } from "grammy";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export interface RetroCandidate {
  memoryId: string;
  content: string;
  category: string;
  confidence: number;
  evidenceSummary: string;
}

interface RetroSession {
  candidates: RetroCandidate[];
  createdAt: number;
}

// In-memory cache — weekly-retro creates sessions, callbacks consume them
const sessions = new Map<string, RetroSession>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (retro may sit a while)

function generateSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Store retro candidates for a session.
 * Called by weekly-retro after generating the candidate list.
 */
export function storeLearningSession(candidates: RetroCandidate[]): string {
  // Cleanup expired sessions
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }

  const sessionId = generateSessionId();
  sessions.set(sessionId, { candidates, createdAt: now });
  return sessionId;
}

/**
 * Build inline keyboard for a single retro candidate.
 */
export function buildRetroKeyboard(
  sessionId: string,
  index: number,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: [
      [
        { text: "Promote", callback_data: `lr:promote:${sessionId}:${index}` },
        { text: "Reject", callback_data: `lr:reject:${sessionId}:${index}` },
        { text: "Later", callback_data: `lr:later:${sessionId}:${index}` },
      ],
    ],
  };
}

const CLAUDE_MD_PATH = join(homedir(), ".claude", "CLAUDE.md");

/**
 * Append a learning rule to the "Learned Preferences" section in CLAUDE.md.
 * Creates the section if it doesn't exist.
 */
async function appendToClaudeMd(content: string, category: string): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(CLAUDE_MD_PATH, "utf-8");
  } catch {
    // File doesn't exist yet — will create
  }

  const today = new Date().toISOString().slice(0, 10);
  const newRule = `- ${content} [${today}, hits: 0]`;

  const sectionHeader = "## Learned Preferences (auto-managed by Jarvis — do not edit manually)";
  const standardHeader = "### Standard (rotated by importance * recency)";

  if (existing.includes(sectionHeader)) {
    // Section exists — append under Standard
    if (existing.includes(standardHeader)) {
      const insertPoint = existing.indexOf(standardHeader) + standardHeader.length;
      const updated = existing.slice(0, insertPoint) + "\n" + newRule + existing.slice(insertPoint);
      await writeFile(CLAUDE_MD_PATH, updated);
    } else {
      // Section exists but no Standard subsection — append at end of section
      const sectionEnd = existing.indexOf("\n## ", existing.indexOf(sectionHeader) + sectionHeader.length);
      const insertAt = sectionEnd === -1 ? existing.length : sectionEnd;
      const updated = existing.slice(0, insertAt) + "\n" + standardHeader + "\n" + newRule + "\n" + existing.slice(insertAt);
      await writeFile(CLAUDE_MD_PATH, updated);
    }
  } else {
    // Section doesn't exist — append at end of file
    const section = `\n\n${sectionHeader}\n<!-- Last updated: ${today} via weekly retro -->\n\n### Critical (pinned — never auto-rotated)\n\n${standardHeader}\n${newRule}\n`;
    await writeFile(CLAUDE_MD_PATH, existing + section);
  }
}

/**
 * Register callback handlers on the bot instance.
 * Called once at startup in relay.ts.
 */
export function registerLearningRetroHandler(bot: Bot<Context>): void {
  bot.callbackQuery(/^lr:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(":");
    if (parts.length < 4) {
      await ctx.answerCallbackQuery({ text: "Invalid callback" });
      return;
    }

    const action = parts[1]; // "promote", "reject", or "later"
    const sessionId = parts[2];
    const index = parseInt(parts[3], 10);

    const session = sessions.get(sessionId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "Session expired — run /reflect or wait for next retro" });
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch { /* message may have been deleted */ }
      return;
    }

    const candidate = session.candidates[index];
    if (!candidate) {
      await ctx.answerCallbackQuery({ text: "Candidate not found" });
      return;
    }

    if (action === "promote") {
      try {
        // 1. Append to CLAUDE.md
        await appendToClaudeMd(candidate.content, candidate.category);

        // 2. Update memory status to "promoted"
        const { getDb } = await import("../local/db");
        const db = getDb();
        db.run(
          "UPDATE memory SET status = 'promoted', updated_at = datetime('now') WHERE id = ?",
          [candidate.memoryId],
        );

        await ctx.answerCallbackQuery({ text: "Promoted to CLAUDE.md" });
        try {
          await ctx.editMessageText(
            ctx.callbackQuery.message?.text + "\n\n_Promoted_",
            { parse_mode: "Markdown" },
          );
        } catch { /* ignore */ }
      } catch (err) {
        console.error("[learningRetro] Promote failed:", err);
        await ctx.answerCallbackQuery({ text: "Promote failed — check logs" });
      }
      return;
    }

    if (action === "reject") {
      try {
        const { getDb } = await import("../local/db");
        const db = getDb();
        db.run(
          "UPDATE memory SET confidence = MAX(0, confidence - 0.2), updated_at = datetime('now') WHERE id = ?",
          [candidate.memoryId],
        );

        await ctx.answerCallbackQuery({ text: "Rejected (confidence -0.2)" });
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        } catch { /* ignore */ }
      } catch (err) {
        console.error("[learningRetro] Reject failed:", err);
        await ctx.answerCallbackQuery({ text: "Reject failed" });
      }
      return;
    }

    if (action === "later") {
      await ctx.answerCallbackQuery({ text: "Deferred to next retro" });
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch { /* ignore */ }
      return;
    }

    await ctx.answerCallbackQuery({ text: "Unknown action" });
  });

  console.log("[learningRetroHandler] Registered lr:* callback handler");
}
