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
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

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

  test("runner throw marks task failed and continues to finalize", async () => {
    const mockRunner = mock(async (_chatId: number, _topicId: number | null, _text: string) => {
      throw new Error("claudeStream: exit 1");
    });

    const plan: DispatchPlan = {
      dispatchId: "int-throw-1",
      userMessage: "Test runner throw",
      classification: {
        intent: "test",
        primaryAgent: "engineering",
        topicHint: null,
        isCompound: false,
        confidence: 0.9,
        reasoning: "test",
      },
      tasks: [{ seq: 1, agentId: "engineering", topicHint: null, taskDescription: "Test runner throw" }],
    };

    // Should NOT throw — error should be caught internally
    const result = await executeBlackboardDispatch(db, plan, mockRunner);
    expect(result.success).toBe(false);

    // Verify task was marked failed (not left as active)
    const sessions = db.query("SELECT id FROM bb_sessions WHERE dispatch_id = ?").all("int-throw-1") as Array<{ id: string }>;
    const tasks = getRecordsBySpace(db, sessions[0].id, "tasks");
    expect(tasks[0].status).toBe("failed");
  });

  test("multi-task dispatch continues after one runner throws", async () => {
    let callCount = 0;
    const mockRunner = mock(async (_chatId: number, _topicId: number | null, text: string) => {
      callCount++;
      if (text.includes("task-1")) throw new Error("claudeStream: exit 1");
      return "Task 2 complete";
    });

    const plan: DispatchPlan = {
      dispatchId: "int-throw-multi",
      userMessage: "Multi task with partial failure",
      classification: {
        intent: "compound",
        primaryAgent: "engineering",
        topicHint: null,
        isCompound: true,
        confidence: 0.9,
        reasoning: "test",
      },
      tasks: [
        { seq: 1, agentId: "engineering", topicHint: null, taskDescription: "task-1: will throw" },
        { seq: 2, agentId: "operations-hub", topicHint: null, taskDescription: "task-2: will succeed" },
      ],
    };

    const result = await executeBlackboardDispatch(db, plan, mockRunner);

    // Both tasks + reviewer for successful task were attempted
    expect(callCount).toBeGreaterThanOrEqual(2);

    // Session completed (not thrown)
    const sessions = db.query("SELECT id, status FROM bb_sessions WHERE dispatch_id = ?").all("int-throw-multi") as Array<{ id: string; status: string }>;
    expect(sessions[0].status).toBe("done");

    // First task failed, second succeeded
    const tasks = getRecordsBySpace(db, sessions[0].id, "tasks");
    const task1 = tasks.find(t => JSON.parse(t.content).taskDescription.includes("task-1"));
    const task2 = tasks.find(t => JSON.parse(t.content).taskDescription.includes("task-2"));
    expect(task1?.status).toBe("failed");
    expect(task2?.status).toBe("done");

    // Artifact written only for successful task
    const artifacts = getRecordsBySpace(db, sessions[0].id, "artifacts");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].producer).toBe("operations-hub");
  });

  test("reviewer runner throw does not break artifact dispatch", async () => {
    let runnerCallCount = 0;
    const mockRunner = mock(async (chatId: number, _topicId: number | null, _text: string) => {
      runnerCallCount++;
      // First call = main agent dispatch (succeeds)
      // Second call = reviewer (throws)
      if (runnerCallCount === 1) return "Main artifact response";
      throw new Error("Reviewer claudeStream: exit 1");
    });

    const plan: DispatchPlan = {
      dispatchId: "int-reviewer-throw",
      userMessage: "Review my AWS CDK stack",
      classification: {
        intent: "code-review",
        primaryAgent: "engineering",
        topicHint: null,
        isCompound: false,
        confidence: 0.9,
        reasoning: "test",
      },
      tasks: [{ seq: 1, agentId: "engineering", topicHint: null, taskDescription: "Review my AWS CDK stack" }],
    };

    const result = await executeBlackboardDispatch(db, plan, mockRunner);

    // Main dispatch succeeded despite reviewer throw
    expect(result.success).toBe(true);

    // Artifact was written
    const sessions = db.query("SELECT id FROM bb_sessions WHERE dispatch_id = ?").all("int-reviewer-throw") as Array<{ id: string }>;
    const artifacts = getRecordsBySpace(db, sessions[0].id, "artifacts");
    expect(artifacts).toHaveLength(1);
  });

  test("loop exit without FINALIZE trigger still attempts synthesis", async () => {
    const mockRunner = mock(async () => "Done");

    const plan: DispatchPlan = {
      dispatchId: "int-loop-exit",
      userMessage: "Simple task",
      classification: {
        intent: "general",
        primaryAgent: "operations-hub",
        topicHint: null,
        isCompound: false,
        confidence: 0.9,
        reasoning: "test",
      },
      tasks: [{ seq: 1, agentId: "operations-hub", topicHint: null, taskDescription: "Simple task" }],
    };

    const result = await executeBlackboardDispatch(db, plan, mockRunner);

    // Session reaches done status
    expect(result.success).toBe(true);
    const sessions = db.query("SELECT id, status FROM bb_sessions WHERE dispatch_id = ?").all("int-loop-exit") as Array<{ id: string; status: string }>;
    expect(sessions[0].status).toBe("done");
  });
});
