/**
 * Job Queue — Module Entry Point
 *
 * Initializes and exports the job queue subsystem.
 * Called once from relay.ts at boot.
 */

import { getDb } from "../local/db.ts";
import { JobStore } from "./jobStore.ts";
import { JobQueue } from "./jobQueue.ts";
import { createSubmitJob } from "./submitJob.ts";
import { AutoApproveEngine } from "./autoApproveEngine.ts";
import { InterventionManager } from "./interventionManager.ts";
import { ExecutorRegistry } from "./executors/registry.ts";
import { RoutineExecutor } from "./executors/routineExecutor.ts";
import { ApiCallExecutor } from "./executors/apiCallExecutor.ts";
import { ClaudeSessionExecutor } from "./executors/claudeSessionExecutor.ts";
import { CompoundExecutor } from "./executors/compoundExecutor.ts";
import { registerJobCommands, buildInterventionKeyboard } from "./telegramJobCommands.ts";
import { createWebhookServer } from "./sources/webhookServer.ts";
import { sendToGroup } from "../utils/sendToGroup.ts";
import { initJobBridge } from "./jobBridge.ts";
import { initFromDb as initTopicRegistry } from "./jobTopicRegistry.ts";
import type { Bot, Context } from "grammy";
import type { Job } from "./types.ts";

export interface JobQueueSystem {
  store: JobStore;
  queue: JobQueue;
  submitJob: ReturnType<typeof createSubmitJob>;
  registry: ExecutorRegistry;
  intervention: InterventionManager;
  start: () => void;
  stop: () => Promise<void>;
}

export function initJobQueue(bot: Bot<Context>): JobQueueSystem {
  const db = getDb();
  const store = new JobStore(db);
  const registry = new ExecutorRegistry();
  const autoApprove = AutoApproveEngine.loadFromFile();

  const intervention = new InterventionManager(store, autoApprove, {
    notify: async (job: Job) => {
      const chatId = (job.metadata as Record<string, unknown>)?.chatId as number | undefined;
      if (!chatId) {
        console.warn(`[jobs] no chatId in metadata for job ${job.id.slice(0, 8)} — skipping notification`);
        return;
      }
      const topicId = (job.metadata as Record<string, unknown>)?.threadId as number | undefined;
      const text = [
        "⚠️ <b>Job awaiting your input</b>",
        "──────────────────────────",
        `${job.title} · ${job.type} · ${job.executor}`,
        "",
        job.intervention_prompt ?? "",
      ].join("\n");

      await sendToGroup(chatId, text, {
        parseMode: "HTML",
        topicId,
        reply_markup: buildInterventionKeyboard(job.id),
      });
    },
    reminderMinutes: parseInt(process.env.INTERVENTION_REMINDER_MINS ?? "30", 10),
    t3Minutes: parseInt(process.env.INTERVENTION_T3_MINS ?? "60", 10),
  });

  const queue = new JobQueue(store, registry, intervention);
  const submitJob = createSubmitJob(store, () => queue.wake());

  // Register built-in executors
  const routineExecutor = new RoutineExecutor();
  registry.register("routine", routineExecutor);

  const apiCallExecutor = new ApiCallExecutor();
  registry.register("api-call", apiCallExecutor);

  const claudeSessionExecutor = new ClaudeSessionExecutor(store, bot);
  registry.register("claude-session", claudeSessionExecutor);

  const compoundExecutor = new CompoundExecutor(store);
  registry.register("compound", compoundExecutor);

  // Expose store + intervention to the orchestration layer (for clarification resume)
  initJobBridge(store, intervention);

  // Rebuild job topic registry from DB (survives PM2 restarts)
  initTopicRegistry(db);

  // Register Telegram commands
  registerJobCommands(bot, store, intervention);

  // Start webhook server if configured
  const webhookPort = process.env.JOBS_WEBHOOK_PORT;
  const webhookSecret = process.env.JOBS_WEBHOOK_SECRET;
  if (webhookPort && webhookSecret) {
    createWebhookServer(submitJob, {
      port: parseInt(webhookPort, 10),
      secret: webhookSecret,
    });
  }

  return {
    store,
    queue,
    submitJob,
    registry,
    intervention,
    start: () => queue.start(),
    stop: () => queue.stop(),
  };
}
