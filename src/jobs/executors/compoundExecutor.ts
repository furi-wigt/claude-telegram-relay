// src/jobs/executors/compoundExecutor.ts
import type { JobExecutor, ExecutorResult } from "./types.ts";
import type { Job, JobCheckpoint } from "../types.ts";
import type { JobStore } from "../jobStore.ts";
import { getDispatchRunner, executeBlackboardDispatch } from "../../orchestration/dispatchEngine.ts";
import { getDb } from "../../local/db.ts";
import type { DispatchPlan } from "../../orchestration/types.ts";

export class CompoundExecutor implements JobExecutor {
  readonly type = "compound" as const;
  readonly maxConcurrent = 2;

  constructor(private store: JobStore) {}

  async execute(job: Job, checkpoint?: JobCheckpoint): Promise<ExecutorResult> {
    const plan = job.payload.plan as DispatchPlan | undefined;
    if (!plan) {
      return { status: "failed", error: "payload.plan required" };
    }

    const runner = getDispatchRunner();
    if (!runner) {
      return { status: "failed", error: "dispatch runner not available" };
    }

    // Agent overlap guard — prevent same agent running in two concurrent compound jobs
    const runningAgentIds = this.store.getRunningCompoundAgentIds();
    const planAgentIds = new Set(
      (plan.tasks ?? []).map((t: { agentId?: string }) => t.agentId).filter(Boolean)
    );
    const overlap = [...planAgentIds].filter((id) => runningAgentIds.has(id as string));

    if (overlap.length > 0) {
      return {
        status: "awaiting-intervention",
        intervention: {
          type: "approval",
          prompt: `Agents ${overlap.join(", ")} are currently busy in another compound job. Wait for them to finish?`,
          dueInMs: 5 * 60 * 1000,
          autoResolvePolicy: "approve_after_timeout",
          autoResolveTimeoutMs: 10 * 60 * 1000,
        },
      };
    }

    if (checkpoint) {
      console.warn(`[compoundExecutor] checkpoint found for ${job.id.slice(0, 8)} — re-running (v1)`);
    }

    try {
      const db = getDb();
      const result = await executeBlackboardDispatch(db, plan, runner);
      this.store.insertCheckpoint(job.id, 0, { sessionId: result.sessionId ?? job.id });

      return {
        status: result.success ? "done" : "failed",
        summary: result.response?.slice(0, 500),
        error: result.success ? undefined : (result.response ?? "Dispatch failed"),
      };
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
