/**
 * Types for user-created routines.
 */

export interface UserRoutineConfig {
  /** Slug name for the routine, e.g. "daily-aws-check" */
  name: string;
  /** Cron expression, e.g. "0 18 * * *" */
  cron: string;
  /** Human-readable schedule, e.g. "Daily at 6pm" */
  scheduleDescription: string;
  /** Prompt sent to Claude when the routine runs */
  prompt: string;
  /** Telegram chat_id to send output to */
  chatId: number;
  /** Telegram forum topic thread ID (message_thread_id). null = root chat. */
  topicId: number | null;
  /** Human-readable label for the target, e.g. "General group" */
  targetLabel: string;
  /** ISO timestamp of creation */
  createdAt: string;
}

export interface PendingRoutine {
  /** Partial config waiting for user confirmation (chatId/topicId not yet set) */
  config: Omit<UserRoutineConfig, "chatId" | "topicId" | "targetLabel" | "createdAt">;
  /** Timestamp the pending entry was created */
  createdAt: number;
}

export type PM2Status = "online" | "stopped" | "errored" | "launching" | "unknown";

export interface PM2ProcessInfo {
  name: string;
  status: PM2Status;
  pid: number | null;
  uptime: number | null;
}

export interface CodeRoutineEntry {
  /** e.g. "aws-daily-cost" */
  name: string;
  /** e.g. "routines/aws-daily-cost.ts" */
  scriptPath: string;
  /** null if not registered in ecosystem.config.cjs */
  cron: string | null;
  /** true if registered in ecosystem.config.cjs */
  registered: boolean;
  /** null if not registered/running */
  pm2Status: PM2Status | null;
  /** from @description JSDoc header in the file */
  description?: string;
  /** from @schedule JSDoc header in the file (for unregistered routines) */
  intendedSchedule?: string;
}
