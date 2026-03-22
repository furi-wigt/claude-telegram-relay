/**
 * Things 3 CLI helper — subprocess wrapper for the `t3` CLI tool.
 *
 * Calls `t3 <view> --json` and parses the JSON output.
 * Used by routines to fetch tasks without going through the
 * integrations/things/ layer (which uses clings).
 */

import { spawn } from "bun";

const T3_PATH = process.env.T3_PATH || "t3";
const T3_TIMEOUT_MS = 10_000;

export interface T3Task {
  uuid: string;
  type: "to-do" | "project";
  title: string;
  status: "incomplete" | "completed" | "canceled";
  notes?: string;
  tags?: string[];
  project_title?: string;
  heading_title?: string;
  area_title?: string;
  start?: string;
  start_date?: string;
  deadline?: string | null;
  stop_date?: string | null;
  created?: string;
  modified?: string | null;
}

/**
 * Fetch tasks from a single t3 view.
 * Returns empty array on timeout or error (graceful degradation).
 */
export async function fetchT3View(view: string): Promise<T3Task[]> {
  try {
    const proc = spawn([T3_PATH, view], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = setTimeout(() => proc.kill(), T3_TIMEOUT_MS);
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.warn(`[t3Helper] t3 ${view} failed (exit ${exitCode}): ${stderr.trim()}`);
      return [];
    }

    const trimmed = output.trim();
    if (!trimmed || trimmed === "[]") return [];

    return JSON.parse(trimmed) as T3Task[];
  } catch (err) {
    console.warn(`[t3Helper] t3 ${view} error:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Fetch tasks from multiple t3 views in parallel.
 * Deduplicates by uuid.
 */
export async function fetchThingsTasks(views: string[]): Promise<T3Task[]> {
  const results = await Promise.all(views.map(fetchT3View));
  const seen = new Set<string>();
  const deduped: T3Task[] = [];

  for (const tasks of results) {
    for (const task of tasks) {
      if (!seen.has(task.uuid)) {
        seen.add(task.uuid);
        deduped.push(task);
      }
    }
  }

  return deduped;
}

/**
 * Check if t3 CLI is available.
 */
export async function isT3Available(): Promise<boolean> {
  try {
    const proc = spawn([T3_PATH, "--help"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}
