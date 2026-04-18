// src/jobs/executors/claudeSessionExecutor.ts
import type { JobExecutor, ExecutorResult } from "./types.ts";
import type { Job, JobCheckpoint } from "../types.ts";
import type { JobStore } from "../jobStore.ts";
import { getDispatchRunner } from "../../orchestration/dispatchEngine.ts";
import { classifyIntent } from "../../orchestration/intentClassifier.ts";
import { AGENTS } from "../../agents/config.ts";
import { nextJobNumber } from "../jobCounter.ts";
import { createForumTopic, editMessage } from "../../utils/telegramApi.ts";
import { sendToGroup } from "../../utils/sendToGroup.ts";
import { registerJobTopic } from "../jobTopicRegistry.ts";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function buildJobCard(jobNumStr: string, prompt: string, agentName: string, status: string): string {
  return [
    `🗂 Job #${jobNumStr}`,
    `Prompt: ${prompt}`,
    `Agent:  ${agentName}`,
    `Status: ${status}`,
  ].join("\n");
}

export class ClaudeSessionExecutor implements JobExecutor {
  readonly type = "claude-session" as const;
  readonly maxConcurrent = 1;

  constructor(private store: JobStore) {}

  async execute(job: Job, checkpoint?: JobCheckpoint): Promise<ExecutorResult> {
    const prompt = job.payload.prompt as string | undefined;
    if (!prompt) {
      return { status: "failed", error: "payload.prompt required" };
    }

    const runner = getDispatchRunner();
    if (!runner) {
      return { status: "failed", error: "dispatch runner not available — is the bot running?" };
    }

    if (checkpoint) {
      console.warn(`[claudeSessionExecutor] checkpoint found for job ${job.id.slice(0, 8)} — re-running from scratch (v1)`);
    }

    // Classify intent and resolve target agent
    const classification = await classifyIntent(prompt);
    const agent = AGENTS[classification.primaryAgent] ?? AGENTS["operations-hub"];
    const agentChatId = agent?.chatId ?? 0;
    const agentTopicId: number | null = (agent?.meshTopicId ?? agent?.topicId) ?? null;
    const agentName = agent?.name ?? classification.primaryAgent;

    // Sequential job number (persists across restarts)
    const jobNumber = nextJobNumber();
    const jobNumStr = String(jobNumber).padStart(3, "0");

    // Create forum topic in Command Center — best-effort, non-fatal
    const ccAgent = AGENTS["command-center"];
    const ccChatId = ccAgent?.chatId;
    let jobTopicId: number | undefined;
    let jobCardMessageId: number | undefined;

    if (ccChatId) {
      try {
        const topicName = `⚙️ #${jobNumStr} — ${truncate(prompt, 60)}`;
        jobTopicId = await createForumTopic(ccChatId, topicName);

        jobCardMessageId = await sendToGroup(
          ccChatId,
          buildJobCard(jobNumStr, prompt, agentName, "🔄 Running…"),
          { topicId: jobTopicId },
        );

        this.store.updateMetadata(job.id, { jobTopicId, jobNumber, jobCardMessageId, ccChatId });

        registerJobTopic(jobTopicId, {
          jobId: job.id,
          prompt,
          agentId: classification.primaryAgent,
        });
      } catch (err) {
        console.warn(`[claudeSessionExecutor] job topic creation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        jobTopicId = undefined;
        jobCardMessageId = undefined;
      }
    }

    try {
      const response = await runner(agentChatId, agentTopicId, prompt) ?? "Done";

      // Route response to job topic; fall back to source chat when no topic available
      if (jobTopicId && ccChatId) {
        await sendToGroup(ccChatId, response, { topicId: jobTopicId });
      } else {
        const chatId = (job.metadata as Record<string, unknown>)?.chatId as number | undefined;
        const threadId = (job.metadata as Record<string, unknown>)?.threadId as number | undefined;
        if (chatId) {
          await sendToGroup(chatId, response, { topicId: threadId });
        }
      }

      // Update job card to Done (best-effort)
      if (ccChatId && jobCardMessageId) {
        await editMessage(ccChatId, jobCardMessageId, buildJobCard(jobNumStr, prompt, agentName, "✅ Done"));
      }

      this.store.insertCheckpoint(job.id, 0, { sessionId: job.id });

      return { status: "done", summary: response.slice(0, 500) };
    } catch (err) {
      if (ccChatId && jobCardMessageId) {
        await editMessage(ccChatId, jobCardMessageId, buildJobCard(jobNumStr, prompt, agentName, "❌ Failed"));
      }
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
