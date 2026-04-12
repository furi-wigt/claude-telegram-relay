// src/jobs/types.ts

export type JobSource = "telegram" | "cron" | "webhook" | "agent" | "cli";

export type JobType = "claude-session" | "routine" | "api-call" | "compound";

export type JobPriority = "urgent" | "normal" | "background";

export type JobStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "paused"
  | "preempted"
  | "awaiting-intervention";

export type InterventionType =
  | "approval"
  | "clarification"
  | "e2e"
  | "error-recovery"
  | "budget";

export type AutoResolvePolicy =
  | "none"
  | "approve_after_timeout"
  | "skip_after_timeout"
  | "abort_after_timeout";

export interface Job {
  id: string;
  dedup_key: string | null;
  source: JobSource;
  type: JobType;
  priority: JobPriority;
  executor: string;
  title: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  intervention_type: InterventionType | null;
  intervention_prompt: string | null;
  intervention_due_at: string | null;
  auto_resolve_policy: AutoResolvePolicy | null;
  auto_resolve_timeout_ms: number | null;
  retry_count: number;
  timeout_ms: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
}

export interface JobCheckpoint {
  id: string;
  job_id: string;
  round: number;
  state: Record<string, unknown>;
  created_at: string;
}

export interface SubmitJobInput {
  type: JobType;
  executor: string;
  title: string;
  priority?: JobPriority;
  source?: JobSource;
  dedup_key?: string;
  payload?: Record<string, unknown>;
  timeout_ms?: number;
  auto_resolve_policy?: AutoResolvePolicy;
  auto_resolve_timeout_ms?: number;
  metadata?: Record<string, unknown>;
}

/** Default running timeouts per job type (ms) */
export const DEFAULT_TIMEOUT_MS: Record<JobType, number> = {
  routine: 5 * 60 * 1000,       // 5 min
  "api-call": 2 * 60 * 1000,    // 2 min
  "claude-session": 30 * 60 * 1000, // 30 min
  compound: 60 * 60 * 1000,     // 60 min
};

/** Default auto-resolve policies per job type */
export const DEFAULT_AUTO_RESOLVE: Record<JobType, { policy: AutoResolvePolicy; timeoutMs: number }> = {
  routine: { policy: "skip_after_timeout", timeoutMs: 2 * 60 * 60 * 1000 },       // 2h
  "api-call": { policy: "abort_after_timeout", timeoutMs: 4 * 60 * 60 * 1000 },   // 4h
  "claude-session": { policy: "none", timeoutMs: 0 },
  compound: { policy: "none", timeoutMs: 0 },
};

/** Concurrency caps per job type */
export const MAX_CONCURRENT: Record<JobType, number> = {
  "claude-session": 1,
  compound: 2,
  routine: 3,
  "api-call": 5,
};

/** Priority lane ordering — lower index = higher priority */
export const PRIORITY_ORDER: JobPriority[] = ["urgent", "normal", "background"];
