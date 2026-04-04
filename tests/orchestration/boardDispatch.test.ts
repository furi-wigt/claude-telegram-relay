import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initBlackboardSchema } from "../../src/orchestration/blackboardSchema";
import { getRecords, getRecordsBySpace, getRecord } from "../../src/orchestration/blackboard";
import { initBoardDispatch, processAgentResponse, clearCircuitBreaker } from "../../src/orchestration/boardDispatch";
import type { BbTaskContent } from "../../src/orchestration/types";

describe("boardDispatch.initBoardDispatch", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    initBlackboardSchema(db);
  });

  afterAll(() => {
    db.close();
  });

  test("creates session + input + task records", () => {
    const result = initBoardDispatch(db, {
      dispatchId: "d-bd-1",
      userMessage: "Prep for CityWatch meeting",
      tasks: [
        { seq: 1, agentId: "research-analyst", topicHint: null, taskDescription: "Research CityWatch project status" },
        { seq: 2, agentId: "strategy-comms", topicHint: null, taskDescription: "Draft talking points", dependsOn: [1] },
      ],
    });

    expect(result.sessionId).toBeTruthy();
    expect(result.taskRecordIds).toHaveLength(2);

    // Check input record
    const inputs = getRecordsBySpace(db, result.sessionId, "input");
    expect(inputs).toHaveLength(1);
    expect(JSON.parse(inputs[0].content).message).toBe("Prep for CityWatch meeting");

    // Check task records
    const tasks = getRecordsBySpace(db, result.sessionId, "tasks");
    expect(tasks).toHaveLength(2);
    const t1 = JSON.parse(tasks[0].content) as BbTaskContent;
    expect(t1.agentId).toBe("research-analyst");
    expect(t1.dependsOn).toEqual([]);
    const t2 = JSON.parse(tasks[1].content) as BbTaskContent;
    expect(t2.dependsOn).toEqual([1]);
  });

  test("returns EXECUTE triggers for ready tasks", () => {
    const result = initBoardDispatch(db, {
      dispatchId: "d-bd-2",
      userMessage: "Review security",
      tasks: [
        { seq: 1, agentId: "security-compliance", topicHint: null, taskDescription: "IM8 audit" },
      ],
    });

    expect(result.initialTriggers.length).toBeGreaterThanOrEqual(1);
    expect(result.initialTriggers.some((t) => t.rule === "EXECUTE" && t.agentId === "security-compliance")).toBe(true);
  });

  test("only triggers tasks with satisfied deps", () => {
    const result = initBoardDispatch(db, {
      dispatchId: "d-bd-3",
      userMessage: "Multi-step task",
      tasks: [
        { seq: 1, agentId: "engineering", topicHint: null, taskDescription: "Step 1" },
        { seq: 2, agentId: "cloud-architect", topicHint: null, taskDescription: "Step 2", dependsOn: [1] },
        { seq: 3, agentId: "security-compliance", topicHint: null, taskDescription: "Step 3", dependsOn: [1, 2] },
      ],
    });

    // Only task 1 should be triggered (no deps)
    expect(result.initialTriggers.some((t) => t.agentId === "engineering")).toBe(true);
    expect(result.initialTriggers.some((t) => t.agentId === "cloud-architect")).toBe(false);
    expect(result.initialTriggers.some((t) => t.agentId === "security-compliance")).toBe(false);
  });
});

describe("boardDispatch.processAgentResponse", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    initBlackboardSchema(db);
  });

  afterAll(() => {
    db.close();
  });

  test("processes board tags → creates records", () => {
    const { sessionId, taskRecordIds } = initBoardDispatch(db, {
      dispatchId: "d-proc-1",
      userMessage: "Security audit",
      tasks: [{ seq: 1, agentId: "security-compliance", topicHint: null, taskDescription: "Audit" }],
    });

    const result = processAgentResponse(db, {
      sessionId,
      agentId: "security-compliance",
      taskRecordId: taskRecordIds[0],
      response: `Here's my analysis:

[BOARD: finding] S3 bucket lacks encryption
[BOARD: finding] IAM role too permissive
[CONFIDENCE: 0.85]
[DONE_TASK: 1]

Let me know if you need more details.`,
      round: 1,
    });

    expect(result.tags).toHaveLength(4);
    expect(result.recordsCreated).toHaveLength(2); // 2 findings
    expect(result.taskCompleted).toBe(true);
  });

  test("auto-creates artifact when no tags present", () => {
    const { sessionId, taskRecordIds } = initBoardDispatch(db, {
      dispatchId: "d-proc-2",
      userMessage: "Write docs",
      tasks: [{ seq: 1, agentId: "strategy-comms", topicHint: null, taskDescription: "Write proposal" }],
    });

    const result = processAgentResponse(db, {
      sessionId,
      agentId: "strategy-comms",
      taskRecordId: taskRecordIds[0],
      response: "Here is the complete proposal for the CityWatch integration project. It covers architecture, timeline, and budget considerations for the team.",
      round: 1,
    });

    expect(result.tags).toHaveLength(0);
    expect(result.recordsCreated).toHaveLength(1); // auto-created artifact
    const artifact = getRecord(db, result.recordsCreated[0])!;
    expect(artifact.space).toBe("artifacts");
    expect(artifact.producer).toBe("strategy-comms");
  });

  test("marks task done even without DONE_TASK tag", () => {
    const { sessionId, taskRecordIds } = initBoardDispatch(db, {
      dispatchId: "d-proc-3",
      userMessage: "Quick task",
      tasks: [{ seq: 1, agentId: "operations-hub", topicHint: null, taskDescription: "Check status" }],
    });

    const result = processAgentResponse(db, {
      sessionId,
      agentId: "operations-hub",
      taskRecordId: taskRecordIds[0],
      response: "All systems operational. No issues found in the last 24 hours across all services.",
      round: 1,
    });

    expect(result.taskCompleted).toBe(true);
    const task = getRecord(db, taskRecordIds[0])!;
    expect(task.status).toBe("done");
  });

  test("response with CONFIDENCE tag updates task record", () => {
    const { sessionId, taskRecordIds } = initBoardDispatch(db, {
      dispatchId: "d-proc-4",
      userMessage: "Assess risk",
      tasks: [{ seq: 1, agentId: "security-compliance", topicHint: null, taskDescription: "Risk assessment" }],
    });

    processAgentResponse(db, {
      sessionId,
      agentId: "security-compliance",
      taskRecordId: taskRecordIds[0],
      response: "[CONFIDENCE: 0.72]\nRisk is moderate.",
      round: 1,
    });

    const task = getRecord(db, taskRecordIds[0])!;
    expect(task.confidence).toBe(0.72);
  });

  test("FINALIZE triggered after all tasks complete", () => {
    const { sessionId, taskRecordIds } = initBoardDispatch(db, {
      dispatchId: "d-proc-5",
      userMessage: "Single task",
      tasks: [{ seq: 1, agentId: "engineering", topicHint: null, taskDescription: "Build feature" }],
    });
    clearCircuitBreaker(sessionId);

    const result = processAgentResponse(db, {
      sessionId,
      agentId: "engineering",
      taskRecordId: taskRecordIds[0],
      response: "Feature built and tested successfully. All unit tests pass.",
      round: 1,
    });

    // After single task completes, FINALIZE should trigger (or REVIEW if artifact created)
    expect(result.nextTriggers.length).toBeGreaterThanOrEqual(1);
  });
});
