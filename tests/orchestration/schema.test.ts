import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initOrchestrationSchema } from "../../src/orchestration/schema";

describe("orchestration schema", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    initOrchestrationSchema(db);
  });

  afterAll(() => {
    db.close();
  });

  test("dispatches table exists", () => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='dispatches'").all();
    expect(tables).toHaveLength(1);
  });

  test("dispatch_tasks table exists", () => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='dispatch_tasks'").all();
    expect(tables).toHaveLength(1);
  });

  test("can insert and query a dispatch", () => {
    db.run(
      `INSERT INTO dispatches (id, user_message, intent, confidence, status)
       VALUES (?, ?, ?, ?, ?)`,
      ["test-1", "review EDEN security", "security-review", 0.9, "planning"]
    );

    const row = db.query("SELECT * FROM dispatches WHERE id = ?").get("test-1") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.user_message).toBe("review EDEN security");
    expect(row.intent).toBe("security-review");
    expect(row.confidence).toBe(0.9);
    expect(row.status).toBe("planning");
  });

  test("can insert and query dispatch_tasks", () => {
    db.run(
      `INSERT INTO dispatch_tasks (id, dispatch_id, seq, agent_id, task_description, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["task-1", "test-1", 1, "security-compliance", "Review EDEN security posture", "pending"]
    );

    const row = db.query("SELECT * FROM dispatch_tasks WHERE id = ?").get("task-1") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.dispatch_id).toBe("test-1");
    expect(row.agent_id).toBe("security-compliance");
    expect(row.status).toBe("pending");
  });

  test("indexes exist", () => {
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_dispatches_status");
    expect(names).toContain("idx_dispatches_created");
    expect(names).toContain("idx_dispatch_tasks_dispatch");
    expect(names).toContain("idx_dispatch_tasks_status");
  });

  test("idempotent — calling initOrchestrationSchema twice does not throw", () => {
    expect(() => initOrchestrationSchema(db)).not.toThrow();
  });
});
