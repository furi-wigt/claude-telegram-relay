// src/jobs/executors/routineExecutor.ts
import type { JobExecutor, ExecutorResult } from "./types.ts";
import type { Job, JobCheckpoint } from "../types.ts";
import { createRoutineContext } from "./routineContext.ts";
import { getRoutineConfig } from "../../routines/routineConfig.ts";
import type { RoutineContext } from "./routineContext.ts";
import type { RoutineConfig } from "../../routines/routineConfig.ts";

type RoutineHandler = (ctx: RoutineContext) => Promise<void>;

function minimalConfig(job: Job): RoutineConfig {
  return {
    name: job.executor,
    type: "handler",
    schedule: "",
    group: "OPERATIONS",
    enabled: true,
  };
}

/**
 * Executes routine handlers (routines/handlers/*.ts).
 * Handlers are registered at startup or dynamically imported.
 *
 * Handler signature: (ctx: RoutineContext) => Promise<void>
 * Legacy `(job: Job) => Promise<string | void>` handlers should be updated to new signature.
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
      this.registerHandler(name, mod.run as RoutineHandler);
      console.log(`[routineExecutor] loaded handler: ${name}`);
    } catch (err) {
      console.error(`[routineExecutor] failed to load ${path}:`, err);
    }
  }

  async execute(job: Job, _checkpoint?: JobCheckpoint): Promise<ExecutorResult> {
    let handler = this.handlers.get(job.executor);

    if (!handler) {
      // Lazy dynamic import from routines/handlers/<name>.ts
      try {
        const handlerPath = `../../routines/handlers/${job.executor}.ts`;
        const mod = await import(handlerPath);
        if (typeof mod.run !== "function") {
          return {
            status: "failed",
            error: `handler ${job.executor} does not export run()`,
          };
        }
        handler = mod.run as RoutineHandler;
        this.handlers.set(job.executor, handler);
        console.log(`[routineExecutor] lazy-loaded handler: ${job.executor}`);
      } catch (err) {
        return {
          status: "failed",
          error: `no handler registered for "${job.executor}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const config = getRoutineConfig(job.executor) ?? minimalConfig(job);
    const ctx = createRoutineContext(config);

    try {
      await handler(ctx);
      return { status: "done" };
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
