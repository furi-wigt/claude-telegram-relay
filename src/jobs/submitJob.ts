// src/jobs/submitJob.ts
import type { Job, SubmitJobInput } from "./types.ts";
import { DEFAULT_TIMEOUT_MS } from "./types.ts";
import type { JobStore } from "./jobStore.ts";

/**
 * Factory for the submitJob function.
 * Injects the store and a wake callback (signals the scheduler to check for new work).
 *
 * @param store - JobStore instance
 * @param wake - Callback to signal the scheduler about new jobs
 * @returns Function that submits jobs and returns them or null on dedup collision
 */
export function createSubmitJob(
  store: JobStore,
  wake: () => void
): (input: SubmitJobInput) => Job | null {
  return (input: SubmitJobInput): Job | null => {
    try {
      const job = store.insertJob({
        source: input.source ?? "cli",
        type: input.type,
        priority: input.priority ?? "normal",
        executor: input.executor,
        title: input.title,
        payload: input.payload ?? {},
        dedup_key: input.dedup_key,
        timeout_ms: input.timeout_ms ?? DEFAULT_TIMEOUT_MS[input.type],
        auto_resolve_policy: input.auto_resolve_policy,
        auto_resolve_timeout_ms: input.auto_resolve_timeout_ms,
        metadata: input.metadata,
      });

      console.log(
        `[jobs] submitted: ${job.title} (${job.id.slice(0, 8)}) priority=${job.priority} type=${job.type}`
      );
      wake();
      return job;
    } catch (err) {
      // Dedup key collision — job already exists for this key
      if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
        console.log(`[jobs] dedup: skipped ${input.dedup_key}`);
        return null;
      }
      throw err;
    }
  };
}
