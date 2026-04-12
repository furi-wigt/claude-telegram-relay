// src/jobs/executors/types.ts
import type { Job, JobCheckpoint, InterventionType, AutoResolvePolicy, JobType } from "../types.ts";

export interface ExecutorResult {
  status: "done" | "failed" | "awaiting-intervention";
  intervention?: {
    type: InterventionType;
    prompt: string;
    dueInMs: number;
    autoResolvePolicy?: AutoResolvePolicy;
    autoResolveTimeoutMs?: number;
    autoProceedConfidence?: number;
    e2eScenario?: string;
  };
  error?: string;
  summary?: string;
  artifactPath?: string;
}

export interface JobExecutor {
  type: JobType;
  maxConcurrent: number;
  execute(job: Job, checkpoint?: JobCheckpoint): Promise<ExecutorResult>;
  checkpoint?(job: Job, state: unknown): Promise<void>;
}
