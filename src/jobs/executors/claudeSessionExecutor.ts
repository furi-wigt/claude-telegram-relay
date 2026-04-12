// src/jobs/executors/claudeSessionExecutor.ts
import type { JobExecutor, ExecutorResult } from "./types.ts";
import type { Job, JobCheckpoint } from "../types.ts";
import type { JobStore } from "../jobStore.ts";
import { getDispatchRunner, executeBlackboardDispatch } from "../../orchestration/dispatchEngine.ts";
import { classifyIntent } from "../../orchestration/intentClassifier.ts";
import { getDb } from "../../local/db.ts";
import type { DispatchPlan } from "../../orchestration/types.ts";

export class ClaudeSessionExecutor implements JobExecutor {
  readonly type = "claude-session" as const;
  readonly maxConcurrent = 1;

  constructor(private store: JobStore) {}

  async execute(job: Job, checkpoint?: JobCheckpoint): Promise<ExecutorResult> {
    // 1. Extract prompt from payload
    const prompt = job.payload.prompt as string | undefined;
    if (!prompt) {
      return { status: "failed", error: "payload.prompt required" };
    }

    // 2. Extract chatId, threadId from metadata
    const chatId = (job.metadata as Record<string, unknown>)?.chatId as number | undefined;
    const threadId = (job.metadata as Record<string, unknown>)?.threadId as number | undefined;

    // 3. Get dispatch runner
    const runner = getDispatchRunner();
    if (!runner) {
      return { status: "failed", error: "dispatch runner not available — is the bot running?" };
    }

    // 4. If checkpoint exists, log warning and re-run (v1 — no resume)
    if (checkpoint) {
      console.warn(
        `[claudeSessionExecutor] checkpoint found for job ${job.id.slice(0, 8)} — re-running from scratch (v1)`
      );
    }

    try {
      // 5. Classify intent
      const classification = await classifyIntent(prompt);

      // 6. Build dispatch plan — single-agent for v1 (isCompound handled by blackboard loop)
      const dispatchId = crypto.randomUUID();
      const plan: DispatchPlan = {
        dispatchId,
        userMessage: prompt,
        classification,
        tasks: [
          {
            seq: 1,
            agentId: classification.primaryAgent,
            taskDescription: prompt,
            dependsOn: [],
            topicHint: classification.topicHint,
          },
        ],
      };

      // 7. Execute via blackboard dispatch
      const db = getDb();
      const result = await executeBlackboardDispatch(db, plan, runner);
      const response = result.response ?? "Done";

      // 8. If chatId, post result back to the originating Telegram chat
      if (chatId) {
        const { sendToGroup } = await import("../../utils/sendToGroup.ts");
        await sendToGroup(chatId, response, { topicId: threadId });
      }

      // 9. Store checkpoint with sessionId for future resume support
      this.store.insertCheckpoint(job.id, 0, { sessionId: result.sessionId });

      return { status: "done", summary: response.slice(0, 500) };
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
