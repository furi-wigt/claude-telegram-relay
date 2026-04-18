// src/jobs/executors/routineExecutor.ts
import type { JobExecutor, ExecutorResult } from "./types.ts";
import type { Job, JobCheckpoint } from "../types.ts";
import { createRoutineContext } from "./routineContext.ts";
import { getRoutineConfig } from "../../routines/routineConfig.ts";
import type { RoutineContext } from "./routineContext.ts";
import type { RoutineConfig } from "../../routines/routineConfig.ts";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

type RoutineHandler = (ctx: RoutineContext) => Promise<void>;

/** Allowed directories for handler resolution — prevents path traversal */
const USER_ROUTINES_DIR = join(
  process.env.RELAY_USER_DIR ?? join(homedir(), ".claude-relay"),
  "routines",
);

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
 * Resolve handler path using dual-directory lookup:
 *   1. User directory: ~/.claude-relay/routines/<name>.ts
 *   2. Repo directory: routines/handlers/<name>.ts (relative import)
 *
 * Returns { path, source } or null if not found.
 */
function resolveHandlerPath(name: string): { path: string; source: "user" | "core" } | null {
  // Reject names with path traversal characters
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return null;

  // 1. User directory (absolute path)
  const userPath = join(USER_ROUTINES_DIR, `${name}.ts`);
  if (existsSync(userPath)) {
    return { path: userPath, source: "user" };
  }

  // 2. Repo directory (relative import from src/jobs/executors/)
  const repoRelative = `../../../routines/handlers/${name}.ts`;
  // Resolve to absolute to check existence, but return relative for import
  const repoAbsolute = join(import.meta.dir, "..", "..", "..", "routines", "handlers", `${name}.ts`);
  if (existsSync(repoAbsolute)) {
    return { path: repoRelative, source: "core" };
  }

  return null;
}

/**
 * Executes routine handlers from two directories:
 *   - Core handlers: routines/handlers/*.ts (shipped with repo)
 *   - User handlers: ~/.claude-relay/routines/*.ts (user-specific)
 *
 * Handler signature: (ctx: RoutineContext) => Promise<void>
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
   * Dynamically import and register a handler from a given path.
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
      const resolved = resolveHandlerPath(job.executor);
      if (resolved) {
        try {
          const mod = await import(resolved.path);
          if (typeof mod.run !== "function") {
            return {
              status: "failed",
              error: `handler ${job.executor} does not export run()`,
            };
          }
          handler = mod.run as RoutineHandler;
          this.handlers.set(job.executor, handler);
          console.log(`[routineExecutor] lazy-loaded ${resolved.source} handler: ${job.executor}`);
        } catch (importErr) {
          return {
            status: "failed",
            error: `failed to import handler "${job.executor}" from ${resolved.source}: ${importErr instanceof Error ? importErr.message : String(importErr)}`,
          };
        }
      } else {
        // No handler file found — check for inline prompt payload
        const prompt = job.payload?.prompt as string | undefined;
        if (prompt) {
          const config = getRoutineConfig(job.executor) ?? minimalConfig(job);
          const ctx = createRoutineContext(config);
          try {
            const response = await ctx.llm(prompt);
            await ctx.send(response);
            return { status: "done" };
          } catch (llmErr) {
            return {
              status: "failed",
              error: `inline prompt failed for "${job.executor}": ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`,
            };
          }
        }
        return {
          status: "failed",
          error: `no handler registered for "${job.executor}" and no inline prompt provided`,
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

// Export for testing
export { resolveHandlerPath, USER_ROUTINES_DIR };
