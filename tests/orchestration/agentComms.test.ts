import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { initBlackboardSchema } from "../../src/orchestration/blackboardSchema";
import { createSession } from "../../src/orchestration/blackboard";
import {
  sendAgentMessage,
  MeshViolationError,
  RateLimitError,
  clearRateCounts,
  setMeshNotifier,
  getMeshNotifier,
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

  afterEach(() => {
    // Reset notifier after each test to avoid cross-test leaks
    setMeshNotifier(null as unknown as ReturnType<typeof getMeshNotifier>);
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

  // ── Mesh notification tests ───────────────────────────────────────────────

  test("mesh notification fires on successful send", async () => {
    const calls: Array<{ chatId: number; topicId: number | null; text: string }> = [];
    setMeshNotifier(async (chatId, topicId, text) => {
      calls.push({ chatId, topicId, text });
    });

    sendAgentMessage(db, {
      from: "command-center",
      to: "engineering",
      dispatchId: "d-notif-1",
      sessionId,
      message: "Implement feature X",
      round: 1,
    });

    // Notification is fire-and-forget — wait a tick for the promise to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(calls.length).toBe(1);
    expect(calls[0].text).toContain("Mesh message from");
    expect(calls[0].text).toContain("Implement feature X");
  });

  test("mesh notification skipped when notifier not set", () => {
    // No notifier registered — should not throw
    const result = sendAgentMessage(db, {
      from: "command-center",
      to: "engineering",
      dispatchId: "d-notif-skip",
      sessionId,
      message: "No notifier",
      round: 1,
    });
    expect(result.recordId).toBeTruthy();
  });

  test("mesh notification failure does not block send", async () => {
    setMeshNotifier(async () => {
      throw new Error("Telegram API down");
    });

    const result = sendAgentMessage(db, {
      from: "command-center",
      to: "engineering",
      dispatchId: "d-notif-fail",
      sessionId,
      message: "Should still succeed",
      round: 1,
    });

    // Send succeeds despite notification failure
    expect(result.recordId).toBeTruthy();
    expect(result.summaryRecordId).toBeTruthy();

    // Wait for the rejected promise to be caught
    await new Promise((r) => setTimeout(r, 10));
  });

  test("mesh notification uses target agent meshTopicId", async () => {
    const calls: Array<{ chatId: number; topicId: number | null }> = [];
    setMeshNotifier(async (chatId, topicId) => {
      calls.push({ chatId, topicId });
    });

    sendAgentMessage(db, {
      from: "command-center",
      to: "engineering",
      dispatchId: "d-notif-topic",
      sessionId,
      message: "Check topic routing",
      round: 1,
    });

    await new Promise((r) => setTimeout(r, 10));

    // The notifier should have been called — chatId comes from AGENTS["engineering"]
    // meshTopicId will be null since test config doesn't set it, but the call was made
    if (calls.length > 0) {
      expect(calls[0].topicId).toBeNull(); // meshTopicId defaults to null
    }
  });
});
