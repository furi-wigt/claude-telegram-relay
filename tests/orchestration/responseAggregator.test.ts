import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initBlackboardSchema } from "../../src/orchestration/blackboardSchema";
import { createSession, writeRecord, updateRecordStatus } from "../../src/orchestration/blackboard";
import { aggregateResults } from "../../src/orchestration/responseAggregator";

describe("responseAggregator", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    initBlackboardSchema(db);
  });

  afterAll(() => {
    db.close();
  });

  test("aggregates results from completed tasks into a summary", () => {
    const session = createSession(db, { dispatchId: "agg-1" });
    const task1 = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      owner: "security-compliance",
      content: { taskDescription: "Review security", agentId: "security-compliance", seq: 1, dependsOn: [], topicHint: null },
      round: 0,
    });
    updateRecordStatus(db, task1.id, "done");
    writeRecord(db, {
      sessionId: session.id,
      space: "artifacts",
      recordType: "artifact",
      producer: "security-compliance",
      content: { summary: "Found 3 critical vulnerabilities in EKS cluster" },
      parentId: task1.id,
      round: 1,
    });

    const result = aggregateResults(db, session.id);
    expect(result.taskCount).toBe(1);
    expect(result.completedCount).toBe(1);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].summary).toContain("3 critical vulnerabilities");
  });

  test("includes failed tasks in summary", () => {
    const session = createSession(db, { dispatchId: "agg-2" });
    const task1 = writeRecord(db, {
      sessionId: session.id,
      space: "tasks",
      recordType: "task",
      owner: "engineering",
      content: { taskDescription: "Build feature", agentId: "engineering", seq: 1, dependsOn: [], topicHint: null },
      round: 0,
    });
    updateRecordStatus(db, task1.id, "failed");
    const result = aggregateResults(db, session.id);
    expect(result.taskCount).toBe(1);
    expect(result.completedCount).toBe(0);
    expect(result.failedCount).toBe(1);
  });

  test("returns empty result for session with no tasks", () => {
    const session = createSession(db, { dispatchId: "agg-3" });
    const result = aggregateResults(db, session.id);
    expect(result.taskCount).toBe(0);
    expect(result.artifacts).toEqual([]);
  });
});
