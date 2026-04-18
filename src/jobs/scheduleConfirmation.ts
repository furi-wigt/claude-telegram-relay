// src/jobs/scheduleConfirmation.ts
//
// Pre-enqueue UX for /schedule:
//   1. Similarity detection — find active jobs with similar prompts
//   2. Confirmation keyboard — user must confirm before job is submitted
//   3. TTL pending map — un-confirmed jobs expire after 5 minutes

import type { Bot, Context } from "grammy";
import type { Job, JobStatus } from "./types.ts";
import type { SubmitJobInput } from "./types.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

export const SIMILAR_THRESHOLD = 0.6;
const TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PENDING = 50;
const MAX_SIMILAR_DISPLAY = 5;
const MIN_TOKEN_LENGTH = 3; // tokens ≤2 chars are stop-words

/** Non-terminal statuses — the only ones worth comparing against */
const ACTIVE_STATUSES = new Set<JobStatus>([
  "pending",
  "running",
  "awaiting-intervention",
  "paused",
  "preempted",
]);

const STATUS_EMOJI: Partial<Record<JobStatus, string>> = {
  pending: "🕐",
  running: "🔄",
  "awaiting-intervention": "⏳",
  paused: "⏸️",
  preempted: "⏪",
};

// ── Token Jaccard similarity ──────────────────────────────────────────────────

/**
 * Compute token-level Jaccard similarity between two strings.
 * Tokens shorter than MIN_TOKEN_LENGTH are treated as stop-words and excluded.
 * Returns 0 if either set is empty.
 */
export function tokenJaccard(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s.toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length >= MIN_TOKEN_LENGTH),
    );

  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

// ── Similar job detection ─────────────────────────────────────────────────────

/**
 * Find active jobs whose title (prompt) is similar to the given prompt.
 * Terminal status jobs (done, failed, cancelled) are excluded.
 * Results are capped at MAX_SIMILAR_DISPLAY.
 */
export function findSimilarJobs(
  prompt: string,
  jobs: Job[],
  threshold = SIMILAR_THRESHOLD,
): Job[] {
  const results: Job[] = [];
  for (const job of jobs) {
    if (!ACTIVE_STATUSES.has(job.status)) continue;
    if (tokenJaccard(prompt, job.title) >= threshold) {
      results.push(job);
      if (results.length === MAX_SIMILAR_DISPLAY) break;
    }
  }
  return results;
}

// ── Message formatting ────────────────────────────────────────────────────────

function formatElapsed(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function formatJobNumber(job: Job): string {
  const meta = job.metadata as Record<string, unknown> | null;
  const num = meta?.jobNumber;
  return num != null ? `#${String(num).padStart(3, "0")}` : `#${job.id.slice(0, 8)}`;
}

function formatSimilarJobCard(job: Job, idx: number): string {
  const numStr = formatJobNumber(job);
  const icon = STATUS_EMOJI[job.status] ?? "❓";
  const elapsed = formatElapsed(job.created_at);
  const title = job.title.length > 80 ? `${job.title.slice(0, 79)}…` : job.title;

  // Map number to keycap emoji: 1️⃣ – 5️⃣
  const keycap = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"][idx] ?? `${idx + 1}.`;

  return [
    `${keycap} ${numStr} — "${title}"`,
    `   Status: ${icon} ${job.status} | Priority: ${job.priority}`,
    `   Elapsed: ${elapsed}`,
  ].join("\n");
}

/**
 * Build the confirmation message shown to the user before enqueueing.
 * If similar jobs exist, a warning section is prepended.
 */
export function buildConfirmationMessage(prompt: string, similar: Job[]): string {
  const lines: string[] = [];

  if (similar.length > 0) {
    lines.push(`⚠️ <b>Similar jobs in pipeline (${similar.length}):</b>\n`);
    for (let i = 0; i < similar.length; i++) {
      lines.push(formatSimilarJobCard(similar[i], i));
    }
    lines.push("");
    lines.push("<b>Your new job:</b>");
    lines.push(`"${prompt}"`);
    lines.push("");
    lines.push("Queue anyway?");
  } else {
    lines.push("📋 <b>New job:</b>");
    lines.push(`"${prompt}"`);
    lines.push("");
    lines.push("Queue this job?");
  }

  return lines.join("\n");
}

/** Inline keyboard for schedule confirmation */
export function buildScheduleKeyboard(uuid: string): object {
  const confirmText = "✅ Queue";
  const cancelText = "❌ Cancel";
  return {
    inline_keyboard: [
      [
        { text: confirmText, callback_data: `schedule:confirm:${uuid}` },
        { text: cancelText, callback_data: `schedule:cancel:${uuid}` },
      ],
    ],
  };
}

// ── Pending schedule TTL map ──────────────────────────────────────────────────

interface PendingSchedule {
  prompt: string;
  chatId: number | undefined;
  threadId: number | undefined;
  expiresAt: number;
}

const _pending = new Map<string, PendingSchedule>();
let _sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Sweep expired entries — called on interval */
function sweep(): void {
  const now = Date.now();
  for (const [uuid, entry] of _pending) {
    if (entry.expiresAt <= now) _pending.delete(uuid);
  }
}

/** Start 60s sweep interval. Idempotent. */
export function startSweep(): void {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(sweep, 60_000);
  // Allow process to exit cleanly
  if (typeof _sweepTimer.unref === "function") _sweepTimer.unref();
}

/** Stop sweep interval. Idempotent. */
export function stopSweep(): void {
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
}

/**
 * Store a pending schedule and return the UUID key.
 * @param expiresAt — override expiry (for tests)
 */
export function createPendingSchedule(
  prompt: string,
  chatId: number | undefined,
  threadId: number | undefined,
  expiresAt?: number,
): string {
  // Evict oldest entry if at cap
  if (_pending.size >= MAX_PENDING) {
    const firstKey = _pending.keys().next().value;
    if (firstKey !== undefined) _pending.delete(firstKey);
  }

  const uuid = crypto.randomUUID();
  _pending.set(uuid, {
    prompt,
    chatId,
    threadId,
    expiresAt: expiresAt ?? Date.now() + TTL_MS,
  });
  return uuid;
}

/**
 * Consume a pending schedule (one-shot — deleted on read).
 * Returns null if not found or expired.
 */
export function consumePendingSchedule(uuid: string): PendingSchedule | null {
  const entry = _pending.get(uuid);
  if (!entry) return null;
  _pending.delete(uuid);
  if (entry.expiresAt <= Date.now()) return null;
  return entry;
}

/** Test-only: clear all pending entries */
export function _clearPending(): void {
  _pending.clear();
}

// ── Callback handler registration ─────────────────────────────────────────────

type SubmitJobFn = (input: SubmitJobInput) => { id: string } | null;

/**
 * Register the `schedule:confirm:*` and `schedule:cancel:*` callback handlers.
 * Must be called once after bot initialisation.
 */
export function registerScheduleCallbacks(
  bot: Bot<Context>,
  submitJob: SubmitJobFn,
): void {
  bot.callbackQuery(/^schedule:(confirm|cancel):(.+)$/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const m = data.match(/^schedule:(confirm|cancel):(.+)$/);
    if (!m) {
      await ctx.answerCallbackQuery({ text: "Invalid callback" });
      return;
    }
    const [, action, uuid] = m;

    const entry = consumePendingSchedule(uuid);

    if (!entry) {
      // Expired or already consumed
      await ctx.answerCallbackQuery({ text: "⏰ Expired" });
      try {
        await ctx.editMessageText("⏰ <b>Expired</b> — this confirmation timed out. Send /schedule again.", {
          parse_mode: "HTML",
        });
      } catch { /* message may be gone */ }
      return;
    }

    if (action === "cancel") {
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      try {
        await ctx.editMessageText("🚫 <b>Cancelled</b> — job was not queued.", {
          parse_mode: "HTML",
        });
      } catch { /* ignore */ }
      return;
    }

    // action === "confirm"
    const job = submitJob({
      type: "claude-session",
      executor: "claude-session",
      title: entry.prompt.slice(0, 80),
      source: "telegram",
      priority: "normal",
      payload: { prompt: entry.prompt },
      metadata: { chatId: entry.chatId, threadId: entry.threadId },
    });

    if (!job) {
      await ctx.answerCallbackQuery({ text: "Failed to queue" });
      try {
        await ctx.editMessageText("❌ Failed to queue job — please try again.", {
          parse_mode: "HTML",
        });
      } catch { /* ignore */ }
      return;
    }

    await ctx.answerCallbackQuery({ text: "✅ Queued!" });
    try {
      await ctx.editMessageText(
        `✅ <b>Job queued</b>\n"${entry.prompt.slice(0, 80)}"\n\nResults will be posted in your CC topic when ready.`,
        { parse_mode: "HTML" },
      );
    } catch { /* ignore */ }
  });

  startSweep();
  console.log("[schedule] registered schedule:confirm/cancel callback handler");
}
