// src/jobs/telegramJobCommands.ts
import type { Bot, Context } from "grammy";
import type { Job, JobStatus, JobType } from "./types.ts";
import type { JobStore } from "./jobStore.ts";
import type { InterventionManager } from "./interventionManager.ts";

const STATUS_EMOJI: Partial<Record<JobStatus, string>> = {
  pending: "⏳",
  running: "▶️",
  done: "✅",
  failed: "❌",
  cancelled: "🚫",
  paused: "⏸️",
  preempted: "⏪",
  "awaiting-intervention": "⚠️",
};

function formatAge(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}

export function formatJobList(jobs: Job[]): string {
  if (jobs.length === 0) return "No jobs found.";

  const counts = {
    running: jobs.filter((j) => j.status === "running").length,
    awaiting: jobs.filter((j) => j.status === "awaiting-intervention").length,
    done: jobs.filter((j) => j.status === "done").length,
  };

  const header = `📋 Jobs (${counts.running} running · ${counts.awaiting} awaiting · ${counts.done} done)`;
  const lines = [header, "─".repeat(40)];

  for (const job of jobs.slice(0, 10)) {
    const emoji = STATUS_EMOJI[job.status] ?? "?";
    const statusLabel = job.status === "awaiting-intervention" ? "needs input" : job.status;
    const age = formatAge(job.created_at);
    lines.push(`${emoji}  ${job.title.slice(0, 24).padEnd(24)} ${statusLabel.padEnd(14)} ${age}`);
  }

  if (jobs.length > 10) {
    lines.push(`\n... and ${jobs.length - 10} more`);
  }

  return lines.join("\n");
}

export function formatJobDetail(job: Job): string {
  const lines = [
    `${STATUS_EMOJI[job.status] ?? ""} <b>${job.title}</b>`,
    "",
    `<b>ID:</b> <code>${job.id.slice(0, 8)}</code>`,
    `<b>Status:</b> ${job.status}`,
    `<b>Type:</b> ${job.type}`,
    `<b>Executor:</b> ${job.executor}`,
    `<b>Source:</b> ${job.source}`,
    `<b>Priority:</b> ${job.priority}`,
    `<b>Created:</b> ${job.created_at}`,
  ];

  if (job.started_at) lines.push(`<b>Started:</b> ${job.started_at}`);
  if (job.completed_at) lines.push(`<b>Done:</b> ${job.completed_at}`);
  if (job.error) lines.push(`\n<b>Error:</b> ${job.error}`);

  if (job.intervention_type) {
    lines.push(`\n<b>Intervention:</b> ${job.intervention_type}`);
    lines.push(`<b>Prompt:</b> ${job.intervention_prompt}`);
  }

  return lines.join("\n");
}

export function buildInterventionKeyboard(jobId: string) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Confirm", callback_data: `job:confirm:${jobId}` },
        { text: "⏭ Skip", callback_data: `job:skip:${jobId}` },
        { text: "❌ Abort", callback_data: `job:abort:${jobId}` },
      ],
    ],
  };
}

export function registerJobCommands(
  bot: Bot<Context>,
  store: JobStore,
  interventionManager: InterventionManager
): void {
  // /jobs [filter]
  bot.command("jobs", async (ctx) => {
    const args = (ctx.match ?? "").trim().toLowerCase();

    let filter: { status?: JobStatus; type?: JobType; limit?: number } = { limit: 20 };
    if (args === "pending") filter.status = "pending";
    else if (args === "failed") filter.status = "failed";
    else if (args === "running") filter.status = "running";

    const jobs = store.listJobs(filter);
    const text = formatJobList(jobs);

    const keyboard = {
      inline_keyboard: [
        [
          { text: "⚠️ Needs attention", callback_data: "job:list:intervention" },
          { text: "▶️ Running", callback_data: "job:list:running" },
          { text: "📜 History", callback_data: "job:list:done" },
        ],
      ],
    };

    await ctx.reply(text, { reply_markup: keyboard });
  });

  // Callback handler for intervention resolution
  bot.callbackQuery(/^job:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(":");
    if (parts.length < 3) {
      await ctx.answerCallbackQuery({ text: "Invalid callback" });
      return;
    }

    const action = parts[1];
    const jobIdOrFilter = parts[2];

    // List filter callbacks
    if (action === "list") {
      let jobs;
      if (jobIdOrFilter === "intervention") {
        jobs = store.getAwaitingIntervention();
      } else {
        jobs = store.listJobs({ status: jobIdOrFilter as JobStatus, limit: 20 });
      }
      const text = formatJobList(jobs);
      try {
        await ctx.editMessageText(text);
      } catch {
        // "message is not modified" or deleted — ignore
      }
      await ctx.answerCallbackQuery();
      return;
    }

    // Resolution callbacks: confirm, skip, abort
    const job = store.getJob(jobIdOrFilter);
    if (!job) {
      await ctx.answerCallbackQuery({ text: "Job not found" });
      return;
    }

    if (action === "confirm") {
      interventionManager.resolveIntervention(job.id, "confirm");
      await ctx.answerCallbackQuery({ text: "✅ Confirmed" });
    } else if (action === "skip") {
      interventionManager.resolveIntervention(job.id, "skip");
      await ctx.answerCallbackQuery({ text: "⏭ Skipped" });
    } else if (action === "abort") {
      interventionManager.resolveIntervention(job.id, "abort");
      await ctx.answerCallbackQuery({ text: "❌ Aborted" });
    } else {
      await ctx.answerCallbackQuery({ text: "Unknown action" });
      return;
    }

    // Update the message to show resolved state
    try {
      const updated = store.getJob(job.id)!;
      await ctx.editMessageText(formatJobDetail(updated), { parse_mode: "HTML" });
    } catch {
      // message may have been deleted
    }
  });

  console.log("[jobs] registered /jobs command and job:* callback handler");
}
