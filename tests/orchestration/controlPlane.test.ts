import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initBlackboardSchema } from "../../src/orchestration/blackboardSchema";
import { createSession, writeRecord, updateRecordStatus } from "../../src/orchestration/blackboard";
import { selectNextAgents } from "../../src/orchestration/controlPlane";

describe("controlPlane.selectNextAgents", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    initBlackboardSchema(db);
  });

  afterAll(() => {
    db.close();
  });

  test("INIT rule: input exists, no tasks → triggers decomposition", () => {
    const session = createSession(db, { dispatchId: "cp-1" });
    writeRecord(db, {
      sessionId: session.id,
      space: "input",
      recordType: "task",
      producer: "command-center",
      content: { message: "Review EDEN security", agentId: "security-compliance", seq: 1, dependsOn: [], topicHint: null },
      round: 0,
    });
    const triggers = selectNextAgents(db, session.id);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].rule).toBe("INIT");
  });

  test("EXECUTE rule: pending task with no deps → triggers owning agent", () => {
    const session = createSession(db, { dispatchId: "cp-2" });
    writeRecord(db, {
      sessionId: session.id,
      space: "input",
      recordType: "task",
      content: { message: "test" },
      round: 0,
    });
    const taskRec = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      owner: "security-compliance",
      content: { taskDescription: "Review security", agentId: "security-compliance", seq: 1, dependsOn: [], topicHint: null },
      round: 0,
    });
    const triggers = selectNextAgents(db, session.id);
    expect(triggers.some((t) => t.rule === "EXECUTE" && t.agentId === "security-compliance")).toBe(true);
  });

  test("EXECUTE rule: task with unfinished deps → NOT triggered", () => {
    const session = createSession(db, { dispatchId: "cp-3" });
    writeRecord(db, { sessionId: session.id, space: "input", recordType: "task", content: { message: "test" }, round: 0 });
    writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      owner: "engineering",
      content: { taskDescription: "Task 1", agentId: "engineering", seq: 1, dependsOn: [], topicHint: null },
      round: 0,
    });
    writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      owner: "cloud-architect",
      content: { taskDescription: "Task 2", agentId: "cloud-architect", seq: 2, dependsOn: [1], topicHint: null },
      round: 0,
    });
    const triggers = selectNextAgents(db, session.id);
    expect(triggers.some((t) => t.agentId === "engineering")).toBe(true);
    expect(triggers.some((t) => t.agentId === "cloud-architect")).toBe(false);
  });

  test("FINALIZE rule: all tasks done, no open reviews → triggers finalizer", () => {
    const session = createSession(db, { dispatchId: "cp-4" });
    writeRecord(db, { sessionId: session.id, space: "input", recordType: "task", content: { message: "test" }, round: 0 });
    const task = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      owner: "engineering",
      content: { taskDescription: "Build it", agentId: "engineering", seq: 1, dependsOn: [], topicHint: null },
      round: 0,
    });
    updateRecordStatus(db, task.id, "done");
    const triggers = selectNextAgents(db, session.id);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].rule).toBe("FINALIZE");
  });

  test("ESCALATE rule: round >= max_rounds", () => {
    const session = createSession(db, { dispatchId: "cp-5", maxRounds: 2 });
    db.run("UPDATE bb_sessions SET current_round = 2 WHERE id = ?", [session.id]);
    writeRecord(db, { sessionId: session.id, space: "input", recordType: "task", content: { message: "test" }, round: 0 });
    writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      owner: "engineering",
      content: { taskDescription: "Incomplete", agentId: "engineering", seq: 1, dependsOn: [], topicHint: null },
      round: 0,
    });
    const triggers = selectNextAgents(db, session.id);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].rule).toBe("ESCALATE");
  });

  test("returns empty when session not found", () => {
    const triggers = selectNextAgents(db, "nonexistent");
    expect(triggers).toEqual([]);
  });
});
