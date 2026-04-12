// src/jobs/executors/routineExecutor.ts
import type { JobExecutor, ExecutorResult } from "./types.ts";
import type { Job, JobCheckpoint } from "../types.ts";

type RoutineHandler = (job: Job) => Promise<string | void>;

/**
 * Executes routine handlers (routines/handlers/*.ts).
 * Handlers are registered at startup or dynamically imported.
 */
export class RoutineExecutor implements JobExecutor {
  readonly type = "routine" as const;
  readonly maxConcurrent = 3;

  private handlers = new Map<string, RoutineHandler>();

  /** Register a handler function for a named routine */
  registerHandler(name: string, handler: RoutineHandler): void {
    this.handlers.set(name, handler);
  }

  /**
   * Dynamically import and register a handler from routines/handlers/<name>.ts.
   * The module must export a `run` function.
   */
  async loadHandler(name: string, path: string): Promise<void> {
    try {
      const mod = await import(path);
      if (typeof mod.run !== "function") {
        console.warn(`[routineExecutor] ${path} does not export a run() function`);
        return;
      }
      this.registerHandler(name, mod.run);
      console.log(`[routineExecutor] loaded handler: ${name}`);
    } catch (err) {
      console.error(`[routineExecutor] failed to load ${path}:`, err);
    }
  }

  async execute(job: Job, _checkpoint?: JobCheckpoint): Promise<ExecutorResult> {
    const handler = this.handlers.get(job.executor);
    if (!handler) {
      return {
        status: "failed",
        error: `no handler registered for "${job.executor}"`,
      };
    }

    try {
      const summary = await handler(job);
      return {
        status: "done",
        summary: typeof summary === "string" ? summary : undefined,
      };
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
