/**
 * Job Bridge — exposes job-layer operations to the orchestration layer.
 *
 * Follows the same singleton-setter pattern as dispatchEngine.ts to avoid
 * circular imports between src/jobs/ and src/orchestration/.
 *
 * Initialized once in src/jobs/index.ts at startup.
 */

import type { JobStore } from "./jobStore.ts";
import type { InterventionManager } from "./interventionManager.ts";
import type { Job } from "./types.ts";

let _store: JobStore | null = null;
let _intervention: InterventionManager | null = null;

export function initJobBridge(store: JobStore, intervention: InterventionManager): void {
  _store = store;
  _intervention = intervention;
}

/** Get a job by ID. Returns null if store not initialized or job not found. */
export function getBridgeJob(jobId: string): Job | null {
  return _store?.getJob(jobId) ?? null;
}

/**
 * Store the user's clarification answer and re-queue the suspended job.
 *
 * @returns true if the job was found, was awaiting clarification, and was re-queued.
 */
export function resumeJobWithAnswer(jobId: string, answer: string, question: string): boolean {
  if (!_store || !_intervention) return false;

  const job = _store.getJob(jobId);
  if (!job || job.status !== "awaiting-intervention" || job.intervention_type !== "clarification") {
    return false;
  }

  // Insert AFTER resolveIntervention's round-0 checkpoint so getLatestCheckpoint
  // returns ours (higher round = returned first by ORDER BY round DESC).
  _intervention.resolveIntervention(jobId, "confirm");
  const latest = _store.getLatestCheckpoint(jobId);
  const round = Math.max((latest?.round ?? 0), 0) + 1;
  _store.insertCheckpoint(jobId, round, { clarificationAnswer: answer, clarificationQuestion: question });
  return true;
}
