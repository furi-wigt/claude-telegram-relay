// src/jobs/executors/claudeSessionExecutor.ts
import type { JobExecutor, ExecutorResult } from "./types.ts";
import type { Job, JobCheckpoint } from "../types.ts";
import type { JobStore } from "../jobStore.ts";
import { getDispatchRunner } from "../../orchestration/dispatchEngine.ts";
import { classifyIntent } from "../../orchestration/intentClassifier.ts";
import { AGENTS } from "../../agents/config.ts";

export class ClaudeSessionExecutor implements JobExecutor {
  readonly type = "claude-session" as const;
  readonly maxConcurrent = 1;

  constructor(private store: JobStore) {}

  async execute(job: Job, checkpoint?: JobCheckpoint): Promise<ExecutorResult> {
    const prompt = job.payload.prompt as string | undefined;
    if (!prompt) {
      return { status: "failed", error: "payload.prompt required" };
    }

    const chatId = (job.metadata as Record<string, unknown>)?.chatId as number | undefined;
    const threadId = (job.metadata as Record<string, unknown>)?.threadId as number | undefined;

    const runner = getDispatchRunner();
    if (!runner) {
      return { status: "failed", error: "dispatch runner not available — is the bot running?" };
    }

    if (checkpoint) {
      console.warn(`[claudeSessionExecutor] checkpoint found for job ${job.id.slice(0, 8)} — re-running from scratch (v1)`);
    }

    try {
      const classification = await classifyIntent(prompt);
      const agent = AGENTS[classification.primaryAgent] ?? AGENTS["operations-hub"];
      const agentChatId = agent?.chatId ?? 0;

      // Run via dispatch runner — direct pipeline invocation
      const response = await runner(agentChatId, null, prompt) ?? "Done";

      if (chatId) {
        const { sendToGroup } = await import("../../utils/sendToGroup.ts");
        await sendToGroup(chatId, response, { topicId: threadId });
      }

      this.store.insertCheckpoint(job.id, 0, { sessionId: job.id });

      return { status: "done", summary: response.slice(0, 500) };
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
