/**
 * Finalizer & Governance (Phase 5) Tests
 *
 * P5.1 — Synthesis: aggregate artifacts/reviews → final record
 * P5.2 — Board compaction: archive done, clean stale
 * P5.3 — Governance UI: final keyboard, callback parsing, action handling
 * P5.4 — CC progress dashboard: snapshot, throttling
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initBlackboardSchema } from "../../src/orchestration/blackboardSchema.ts";
import {
  createSession,
  writeRecord,
  getRecords,
  getRecordsBySpace,
  getSession,
  updateRecordStatus,
} from "../../src/orchestration/blackboard.ts";
import {
  finalizeSynthesis,
  completeSession,
  compactBoard,
  compactAllSessions,
  buildFinalKeyboard,
  parseFinalCallback,
  handleFinalAction,
  buildProgressSnapshot,
  clearProgressThrottle,
  STALE_HOURS,
  PROGRESS_THROTTLE_MS,
} from "../../src/orchestration/finalizer.ts";
import { ORCH_CB_PREFIX } from "../../src/orchestration/interruptProtocol.ts";

let db: Database;

function freshDb(): Database {
  const d = new Database(":memory:");
  initBlackboardSchema(d);
  return d;
}

/** Helper: create a session with N done tasks and N artifacts */
function seedCompletedSession(taskCount: number = 2): { sessionId: string } {
  const session = createSession(db);
  for (let i = 1; i <= taskCount; i++) {
    const task = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      producer: "command-center",
      owner: i % 2 === 0 ? "cloud-architect" : "engineering",
      content: { taskDescription: `Task ${i}`, agentId: i % 2 === 0 ? "cloud-architect" : "engineering", seq: i, dependsOn: [] },
    });
    updateRecordStatus(db, task.id, "done");

    const artifact = writeRecord(db, {
      sessionId: session.id,
      space: "artifacts",
      recordType: "artifact",
      producer: i % 2 === 0 ? "cloud-architect" : "engineering",
      content: { summary: `Artifact ${i} output`, fullResponse: `Full response for artifact ${i}` },
    });
    updateRecordStatus(db, artifact.id, "done");

    // Add a review for each artifact
    writeRecord(db, {
      sessionId: session.id,
      space: "reviews",
      recordType: "review",
      producer: "code-quality-coach",
      content: { verdict: "approved", targetRecordId: artifact.id, feedback: "Looks good", iteration: 1 },
      parentId: artifact.id,
    });
  }
  return { sessionId: session.id };
}

beforeEach(() => {
  db = freshDb();
  clearProgressThrottle();
});

// ── P5.1: Synthesis ──────────────────────────────────────────────────────────

describe("P5.1 — finalizeSynthesis", () => {
  test("produces synthesis record from completed tasks", () => {
    const { sessionId } = seedCompletedSession(3);

    const result = finalizeSynthesis(db, sessionId);

    expect(result).not.toBeNull();
    expect(result!.taskCount).toBe(3);
    expect(result!.completedCount).toBe(3);
    expect(result!.failedCount).toBe(0);
    expect(result!.artifactSummaries.length).toBe(3);
    expect(result!.reviewSummaries.length).toBe(3);
    expect(result!.summary).toContain("SYNTHESIS");
    expect(result!.summary).toContain("3/3 tasks complete");
  });

  test("transitions session to finalizing", () => {
    const { sessionId } = seedCompletedSession();

    finalizeSynthesis(db, sessionId);

    const session = getSession(db, sessionId);
    expect(session!.status).toBe("finalizing");
  });

  test("writes final record to 'final' space", () => {
    const { sessionId } = seedCompletedSession();

    const result = finalizeSynthesis(db, sessionId);

    const finalRecords = getRecordsBySpace(db, sessionId, "final");
    expect(finalRecords.length).toBe(1);
    expect(finalRecords[0].id).toBe(result!.finalRecordId);
    expect(finalRecords[0].record_type).toBe("output");
    expect(finalRecords[0].producer).toBe("finalizer");
  });

  test("excludes superseded artifacts from synthesis", () => {
    const session = createSession(db);
    const task = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      producer: "command-center",
      content: { taskDescription: "Build API", agentId: "engineering", seq: 1, dependsOn: [] },
    });
    updateRecordStatus(db, task.id, "done");

    // Superseded artifact (v1)
    const v1 = writeRecord(db, {
      sessionId: session.id,
      space: "artifacts",
      recordType: "artifact",
      producer: "engineering",
      content: { summary: "v1 output" },
    });
    updateRecordStatus(db, v1.id, "superseded");

    // Active artifact (v2)
    writeRecord(db, {
      sessionId: session.id,
      space: "artifacts",
      recordType: "artifact",
      producer: "engineering",
      content: { summary: "v2 output" },
      supersedes: v1.id,
    });

    const result = finalizeSynthesis(db, session.id);

    expect(result!.artifactSummaries.length).toBe(1);
    expect(result!.artifactSummaries[0].summary).toBe("v2 output");
  });

  test("includes conflict resolutions in synthesis", () => {
    const { sessionId } = seedCompletedSession(1);

    // Add a resolved conflict
    const conflict = writeRecord(db, {
      sessionId,
      space: "conflicts",
      recordType: "conflict",
      producer: "control-plane",
      content: { type: "recommendation_conflict", agents: ["cloud-architect", "security-compliance"], relatedRecords: [], resolutionPolicy: "evidence_then_arbitration", resolution: "cloud-architect recommendation accepted" },
    });
    updateRecordStatus(db, conflict.id, "done");

    const result = finalizeSynthesis(db, sessionId);

    expect(result!.conflictResolutions.length).toBe(1);
    expect(result!.conflictResolutions[0]).toContain("cloud-architect");
  });

  test("reports failed tasks in synthesis", () => {
    const session = createSession(db);
    const t1 = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      content: { taskDescription: "Done task", agentId: "engineering", seq: 1, dependsOn: [] },
    });
    updateRecordStatus(db, t1.id, "done");

    const t2 = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      content: { taskDescription: "Failed task", agentId: "cloud-architect", seq: 2, dependsOn: [] },
    });
    updateRecordStatus(db, t2.id, "failed");

    const result = finalizeSynthesis(db, session.id);

    expect(result!.completedCount).toBe(1);
    expect(result!.failedCount).toBe(1);
    expect(result!.summary).toContain("1 task(s) failed");
  });

  test("returns null for already-done session", () => {
    const { sessionId } = seedCompletedSession();
    db.run("UPDATE bb_sessions SET status = 'done' WHERE id = ?", [sessionId]);

    expect(finalizeSynthesis(db, sessionId)).toBeNull();
  });

  test("returns null for cancelled session", () => {
    const { sessionId } = seedCompletedSession();
    db.run("UPDATE bb_sessions SET status = 'cancelled' WHERE id = ?", [sessionId]);

    expect(finalizeSynthesis(db, sessionId)).toBeNull();
  });

  test("includes review verdict in artifact summary", () => {
    const { sessionId } = seedCompletedSession(1);
    const result = finalizeSynthesis(db, sessionId);

    // seedCompletedSession adds "approved" reviews
    expect(result!.artifactSummaries[0].verdict).toBe("approved");
  });
});

// ── P5.1b: completeSession ───────────────────────────────────────────────────

describe("P5.1b — completeSession", () => {
  test("marks session done and archives records", () => {
    const { sessionId } = seedCompletedSession(2);

    const { archivedCount } = completeSession(db, sessionId, true);

    expect(archivedCount).toBeGreaterThan(0);
    expect(getSession(db, sessionId)!.status).toBe("done");
  });

  test("marks session done without archiving when requested", () => {
    const { sessionId } = seedCompletedSession(2);

    const { archivedCount } = completeSession(db, sessionId, false);

    expect(archivedCount).toBe(0);
    expect(getSession(db, sessionId)!.status).toBe("done");
  });
});

// ── P5.2: Board Compaction ───────────────────────────────────────────────────

describe("P5.2 — compactBoard", () => {
  test("archives done records", () => {
    const { sessionId } = seedCompletedSession(2);

    const result = compactBoard(db, sessionId);

    expect(result.archivedCount).toBeGreaterThan(0);
    // Verify records are now archived
    const records = getRecords(db, sessionId);
    const archived = records.filter((r) => r.status === "archived");
    expect(archived.length).toBe(result.archivedCount);
  });

  test("cleans stale pending records", () => {
    const session = createSession(db);

    // Insert a stale record (backdated)
    db.run(
      `INSERT INTO bb_records (id, session_id, space, record_type, status, content, created_at)
       VALUES (?, ?, 'tasks', 'task', 'pending', '{}', datetime('now', '-${STALE_HOURS + 1} hours'))`,
      [crypto.randomUUID(), session.id],
    );

    const result = compactBoard(db, session.id);

    expect(result.staleCleanedCount).toBe(1);
  });

  test("does not clean fresh pending records", () => {
    const session = createSession(db);
    writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      content: { taskDescription: "Fresh task", agentId: "engineering", seq: 1, dependsOn: [] },
    });

    const result = compactBoard(db, session.id);

    expect(result.staleCleanedCount).toBe(0);
  });
});

describe("P5.2b — compactAllSessions", () => {
  test("processes all completed sessions", () => {
    // Create 2 done sessions
    const s1 = seedCompletedSession(1);
    db.run("UPDATE bb_sessions SET status = 'done' WHERE id = ?", [s1.sessionId]);

    const s2 = seedCompletedSession(1);
    db.run("UPDATE bb_sessions SET status = 'done' WHERE id = ?", [s2.sessionId]);

    // Create 1 active session (should be skipped)
    seedCompletedSession(1);

    const result = compactAllSessions(db);

    expect(result.sessionsProcessed).toBe(2);
    expect(result.totalArchived).toBeGreaterThan(0);
  });
});

// ── P5.3: Governance UI ─────────────────────────────────────────────────────

describe("P5.3 — buildFinalKeyboard", () => {
  test("returns keyboard with 4 buttons in 2 rows", () => {
    const kb = buildFinalKeyboard("session-123");
    const rows = kb.inline_keyboard;

    expect(rows.length).toBe(2);
    expect(rows[0].length).toBe(2); // Approve, Override
    expect(rows[1].length).toBe(2); // Retry, Discard
  });

  test("callbacks use ORCH_CB_PREFIX", () => {
    const kb = buildFinalKeyboard("session-123");
    const allButtons = kb.inline_keyboard.flat();

    for (const btn of allButtons) {
      expect(btn.callback_data).toStartWith(ORCH_CB_PREFIX);
      expect(btn.callback_data).toContain("session-123");
    }
  });
});

describe("P5.3b — parseFinalCallback", () => {
  test("parses valid finalizer callbacks", () => {
    const actions = ["final_approve", "final_override", "final_retry", "final_discard"] as const;
    for (const action of actions) {
      const result = parseFinalCallback(`${ORCH_CB_PREFIX}${action}:session-abc`);
      expect(result).not.toBeNull();
      expect(result!.action).toBe(action);
      expect(result!.sessionId).toBe("session-abc");
    }
  });

  test("returns null for non-finalizer callbacks", () => {
    expect(parseFinalCallback(`${ORCH_CB_PREFIX}pause:dispatch-1`)).toBeNull();
    expect(parseFinalCallback(`${ORCH_CB_PREFIX}conflict_keep:record:agent`)).toBeNull();
    expect(parseFinalCallback("random_data")).toBeNull();
  });

  test("returns null for malformed data", () => {
    expect(parseFinalCallback(`${ORCH_CB_PREFIX}final_approve`)).toBeNull(); // no colon+id
    expect(parseFinalCallback("")).toBeNull();
  });
});

describe("P5.3c — handleFinalAction", () => {
  test("final_approve: marks done + archives", () => {
    const { sessionId } = seedCompletedSession(2);

    const result = handleFinalAction(db, "final_approve", sessionId);

    expect(result.sessionCompleted).toBe(true);
    expect(result.message).toContain("approved");
    expect(getSession(db, sessionId)!.status).toBe("done");
  });

  test("final_override: marks done without archiving", () => {
    const { sessionId } = seedCompletedSession(1);

    const result = handleFinalAction(db, "final_override", sessionId);

    expect(result.sessionCompleted).toBe(true);
    expect(result.message).toContain("preserved");
    expect(getSession(db, sessionId)!.status).toBe("done");
    // Records should still be 'done', not 'archived'
    const records = getRecords(db, sessionId).filter((r) => r.status === "done");
    expect(records.length).toBeGreaterThan(0);
  });

  test("final_retry: resets failed tasks + reactivates session", () => {
    const session = createSession(db);
    const t1 = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      content: { taskDescription: "Failed task", agentId: "engineering", seq: 1, dependsOn: [] },
    });
    updateRecordStatus(db, t1.id, "failed");

    const result = handleFinalAction(db, "final_retry", session.id);

    expect(result.sessionCompleted).toBe(false);
    expect(result.message).toContain("1 failed task(s) reset");
    expect(getSession(db, session.id)!.status).toBe("active");

    // Task should be pending again
    const records = getRecordsBySpace(db, session.id, "tasks");
    expect(records[0].status).toBe("pending");
  });

  test("final_discard: cancels session", () => {
    const { sessionId } = seedCompletedSession(1);

    const result = handleFinalAction(db, "final_discard", sessionId);

    expect(result.sessionCompleted).toBe(true);
    expect(result.message).toContain("discarded");
    expect(getSession(db, sessionId)!.status).toBe("cancelled");
  });
});

// ── P5.4: Progress Dashboard ─────────────────────────────────────────────────

describe("P5.4 — buildProgressSnapshot", () => {
  test("returns accurate task counters", () => {
    const session = createSession(db);
    const t1 = writeRecord(db, {
      sessionId: session.id, space: "tasks", recordType: "task",
      content: { taskDescription: "Pending", agentId: "a", seq: 1, dependsOn: [] },
    });
    const t2 = writeRecord(db, {
      sessionId: session.id, space: "tasks", recordType: "task",
      content: { taskDescription: "Active", agentId: "b", seq: 2, dependsOn: [] },
    });
    updateRecordStatus(db, t2.id, "active");
    const t3 = writeRecord(db, {
      sessionId: session.id, space: "tasks", recordType: "task",
      content: { taskDescription: "Done", agentId: "c", seq: 3, dependsOn: [] },
    });
    updateRecordStatus(db, t3.id, "done");

    const snap = buildProgressSnapshot(db, session.id, true);

    expect(snap).not.toBeNull();
    expect(snap!.tasksPending).toBe(1);
    expect(snap!.tasksActive).toBe(1);
    expect(snap!.tasksDone).toBe(1);
    expect(snap!.tasksFailed).toBe(0);
  });

  test("counts artifacts, reviews, and open conflicts", () => {
    const session = createSession(db);
    writeRecord(db, { sessionId: session.id, space: "artifacts", recordType: "artifact", content: { summary: "art1" } });
    writeRecord(db, { sessionId: session.id, space: "reviews", recordType: "review", content: { verdict: "approved", targetRecordId: "x", feedback: "", iteration: 1 } });
    writeRecord(db, { sessionId: session.id, space: "conflicts", recordType: "conflict", content: { type: "recommendation_conflict", agents: ["a", "b"], relatedRecords: [], resolutionPolicy: "human_escalation" } });

    const snap = buildProgressSnapshot(db, session.id, true);

    expect(snap!.artifactCount).toBe(1);
    expect(snap!.reviewCount).toBe(1);
    expect(snap!.openConflicts).toBe(1);
  });

  test("excludes superseded artifacts from count", () => {
    const session = createSession(db);
    const a1 = writeRecord(db, { sessionId: session.id, space: "artifacts", recordType: "artifact", content: { summary: "v1" } });
    updateRecordStatus(db, a1.id, "superseded");
    writeRecord(db, { sessionId: session.id, space: "artifacts", recordType: "artifact", content: { summary: "v2" } });

    const snap = buildProgressSnapshot(db, session.id, true);

    expect(snap!.artifactCount).toBe(1);
  });

  test("formats progress bar in text", () => {
    const { sessionId } = seedCompletedSession(2);

    const snap = buildProgressSnapshot(db, sessionId, true);

    expect(snap!.text).toContain("Progress");
    expect(snap!.text).toContain("2/2 tasks");
    // Should have full bar (all done)
    expect(snap!.text).toMatch(/\u2588{10}/); // 10 filled blocks
  });

  test("throttles updates unless forced", () => {
    const session = createSession(db);

    // First call — should succeed
    const snap1 = buildProgressSnapshot(db, session.id);
    expect(snap1).not.toBeNull();

    // Immediate second call — throttled
    const snap2 = buildProgressSnapshot(db, session.id);
    expect(snap2).toBeNull();

    // Forced call — bypasses throttle
    const snap3 = buildProgressSnapshot(db, session.id, true);
    expect(snap3).not.toBeNull();
  });

  test("returns null for nonexistent session", () => {
    expect(buildProgressSnapshot(db, "nonexistent", true)).toBeNull();
  });

  test("clearProgressThrottle resets throttle for specific session", () => {
    const session = createSession(db);

    buildProgressSnapshot(db, session.id);
    expect(buildProgressSnapshot(db, session.id)).toBeNull(); // throttled

    clearProgressThrottle(session.id);
    expect(buildProgressSnapshot(db, session.id)).not.toBeNull(); // cleared
  });
});
