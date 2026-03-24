/**
 * Atomic Task Breakdown Engine
 *
 * Uses Claude Haiku to identify complex tasks and decompose them
 * into atomic execution steps (≤2 hours each).
 *
 * "Complex" = vague description OR requires manual execution
 * (not automatable by an LLM agent).
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { callRoutineModel } from "../routines/routineModel.ts";
import type { T3Task } from "./t3Helper.ts";
import type { NewThingsTask } from "../../integrations/things/types.ts";
import type { AppleCalendarEvent } from "../../integrations/osx-calendar/index.ts";

export interface AtomicTask {
  /** Original task title (if broken down) or standalone suggestion */
  parentTitle?: string;
  /** Sequence within the parent (1-based). undefined for standalone tasks. */
  stepOrder?: number;
  /** The atomic step description */
  description: string;
  /** Why this step matters or what it unblocks */
  rationale: string;
  /** Suggested time slot (HH:MM) */
  suggestedTime: string;
  /** Estimated duration in minutes (max 120) */
  estimatedDuration: number;
  /** Source: 'things3' | 'todos' | 'goal' | 'suggested' */
  source: string;
}

export interface TodoItem {
  file: string;
  description: string;
  step: string;
}

/**
 * Identify complex tasks and break them into atomic steps.
 *
 * @param thingsTasks - Tasks from Things 3 (today/upcoming/deadlines)
 * @param todoItems - Pending items from .claude/todos/ files
 * @param calendarEvents - Today's calendar events (for time-slotting)
 * @param goals - Active goals from memory DB
 */
export async function breakdownTasks(
  thingsTasks: T3Task[],
  todoItems: TodoItem[],
  calendarEvents: AppleCalendarEvent[] | null,
  goals: { content: string; deadline: string | null }[]
): Promise<AtomicTask[]> {
  const calendarContext = formatCalendarForPrompt(calendarEvents);
  const thingsContext = formatThingsForPrompt(thingsTasks);
  const todosContext = formatTodosForPrompt(todoItems);
  const goalsContext = goals.length > 0
    ? goals.map(g => `- ${g.content}${g.deadline ? ` (by ${g.deadline})` : ""}`).join("\n")
    : "None";

  const prompt = `You are a personal productivity assistant. Analyze these tasks and break complex ones into sequential sub-tasks (each ≤2 hours of effort).

A task is "complex" if:
- It has a vague description (e.g., "look into BCP plan", "review weekly updates")
- It requires multiple distinct actions (e.g., "Discuss with Alice on Project X")
- It requires manual human execution (meetings, phone calls, document review)
- It would take more than 2 hours to complete as-is

DECOMPOSITION EXAMPLES:
- "Discuss with Alice on Project X" → sub-tasks: "Research Project X status and prepare talking points", "Schedule meeting with Alice", "Write summary of discussion and next steps"
- "Review BCP plan" → sub-tasks: "Read current BCP document and note gaps", "Draft improvement recommendations", "Share findings with team lead"
- "Set up CI/CD pipeline" → sub-tasks: "Research CI/CD options for the project stack", "Configure build pipeline in GitHub Actions", "Add deployment step and test end-to-end"

For simple tasks (already atomic, ≤2h, single clear action like "Buy groceries", "Reply to email", "Review PR #42"), keep them as-is with parentTitle: null. Do NOT over-decompose — only break down tasks that genuinely require multiple distinct steps.

CALENDAR (slot tasks around these — DO NOT create tasks for calendar events):
${calendarContext}

THINGS 3 TASKS:
${thingsContext}

DEV TODOS (.claude/todos/ pending items):
${todosContext}

ACTIVE GOALS:
${goalsContext}

RULES:
1. Each sub-task MUST be completable in ≤2 hours
2. Sub-tasks of the same parent MUST be in logical execution order (prep → action → follow-up)
3. Suggest realistic time slots (06:00–22:00) that don't overlap calendar events
4. Prioritize tasks with approaching deadlines
5. Include source: "things3", "todos", "goal", or "suggested"
6. For decomposed tasks, set parentTitle to the original task name; for simple tasks, set null
7. Use "stepOrder" (1-based) to indicate sequence within the same parent
8. Estimate duration realistically (15–120 minutes)
9. Maximum 12 atomic tasks total — focus on highest priority
10. Do NOT duplicate tasks that already exist in Things 3

Output ONLY a valid JSON array:
[{"parentTitle":"original task or null","stepOrder":1,"description":"atomic step","rationale":"why","suggestedTime":"HH:MM","estimatedDuration":60,"source":"things3"}]

No explanation, no markdown, just the JSON array.`;

  try {
    const response = await callRoutineModel(prompt, {
      label: "atomicBreakdown",
      timeoutMs: 120_000, // 120s — matches default; 60s was too tight after a cold-start recap call
    });

    if (!response) return fallbackTasks(thingsTasks);

    let jsonText = response.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return fallbackTasks(thingsTasks);

    const validated: AtomicTask[] = parsed
      .filter(
        (t: any) =>
          t.description &&
          t.suggestedTime &&
          typeof t.estimatedDuration === "number" &&
          t.estimatedDuration <= 120
      )
      .map((t: any) => ({
        parentTitle: t.parentTitle || undefined,
        stepOrder: typeof t.stepOrder === "number" ? t.stepOrder : undefined,
        description: t.description,
        rationale: t.rationale || "",
        suggestedTime: t.suggestedTime,
        estimatedDuration: t.estimatedDuration,
        source: t.source || "suggested",
      }));

    if (validated.length === 0) return fallbackTasks(thingsTasks);

    console.log(`[atomicBreakdown] Generated ${validated.length} atomic tasks`);
    return validated;
  } catch (err) {
    console.warn("[atomicBreakdown] LLM failed, using fallback:", err instanceof Error ? err.message : err);
    return fallbackTasks(thingsTasks);
  }
}

function formatCalendarForPrompt(events: AppleCalendarEvent[] | null): string {
  if (events === null) return "Calendar unavailable.";
  if (events.length === 0) return "No calendar events today.";
  return events.map(e => {
    if (e.isAllDay) return `All day — ${e.title}`;
    const start = e.start.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Singapore" });
    const end = e.end.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Singapore" });
    return `${start}–${end} — ${e.title}`;
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

/**
 * Scan .claude/todos/ for pending implementation checklist items.
 * Returns unchecked `- [ ]` items from the Implementation Checklist section.
 */
export async function scanPendingTodos(todosDir: string): Promise<TodoItem[]> {
  const items: TodoItem[] = [];
  try {
    const files = await readdir(todosDir);
    const mdFiles = files.filter(f => f.endsWith(".md")).sort().reverse().slice(0, 5); // 5 most recent

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

/**
 * Format atomic tasks as a numbered markdown block with an inline keyboard
 * for one-shot "Add All to Things 3".
 *
 * Shared by morning-summary and smart-checkin to avoid duplication.
 */
export function formatAtomicTaskBlock(
  tasks: AtomicTask[],
  storeSession: (t: NewThingsTask[]) => string,
  buildKeyboard: (id: string) => unknown
): { text: string; replyMarkup: unknown } {
  const sorted = [...tasks].sort((a, b) => {
    // Sort by earliest suggestedTime of the group (parent or standalone)
    const aTime = a.suggestedTime;
    const bTime = b.suggestedTime;
    if (aTime !== bTime) return aTime.localeCompare(bTime);
    // Within same parent, sort by stepOrder
    return (a.stepOrder ?? 0) - (b.stepOrder ?? 0);
  });

  // Group tasks: standalone vs sub-tasks under a parent
  const lines: string[] = [];
  let itemNum = 0;
  const rendered = new Set<number>(); // indices already rendered

  for (let i = 0; i < sorted.length; i++) {
    if (rendered.has(i)) continue;
    const task = sorted[i];

    if (!task.parentTitle) {
      // Standalone task
      itemNum++;
      lines.push(`${itemNum}. **[${task.suggestedTime}]** ${task.description} (~${task.estimatedDuration}min)`);
      if (task.rationale) lines.push(`   _${task.rationale}_`);
      rendered.add(i);
    } else {
      // Collect all sub-tasks for this parent
      const siblings = sorted
        .map((t, idx) => ({ t, idx }))
        .filter(({ t, idx }) => !rendered.has(idx) && t.parentTitle === task.parentTitle);

      // Sort siblings by stepOrder
      siblings.sort((a, b) => (a.t.stepOrder ?? 0) - (b.t.stepOrder ?? 0));

      itemNum++;
      const earliestTime = siblings[0].t.suggestedTime;
      const totalDuration = siblings.reduce((sum, { t }) => sum + t.estimatedDuration, 0);
      lines.push(`${itemNum}. **[${earliestTime}]** ${task.parentTitle} (~${totalDuration}min total)`);

      siblings.forEach(({ t, idx }, subIdx) => {
        lines.push(`   ${subIdx + 1}. ${t.description} (~${t.estimatedDuration}min)`);
        if (t.rationale) lines.push(`      _${t.rationale}_`);
        rendered.add(idx);
      });
    }
  }

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

/** Simple fallback: list Things 3 tasks without AI breakdown. */
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
    }));
}
