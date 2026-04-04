import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initBlackboardSchema } from "../../src/orchestration/blackboardSchema";
import {
  createSession,
  getSession,
  updateSessionStatus,
  incrementRound,
  writeRecord,
  getRecords,
  getRecordsBySpace,
  updateRecordStatus,
} from "../../src/orchestration/blackboard";

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

describe("blackboard CRUD", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    initBlackboardSchema(db);
  });

  afterAll(() => {
    db.close();
  });

  test("createSession inserts and returns a session", () => {
    const session = createSession(db, { dispatchId: "d-100", workflow: "default", maxRounds: 5 });
    expect(session.id).toBeTruthy();
    expect(session.status).toBe("active");
    expect(session.max_rounds).toBe(5);
    expect(session.current_round).toBe(0);
  });

  test("getSession returns the session by id", () => {
    const created = createSession(db, { dispatchId: "d-101" });
    const fetched = getSession(db, created.id);
    expect(fetched).toBeTruthy();
    expect(fetched!.id).toBe(created.id);
  });

  test("getSession returns null for missing id", () => {
    expect(getSession(db, "nonexistent")).toBeNull();
  });

  test("updateSessionStatus changes status", () => {
    const session = createSession(db, { dispatchId: "d-102" });
    updateSessionStatus(db, session.id, "done");
    const fetched = getSession(db, session.id);
    expect(fetched!.status).toBe("done");
    expect(fetched!.completed_at).toBeTruthy();
  });

  test("incrementRound bumps current_round", () => {
    const session = createSession(db, { dispatchId: "d-103" });
    incrementRound(db, session.id);
    incrementRound(db, session.id);
    const fetched = getSession(db, session.id);
    expect(fetched!.current_round).toBe(2);
  });

  test("writeRecord inserts and returns a record", () => {
    const session = createSession(db, { dispatchId: "d-104" });
    const record = writeRecord(db, {
      sessionId: session.id,
      space: "input",
      recordType: "task",
      producer: "command-center",
      content: { message: "test task" },
      round: 0,
    });
    expect(record.id).toBeTruthy();
    expect(record.space).toBe("input");
    expect(record.status).toBe("pending");
    expect(JSON.parse(record.content)).toEqual({ message: "test task" });
  });

  test("getRecords returns all records for a session", () => {
    const session = createSession(db, { dispatchId: "d-105" });
    writeRecord(db, { sessionId: session.id, space: "input", recordType: "task", content: { a: 1 }, round: 0 });
    writeRecord(db, { sessionId: session.id, space: "tasks", recordType: "task", content: { b: 2 }, round: 0 });
    const records = getRecords(db, session.id);
    expect(records).toHaveLength(2);
  });

  test("getRecordsBySpace filters by space", () => {
    const session = createSession(db, { dispatchId: "d-106" });
    writeRecord(db, { sessionId: session.id, space: "input", recordType: "task", content: { a: 1 }, round: 0 });
    writeRecord(db, { sessionId: session.id, space: "tasks", recordType: "task", content: { b: 2 }, round: 0 });
    writeRecord(db, { sessionId: session.id, space: "tasks", recordType: "task", content: { c: 3 }, round: 0 });
    const tasks = getRecordsBySpace(db, session.id, "tasks");
    expect(tasks).toHaveLength(2);
  });

  test("updateRecordStatus changes status and sets updated_at", () => {
    const session = createSession(db, { dispatchId: "d-107" });
    const record = writeRecord(db, { sessionId: session.id, space: "tasks", recordType: "task", content: { x: 1 }, round: 0 });
    updateRecordStatus(db, record.id, "done");
    const rows = getRecordsBySpace(db, session.id, "tasks");
    const updated = rows.find((r) => r.id === record.id);
    expect(updated!.status).toBe("done");
    expect(updated!.updated_at).toBeTruthy();
  });
});
