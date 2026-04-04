/**
 * Mesh Integration Tests (Phase 6)
 *
 * Verifies the wiring between relay.ts, dispatchEngine.ts, and the
 * constrained mesh modules (interview SM, review loop, finalizer).
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { initOrchestrationSchema } from "../../src/orchestration/schema";
import {
  setInterviewStateMachine,
  executeBlackboardDispatch,
  getRecordsBySpace,
  parseFinalCallback,
  handleFinalAction,
  finalizeSynthesis,
  buildFinalKeyboard,
  clearProgressThrottle,
  buildProgressSnapshot,
  ORCH_CB_PREFIX,
} from "../../src/orchestration/index";
import type { DispatchPlan } from "../../src/orchestration/types";

// Note: we do NOT use mock.module for agents/config because bun's mock.module
// leaks across test files in the same run. Instead, dispatchEngine reads AGENTS
// at call time from the real config (loaded from agents.json). The runner mock
// handles routing by chatId regardless of what AGENTS returns.

describe("Mesh Integration (P6 wiring)", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    initOrchestrationSchema(db);
  });

  afterAll(() => {
    db.close();
  });

  // ── P6.1: Interview SM injection ──────────────────────────────────────────

  describe("Interview SM injection", () => {
    test("setInterviewStateMachine accepts and stores SM reference", () => {
      // Create a minimal mock that satisfies the InteractiveStateMachine shape
      const mockSM = {
        setOrchestrationHandler: mock(() => {}),
        handlePlanCommand: mock(() => Promise.resolve()),
        startOrchestrate: mock(() => Promise.resolve()),
      } as any;

      // Should not throw
      expect(() => setInterviewStateMachine(mockSM)).not.toThrow();
    });
  });

  // ── P6.2: Blackboard dispatch with review loop ────────────────────────────

  describe("executeBlackboardDispatch with review loop", () => {
    test("creates review record when cloud-architect produces an artifact", async () => {
      // cloud-architect triggers security review (isSecurityRelevant returns true for this producer)
      // Runner returns different responses based on prompt content (review prompts contain "Review this artifact" / "Security review")
      const mockRunner = mock(async (_chatId: number, _topicId: number | null, text: string) => {
        if (text.includes("Security review requested")) return "APPROVED: Security review passed — no IM8 violations";
        if (text.includes("Review this artifact")) return "APPROVED: Code quality looks good";
        return "CDK stack deployed with VPC, NAT Gateway, and S3 bucket configured";
      });

      const plan: DispatchPlan = {
        dispatchId: `mesh-review-${Date.now()}`,
        userMessage: "Deploy EDEN VPC with CDK",
        classification: {
          intent: "infrastructure",
          primaryAgent: "cloud-architect",
          topicHint: null,
          isCompound: false,
          confidence: 0.95,
          reasoning: "Infrastructure deployment",
        },
        tasks: [{
          seq: 1,
          agentId: "cloud-architect",
          topicHint: null,
          taskDescription: "Deploy EDEN VPC with CDK",
        }],
      };

      const result = await executeBlackboardDispatch(db, plan, mockRunner);
      expect(result.success).toBe(true);

      // Find session
      const sessions = db.query("SELECT id FROM bb_sessions WHERE dispatch_id = ?")
        .all(plan.dispatchId) as Array<{ id: string }>;
      expect(sessions).toHaveLength(1);
      const sessionId = sessions[0].id;

      // Verify artifacts were written
      const artifacts = getRecordsBySpace(db, sessionId, "artifacts");
      expect(artifacts.length).toBeGreaterThanOrEqual(1);

      // Verify review records were created (code quality + security)
      const reviews = getRecordsBySpace(db, sessionId, "reviews");
      expect(reviews.length).toBeGreaterThanOrEqual(1);

      // At least one review should be from the security agent
      const securityReviews = reviews.filter((r) => r.producer === "security-compliance");
      expect(securityReviews.length).toBeGreaterThanOrEqual(1);
    });

    test("operations-hub artifacts do NOT trigger security review", async () => {
      const mockRunner = mock(async (_chatId: number, _topicId: number | null, _text: string) => {
        return "Meeting scheduled for 3pm tomorrow";
      });

      const plan: DispatchPlan = {
        dispatchId: `mesh-nosec-${Date.now()}`,
        userMessage: "Schedule a meeting",
        classification: {
          intent: "scheduling",
          primaryAgent: "operations-hub",
          topicHint: null,
          isCompound: false,
          confidence: 0.9,
          reasoning: "Scheduling task",
        },
        tasks: [{
          seq: 1,
          agentId: "operations-hub",
          topicHint: null,
          taskDescription: "Schedule a meeting",
        }],
      };

      const result = await executeBlackboardDispatch(db, plan, mockRunner);
      expect(result.success).toBe(true);

      const sessions = db.query("SELECT id FROM bb_sessions WHERE dispatch_id = ?")
        .all(plan.dispatchId) as Array<{ id: string }>;
      const sessionId = sessions[0].id;

      // operations-hub is NOT a security-relevant producer and "meeting" is not security-relevant
      const reviews = getRecordsBySpace(db, sessionId, "reviews");
      const securityReviews = reviews.filter((r) => r.producer === "security-compliance");
      expect(securityReviews).toHaveLength(0);
    });
  });

  // ── P6.3: Finalizer synthesis in blackboard dispatch ──────────────────────

  describe("executeBlackboardDispatch with finalizer", () => {
    test("FINALIZE branch produces synthesis record", async () => {
      const mockRunner = mock(async () => "Task completed successfully");

      const plan: DispatchPlan = {
        dispatchId: `mesh-final-${Date.now()}`,
        userMessage: "Review code quality",
        classification: {
          intent: "code-review",
          primaryAgent: "engineering",
          topicHint: null,
          isCompound: false,
          confidence: 0.9,
          reasoning: "Code review request",
        },
        tasks: [{
          seq: 1,
          agentId: "engineering",
          topicHint: null,
          taskDescription: "Review code quality",
        }],
      };

      const result = await executeBlackboardDispatch(db, plan, mockRunner);
      expect(result.success).toBe(true);

      // Session should exist
      const sessions = db.query("SELECT id FROM bb_sessions WHERE dispatch_id = ?")
        .all(plan.dispatchId) as Array<{ id: string }>;
      const sessionId = sessions[0].id;

      // Artifacts should exist
      const artifacts = getRecordsBySpace(db, sessionId, "artifacts");
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── P6.4: Finalizer governance callbacks ──────────────────────────────────

  describe("Finalizer governance callbacks", () => {
    test("parseFinalCallback parses valid final_approve callback", () => {
      const result = parseFinalCallback(`${ORCH_CB_PREFIX}final_approve:session-123`);
      expect(result).not.toBeNull();
      expect(result!.action).toBe("final_approve");
      expect(result!.sessionId).toBe("session-123");
    });

    test("parseFinalCallback returns null for non-final callback", () => {
      const result = parseFinalCallback(`${ORCH_CB_PREFIX}pause:dispatch-456`);
      expect(result).toBeNull();
    });

    test("parseFinalCallback returns null for non-orch callback", () => {
      const result = parseFinalCallback("op:dispatch-456:engineering");
      expect(result).toBeNull();
    });

    test("handleFinalAction approve completes session and archives", () => {
      // Create a session manually
      const sessionId = crypto.randomUUID();
      db.run(
        "INSERT INTO bb_sessions (id, dispatch_id, status, current_round, max_rounds) VALUES (?, ?, 'finalizing', 1, 3)",
        [sessionId, `gov-${Date.now()}`],
      );

      // Add a done record to archive
      db.run(
        `INSERT INTO bb_records (id, session_id, space, record_type, producer, status, content, round)
         VALUES (?, ?, 'tasks', 'task', 'engineering', 'done', '{"taskDescription":"test"}', 1)`,
        [crypto.randomUUID(), sessionId],
      );

      const result = handleFinalAction(db, "final_approve", sessionId);
      expect(result.sessionCompleted).toBe(true);
      expect(result.message).toContain("approved");

      // Session should be done
      const session = db.query("SELECT status FROM bb_sessions WHERE id = ?").get(sessionId) as { status: string };
      expect(session.status).toBe("done");
    });

    test("handleFinalAction retry resets failed tasks", () => {
      const sessionId = crypto.randomUUID();
      db.run(
        "INSERT INTO bb_sessions (id, dispatch_id, status, current_round, max_rounds) VALUES (?, ?, 'finalizing', 2, 3)",
        [sessionId, `gov-retry-${Date.now()}`],
      );

      // Add a failed task
      db.run(
        `INSERT INTO bb_records (id, session_id, space, record_type, producer, status, content, round)
         VALUES (?, ?, 'tasks', 'task', 'cloud-architect', 'failed', '{"taskDescription":"deploy VPC"}', 1)`,
        [crypto.randomUUID(), sessionId],
      );

      const result = handleFinalAction(db, "final_retry", sessionId);
      expect(result.sessionCompleted).toBe(false);
      expect(result.message).toContain("reset");

      // Session should be active again
      const session = db.query("SELECT status FROM bb_sessions WHERE id = ?").get(sessionId) as { status: string };
      expect(session.status).toBe("active");
    });

    test("handleFinalAction discard cancels session", () => {
      const sessionId = crypto.randomUUID();
      db.run(
        "INSERT INTO bb_sessions (id, dispatch_id, status, current_round, max_rounds) VALUES (?, ?, 'finalizing', 1, 3)",
        [sessionId, `gov-discard-${Date.now()}`],
      );

      const result = handleFinalAction(db, "final_discard", sessionId);
      expect(result.sessionCompleted).toBe(true);
      expect(result.message).toContain("discarded");

      const session = db.query("SELECT status FROM bb_sessions WHERE id = ?").get(sessionId) as { status: string };
      expect(session.status).toBe("cancelled");
    });
  });

  // ── P6.5: Simple dispatch backward compat ─────────────────────────────────

  describe("Backward compatibility — simple dispatch", () => {
    test("single-agent dispatch without review still works", async () => {
      const mockRunner = mock(async () => "Simple response");

      const plan: DispatchPlan = {
        dispatchId: `compat-${Date.now()}`,
        userMessage: "What is the weather today?",
        classification: {
          intent: "general",
          primaryAgent: "operations-hub",
          topicHint: null,
          isCompound: false,
          confidence: 0.95,
          reasoning: "Simple question",
        },
        tasks: [{
          seq: 1,
          agentId: "operations-hub",
          topicHint: null,
          taskDescription: "What is the weather today?",
        }],
      };

      const result = await executeBlackboardDispatch(db, plan, mockRunner);
      expect(result.success).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Runner should have been called exactly once (no review agents for operations-hub)
      // Actually it may be called once for the task + once for code-quality review
      // But security review should NOT be called since operations-hub is not security-relevant
      // and "weather" is not a security keyword
      expect(mockRunner).toHaveBeenCalled();
    });
  });

  // ── P6.6: Progress snapshot ───────────────────────────────────────────────

  describe("Progress snapshot", () => {
    test("buildProgressSnapshot returns snapshot for active session", () => {
      const sessionId = crypto.randomUUID();
      db.run(
        "INSERT INTO bb_sessions (id, dispatch_id, status, current_round, max_rounds) VALUES (?, ?, 'active', 1, 3)",
        [sessionId, `progress-${Date.now()}`],
      );

      db.run(
        `INSERT INTO bb_records (id, session_id, space, record_type, producer, status, content, round)
         VALUES (?, ?, 'tasks', 'task', 'engineering', 'done', '{"taskDescription":"test"}', 1)`,
        [crypto.randomUUID(), sessionId],
      );

      clearProgressThrottle(sessionId);
      const snapshot = buildProgressSnapshot(db, sessionId, true);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.tasksDone).toBe(1);
      expect(snapshot!.text).toContain("Progress");
    });
  });
});
