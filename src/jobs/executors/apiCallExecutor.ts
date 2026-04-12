// src/jobs/executors/apiCallExecutor.ts
import type { JobExecutor, ExecutorResult } from "./types.ts";
import type { Job, JobCheckpoint } from "../types.ts";

interface ApiPayload {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  retries?: number;
}

export class ApiCallExecutor implements JobExecutor {
  readonly type = "api-call" as const;
  readonly maxConcurrent = 5;

  async execute(job: Job, _checkpoint?: JobCheckpoint): Promise<ExecutorResult> {
    const payload = job.payload as ApiPayload;

    if (!payload.url) {
      return { status: "failed", error: "payload.url is required" };
    }

    const maxRetries = payload.retries ?? 2;
    let lastError: string = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Exponential backoff: 1s, 2s, 4s...
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        }

        const response = await fetch(payload.url, {
          method: payload.method ?? "GET",
          headers: payload.headers,
          body: payload.body ? JSON.stringify(payload.body) : undefined,
        });

        if (response.status === 429 || response.status === 402) {
          return {
            status: "awaiting-intervention",
            intervention: {
              type: "budget",
              prompt: `API call to ${payload.url} returned ${response.status}. Proceed?`,
              dueInMs: 30 * 60 * 1000,
            },
          };
        }

        if (!response.ok) {
          lastError = `HTTP ${response.status}: ${await response.text().catch(() => "")}`;
          continue;
        }

        const responseBody = await response.text();
        return {
          status: "done",
          summary: `${payload.method ?? "GET"} ${payload.url} → ${response.status} (${responseBody.length} bytes)`,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return { status: "failed", error: `${maxRetries + 1} attempts failed: ${lastError}` };
  }
}
