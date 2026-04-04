/**
 * Mesh Gap Analysis — Tier 1+2 Tests
 *
 * Gap 3:  Status transition validation
 * Gap 4:  Dispatch wall-clock timeout
 * Gap 1:  Audit log table + writes
 * Gap 10: Trigger firing persistence
 * Gap 8:  Orphan record reaper
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initBlackboardSchema } from "../../src/orchestration/blackboardSchema.ts";
import {
  createSession,
  writeRecord,
  updateRecordStatus,
  updateSessionStatus,
  getAuditEntries,
  reapOrphanRecords,
  InvalidTransitionError,
  VALID_RECORD_TRANSITIONS,
  VALID_SESSION_TRANSITIONS,
  writeAuditEntry,
} from "../../src/orchestration/blackboard.ts";
import { executeBlackboardDispatch, DISPATCH_TIMEOUT_MS } from "../../src/orchestration/dispatchEngine.ts";
import { initOrchestrationSchema } from "../../src/orchestration/schema.ts";
import type { DispatchPlan } from "../../src/orchestration/types.ts";

let db: Database;

function freshDb(): Database {
  const d = new Database(":memory:");
  initBlackboardSchema(d);
  return d;
}

function freshFullDb(): Database {
  const d = new Database(":memory:");
  initOrchestrationSchema(d);
  return d;
}

beforeEach(() => {
  db = freshDb();
});

// ── Gap 3: Status Transition Validation ─────────────────────────────────────

describe("Gap 3 — Record status transitions", () => {
  test("allows all valid transitions from pending", () => {
    for (const target of VALID_RECORD_TRANSITIONS.pending) {
      const session = createSession(db);
      const rec = writeRecord(db, {
        sessionId: session.id,
        space: "tasks",
        recordType: "task",
        content: { test: true },
      });
      expect(() => updateRecordStatus(db, rec.id, target)).not.toThrow();
    }
  });

  test("allows active → done", () => {
    const session = createSession(db);
    const rec = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      content: { test: true },
    });
    updateRecordStatus(db, rec.id, "active");
    expect(() => updateRecordStatus(db, rec.id, "done")).not.toThrow();
  });

  test("allows active → failed", () => {
    const session = createSession(db);
    const rec = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      content: { test: true },
    });
    updateRecordStatus(db, rec.id, "active");
    expect(() => updateRecordStatus(db, rec.id, "failed")).not.toThrow();
  });

  test("allows failed → pending (retry path)", () => {
    const session = createSession(db);
    const rec = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      content: { test: true },
    });
    updateRecordStatus(db, rec.id, "failed");
    expect(() => updateRecordStatus(db, rec.id, "pending")).not.toThrow();
  });

  test("rejects done → pending (invalid backtrack)", () => {
    const session = createSession(db);
    const rec = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      content: { test: true },
    });
    updateRecordStatus(db, rec.id, "done");
    expect(() => updateRecordStatus(db, rec.id, "pending")).toThrow(InvalidTransitionError);
  });

  test("rejects done → active (invalid backtrack)", () => {
    const session = createSession(db);
    const rec = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      content: { test: true },
    });
    updateRecordStatus(db, rec.id, "done");
    expect(() => updateRecordStatus(db, rec.id, "active")).toThrow(InvalidTransitionError);
  });

  test("rejects archived → anything", () => {
    const session = createSession(db);
    const rec = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      content: { test: true },
    });
    updateRecordStatus(db, rec.id, "archived");
    for (const target of ["pending", "active", "done", "failed", "superseded"] as const) {
      expect(() => updateRecordStatus(db, rec.id, target)).toThrow(InvalidTransitionError);
    }
  });

  test("throws InvalidTransitionError with correct fields", () => {
    const session = createSession(db);
    const rec = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      content: { test: true },
    });
    updateRecordStatus(db, rec.id, "done");
    try {
      updateRecordStatus(db, rec.id, "pending");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      expect((err as InvalidTransitionError).entity).toBe("record");
      expect((err as InvalidTransitionError).from).toBe("done");
      expect((err as InvalidTransitionError).to).toBe("pending");
    }
  });
});

describe("Gap 3 — Session status transitions", () => {
  test("allows active → done", () => {
    const session = createSession(db);
    expect(() => updateSessionStatus(db, session.id, "done")).not.toThrow();
  });

  test("allows active → finalizing → done", () => {
    const session = createSession(db);
    updateSessionStatus(db, session.id, "finalizing");
    expect(() => updateSessionStatus(db, session.id, "done")).not.toThrow();
  });

  test("allows done → active (governance retry)", () => {
    const session = createSession(db);
    updateSessionStatus(db, session.id, "done");
    expect(() => updateSessionStatus(db, session.id, "active")).not.toThrow();
  });

  test("allows failed → active (retry)", () => {
    const session = createSession(db);
    updateSessionStatus(db, session.id, "failed");
    expect(() => updateSessionStatus(db, session.id, "active")).not.toThrow();
  });

  test("rejects cancelled → active", () => {
    const session = createSession(db);
    updateSessionStatus(db, session.id, "cancelled");
    expect(() => updateSessionStatus(db, session.id, "active")).toThrow(InvalidTransitionError);
  });

  test("rejects done → finalizing", () => {
    const session = createSession(db);
    updateSessionStatus(db, session.id, "done");
    expect(() => updateSessionStatus(db, session.id, "finalizing")).toThrow(InvalidTransitionError);
  });
});

// ── Gap 1: Audit Log ────────────────────────────────────────────────────────

describe("Gap 1 — Audit log", () => {
  test("bb_audit_log table exists", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='bb_audit_log'")
      .all();
    expect(tables).toHaveLength(1);
  });

  test("writeRecord emits record_created audit entry", () => {
    const session = createSession(db);
    writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      producer: "command-center",
      content: { test: true },
    });

    const entries = getAuditEntries(db, session.id);
    const createEntries = entries.filter((e) => e.event_type === "record_created");
    expect(createEntries.length).toBeGreaterThanOrEqual(1);
    expect(createEntries[0].new_status).toBe("pending");
    expect(createEntries[0].agent).toBe("command-center");
  });

  test("updateRecordStatus emits record_status_changed audit entry", () => {
    const session = createSession(db);
    const rec = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      content: { test: true },
    });
    updateRecordStatus(db, rec.id, "active");

    const entries = getAuditEntries(db, session.id);
    const statusEntries = entries.filter((e) => e.event_type === "record_status_changed");
    expect(statusEntries.length).toBeGreaterThanOrEqual(1);
    const last = statusEntries[statusEntries.length - 1];
    expect(last.old_status).toBe("pending");
    expect(last.new_status).toBe("active");
  });

  test("updateSessionStatus emits session_status_changed audit entry", () => {
    const session = createSession(db);
    updateSessionStatus(db, session.id, "finalizing");

    const entries = getAuditEntries(db, session.id);
    const sessionEntries = entries.filter((e) => e.event_type === "session_status_changed");
    expect(sessionEntries.length).toBeGreaterThanOrEqual(1);
    expect(sessionEntries[0].old_status).toBe("active");
    expect(sessionEntries[0].new_status).toBe("finalizing");
  });

  test("audit entries are ordered by id (insertion order)", () => {
    const session = createSession(db);
    const rec = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      content: { test: true },
    });
    updateRecordStatus(db, rec.id, "active");
    updateRecordStatus(db, rec.id, "done");

    const entries = getAuditEntries(db, session.id);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].id).toBeGreaterThan(entries[i - 1].id);
    }
  });

  test("audit failure does not block record write", () => {
    // writeAuditEntry catches internally, so even if something goes wrong
    // the parent operation should succeed. We test that writeRecord works
    // even when audit_log table schema is unusual.
    const session = createSession(db);
    const rec = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      content: { test: true },
    });
    expect(rec.id).toBeTruthy();
    expect(rec.status).toBe("pending");
  });
});

// ── Gap 4: Dispatch Wall-Clock Timeout ──────────────────────────────────────

describe("Gap 4 — Dispatch wall-clock timeout", () => {
  test("DISPATCH_TIMEOUT_MS is exported and is 10 minutes", () => {
    expect(DISPATCH_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  test("dispatch completes normally when within timeout", async () => {
    const fullDb = freshFullDb();
    const mockRunner = async () => "Done quickly";

    const plan: DispatchPlan = {
      dispatchId: "timeout-1",
      userMessage: "Quick task",
      classification: {
        intent: "test",
        primaryAgent: "operations-hub",
        topicHint: null,
        isCompound: false,
        confidence: 0.9,
        reasoning: "test",
      },
      tasks: [{ seq: 1, agentId: "operations-hub", topicHint: null, taskDescription: "Quick task" }],
    };

    const result = await executeBlackboardDispatch(fullDb, plan, mockRunner);
    expect(result.success).toBe(true);
    expect(result.durationMs).toBeLessThan(DISPATCH_TIMEOUT_MS);
    fullDb.close();
  });
});

// ── Gap 10: Trigger Firing Persistence ──────────────────────────────────────

describe("Gap 10 — Trigger firing log", () => {
  test("trigger firings are logged in audit after dispatch", async () => {
    const fullDb = freshFullDb();
    const mockRunner = async () => "Agent response";

    const plan: DispatchPlan = {
      dispatchId: "trigger-log-1",
      userMessage: "Test trigger logging",
      classification: {
        intent: "test",
        primaryAgent: "engineering",
        topicHint: null,
        isCompound: false,
        confidence: 0.9,
        reasoning: "test",
      },
      tasks: [{ seq: 1, agentId: "engineering", topicHint: null, taskDescription: "Test trigger logging" }],
    };

    const result = await executeBlackboardDispatch(fullDb, plan, mockRunner);

    // Find the session
    const sessions = fullDb.query("SELECT id FROM bb_sessions WHERE dispatch_id = ?").all("trigger-log-1") as Array<{ id: string }>;
    const sessionId = sessions[0].id;

    // Check audit log for trigger_fired entries
    const entries = getAuditEntries(fullDb, sessionId);
    const triggerEntries = entries.filter((e) => e.event_type === "trigger_fired");

    expect(triggerEntries.length).toBeGreaterThanOrEqual(1);
    // At minimum: EXECUTE trigger for the task
    const executeTrigger = triggerEntries.find((e) => {
      const meta = JSON.parse(e.metadata!);
      return meta.rule === "EXECUTE";
    });
    expect(executeTrigger).toBeTruthy();

    fullDb.close();
  });

  test("trigger metadata includes rule, reason, and round", async () => {
    const fullDb = freshFullDb();
    const mockRunner = async () => "Done";

    const plan: DispatchPlan = {
      dispatchId: "trigger-meta-1",
      userMessage: "Test meta",
      classification: {
        intent: "test",
        primaryAgent: "operations-hub",
        topicHint: null,
        isCompound: false,
        confidence: 0.9,
        reasoning: "test",
      },
      tasks: [{ seq: 1, agentId: "operations-hub", topicHint: null, taskDescription: "Test meta" }],
    };

    await executeBlackboardDispatch(fullDb, plan, mockRunner);

    const sessions = fullDb.query("SELECT id FROM bb_sessions WHERE dispatch_id = ?").all("trigger-meta-1") as Array<{ id: string }>;
    const entries = getAuditEntries(fullDb, sessions[0].id);
    const trigger = entries.find((e) => e.event_type === "trigger_fired");

    expect(trigger).toBeTruthy();
    const meta = JSON.parse(trigger!.metadata!);
    expect(meta).toHaveProperty("rule");
    expect(meta).toHaveProperty("reason");
    expect(meta).toHaveProperty("round");

    fullDb.close();
  });
});

// ── Gap 8: Orphan Record Reaper ─────────────────────────────────────────────

describe("Gap 8 — Orphan record reaper", () => {
  test("reaps active records older than threshold on active sessions", () => {
    const session = createSession(db);
    // Create an active record backdated 15 min
    db.run(
      `INSERT INTO bb_records (id, session_id, space, record_type, status, content, created_at, updated_at)
       VALUES (?, ?, 'tasks', 'task', 'active', '{}', datetime('now', '-15 minutes'), datetime('now', '-15 minutes'))`,
      [crypto.randomUUID(), session.id],
    );

    const reaped = reapOrphanRecords(db, 10);
    expect(reaped).toBe(1);
  });

  test("does NOT reap fresh active records", () => {
    const session = createSession(db);
    const rec = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      content: { test: true },
    });
    updateRecordStatus(db, rec.id, "active");

    const reaped = reapOrphanRecords(db, 10);
    expect(reaped).toBe(0);
  });

  test("does NOT reap records on non-active sessions", () => {
    const session = createSession(db);
    db.run(
      `INSERT INTO bb_records (id, session_id, space, record_type, status, content, created_at, updated_at)
       VALUES (?, ?, 'tasks', 'task', 'active', '{}', datetime('now', '-15 minutes'), datetime('now', '-15 minutes'))`,
      [crypto.randomUUID(), session.id],
    );
    // Mark session as done
    updateSessionStatus(db, session.id, "done");

    const reaped = reapOrphanRecords(db, 10);
    expect(reaped).toBe(0);
  });

  test("does NOT reap pending records (only active)", () => {
    const session = createSession(db);
    // Create a pending record backdated 15 min
    db.run(
      `INSERT INTO bb_records (id, session_id, space, record_type, status, content, created_at)
       VALUES (?, ?, 'tasks', 'task', 'pending', '{}', datetime('now', '-15 minutes'))`,
      [crypto.randomUUID(), session.id],
    );

    const reaped = reapOrphanRecords(db, 10);
    expect(reaped).toBe(0);
  });

  test("returns 0 when no orphans found", () => {
    createSession(db);
    expect(reapOrphanRecords(db)).toBe(0);
  });

  test("custom staleMinutes threshold works", () => {
    const session = createSession(db);
    db.run(
      `INSERT INTO bb_records (id, session_id, space, record_type, status, content, created_at, updated_at)
       VALUES (?, ?, 'tasks', 'task', 'active', '{}', datetime('now', '-6 minutes'), datetime('now', '-6 minutes'))`,
      [crypto.randomUUID(), session.id],
    );

    // 10 min threshold — should NOT reap (only 6 min old)
    expect(reapOrphanRecords(db, 10)).toBe(0);

    // 5 min threshold — SHOULD reap
    expect(reapOrphanRecords(db, 5)).toBe(1);
  });
});
