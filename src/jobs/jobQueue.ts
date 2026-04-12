// src/jobs/jobQueue.ts
import type { Job, JobType } from "./types.ts";
import { MAX_CONCURRENT } from "./types.ts";
import type { JobStore } from "./jobStore.ts";
import type { ExecutorRegistry } from "./executors/registry.ts";
import type { InterventionManager } from "./interventionManager.ts";

const HEARTBEAT_MS = 500;
const MAX_RETRIES = 3;

export class JobQueue {
  private wakeResolve: (() => void) | null = null;
  private running = false;

  constructor(
    private store: JobStore,
    private registry: ExecutorRegistry,
    private intervention: InterventionManager
  ) {}

  /** Signal the scheduler to check for work immediately */
  wake(): void {
    if (this.wakeResolve) {
      this.wakeResolve();
      this.wakeResolve = null;
    }
  }

  /** Start the event-driven scheduler loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    console.log("[jobs:queue] scheduler started");
    this.loop();
  }

  /** Stop the scheduler */
  stop(): void {
    this.running = false;
    this.wake(); // unblock any waiting tick
  }

  /** Main loop — waits for wake signal or heartbeat, then dispatches */
  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        console.error("[jobs:queue] tick error:", err);
      }

      // Wait for wake signal or heartbeat
      await Promise.race([
        new Promise<void>((resolve) => {
          this.wakeResolve = resolve;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, HEARTBEAT_MS)),
      ]);
    }
  }

  /** Single dispatch cycle — exposed for testing */
  async tick(): Promise<void> {
    // 1. Check for timed-out running jobs
    this.handleTimeouts();

    // 2. Process expired auto-resolve interventions
    this.intervention.processExpiredInterventions();

    // 3. Dispatch pending jobs
    await this.dispatchPending();
  }

  private handleTimeouts(): void {
    const timedOut = this.store.getTimedOutJobs();
    for (const job of timedOut) {
      console.log(`[jobs:queue] timeout: ${job.title} (${job.id.slice(0, 8)})`);
      this.store.setError(job.id, `Timed out after ${job.timeout_ms}ms`);

      if (job.retry_count < MAX_RETRIES) {
        this.store.incrementRetry(job.id);
        this.store.updateStatus(job.id, "pending");
        console.log(`[jobs:queue] re-queued ${job.id.slice(0, 8)} (retry ${job.retry_count + 1}/${MAX_RETRIES})`);
      } else {
        this.store.updateStatus(job.id, "failed");
        console.log(`[jobs:queue] permanently failed (timeout + max retries): ${job.title}`);
      }
    }
  }

  private async dispatchPending(): Promise<void> {
    const pending = this.store.getPendingByPriority();

    // Track how many jobs we've started per type within this tick
    // so concurrency checks are accurate before the DB reflects "running"
    const startedThisTick = new Map<JobType, number>();

    const dispatches: Promise<void>[] = [];

    for (const job of pending) {
      const executor = this.registry.getForJob(job.executor, job.type);
      if (!executor) {
        this.store.setError(job.id, `no executor registered for "${job.executor}" (type=${job.type})`);
        this.store.updateStatus(job.id, "failed");
        continue;
      }

      // Concurrency cap = minimum of global type cap and executor-specific cap
      const globalCap = MAX_CONCURRENT[job.type] ?? executor.maxConcurrent;
      const cap = Math.min(globalCap, executor.maxConcurrent);

      // Running count = DB running + jobs started this tick not yet reflected in DB
      const dbRunning = this.store.countRunningByType(job.type);
      const tickRunning = startedThisTick.get(job.type) ?? 0;
      const totalRunning = dbRunning + tickRunning;

      if (totalRunning >= cap) {
        continue; // slot full for this type
      }

      // Mark as running immediately so DB count is correct for subsequent loop iterations
      this.store.updateStatus(job.id, "running");
      // Track in-tick concurrency to handle jobs dispatched faster than DB reads update
      startedThisTick.set(job.type, tickRunning + 1);

      // Fire without awaiting — allows true concurrent execution
      const p = this.executeJob(job).catch((err) => {
        console.error(`[jobs:queue] unhandled executor error for ${job.id.slice(0, 8)}:`, err);
      });
      dispatches.push(p);
    }

    // Wait for all dispatched jobs to settle (important for tick() in tests)
    await Promise.all(dispatches);
  }

  private async executeJob(job: Job): Promise<void> {
    const executor = this.registry.getForJob(job.executor, job.type)!;
    const checkpoint = this.store.getLatestCheckpoint(job.id) ?? undefined;

    try {
      const result = await executor.execute(job, checkpoint);

      switch (result.status) {
        case "done":
          this.store.updateStatus(job.id, "done");
          console.log(`[jobs:queue] done: ${job.title} (${job.id.slice(0, 8)})`);
          break;

        case "failed": {
          this.store.setError(job.id, result.error ?? "executor returned failed");
          if (job.retry_count < MAX_RETRIES) {
            this.store.incrementRetry(job.id);
            this.store.updateStatus(job.id, "pending");
            console.log(`[jobs:queue] failed + re-queued: ${job.title} (retry ${job.retry_count + 1}/${MAX_RETRIES})`);
          } else {
            this.store.updateStatus(job.id, "failed");
            console.log(`[jobs:queue] permanently failed (max retries): ${job.title}`);
          }
          break;
        }

        case "awaiting-intervention":
          await this.intervention.handleIntervention(job.id, result);
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.store.setError(job.id, msg);
      if (job.retry_count < MAX_RETRIES) {
        this.store.incrementRetry(job.id);
        this.store.updateStatus(job.id, "pending");
      } else {
        this.store.updateStatus(job.id, "failed");
      }
    }

    this.wake(); // signal scheduler to check for next job
  }
}
