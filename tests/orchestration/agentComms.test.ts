import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initBlackboardSchema } from "../../src/orchestration/blackboardSchema";
import { createSession } from "../../src/orchestration/blackboard";
import {
  sendAgentMessage,
  MeshViolationError,
  RateLimitError,
  clearRateCounts,
} from "../../src/orchestration/agentComms";

describe("agentComms.sendAgentMessage", () => {
  let db: Database;
  let sessionId: string;

  beforeAll(() => {
    db = new Database(":memory:");
    initBlackboardSchema(db);
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(() => {
    const session = createSession(db, { dispatchId: `d-comms-${Date.now()}` });
    sessionId = session.id;
    clearRateCounts(`d-comms-${Date.now()}`);
  });

  test("sends message between whitelisted peers", () => {
    const result = sendAgentMessage(db, {
      from: "command-center",
      to: "engineering",
      dispatchId: "d-1",
      sessionId,
      message: "Please implement the auth module",
      round: 1,
    });
    expect(result.recordId).toBeTruthy();
    expect(result.summaryRecordId).toBeTruthy();
  });

  test("creates evidence + summary records on the board", () => {
    const result = sendAgentMessage(db, {
      from: "engineering",
      to: "code-quality-coach",
      dispatchId: "d-2",
      sessionId,
      message: "Ready for code review",
      round: 1,
    });

    const evidence = db.query("SELECT * FROM bb_records WHERE id = ?").get(result.recordId) as Record<string, unknown>;
    expect(evidence.space).toBe("evidence");
    expect(evidence.producer).toBe("engineering");
    expect(evidence.owner).toBe("code-quality-coach");

    const summary = db.query("SELECT * FROM bb_records WHERE id = ?").get(result.summaryRecordId) as Record<string, unknown>;
    expect(summary.space).toBe("decisions");
    const content = JSON.parse(summary.content as string);
    expect(content.type).toBe("direct_message_summary");
  });

  test("throws MeshViolationError for non-whitelisted pair", () => {
    expect(() =>
      sendAgentMessage(db, {
        from: "research-analyst",
        to: "engineering",
        dispatchId: "d-3",
        sessionId,
        message: "This should fail",
        round: 1,
      })
    ).toThrow(MeshViolationError);
  });

  test("throws RateLimitError after 5 messages per pair per dispatch", () => {
    const dispatchId = "d-rate-limit";
    for (let i = 0; i < 5; i++) {
      sendAgentMessage(db, {
        from: "command-center",
        to: "engineering",
        dispatchId,
        sessionId,
        message: `Message ${i + 1}`,
        round: 1,
      });
    }
    expect(() =>
      sendAgentMessage(db, {
        from: "command-center",
        to: "engineering",
        dispatchId,
        sessionId,
        message: "Message 6 — should fail",
        round: 1,
      })
    ).toThrow(RateLimitError);
  });

  test("rate limit is per-dispatch (different dispatches don't conflict)", () => {
    for (let i = 0; i < 5; i++) {
      sendAgentMessage(db, {
        from: "command-center",
        to: "engineering",
        dispatchId: "d-a",
        sessionId,
        message: `Msg ${i}`,
        round: 1,
      });
    }
    // Different dispatch — should work
    expect(() =>
      sendAgentMessage(db, {
        from: "command-center",
        to: "engineering",
        dispatchId: "d-b",
        sessionId,
        message: "Should succeed",
        round: 1,
      })
    ).not.toThrow();
  });

  test("long messages are truncated in summary", () => {
    const longMsg = "A".repeat(300);
    const result = sendAgentMessage(db, {
      from: "command-center",
      to: "cloud-architect",
      dispatchId: "d-long",
      sessionId,
      message: longMsg,
      round: 1,
    });
    const summary = db.query("SELECT * FROM bb_records WHERE id = ?").get(result.summaryRecordId) as Record<string, unknown>;
    const content = JSON.parse(summary.content as string);
    expect(content.summary.length).toBe(200);
    expect(content.summary.endsWith("...")).toBe(true);
  });
});
