import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { initOrchestrationSchema } from "../../src/orchestration/schema";
import { getRecordsBySpace, getSession } from "../../src/orchestration/blackboard";
import { executeBlackboardDispatch } from "../../src/orchestration/dispatchEngine";
import type { DispatchPlan } from "../../src/orchestration/types";

describe("executeBlackboardDispatch", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    initOrchestrationSchema(db);
  });

  afterAll(() => {
    db.close();
  });

  test("single-agent dispatch creates session, writes input, runs 1 round, finalizes", async () => {
    const mockRunner = mock(async (_chatId: number, _topicId: number | null, _text: string) => {
      return "Security review complete: no critical findings";
    });

    const plan: DispatchPlan = {
      dispatchId: "int-1",
      userMessage: "Review EDEN security",
      classification: {
        intent: "security-review",
        primaryAgent: "security-compliance",
        topicHint: null,
        isCompound: false,
        confidence: 0.9,
        reasoning: "Security keyword match",
      },
      tasks: [{
        seq: 1,
        agentId: "security-compliance",
        topicHint: null,
        taskDescription: "Review EDEN security",
      }],
    };

    const result = await executeBlackboardDispatch(db, plan, mockRunner);

    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThan(0);

    // Verify session was created and completed
    const sessions = db.query("SELECT * FROM bb_sessions WHERE dispatch_id = ?").all("int-1") as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("done");

    // Verify input record was written
    const sessionId = sessions[0].id as string;
    const inputs = getRecordsBySpace(db, sessionId, "input");
    expect(inputs).toHaveLength(1);

    // Verify task record
    const tasks = getRecordsBySpace(db, sessionId, "tasks");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("done");

    // Verify artifact was written
    const artifacts = getRecordsBySpace(db, sessionId, "artifacts");
    expect(artifacts).toHaveLength(1);
  });

  test("returns failure when dispatch runner returns null", async () => {
    const mockRunner = mock(async () => null);

    const plan: DispatchPlan = {
      dispatchId: "int-2",
      userMessage: "Test failure",
      classification: {
        intent: "test",
        primaryAgent: "engineering",
        topicHint: null,
        isCompound: false,
        confidence: 0.8,
        reasoning: "test",
      },
      tasks: [{ seq: 1, agentId: "engineering", topicHint: null, taskDescription: "Test failure" }],
    };

    const result = await executeBlackboardDispatch(db, plan, mockRunner);
    expect(result.success).toBe(false);
  });
});
