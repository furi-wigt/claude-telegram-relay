/**
 * Things 3 CLI reader — reads via `clings` (https://github.com/nicowillis/clings).
 * Install: brew install dan-hart/tap/clings
 *
 * All read operations throw UnavailableError if clings is not installed.
 */

import { spawn } from "../../src/spawn.ts";
import type { ThingsTask } from "./types.ts";

export class UnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnavailableError";
  }
}

function getClingsPath(): string {
  return process.env.CLINGS_PATH ?? "clings";
}

async function runClings(args: string[]): Promise<string> {
  const clingsPath = getClingsPath();

  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn([clingsPath, ...args], { stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT") || msg.includes("not found")) {
      throw new UnavailableError(
        `clings not installed. Install with: brew install dan-hart/tap/clings`
      );
    }
    throw err;
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const errMsg = stderr.trim();
    if (errMsg.includes("not found") || errMsg.includes("No such file")) {
      throw new UnavailableError(
        `clings not installed. Install with: brew install dan-hart/tap/clings`
      );
    }
    throw new Error(`clings ${args.join(" ")} failed (exit ${exitCode}): ${errMsg}`);
  }

  return stdout.trim();
}

function parseClingsTasks(raw: string): ThingsTask[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: Record<string, unknown>) => ({
      id: String(item.id ?? item.uuid ?? ""),
      title: String(item.name ?? item.title ?? ""),
      notes: item.notes ? String(item.notes) : undefined,
      dueDate: item.dueDate ? String(item.dueDate) : undefined,
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      list: item.list ? String(item.list) : undefined,
      status: item.status === "completed" ? "completed" : "incomplete",
    }));
  } catch {
    return [];
  }
}

/** Check if clings is available (no throw). */
export async function isClingsAvailable(): Promise<boolean> {
  try {
    await runClings(["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Get tasks scheduled for today. */
export async function getTodayTasksRaw(): Promise<ThingsTask[]> {
  const raw = await runClings(["today", "--json"]);
  return parseClingsTasks(raw);
}

/** Get tasks in the inbox. */
export async function getInboxTasksRaw(): Promise<ThingsTask[]> {
  const raw = await runClings(["inbox", "--json"]);
  return parseClingsTasks(raw);
}

/** Search tasks by query and optional tag. */
export async function searchTasksRaw(query: string, tag?: string): Promise<ThingsTask[]> {
  const args = ["search", query, "--json"];
  if (tag) args.push("--tag", tag);
  const raw = await runClings(args);
  return parseClingsTasks(raw);
}
