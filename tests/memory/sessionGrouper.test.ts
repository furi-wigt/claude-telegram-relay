import { describe, test, expect } from "bun:test";
import {
  filterTodaySessions,
  buildSessionQuery,
  type SessionInfo,
} from "../../src/memory/sessionGrouper";

describe("filterTodaySessions", () => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const yesterday = new Date(now.getTime() - 86400000).toISOString();

  test("includes sessions active today with enough messages", () => {
    const sessions: SessionInfo[] = [
      {
        chatId: -100123,
        threadId: null,
        agentId: "code-quality-coach",
        sessionId: "uuid-1",
        startedAt: `${today}T09:00:00Z`,
        lastActivity: `${today}T10:30:00Z`,
        messageCount: 8,
        cwd: "/project/a",
      },
    ];
    const result = filterTodaySessions(sessions);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe("code-quality-coach");
  });

  test("excludes sessions from yesterday", () => {
    const sessions: SessionInfo[] = [
      {
        chatId: -100123,
        threadId: null,
        agentId: "general-assistant",
        sessionId: "uuid-2",
        startedAt: yesterday,
        lastActivity: yesterday,
        messageCount: 10,
      },
    ];
    const result = filterTodaySessions(sessions);
    expect(result).toHaveLength(0);
  });

  test("excludes sessions with fewer than 3 messages", () => {
    const sessions: SessionInfo[] = [
      {
        chatId: -100123,
        threadId: null,
        agentId: "general-assistant",
        sessionId: "uuid-3",
        startedAt: `${today}T09:00:00Z`,
        lastActivity: `${today}T09:05:00Z`,
        messageCount: 2,
      },
    ];
    const result = filterTodaySessions(sessions);
    expect(result).toHaveLength(0);
  });
});

describe("buildSessionQuery", () => {
  test("builds correct query params", () => {
    const session: SessionInfo = {
      chatId: -100123,
      threadId: 456,
      agentId: "code-quality-coach",
      sessionId: "uuid-1",
      startedAt: "2026-03-28T09:00:00Z",
      lastActivity: "2026-03-28T10:30:00Z",
      messageCount: 8,
    };
    const q = buildSessionQuery(session);
    expect(q.chatId).toBe("-100123");
    expect(q.threadId).toBe("456");
    expect(q.startedAt).toBe("2026-03-28T09:00:00Z");
    expect(q.lastActivity).toBe("2026-03-28T10:30:00Z");
  });

  test("handles null threadId", () => {
    const session: SessionInfo = {
      chatId: -100123,
      threadId: null,
      agentId: "general-assistant",
      sessionId: null,
      startedAt: "2026-03-28T09:00:00Z",
      lastActivity: "2026-03-28T10:30:00Z",
      messageCount: 5,
    };
    const q = buildSessionQuery(session);
    expect(q.threadId).toBeNull();
  });
});
