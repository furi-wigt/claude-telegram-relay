// src/jobs/executors/registry.ts
import type { JobExecutor } from "./types.ts";

export class ExecutorRegistry {
  private executors = new Map<string, JobExecutor>();

  register(name: string, executor: JobExecutor): void {
    this.executors.set(name, executor);
    console.log(`[jobs:registry] registered executor: ${name} (type=${executor.type}, max=${executor.maxConcurrent})`);
  }

  get(name: string): JobExecutor | undefined {
    return this.executors.get(name);
  }

  /** Look up by name first, then fall back to type-based lookup */
  getForJob(name: string, type: string): JobExecutor | undefined {
    return this.executors.get(name) ?? this.executors.get(type);
  }

  getMaxConcurrent(name: string): number {
    return this.executors.get(name)?.maxConcurrent ?? 1;
  }

  listRegistered(): string[] {
    return Array.from(this.executors.keys());
  }
}
