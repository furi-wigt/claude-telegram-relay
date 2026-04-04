import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initBlackboardSchema } from "../../src/orchestration/blackboardSchema";

describe("blackboard schema", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    initBlackboardSchema(db);
  });

  afterAll(() => {
    db.close();
  });

  test("bb_sessions table exists", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='bb_sessions'")
      .all();
    expect(tables).toHaveLength(1);
  });

  test("bb_records table exists", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='bb_records'")
      .all();
    expect(tables).toHaveLength(1);
  });

  test("bb_mesh_links table exists", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='bb_mesh_links'")
      .all();
    expect(tables).toHaveLength(1);
  });

  test("can insert and query a session", () => {
    db.run(
      `INSERT INTO bb_sessions (id, dispatch_id, status, workflow, max_rounds)
       VALUES (?, ?, ?, ?, ?)`,
      ["sess-1", "disp-1", "active", "default", 10]
    );
    const row = db.query("SELECT * FROM bb_sessions WHERE id = ?").get("sess-1") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.status).toBe("active");
    expect(row.max_rounds).toBe(10);
    expect(row.current_round).toBe(0);
  });

  test("can insert and query a record", () => {
    db.run(
      `INSERT INTO bb_records (id, session_id, space, record_type, producer, status, confidence, content, round)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["rec-1", "sess-1", "input", "task", "command-center", "pending", 0.9, '{"message":"test"}', 0]
    );
    const row = db.query("SELECT * FROM bb_records WHERE id = ?").get("rec-1") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.space).toBe("input");
    expect(row.producer).toBe("command-center");
    expect(JSON.parse(row.content as string)).toEqual({ message: "test" });
  });

  test("can insert and query mesh links", () => {
    db.run(
      `INSERT INTO bb_mesh_links (from_agent, to_agent, link_type) VALUES (?, ?, ?)`,
      ["command-center", "research-analyst", "bidirectional"]
    );
    const row = db
      .query("SELECT * FROM bb_mesh_links WHERE from_agent = ? AND to_agent = ?")
      .get("command-center", "research-analyst") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.link_type).toBe("bidirectional");
  });

  test("bb_mesh_links enforces unique constraint", () => {
    expect(() =>
      db.run(
        `INSERT INTO bb_mesh_links (from_agent, to_agent, link_type) VALUES (?, ?, ?)`,
        ["command-center", "research-analyst", "bidirectional"]
      )
    ).toThrow();
  });

  test("indexes exist", () => {
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_bb_records_session");
    expect(names).toContain("idx_bb_records_space");
    expect(names).toContain("idx_bb_records_status");
    expect(names).toContain("idx_bb_sessions_status");
  });

  test("idempotent — calling initBlackboardSchema twice does not throw", () => {
    expect(() => initBlackboardSchema(db)).not.toThrow();
  });
});
