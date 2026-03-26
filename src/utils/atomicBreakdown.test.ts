import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  formatCalendarForPrompt,
  formatAtomicTaskBlock,
  formatDevTodosMessage,
  computeFreeBlocks,
  injectMeetingTasks,
  type AtomicTask,
  type TodoItem,
} from "./atomicBreakdown.ts";
import type { AppleCalendarEvent } from "../../integrations/osx-calendar/index.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<AppleCalendarEvent> & { title: string }): AppleCalendarEvent {
  return {
    id: "evt-1",
    start: new Date("2026-03-26T09:00:00+08:00"),
    end: new Date("2026-03-26T10:00:00+08:00"),
    isAllDay: false,
    calendar: "Work",
    ...overrides,
  };
}

function makeTask(overrides: Partial<AtomicTask> = {}): AtomicTask {
  return {
    description: "Test task",
    rationale: "Test rationale",
    suggestedTime: "09:00",
    estimatedDuration: 60,
    source: "things3",
    taskType: "regular",
    tier: "priority",
    ...overrides,
  };
}

const stubStore = (_: any) => "session-123";
const stubKeyboard = (_: string) => ({ inline_keyboard: [] });

// ── formatCalendarForPrompt ─────────────────────────────────────────────────

describe("formatCalendarForPrompt", () => {
  test("includes notes field truncated to 200 chars", () => {
    const event = makeEvent({
      title: "Sprint Planning",
      notes: "Agenda: 1. Review backlog 2. Estimate stories 3. Plan sprint " + "x".repeat(200),
    });
    const result = formatCalendarForPrompt([event]);
    expect(result).toContain("Sprint Planning");
    expect(result).toContain("Agenda:");
    // Truncated — should not have the full 200+ char string
    expect(result.length).toBeLessThan(500);
  });

  test("omits notes line when notes is empty", () => {
    const event = makeEvent({ title: "Standup" });
    const result = formatCalendarForPrompt([event]);
    expect(result).toContain("Standup");
    expect(result).not.toContain("Notes:");
  });

  test("handles null calendar", () => {
    expect(formatCalendarForPrompt(null)).toBe("Calendar unavailable.");
  });

  test("handles empty calendar", () => {
    expect(formatCalendarForPrompt([])).toBe("No calendar events today.");
  });

  test("marks all-day events as context", () => {
    const event = makeEvent({ title: "Company Retreat", isAllDay: true });
    const result = formatCalendarForPrompt([event]);
    expect(result).toContain("All day");
    expect(result).toContain("Company Retreat");
  });
});

// ── computeFreeBlocks ───────────────────────────────────────────────────────

describe("computeFreeBlocks", () => {
  test("full day free when no timed events", () => {
    const blocks = computeFreeBlocks([], "09:00", "18:00", 15);
    expect(blocks).toEqual([{ start: "09:00", end: "18:00" }]);
  });

  test("gaps around a single meeting with 15-min buffers", () => {
    const events = [
      makeEvent({
        title: "Meeting",
        start: new Date("2026-03-26T10:00:00+08:00"),
        end: new Date("2026-03-26T11:00:00+08:00"),
      }),
    ];
    const blocks = computeFreeBlocks(events, "09:00", "18:00", 15);
    // Before meeting: 09:00 – 09:45 (10:00 - 15min buffer)
    // After meeting: 11:15 – 18:00 (11:00 + 15min buffer)
    expect(blocks).toEqual([
      { start: "09:00", end: "09:45" },
      { start: "11:15", end: "18:00" },
    ]);
  });

  test("no gap when back-to-back meetings", () => {
    const events = [
      makeEvent({
        title: "Meeting 1",
        start: new Date("2026-03-26T09:00:00+08:00"),
        end: new Date("2026-03-26T10:00:00+08:00"),
      }),
      makeEvent({
        title: "Meeting 2",
        start: new Date("2026-03-26T10:00:00+08:00"),
        end: new Date("2026-03-26T11:00:00+08:00"),
      }),
    ];
    const blocks = computeFreeBlocks(events, "09:00", "18:00", 15);
    // Only gap after both meetings: 11:15 – 18:00
    expect(blocks).toEqual([{ start: "11:15", end: "18:00" }]);
  });

  test("ignores all-day events", () => {
    const events = [
      makeEvent({ title: "Company Retreat", isAllDay: true }),
    ];
    const blocks = computeFreeBlocks(events, "09:00", "18:00", 15);
    expect(blocks).toEqual([{ start: "09:00", end: "18:00" }]);
  });

  test("filters out blocks shorter than 15min", () => {
    const events = [
      makeEvent({
        title: "Meeting 1",
        start: new Date("2026-03-26T09:00:00+08:00"),
        end: new Date("2026-03-26T09:50:00+08:00"),
      }),
      makeEvent({
        title: "Meeting 2",
        start: new Date("2026-03-26T10:00:00+08:00"),
        end: new Date("2026-03-26T11:00:00+08:00"),
      }),
    ];
    // Gap between meetings: 09:50+15=10:05 to 10:00-15=09:45 → negative, no gap
    const blocks = computeFreeBlocks(events, "09:00", "18:00", 15);
    expect(blocks).toEqual([{ start: "11:15", end: "18:00" }]);
  });
});

// ── injectMeetingTasks ──────────────────────────────────────────────────────

describe("injectMeetingTasks", () => {
  test("generates pre and post tasks for >30min meetings", () => {
    const events = [
      makeEvent({
        title: "Sprint Planning",
        start: new Date("2026-03-26T10:00:00+08:00"),
        end: new Date("2026-03-26T11:00:00+08:00"), // 60min
      }),
    ];
    const tasks = injectMeetingTasks(events);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].taskType).toBe("pre-meeting");
    expect(tasks[0].description).toContain("Sprint Planning");
    expect(tasks[0].suggestedTime).toBe("09:45"); // 15min before
    expect(tasks[1].taskType).toBe("post-meeting");
    expect(tasks[1].description).toContain("Sprint Planning");
    expect(tasks[1].suggestedTime).toBe("11:00"); // right after
  });

  test("skips meetings <=30min", () => {
    const events = [
      makeEvent({
        title: "Quick Standup",
        start: new Date("2026-03-26T09:00:00+08:00"),
        end: new Date("2026-03-26T09:15:00+08:00"), // 15min
      }),
    ];
    const tasks = injectMeetingTasks(events);
    expect(tasks).toHaveLength(0);
  });

  test("skips all-day events", () => {
    const events = [makeEvent({ title: "Holiday", isAllDay: true })];
    const tasks = injectMeetingTasks(events);
    expect(tasks).toHaveLength(0);
  });
});

// ── formatAtomicTaskBlock (tiered rendering) ────────────────────────────────

describe("formatAtomicTaskBlock", () => {
  test("renders priority and optional tiers separately", () => {
    const tasks: AtomicTask[] = [
      makeTask({ description: "Priority task", suggestedTime: "09:00", tier: "priority" }),
      makeTask({ description: "Optional task", suggestedTime: "14:00", tier: "optional" }),
    ];
    const { text } = formatAtomicTaskBlock(tasks, stubStore, stubKeyboard);
    expect(text).toContain("Priority task");
    expect(text).toContain("Optional task");
    expect(text).toContain("If time allows");
  });

  test("renders pre-meeting marker", () => {
    const tasks: AtomicTask[] = [
      makeTask({ description: "Prep for meeting", taskType: "pre-meeting", suggestedTime: "09:45" }),
    ];
    const { text } = formatAtomicTaskBlock(tasks, stubStore, stubKeyboard);
    expect(text).toContain("Prep for meeting");
  });

  test("renders post-meeting marker", () => {
    const tasks: AtomicTask[] = [
      makeTask({ description: "Process notes: Sprint", taskType: "post-meeting", suggestedTime: "11:00" }),
    ];
    const { text } = formatAtomicTaskBlock(tasks, stubStore, stubKeyboard);
    expect(text).toContain("Process notes: Sprint");
  });

  test("handles empty tasks array", () => {
    const { text } = formatAtomicTaskBlock([], stubStore, stubKeyboard);
    expect(text).toBe("");
  });

  test("handles all priority tasks (no optional section)", () => {
    const tasks: AtomicTask[] = [
      makeTask({ description: "Task A", suggestedTime: "09:00", tier: "priority" }),
      makeTask({ description: "Task B", suggestedTime: "10:00", tier: "priority" }),
    ];
    const { text } = formatAtomicTaskBlock(tasks, stubStore, stubKeyboard);
    expect(text).not.toContain("If time allows");
    expect(text).toContain("Task A");
    expect(text).toContain("Task B");
  });

  test("mixed task types render in correct time order", () => {
    const tasks: AtomicTask[] = [
      makeTask({ description: "Regular work", suggestedTime: "09:00", taskType: "regular", tier: "priority" }),
      makeTask({ description: "Prep for Sync", suggestedTime: "09:45", taskType: "pre-meeting", tier: "priority" }),
      makeTask({ description: "Process notes: Sync", suggestedTime: "11:00", taskType: "post-meeting", tier: "priority" }),
    ];
    const { text } = formatAtomicTaskBlock(tasks, stubStore, stubKeyboard);
    const lines = text.split("\n");
    const regularIdx = lines.findIndex(l => l.includes("Regular work"));
    const prepIdx = lines.findIndex(l => l.includes("Prep for Sync"));
    const postIdx = lines.findIndex(l => l.includes("Process notes"));
    expect(regularIdx).toBeLessThan(prepIdx);
    expect(prepIdx).toBeLessThan(postIdx);
  });
});

// ── formatDevTodosMessage ───────────────────────────────────────────────────

describe("formatDevTodosMessage", () => {
  test("formats dev todos with header", () => {
    const todos: TodoItem[] = [
      { file: "260325_todo", description: "260325_todo.md", step: "Write unit tests for auth module" },
      { file: "260324_todo", description: "260324_todo.md", step: "Fix embed timeout handling" },
    ];
    const result = formatDevTodosMessage(todos);
    expect(result).toContain("Dev Backlog");
    expect(result).toContain("Write unit tests for auth module");
    expect(result).toContain("Fix embed timeout handling");
  });

  test("returns null for empty todos", () => {
    expect(formatDevTodosMessage([])).toBeNull();
  });
});

// ── MAX_ATOMIC_TASKS ────────────────────────────────────────────────────────

describe("MAX_ATOMIC_TASKS", () => {
  const origEnv = process.env.MAX_ATOMIC_TASKS;

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.MAX_ATOMIC_TASKS = origEnv;
    } else {
      delete process.env.MAX_ATOMIC_TASKS;
    }
  });

  test("getMaxAtomicTasks defaults to 20", async () => {
    delete process.env.MAX_ATOMIC_TASKS;
    const { getMaxAtomicTasks } = await import("./atomicBreakdown.ts");
    expect(getMaxAtomicTasks()).toBe(20);
  });

  test("getMaxAtomicTasks reads env var", async () => {
    process.env.MAX_ATOMIC_TASKS = "10";
    const { getMaxAtomicTasks } = await import("./atomicBreakdown.ts");
    expect(getMaxAtomicTasks()).toBe(10);
  });

  test("getMaxAtomicTasks clamps invalid values to default", async () => {
    process.env.MAX_ATOMIC_TASKS = "-5";
    const { getMaxAtomicTasks } = await import("./atomicBreakdown.ts");
    expect(getMaxAtomicTasks()).toBe(20);
  });
});
