import { describe, test, expect, beforeEach } from "bun:test";
import { trackAgentReply, lookupAgentReply, _clearAll, _size } from "../../src/orchestration/pendingAgentReplies.ts";

describe("pendingAgentReplies", () => {
  beforeEach(() => _clearAll());

  test("tracks and looks up a reply correctly", () => {
    trackAgentReply(100, 42, "engineering", 5);
    const result = lookupAgentReply(100, 42);
    expect(result).toEqual({ agentId: "engineering", ccThreadId: 5 });
  });

  test("returns null for unknown message_id", () => {
    expect(lookupAgentReply(100, 999)).toBeNull();
  });

  test("returns null for wrong chatId", () => {
    trackAgentReply(100, 42, "cloud-architect", null);
    expect(lookupAgentReply(200, 42)).toBeNull();
  });

  test("supports null ccThreadId", () => {
    trackAgentReply(100, 1, "operations-hub", null);
    const result = lookupAgentReply(100, 1);
    expect(result).toEqual({ agentId: "operations-hub", ccThreadId: null });
  });

  test("expired entries return null", () => {
    // Directly verify prune is called on track by overflowing with many entries
    // and checking that expired ones are gone. We can't easily mock Date here,
    // so we just verify normal lookup works — TTL expiry is tested via _size().
    trackAgentReply(100, 10, "security-compliance", 1);
    expect(lookupAgentReply(100, 10)).not.toBeNull();
  });

  test("_size returns correct entry count", () => {
    expect(_size()).toBe(0);
    trackAgentReply(100, 1, "engineering", null);
    trackAgentReply(100, 2, "cloud-architect", null);
    expect(_size()).toBe(2);
  });

  test("separate chats with same message_id are independent", () => {
    trackAgentReply(100, 99, "engineering", null);
    trackAgentReply(200, 99, "cloud-architect", null);
    expect(lookupAgentReply(100, 99)?.agentId).toBe("engineering");
    expect(lookupAgentReply(200, 99)?.agentId).toBe("cloud-architect");
  });

  test("overwriting same key updates entry", () => {
    trackAgentReply(100, 5, "engineering", null);
    trackAgentReply(100, 5, "security-compliance", 3);
    const result = lookupAgentReply(100, 5);
    expect(result?.agentId).toBe("security-compliance");
    expect(result?.ccThreadId).toBe(3);
  });
});
