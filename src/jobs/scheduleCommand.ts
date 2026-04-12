// src/jobs/scheduleCommand.ts
//
// Extracted handler logic for the /schedule command.
// Kept separate so it can be unit-tested without importing relay.ts.

import type { Job, SubmitJobInput } from "./types.ts";

export interface ScheduleCommandDeps {
  submitJob: (input: SubmitJobInput) => Job | null;
}

export interface ScheduleCommandContext {
  chatId: number | undefined;
  threadId: number | undefined;
  prompt: string;
}

export type ScheduleCommandResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: "no-prompt" | "submit-failed" };

/**
 * Core logic for the /schedule bot command.
 *
 * Returns a discriminated union so the caller (relay.ts or tests) can
 * decide how to reply without the function touching ctx directly.
 */
export function handleScheduleCommand(
  deps: ScheduleCommandDeps,
  ctx: ScheduleCommandContext
): ScheduleCommandResult {
  if (!ctx.prompt) {
    return { ok: false, reason: "no-prompt" };
  }

  const job = deps.submitJob({
    type: "claude-session",
    executor: "claude-session",
    title: ctx.prompt.slice(0, 80),
    source: "telegram",
    priority: "normal",
    payload: { prompt: ctx.prompt },
    metadata: {
      chatId: ctx.chatId,
      threadId: ctx.threadId,
    },
  });

  if (!job) {
    return { ok: false, reason: "submit-failed" };
  }

  return { ok: true, jobId: job.id };
}
