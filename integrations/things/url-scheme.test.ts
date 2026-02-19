/**
 * Things URL scheme builder tests — pure functions, no mocking needed.
 * Run: bun test integrations/things/url-scheme.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  buildAddTaskURL,
  buildAddTasksJSONURL,
  buildCompleteTaskURL,
  buildUpdateTaskURL,
} from "./url-scheme.ts";

// ── buildAddTaskURL ────────────────────────────────────────────────────────────

describe("buildAddTaskURL", () => {
  test("builds minimal URL with just title", () => {
    const url = buildAddTaskURL({ title: "Buy milk" });
    expect(url).toStartWith("things:///add?");
    expect(url).toContain("title=Buy+milk");
  });

  test("includes notes when provided", () => {
    const url = buildAddTaskURL({ title: "Task", notes: "Do it now" });
    expect(url).toContain("notes=Do+it+now");
  });

  test("includes deadline when dueDate provided", () => {
    const url = buildAddTaskURL({ title: "Task", dueDate: new Date("2026-03-15") });
    expect(url).toContain("deadline=2026-03-15");
  });

  test("includes comma-separated tags", () => {
    const url = buildAddTaskURL({ title: "Task", tags: ["work", "urgent"] });
    expect(url).toContain("tags=work%2Curgent");
  });

  test("includes list (listName)", () => {
    const url = buildAddTaskURL({ title: "Task", listName: "Inbox" });
    expect(url).toContain("list=Inbox");
  });

  test("encodes 'today' when keyword", () => {
    const url = buildAddTaskURL({ title: "Task", when: "today" });
    expect(url).toContain("when=today");
  });

  test("encodes 'evening' when keyword", () => {
    const url = buildAddTaskURL({ title: "Task", when: "evening" });
    expect(url).toContain("when=evening");
  });

  test("formats Date as YYYY-MM-DD for when", () => {
    const url = buildAddTaskURL({ title: "Task", when: new Date("2026-03-20") });
    expect(url).toContain("when=2026-03-20");
  });

  test("does not include undefined optional fields", () => {
    const url = buildAddTaskURL({ title: "Task" });
    expect(url).not.toContain("notes=");
    expect(url).not.toContain("deadline=");
    expect(url).not.toContain("tags=");
    expect(url).not.toContain("when=");
  });
});

// ── buildAddTasksJSONURL ───────────────────────────────────────────────────────

describe("buildAddTasksJSONURL", () => {
  test("builds JSON URL for single task", () => {
    const url = buildAddTasksJSONURL([{ title: "Task A" }]);
    expect(url).toStartWith("things:///json?data=");
    const data = JSON.parse(decodeURIComponent(url.split("data=")[1]));
    expect(data).toHaveLength(1);
    expect(data[0].type).toBe("to-do");
    expect(data[0].attributes.title).toBe("Task A");
  });

  test("builds JSON URL for multiple tasks", () => {
    const url = buildAddTasksJSONURL([
      { title: "Task A" },
      { title: "Task B", tags: ["urgent"] },
    ]);
    const data = JSON.parse(decodeURIComponent(url.split("data=")[1]));
    expect(data).toHaveLength(2);
    expect(data[1].attributes.tags).toEqual(["urgent"]);
  });

  test("includes deadline in JSON attributes", () => {
    const url = buildAddTasksJSONURL([{ title: "Task", dueDate: new Date("2026-04-01") }]);
    const data = JSON.parse(decodeURIComponent(url.split("data=")[1]));
    expect(data[0].attributes.deadline).toBe("2026-04-01");
  });
});

// ── buildCompleteTaskURL ───────────────────────────────────────────────────────

describe("buildCompleteTaskURL", () => {
  test("builds complete URL with id and completed=true", () => {
    const url = buildCompleteTaskURL("abc-123");
    expect(url).toStartWith("things:///update?");
    expect(url).toContain("id=abc-123");
    expect(url).toContain("completed=true");
  });
});

// ── buildUpdateTaskURL ─────────────────────────────────────────────────────────

describe("buildUpdateTaskURL", () => {
  test("builds update URL with id only when no updates", () => {
    const url = buildUpdateTaskURL("task-1", {});
    expect(url).toStartWith("things:///update?");
    expect(url).toContain("id=task-1");
  });

  test("includes title update", () => {
    const url = buildUpdateTaskURL("task-1", { title: "New title" });
    expect(url).toContain("title=New+title");
  });

  test("includes deadline update", () => {
    const url = buildUpdateTaskURL("task-1", { dueDate: new Date("2026-05-10") });
    expect(url).toContain("deadline=2026-05-10");
  });

  test("includes tags update as comma-separated", () => {
    const url = buildUpdateTaskURL("task-1", { tags: ["a", "b"] });
    expect(url).toContain("tags=a%2Cb");
  });
});
