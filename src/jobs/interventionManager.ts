// src/jobs/interventionManager.ts
import type { Job } from "./types.ts";
import type { JobStore } from "./jobStore.ts";
import type { AutoApproveEngine } from "./autoApproveEngine.ts";
import type { ExecutorResult } from "./executors/types.ts";
import { DEFAULT_AUTO_RESOLVE } from "./types.ts";

type ResolutionAction = "confirm" | "skip" | "abort";
type HandleResult = "auto-approved" | "auto-proceeded" | "notified";

interface InterventionOptions {
  notify: (job: Job) => Promise<void>;
  reminderMinutes: number;
  t3Minutes: number;
}

export class InterventionManager {
  constructor(
    private store: JobStore,
    private autoApprove: AutoApproveEngine,
    private options: InterventionOptions
  ) {}

  /**
   * Run the automation-first cascade when an executor signals awaiting-intervention.
   * Returns what happened: auto-approved, auto-proceeded, or notified (human fallback).
   */
  async handleIntervention(jobId: string, result: ExecutorResult): Promise<HandleResult> {
    const intervention = result.intervention!;
    const job = this.store.getJob(jobId)!;

    // Step 1: Auto-approve rules — evaluate by temporarily assigning intervention_type
    const autoAction = this.autoApprove.evaluate({
      ...job,
      intervention_type: intervention.type,
    });
    if (autoAction) {
      this.resolveIntervention(jobId, autoAction);
      console.log(`[jobs:intervention] auto-approved ${jobId.slice(0, 8)} via rule (action=${autoAction})`);
      return "auto-approved";
    }

    // Step 2: Confidence-based auto-proceed
    if (intervention.autoProceedConfidence && intervention.autoProceedConfidence >= 0.85) {
      this.store.clearIntervention(jobId, "running");
      this.store.insertCheckpoint(jobId, 0, {
        resolution: "auto-proceeded",
        confidence: intervention.autoProceedConfidence,
      });
      console.log(`[jobs:intervention] auto-proceeded ${jobId.slice(0, 8)} (confidence=${intervention.autoProceedConfidence})`);
      return "auto-proceeded";
    }

    // Step 3: E2E auto-verification (Playwright) — placeholder for integration
    // When intervention.type === "e2e" && intervention.e2eScenario exists,
    // this will route to the Playwright runner. For now, falls through.

    // Step 4: Set up auto-resolve policy if applicable
    const typeDefaults = DEFAULT_AUTO_RESOLVE[job.type];
    const policy = intervention.autoResolvePolicy ?? typeDefaults.policy;
    const timeoutMs = intervention.autoResolveTimeoutMs ?? typeDefaults.timeoutMs;

    // Step 5: Fall through to human notification
    const dueAt = new Date(Date.now() + intervention.dueInMs).toISOString();
    this.store.setIntervention(jobId, {
      type: intervention.type,
      prompt: intervention.prompt,
      due_at: dueAt,
      auto_resolve_policy: policy,
      auto_resolve_timeout_ms: timeoutMs > 0 ? timeoutMs : undefined,
    });

    const updatedJob = this.store.getJob(jobId)!;
    await this.options.notify(updatedJob);
    console.log(`[jobs:intervention] notified human for ${jobId.slice(0, 8)} (type=${intervention.type})`);
    return "notified";
  }

  /**
   * Resolve an intervention — called by Telegram callback, CLI, or auto-resolve timer.
   */
  resolveIntervention(jobId: string, action: ResolutionAction): void {
    switch (action) {
      case "confirm":
        this.store.clearIntervention(jobId, "running");
        this.store.insertCheckpoint(jobId, 0, { resolution: "confirmed" });
        break;
      case "skip":
        this.store.clearIntervention(jobId, "done");
        break;
      case "abort":
        this.store.clearIntervention(jobId, "cancelled");
        break;
    }
    console.log(`[jobs:intervention] resolved ${jobId.slice(0, 8)} → ${action}`);
  }

  /**
   * Process expired auto-resolve policies (called by scheduler heartbeat).
   */
  processExpiredInterventions(): void {
    const expired = this.store.getExpiredInterventions();
    for (const job of expired) {
      const policy = job.auto_resolve_policy!;
      let action: ResolutionAction;
      switch (policy) {
        case "approve_after_timeout":
          action = "confirm";
          break;
        case "skip_after_timeout":
          action = "skip";
          break;
        case "abort_after_timeout":
          action = "abort";
          break;
        default:
          continue;
      }
      console.log(`[jobs:intervention] auto-resolving ${job.id.slice(0, 8)} via policy ${policy}`);
      this.resolveIntervention(job.id, action);
    }
  }
}
