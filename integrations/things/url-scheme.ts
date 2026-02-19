/**
 * Things 3 URL scheme writer — macOS only, no dependencies.
 * Write operations always work as long as Things 3 is running.
 */

import { spawn } from "../../src/spawn.ts";
import type { NewThingsTask } from "./types.ts";

/** Open a URL on macOS via the `open` command. */
async function openURL(url: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Things URL scheme requires macOS");
  }
  const proc = spawn(["open", url], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    throw new Error(`open "${url}" failed (exit ${exitCode}): ${stderr.trim()}`);
  }
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0]; // YYYY-MM-DD
}

function whenValue(when: NewThingsTask['when']): string | undefined {
  if (!when) return undefined;
  if (when === 'today') return 'today';
  if (when === 'evening') return 'evening';
  return formatDate(when as Date);
}

/** Build a things:///add URL for a single task. */
export function buildAddTaskURL(task: NewThingsTask): string {
  const params = new URLSearchParams();
  params.set("title", task.title);
  if (task.notes) params.set("notes", task.notes);
  if (task.dueDate) params.set("deadline", formatDate(task.dueDate));
  if (task.tags?.length) params.set("tags", task.tags.join(","));
  if (task.listName) params.set("list", task.listName);
  const w = whenValue(task.when);
  if (w) params.set("when", w);
  return `things:///add?${params.toString()}`;
}

/** Build a things:///json URL for batch task creation (up to 250 items). */
export function buildAddTasksJSONURL(tasks: NewThingsTask[]): string {
  const items = tasks.map(task => {
    const item: Record<string, unknown> = { type: "to-do", attributes: { title: task.title } };
    const attrs = item.attributes as Record<string, unknown>;
    if (task.notes) attrs.notes = task.notes;
    if (task.dueDate) attrs.deadline = formatDate(task.dueDate);
    if (task.tags?.length) attrs.tags = task.tags;
    if (task.listName) attrs["list-id"] = task.listName;
    const w = whenValue(task.when);
    if (w) attrs.when = w;
    return item;
  });
  return `things:///json?data=${encodeURIComponent(JSON.stringify(items))}`;
}

/** Build a things:///update URL to complete a task by ID. */
export function buildCompleteTaskURL(id: string): string {
  const params = new URLSearchParams({ id, completed: "true" });
  return `things:///update?${params.toString()}`;
}

/** Build a things:///update URL to update a task. */
export function buildUpdateTaskURL(id: string, updates: Partial<NewThingsTask>): string {
  const params = new URLSearchParams({ id });
  if (updates.title) params.set("title", updates.title);
  if (updates.notes) params.set("notes", updates.notes);
  if (updates.dueDate) params.set("deadline", formatDate(updates.dueDate));
  if (updates.tags?.length) params.set("tags", updates.tags.join(","));
  const w = whenValue(updates.when);
  if (w) params.set("when", w);
  return `things:///update?${params.toString()}`;
}

/** Add a single task via URL scheme. */
export async function addTaskViaURL(task: NewThingsTask): Promise<void> {
  await openURL(buildAddTaskURL(task));
}

/** Add multiple tasks via JSON URL scheme (up to 250). */
export async function addTasksViaURL(tasks: NewThingsTask[]): Promise<void> {
  if (tasks.length === 0) return;
  await openURL(buildAddTasksJSONURL(tasks));
}

/** Complete a task by ID via URL scheme. */
export async function completeTaskViaURL(id: string): Promise<void> {
  await openURL(buildCompleteTaskURL(id));
}

/** Update a task by ID via URL scheme. */
export async function updateTaskViaURL(id: string, updates: Partial<NewThingsTask>): Promise<void> {
  await openURL(buildUpdateTaskURL(id, updates));
}
