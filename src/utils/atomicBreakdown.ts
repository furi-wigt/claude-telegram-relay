/**
 * Atomic Task Breakdown Engine
 *
 * Uses local LLM to identify complex tasks and decompose them
 * into atomic execution steps (≤2 hours each).
 *
 * Features:
 * - Calendar gap-filling: computes free blocks between meetings
 * - Pre/post meeting tasks: structural blocks for meetings >30min
 * - Visual tiering: priority vs "if time allows"
 * - Configurable max tasks via MAX_ATOMIC_TASKS env var
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { callRoutineModel } from "../routines/routineModel.ts";
import type { T3Task } from "./t3Helper.ts";
import type { NewThingsTask } from "../../integrations/things/types.ts";
import type { AppleCalendarEvent } from "../../integrations/osx-calendar/index.ts";

const DEFAULT_MAX_TASKS = 20;
const PRIORITY_TIER_SIZE = 7;
const MEETING_THRESHOLD_MIN = 30;
const BUFFER_MIN = 15;

export type TaskType = "pre-meeting" | "post-meeting" | "transition" | "regular";
export type TaskTier = "priority" | "optional";

export interface AtomicTask {
  parentTitle?: string;
  stepOrder?: number;
  description: string;
  rationale: string;
  suggestedTime: string;
  estimatedDuration: number;
  source: string;
  taskType?: TaskType;
  tier?: TaskTier;
}

export interface TodoItem {
  file: string;
  description: string;
  step: string;
}

export interface FreeBlock {
  start: string; // HH:MM
  end: string;   // HH:MM
}

/** Read MAX_ATOMIC_TASKS from env, clamped to default if invalid. */
export function getMaxAtomicTasks(): number {
  const raw = process.env.MAX_ATOMIC_TASKS;
  if (!raw) return DEFAULT_MAX_TASKS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TASKS;
}

// ── Time helpers (HH:MM arithmetic) ─────────────────────────────────────────

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function toHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function eventToHHMM(date: Date): string {
  return date.toLocaleTimeString("en-SG", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Singapore",
  });
}

// ── Free block computation ──────────────────────────────────────────────────

/**
 * Compute free time blocks between calendar events, accounting for buffers.
 * All-day events are ignored. Returns blocks sorted chronologically.
 */
export function computeFreeBlocks(
  events: AppleCalendarEvent[],
  dayStart: string,
  dayEnd: string,
  bufferMin: number,
): FreeBlock[] {
  const timed = events
    .filter(e => !e.isAllDay)
    .map(e => ({
      start: toMinutes(eventToHHMM(e.start)),
      end: toMinutes(eventToHHMM(e.end)),
    }))
    .sort((a, b) => a.start - b.start);

  if (timed.length === 0) {
    return [{ start: dayStart, end: dayEnd }];
  }

  // Merge overlapping events
  const merged: { start: number; end: number }[] = [timed[0]];
  for (let i = 1; i < timed.length; i++) {
    const prev = merged[merged.length - 1];
    if (timed[i].start <= prev.end) {
      prev.end = Math.max(prev.end, timed[i].end);
    } else {
      merged.push({ ...timed[i] });
    }
  }

  const blocks: FreeBlock[] = [];
  const dayStartMin = toMinutes(dayStart);
  const dayEndMin = toMinutes(dayEnd);

  // Gap before first meeting
  const firstBuffered = merged[0].start - bufferMin;
  if (firstBuffered > dayStartMin + bufferMin) {
    blocks.push({ start: dayStart, end: toHHMM(firstBuffered) });
  }

  // Gaps between meetings
  for (let i = 0; i < merged.length - 1; i++) {
    const gapStart = merged[i].end + bufferMin;
    const gapEnd = merged[i + 1].start - bufferMin;
    if (gapEnd - gapStart >= bufferMin) {
      blocks.push({ start: toHHMM(gapStart), end: toHHMM(gapEnd) });
    }
  }

  // Gap after last meeting
  const lastBuffered = merged[merged.length - 1].end + bufferMin;
  if (lastBuffered < dayEndMin - bufferMin) {
    blocks.push({ start: toHHMM(lastBuffered), end: dayEnd });
  }

  return blocks;
}

// ── Meeting task injection ──────────────────────────────────────────────────

/**
 * Generate structural pre/post meeting tasks for meetings >30min.
 * Pre: "Prep block reserved — [Meeting Name]" at 15min before start.
 * Post: "Process notes: [Meeting Name]" at meeting end.
 */
export function injectMeetingTasks(events: AppleCalendarEvent[]): AtomicTask[] {
  const tasks: AtomicTask[] = [];
  for (const e of events) {
    if (e.isAllDay) continue;
    const durationMin = (e.end.getTime() - e.start.getTime()) / 60_000;
    if (durationMin <= MEETING_THRESHOLD_MIN) continue;

    const startHHMM = eventToHHMM(e.start);
    const endHHMM = eventToHHMM(e.end);
    const preTime = toHHMM(toMinutes(startHHMM) - BUFFER_MIN);

    tasks.push({
      description: `Prep block reserved — ${e.title}`,
      rationale: `15-min transition before ${e.title}`,
      suggestedTime: preTime,
      estimatedDuration: 15,
      source: "suggested",
      taskType: "pre-meeting",
      tier: "priority",
    });

    tasks.push({
      description: `Process notes: ${e.title}`,
      rationale: `Capture action items and key decisions from ${e.title}`,
      suggestedTime: endHHMM,
      estimatedDuration: 15,
      source: "suggested",
      taskType: "post-meeting",
      tier: "priority",
    });
  }
  return tasks;
}

// ── Format helpers for LLM prompt ───────────────────────────────────────────

export function formatCalendarForPrompt(events: AppleCalendarEvent[] | null): string {
  if (events === null) return "Calendar unavailable.";
  if (events.length === 0) return "No calendar events today.";
  return events.map(e => {
    if (e.isAllDay) return `All day — ${e.title} (context only, does not block time)`;
    const start = eventToHHMM(e.start);
    const end = eventToHHMM(e.end);
    let line = `${start}–${end} — ${e.title}`;
    if (e.notes) {
      const truncated = e.notes.slice(0, 200);
      line += `\n  Notes: ${truncated}${e.notes.length > 200 ? "…" : ""}`;
    }
    return line;
  }).join("\n");
}

function formatThingsForPrompt(tasks: T3Task[]): string {
  if (tasks.length === 0) return "No Things 3 tasks.";
  return tasks
    .filter(t => t.status === "incomplete")
    .map(t => {
      const parts = [t.title];
      if (t.deadline) parts.push(`(deadline: ${t.deadline})`);
      if (t.project_title) parts.push(`[${t.project_title}]`);
      if (t.tags?.length) parts.push(`tags: ${t.tags.join(", ")}`);
      if (t.notes) parts.push(`notes: ${t.notes.slice(0, 100)}`);
      return `- ${parts.join(" ")}`;
    })
    .join("\n");
}

function formatTodosForPrompt(items: TodoItem[]): string {
  if (items.length === 0) return "No pending dev todos.";
  return items.map(t => `- [${t.file}] ${t.step}`).join("\n");
}

// ── Core breakdown ──────────────────────────────────────────────────────────

/**
 * Identify complex tasks and break them into atomic steps.
 * Injects structural pre/post meeting tasks and computes free blocks.
 */
export async function breakdownTasks(
  thingsTasks: T3Task[],
  todoItems: TodoItem[],
  calendarEvents: AppleCalendarEvent[] | null,
  goals: { content: string; deadline: string | null }[]
): Promise<AtomicTask[]> {
  const maxTasks = getMaxAtomicTasks();
  const calendarContext = formatCalendarForPrompt(calendarEvents);
  const thingsContext = formatThingsForPrompt(thingsTasks);
  const goalsContext = goals.length > 0
    ? goals.map(g => `- ${g.content}${g.deadline ? ` (by ${g.deadline})` : ""}`).join("\n")
    : "None";

  // Pre-compute structural meeting tasks (not LLM-generated)
  const meetingTasks = calendarEvents ? injectMeetingTasks(calendarEvents) : [];

  // Compute free blocks for gap-filling instructions
  const freeBlocks = calendarEvents
    ? computeFreeBlocks(calendarEvents, "09:00", "18:00", BUFFER_MIN)
    : [{ start: "09:00", end: "18:00" }];
  const freeBlocksStr = freeBlocks.length > 0
    ? freeBlocks.map(b => `${b.start}–${b.end}`).join(", ")
    : "No free time available.";

  // Budget for LLM tasks (subtract meeting tasks already injected)
  const llmBudget = Math.max(0, maxTasks - meetingTasks.length);

  const prompt = `You are a personal productivity assistant. Analyze these tasks and break complex ones into sequential sub-tasks (each ≤2 hours of effort).

A task is "complex" if:
- It has a vague description (e.g., "look into BCP plan", "review weekly updates")
- It requires multiple distinct actions (e.g., "Discuss with Alice on Project X")
- It requires manual human execution (meetings, phone calls, document review)
- It would take more than 2 hours to complete as-is

For simple tasks (already atomic, ≤2h, single clear action), keep them as-is with parentTitle: null. Do NOT over-decompose.

CALENDAR (reference only — DO NOT create tasks for calendar events):
${calendarContext}

AVAILABLE FREE TIME BLOCKS (schedule tasks ONLY within these windows):
${freeBlocksStr}

THINGS 3 TASKS (prioritize deadline tasks first):
${thingsContext}

ACTIVE GOALS:
${goalsContext}

RULES:
1. Schedule tasks ONLY within the free time blocks listed above
2. Each sub-task MUST be completable in ≤2 hours
3. Sub-tasks of the same parent MUST be in logical execution order
4. Prioritize tasks with approaching deadlines FIRST
5. Include source: "things3", "goal", or "suggested"
6. For decomposed tasks, set parentTitle to original task name; for simple tasks, set null
7. Use "stepOrder" (1-based) for sequence within same parent
8. Estimate duration realistically (15–120 minutes)
9. Maximum ${llmBudget} tasks total — focus on highest priority
10. Do NOT duplicate tasks already in Things 3
11. Assign tier: "priority" for the first ${Math.min(PRIORITY_TIER_SIZE, llmBudget)} most important tasks, "optional" for the rest
12. Set taskType: "regular" for all tasks

Output ONLY a valid JSON array:
[{"parentTitle":null,"stepOrder":1,"description":"atomic step","rationale":"why","suggestedTime":"HH:MM","estimatedDuration":60,"source":"things3","taskType":"regular","tier":"priority"}]

No explanation, no markdown, just the JSON array.`;

  try {
    const response = await callRoutineModel(prompt, {
      label: "atomicBreakdown",
      timeoutMs: 120_000,
    });

    if (!response) return [...meetingTasks, ...fallbackTasks(thingsTasks)].slice(0, maxTasks);

    let jsonText = response.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return [...meetingTasks, ...fallbackTasks(thingsTasks)].slice(0, maxTasks);

    const validated: AtomicTask[] = parsed
      .filter(
        (t: any) =>
          t.description &&
          t.suggestedTime &&
          typeof t.estimatedDuration === "number" &&
          t.estimatedDuration <= 120
      )
      .slice(0, llmBudget)
      .map((t: any) => ({
        parentTitle: t.parentTitle || undefined,
        stepOrder: typeof t.stepOrder === "number" ? t.stepOrder : undefined,
        description: t.description,
        rationale: t.rationale || "",
        suggestedTime: t.suggestedTime,
        estimatedDuration: t.estimatedDuration,
        source: t.source || "suggested",
        taskType: (t.taskType as TaskType) || "regular",
        tier: (t.tier as TaskTier) || "priority",
      }));

    if (validated.length === 0) return [...meetingTasks, ...fallbackTasks(thingsTasks)].slice(0, maxTasks);

    const combined = [...meetingTasks, ...validated];
    console.log(`[atomicBreakdown] Generated ${combined.length} tasks (${meetingTasks.length} meeting + ${validated.length} LLM)`);
    return combined;
  } catch (err) {
    console.warn("[atomicBreakdown] LLM failed, using fallback:", err instanceof Error ? err.message : err);
    return [...meetingTasks, ...fallbackTasks(thingsTasks)].slice(0, maxTasks);
  }
}

// ── Pending todos scanner ───────────────────────────────────────────────────

export async function scanPendingTodos(todosDir: string): Promise<TodoItem[]> {
  const items: TodoItem[] = [];
  try {
    const files = await readdir(todosDir);
    const mdFiles = files.filter(f => f.endsWith(".md")).sort().reverse().slice(0, 5);

    for (const file of mdFiles) {
      const content = await readFile(join(todosDir, file), "utf-8");
      const lines = content.split("\n");
      let inChecklist = false;

      for (const line of lines) {
        if (line.match(/^##\s+Implementation Checklist/i) || line.match(/^##\s+Checklist/i)) {
          inChecklist = true;
          continue;
        }
        if (inChecklist && line.startsWith("## ")) {
          inChecklist = false;
          continue;
        }
        if (inChecklist && line.match(/^- \[ \]/)) {
          const step = line.replace(/^- \[ \]\s*/, "").trim();
          if (step) {
            items.push({ file: file.replace(".md", ""), description: file, step });
          }
        }
      }
    }
  } catch {
    // Directory may not exist
  }
  return items;
}

// ── Rendering ───────────────────────────────────────────────────────────────

const TASK_TYPE_MARKERS: Record<TaskType, string> = {
  "pre-meeting": "🔜",
  "post-meeting": "📝",
  "transition": "⏸",
  "regular": "",
};

/**
 * Format atomic tasks with visual tiering (Priority / If time allows).
 * Shared by morning-summary and smart-checkin.
 */
export function formatAtomicTaskBlock(
  tasks: AtomicTask[],
  storeSession: (t: NewThingsTask[]) => string,
  buildKeyboard: (id: string) => unknown
): { text: string; replyMarkup: unknown } {
  if (tasks.length === 0) {
    return { text: "", replyMarkup: buildKeyboard(storeSession([])) };
  }

  const sorted = [...tasks].sort((a, b) => {
    const aTime = a.suggestedTime;
    const bTime = b.suggestedTime;
    if (aTime !== bTime) return aTime.localeCompare(bTime);
    return (a.stepOrder ?? 0) - (b.stepOrder ?? 0);
  });

  const priorityTasks = sorted.filter(t => (t.tier ?? "priority") === "priority");
  const optionalTasks = sorted.filter(t => t.tier === "optional");

  const lines: string[] = [];

  // Priority section
  if (priorityTasks.length > 0) {
    renderTaskList(priorityTasks, lines, 0);
  }

  // Optional section
  if (optionalTasks.length > 0) {
    lines.push("");
    lines.push("_If time allows:_");
    renderTaskList(optionalTasks, lines, priorityTasks.length);
  }

  // Build Things 3 payload for ALL tasks (user picks via button)
  const newTasks: NewThingsTask[] = sorted.map(t => ({
    title: t.parentTitle
      ? `${t.parentTitle} → ${t.description}`
      : t.description,
    notes: t.rationale || undefined,
    when: "today" as const,
    tags: [t.source],
  }));
  const sessionId = storeSession(newTasks);
  const replyMarkup = buildKeyboard(sessionId);

  return { text: lines.join("\n"), replyMarkup };
}

function renderTaskList(tasks: AtomicTask[], lines: string[], startNum: number): void {
  let itemNum = startNum;
  const rendered = new Set<number>();

  for (let i = 0; i < tasks.length; i++) {
    if (rendered.has(i)) continue;
    const task = tasks[i];
    const marker = TASK_TYPE_MARKERS[task.taskType ?? "regular"];
    const prefix = marker ? `${marker} ` : "";

    if (!task.parentTitle) {
      itemNum++;
      lines.push(`${itemNum}. ${prefix}**[${task.suggestedTime}]** ${task.description} (~${task.estimatedDuration}min)`);
      if (task.rationale) lines.push(`   _${task.rationale}_`);
      rendered.add(i);
    } else {
      const siblings = tasks
        .map((t, idx) => ({ t, idx }))
        .filter(({ t, idx }) => !rendered.has(idx) && t.parentTitle === task.parentTitle);

      siblings.sort((a, b) => (a.t.stepOrder ?? 0) - (b.t.stepOrder ?? 0));

      itemNum++;
      const earliestTime = siblings[0].t.suggestedTime;
      const totalDuration = siblings.reduce((sum, { t }) => sum + t.estimatedDuration, 0);
      lines.push(`${itemNum}. ${prefix}**[${earliestTime}]** ${task.parentTitle} (~${totalDuration}min total)`);

      siblings.forEach(({ t, idx }, subIdx) => {
        lines.push(`   ${subIdx + 1}. ${t.description} (~${t.estimatedDuration}min)`);
        if (t.rationale) lines.push(`      _${t.rationale}_`);
        rendered.add(idx);
      });
    }
  }
}

// ── Dev todos message ───────────────────────────────────────────────────────

/**
 * Format dev todos as a standalone reference message.
 * Returns null if there are no pending todos.
 */
export function formatDevTodosMessage(todos: TodoItem[]): string | null {
  if (todos.length === 0) return null;

  const lines = [
    "🛠️ **Dev Backlog** _(reference — not time-slotted)_",
    "",
  ];

  // Group by source file
  const byFile = new Map<string, string[]>();
  for (const t of todos) {
    const steps = byFile.get(t.file) ?? [];
    steps.push(t.step);
    byFile.set(t.file, steps);
  }

  for (const [file, steps] of byFile) {
    lines.push(`**${file}**`);
    for (const step of steps) {
      lines.push(`• ${step}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// ── Fallback ────────────────────────────────────────────────────────────────

function fallbackTasks(tasks: T3Task[]): AtomicTask[] {
  return tasks
    .filter(t => t.status === "incomplete" && t.type === "to-do")
    .slice(0, 5)
    .map((t, i) => ({
      description: t.title,
      rationale: t.deadline ? `Deadline: ${t.deadline}` : "From Things 3 Today",
      suggestedTime: `${String(9 + i).padStart(2, "0")}:00`,
      estimatedDuration: 60,
      source: "things3",
      taskType: "regular" as TaskType,
      tier: (i < PRIORITY_TIER_SIZE ? "priority" : "optional") as TaskTier,
    }));
}
