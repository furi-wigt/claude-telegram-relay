// src/jobs/executors/claudeSessionExecutor.ts
import type { Bot, Context } from "grammy";
import type { JobExecutor, ExecutorResult } from "./types.ts";
import type { Job, JobCheckpoint } from "../types.ts";
import type { JobStore } from "../jobStore.ts";
import { runHarness, loadHarnessState } from "../../orchestration/harness.ts";
import { classifyIntent } from "../../orchestration/intentClassifier.ts";
import { AGENTS } from "../../agents/config.ts";
import { nextJobNumber } from "../jobCounter.ts";
import { createForumTopic, editMessage } from "../../utils/telegramApi.ts";
import { sendToGroup } from "../../utils/sendToGroup.ts";
import { registerJobTopic } from "../jobTopicRegistry.ts";
import type { DispatchPlan } from "../../orchestration/types.ts";

const CLARIFY_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

  constructor(
    private store: JobStore,
    private bot: Bot<Context>,
  ) {}

  async execute(job: Job, checkpoint?: JobCheckpoint): Promise<ExecutorResult> {
    const prompt = job.payload.prompt as string | undefined;
    if (!prompt) {
      return { status: "failed", error: "payload.prompt required" };
    }

    // ── Resume path: clarification answer available ───────────────────────────

    if (checkpoint?.state.clarificationAnswer) {
      return this.resumeWithClarification(job, checkpoint);
    }

    if (checkpoint) {
      console.warn(`[claudeSessionExecutor] stale checkpoint for job ${job.id.slice(0, 8)} — re-running from scratch`);
    }

    // ── Fresh execution ────────────────────────────────────────────────────────

    const classification = await classifyIntent(prompt);
    const agent = AGENTS[classification.primaryAgent] ?? AGENTS["operations-hub"];
    const agentName = agent?.name ?? classification.primaryAgent;

    const jobNumber = nextJobNumber();
    const jobNumStr = String(jobNumber).padStart(3, "0");

    // Create CC forum topic — best-effort, non-fatal
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

    const plan: DispatchPlan = {
      dispatchId: job.id,
      userMessage: prompt,
      classification,
      tasks: [{ seq: 1, agentId: classification.primaryAgent, topicHint: classification.topicHint, taskDescription: prompt }],
    };

    try {
      const result = await runHarness(
        this.bot,
        plan,
        ccChatId ?? 0,
        jobTopicId ? Number(jobTopicId) : null,
      );

      if (result.outcome === "suspended") {
        if (ccChatId && jobCardMessageId) {
          await editMessage(ccChatId, jobCardMessageId, buildJobCard(jobNumStr, prompt, agentName, "⏳ Awaiting clarification"));
        }
        return {
          status: "awaiting-intervention",
          intervention: {
            type: "clarification",
            prompt: result.question,
            dueInMs: CLARIFY_TIMEOUT_MS,
            autoResolvePolicy: "none",
          },
        };
      }

      const cancelled = result.outcome === "cancelled";
      const success = result.outcome === "done";
      if (ccChatId && jobCardMessageId) {
        const label = cancelled ? "🛑 Cancelled" : success ? "✅ Done" : "❌ Failed";
        await editMessage(ccChatId, jobCardMessageId, buildJobCard(jobNumStr, prompt, agentName, label));
      }
      this.store.insertCheckpoint(job.id, 0, { sessionId: job.id });
      return { status: success ? "done" : "failed", summary: cancelled ? "cancelled by user" : result.outcome };
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

  /** Re-run after user provided clarification answer. */
  private async resumeWithClarification(job: Job, checkpoint: JobCheckpoint): Promise<ExecutorResult> {
    const originalPrompt = job.payload.prompt as string;
    const answer = checkpoint.state.clarificationAnswer as string;
    const question = (checkpoint.state.clarificationQuestion as string | undefined) ?? "";

    const existingState = await loadHarnessState(job.id);

    const enrichedPrompt = question
      ? `${originalPrompt}\n\n---\nClarification needed: ${question}\nUser answer: ${answer}`
      : `${originalPrompt}\n\n---\nUser clarification: ${answer}`;

    const meta = job.metadata as Record<string, unknown> | null;
    const ccChatId = meta?.ccChatId as number | undefined;
    const jobTopicId = meta?.jobTopicId as number | undefined;
    const jobCardMessageId = meta?.jobCardMessageId as number | undefined;
    const jobNumber = meta?.jobNumber as number | undefined;
    const jobNumStr = jobNumber !== undefined ? String(jobNumber).padStart(3, "0") : "???";

    const classification = await classifyIntent(originalPrompt);
    const agent = AGENTS[classification.primaryAgent] ?? AGENTS["operations-hub"];
    const agentName = agent?.name ?? classification.primaryAgent;

    const plan: DispatchPlan = {
      dispatchId: job.id,
      userMessage: enrichedPrompt,
      classification,
      tasks: [{ seq: 1, agentId: classification.primaryAgent, topicHint: classification.topicHint, taskDescription: enrichedPrompt }],
    };

    try {
      const result = await runHarness(
        this.bot,
        plan,
        ccChatId ?? 0,
        jobTopicId ? Number(jobTopicId) : null,
        { resumeFrom: existingState ?? undefined },
      );

      const cancelled = result.outcome === "cancelled";
      const success = result.outcome === "done";
      if (ccChatId && jobCardMessageId) {
        const label = cancelled ? "🛑 Cancelled" : success ? "✅ Done" : "❌ Failed";
        await editMessage(ccChatId, jobCardMessageId, buildJobCard(jobNumStr, originalPrompt, agentName, label));
      }
      return { status: success ? "done" : "failed", summary: cancelled ? "cancelled by user" : result.outcome };
    } catch (err) {
      if (ccChatId && jobCardMessageId) {
        await editMessage(ccChatId, jobCardMessageId, buildJobCard(jobNumStr, originalPrompt, agentName, "❌ Failed"));
      }
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
