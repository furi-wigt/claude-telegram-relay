/**
 * Orchestration Layer — Shared Types
 *
 * Interfaces for the Command Center orchestration pipeline:
 * intent classification → dispatch plan → execution → aggregation.
 */

// ── Intent Classification ───────────────────────────────────────────────────

export interface ClassificationResult {
  /** Classified intent label (e.g. "security-review", "meeting-prep") */
  intent: string;
  /** Best-fit agent ID */
  primaryAgent: string;
  /** Suggested topic name in the target agent group (null = root) */
  topicHint: string | null;
  /** Whether this requires multiple agents (compound task) */
  isCompound: boolean;
  /** Classification confidence 0-1 */
  confidence: number;
  /** Brief explanation shown to user */
  reasoning: string;
}

// ── Dispatch Plan ───────────────────────────────────────────────────────────

export type DispatchStatus =
  | "planning"
  | "countdown"
  | "dispatching"
  | "in_progress"
  | "paused"
  | "done"
  | "cancelled"
  | "failed";

export type TaskStatus =
  | "pending"
  | "dispatched"
  | "in_progress"
  | "done"
  | "failed"
  | "cancelled";

export interface SubTask {
  /** Execution order — same seq = parallel */
  seq: number;
  /** Target agent ID */
  agentId: string;
  /** Topic name hint (null = root) */
  topicHint: string | null;
  /** What to tell the agent */
  taskDescription: string;
  /** Seq numbers this depends on */
  dependsOn?: number[];
}

export interface DispatchPlan {
  /** Unique dispatch ID */
  dispatchId: string;
  /** Original user message */
  userMessage: string;
  /** Classification result */
  classification: ClassificationResult;
  /** Sub-tasks to execute */
  tasks: SubTask[];
  /** Telegram message ID of the plan message in CC */
  planMessageId?: number;
}

// ── Dispatch Events (emitted by engine) ─────────────────────────────────────

export type DispatchEvent =
  | { type: "plan_posted"; planMessageId: number }
  | { type: "countdown_tick"; secondsLeft: number }
  | { type: "countdown_cancelled" }
  | { type: "dispatched"; taskIndex: number; agentMessageId?: number }
  | { type: "task_complete"; taskIndex: number; resultSummary: string }
  | { type: "task_failed"; taskIndex: number; error: string }
  | { type: "dispatch_complete"; totalDurationMs: number }
  | { type: "dispatch_cancelled" };

// ── DB Row Types ────────────────────────────────────────────────────────────

export interface DispatchRow {
  id: string;
  command_center_msg_id: number | null;
  user_message: string;
  intent: string | null;
  confidence: number | null;
  is_compound: number; // SQLite boolean
  status: string;
  plan_json: string | null;
  created_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  metadata: string | null;
}

export interface DispatchTaskRow {
  id: string;
  dispatch_id: string;
  seq: number;
  agent_id: string;
  topic_hint: string | null;
  task_description: string | null;
  status: string;
  agent_message_id: number | null;
  result_summary: string | null;
  result_artifact_path: string | null;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

// ── Interrupt Protocol ──────────────────────────────────────────────────────

export type InterruptAction = "pause" | "edit" | "cancel" | "resume";

export interface CountdownState {
  dispatchId: string;
  secondsLeft: number;
  timer: ReturnType<typeof setTimeout> | null;
  status: "counting" | "paused" | "cancelled" | "dispatched";
  planMessageId: number;
  chatId: number;
  threadId: number | null;
}

// ── Blackboard Types ───────────────────────────────────────────────────────

export type BbSpace = "input" | "tasks" | "evidence" | "artifacts" | "decisions" | "reviews" | "conflicts" | "final";

export type BbRecordType = "task" | "finding" | "artifact" | "decision" | "review" | "conflict" | "output";

export type BbSessionStatus = "active" | "finalizing" | "done" | "failed" | "cancelled";

export type BbRecordStatus = "pending" | "active" | "done" | "failed" | "superseded" | "archived";

export interface BbSession {
  id: string;
  dispatch_id: string | null;
  status: BbSessionStatus;
  workflow: string;
  max_rounds: number;
  current_round: number;
  budget_tokens: number | null;
  created_at: string;
  completed_at: string | null;
  metadata: string | null;
}

export interface BbRecord {
  id: string;
  session_id: string;
  space: BbSpace;
  record_type: BbRecordType;
  producer: string | null;
  owner: string | null;
  status: BbRecordStatus;
  confidence: number | null;
  content: string; // JSON
  parent_id: string | null;
  supersedes: string | null;
  round: number | null;
  created_at: string;
  updated_at: string | null;
}

/** Content shape for task records in the tasks space */
export interface BbTaskContent {
  taskDescription: string;
  agentId: string;
  seq: number;
  dependsOn: number[];
  topicHint: string | null;
  retryCount?: number;
}

/** Content shape for artifact/evidence records */
export interface BbArtifactContent {
  summary: string;
  fullResponse?: string;
  artifactPath?: string;
}

/** Returned by controlPlane.selectNextAgents() */
export interface AgentTrigger {
  rule: "INIT" | "EXECUTE" | "REVIEW" | "CONFLICT" | "FINALIZE" | "ESCALATE";
  agentId: string;
  taskRecordId?: string; // bb_records id of the task to execute
  reason: string;
}
