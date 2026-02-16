/**
 * Type definitions for the agentic coding session system.
 */

export type SessionStatus =
  | "pending_permission"
  | "starting"
  | "running"
  | "waiting_for_input"
  | "waiting_for_plan"
  | "paused"
  | "completed"
  | "failed"
  | "killed";

export interface PendingQuestion {
  questionMessageId: number;
  questionText: string;
  options?: string[];
  toolUseId: string;
  askedAt: string;
  reminderSentAt?: string;
}

export interface PendingPlanApproval {
  planMessageIds: number[];
  planText: string;
  requestId: string;
  askedAt: string;
  reminderSentAt?: string;
  awaitingModificationReplyMessageId?: number;
}

export interface CodingSession {
  id: string;
  chatId: number;
  pinnedMessageId?: number;
  directory: string;
  projectName: string;
  task: string;
  status: SessionStatus;
  claudeSessionId?: string;
  pid?: number;
  useAgentTeam: boolean;
  startedAt: string;
  lastActivityAt: string;
  completedAt?: string;
  filesChanged: string[];
  summary?: string;
  errorMessage?: string;
  source: "bot" | "desktop";
  pendingQuestion?: PendingQuestion;
  pendingPlanApproval?: PendingPlanApproval;
  questionReminderTimerId?: ReturnType<typeof setTimeout>;
}

export interface PermittedDirectory {
  path: string;
  type: "exact" | "prefix";
  grantedAt: string;
  grantedByChatId: number;
}
