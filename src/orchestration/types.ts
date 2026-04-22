/**
 * Orchestration Layer — Shared Types
 *
 * Interfaces for the CC orchestration pipeline:
 * intent classification → dispatch plan → harness execution.
 */

// ── Intent Classification ───────────────────────────────────────────────────

export interface ClassificationResult {
  /** Classified intent label (e.g. "security-audit", "code-review") */
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
  /** Execution order */
  seq: number;
  /** Target agent ID */
  agentId: string;
  /** Topic name hint (null = root) */
  topicHint: string | null;
  /** What to tell the agent */
  taskDescription: string;
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
  /**
   * Pre-computed vision description for photo attachments sent to CC.
   * Analyzed once at CC entry; injected into every step's taskDescription.
   */
  imageContext?: string;
  /**
   * Lightweight listing of non-image attachments (PDF/XLSX/CSV/etc.) sent to CC:
   * filename, mime, size, and on-disk path. Built once at CC entry (no content
   * extraction — agents read files lazily via Read/extractPdf tools). Prefixed
   * into every step's taskDescription so each agent sees the available files.
   */
  documentContext?: string;
  /**
   * Local file paths of downloaded attachments (photos AND documents).
   * Persisted in DispatchState so clarify-resume can re-inject them after restart.
   */
  attachmentPaths?: string[];
  /**
   * Working directory captured from the CC session at plan-creation time.
   * Propagated to every dispatched agent step so they all operate in the same directory.
   * Persisted in DispatchState so cwd survives suspend/resume restarts.
   */
  cwd?: string;
  /**
   * When true (set from Contract.isolate), the command center creates a dedicated
   * forum topic in the CC group for this dispatch and routes all step outputs there.
   */
  isolate?: boolean;
  /**
   * ID of the forum topic created for this dispatch (if `isolate` is true and
   * topic creation succeeded). Persisted in DispatchState for suspend/resume.
   */
  isolateTopicId?: number;
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
