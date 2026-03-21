/**
 * Tests for isResumeReliable()
 *
 * Guards whether shortTermContext should be skipped (Claude already has it
 * via --resume) or injected (new/expired/cold session).
 */
import { describe, test, expect } from "bun:test";
import { isResumeReliable } from "./groupSessions.ts";
import type { SessionState } from "./groupSessions.ts";

/** Helper: build a minimal SessionState for testing */
function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    chatId: 12345,
    agentId: "general-assistant",
    threadId: null,
    sessionId: "test-uuid-1234",
    lastActivity: new Date().toISOString(),   // now = fresh
    topicKeywords: [],
    messageCount: 5,
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    pendingContextSwitch: false,
    pendingMessage: "",
    lastUserMessages: [],
    ...overrides,
  };
}

/** Helper: timestamp N hours ago */
function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

// ─── Core behaviour ─────────────────────────────────────────────────────────

describe("isResumeReliable — sessionId absent", () => {
  test("returns false when sessionId is null", () => {
    const session = makeSession({ sessionId: null });
    expect(isResumeReliable(session)).toBe(false);
  });

  test("returns false when sessionId is empty string", () => {
    const session = makeSession({ sessionId: "" });
    expect(isResumeReliable(session)).toBe(false);
  });
});

describe("isResumeReliable — within default TTL (4h)", () => {
  test("returns true for activity 1 minute ago", () => {
    const session = makeSession({ lastActivity: hoursAgo(0.017) }); // ~1 min
    expect(isResumeReliable(session)).toBe(true);
  });

  test("returns true for activity 1 hour ago", () => {
    const session = makeSession({ lastActivity: hoursAgo(1) });
    expect(isResumeReliable(session)).toBe(true);
  });

  test("returns true for activity just under 4 hours ago", () => {
    const session = makeSession({ lastActivity: hoursAgo(3.9) });
    expect(isResumeReliable(session)).toBe(true);
  });
});

describe("isResumeReliable — beyond default TTL (4h)", () => {
  test("returns false for activity exactly 4 hours ago", () => {
    const session = makeSession({ lastActivity: hoursAgo(4) });
    expect(isResumeReliable(session)).toBe(false);
  });

  test("returns false for activity 8 hours ago (overnight)", () => {
    const session = makeSession({ lastActivity: hoursAgo(8) });
    expect(isResumeReliable(session)).toBe(false);
  });

  test("returns false for activity 24 hours ago", () => {
    const session = makeSession({ lastActivity: hoursAgo(24) });
    expect(isResumeReliable(session)).toBe(false);
  });
});

// ─── Custom TTL override ─────────────────────────────────────────────────────

describe("isResumeReliable — custom ttlHours override", () => {
  test("returns true within custom 1h TTL", () => {
    const session = makeSession({ lastActivity: hoursAgo(0.5) });
    expect(isResumeReliable(session, 1)).toBe(true);
  });

  test("returns false beyond custom 1h TTL", () => {
    const session = makeSession({ lastActivity: hoursAgo(1.5) });
    expect(isResumeReliable(session, 1)).toBe(false);
  });

  test("returns true with generous 24h TTL even for 12h old session", () => {
    const session = makeSession({ lastActivity: hoursAgo(12) });
    expect(isResumeReliable(session, 24)).toBe(true);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("isResumeReliable — edge cases", () => {
  test("handles malformed lastActivity gracefully (returns false)", () => {
    const session = makeSession({ lastActivity: "not-a-date" });
    expect(isResumeReliable(session)).toBe(false);
  });

  test("handles missing lastActivity (empty string) gracefully", () => {
    const session = makeSession({ lastActivity: "" });
    expect(isResumeReliable(session)).toBe(false);
  });

  test("null sessionId overrides fresh lastActivity → false", () => {
    // Even if the session was just active, no sessionId means no resume
    const session = makeSession({
      sessionId: null,
      lastActivity: new Date().toISOString(),
    });
    expect(isResumeReliable(session)).toBe(false);
  });
});
