/**
 * Tests for short-term memory module
 *
 * Run: bun test src/memory/shortTermMemory.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// ── Mock storageBackend so tests don't hit SQLite/Qdrant/Ollama ────────────

const mockGetRecentMessagesLocal = mock(async () => []);
const mockGetConversationSummariesLocal = mock(() => []);
const mockGetMessageCountLocal = mock(async () => 0);
const mockInsertSummaryRecord = mock(async () => {});

mock.module("../local/storageBackend", () => ({
  getRecentMessagesLocal: mockGetRecentMessagesLocal,
  getConversationSummariesLocal: mockGetConversationSummariesLocal,
  getMessageCountLocal: mockGetMessageCountLocal,
  insertSummaryRecord: mockInsertSummaryRecord,
}));

// Mock getDb so shouldSummarize / summarizeOldMessages don't hit real SQLite
const mockQuery = mock(() => ({
  get: mock(() => null),
  all: mock(() => []),
}));
const mockDb = { query: mockQuery };
mock.module("../local/db", () => ({
  getDb: () => mockDb,
}));

import {
  relativeTime,
  formatDateHeader,
  formatMessage,
  formatShortTermContext,
  shouldSummarize,
  getRecentMessages,
  getConversationSummaries,
  summarizeOldMessages,
  getLastRoutineMessage,
  getLastRealAssistantTurn,
  type ConversationMessage,
  type ConversationSummary,
  type ShortTermContext,
} from "./shortTermMemory.ts";

// ============================================================
// Helper: fixed timestamps relative to "now"
// ============================================================

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

function daysAgo(d: number): string {
  return new Date(Date.now() - d * 86_400_000).toISOString();
}

function makeMsg(
  overrides: Partial<ConversationMessage> & { created_at: string }
): ConversationMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: "hello",
    ...overrides,
  };
}

// ============================================================
// relativeTime
// ============================================================

describe("relativeTime", () => {
  const tz = "Asia/Singapore";

  test("returns 'just now' for < 1 hour ago", () => {
    expect(relativeTime(hoursAgo(0.5), tz)).toBe("just now");
  });

  test("returns '3h ago' for 3 hours ago", () => {
    expect(relativeTime(hoursAgo(3), tz)).toBe("3h ago");
  });

  test("returns 'yesterday' for 30 hours ago", () => {
    expect(relativeTime(hoursAgo(30), tz)).toBe("yesterday");
  });

  test("returns 'N days ago' for 5 days ago", () => {
    expect(relativeTime(daysAgo(5), tz)).toBe("5 days ago");
  });
});

// ============================================================
// formatDateHeader
// ============================================================

describe("formatDateHeader", () => {
  test("returns full date string with weekday", () => {
    // Wed 18 Feb 2026 in SGT
    const result = formatDateHeader("2026-02-18T10:00:00+08:00", "Asia/Singapore");
    expect(result).toContain("Wednesday");
    expect(result).toContain("18");
    expect(result).toContain("February");
    expect(result).toContain("2026");
  });

  test("respects timezone — UTC midnight is previous day in US Eastern", () => {
    // 2026-02-18 00:00 UTC = 2026-02-17 19:00 EST
    const result = formatDateHeader("2026-02-18T00:00:00Z", "America/New_York");
    expect(result).toContain("17");
    expect(result).toContain("February");
  });
});

// ============================================================
// formatMessage
// ============================================================

describe("formatMessage", () => {
  const tz = "Asia/Singapore";

  test("formats routine message with label, time, relative time, summary", () => {
    const msg = makeMsg({
      role: "assistant",
      content: "Full routine content that is very long...",
      created_at: hoursAgo(3),
      metadata: {
        source: "routine",
        routine: "smart-checkin",
        summary: "Quick status update sent",
      },
    });

    const result = formatMessage(msg, tz);
    expect(result).toContain("smart-checkin");
    expect(result).toContain("3h ago");
    expect(result).toContain("Quick status update sent");
    expect(result).toMatch(/^\[smart-checkin \|/);
  });

  test("formats regular user message", () => {
    const msg = makeMsg({
      role: "user",
      content: "How are you?",
      created_at: "2026-02-18T09:30:00+08:00",
    });

    const result = formatMessage(msg, tz);
    expect(result).toContain("User:");
    expect(result).toContain("How are you?");
    expect(result).toMatch(/^\[/);
  });

  test("formats regular assistant message", () => {
    const msg = makeMsg({
      role: "assistant",
      content: "I am doing well, thank you!",
      created_at: "2026-02-18T09:31:00+08:00",
    });

    const result = formatMessage(msg, tz);
    expect(result).toContain("Assistant:");
    expect(result).toContain("I am doing well, thank you!");
  });

  test("routine message without metadata.summary falls back to content slice", () => {
    const longContent = "A".repeat(400);
    const msg = makeMsg({
      role: "assistant",
      content: longContent,
      created_at: hoursAgo(1.5),
      metadata: {
        source: "routine",
        routine: "morning-summary",
        // no summary field
      },
    });

    const result = formatMessage(msg, tz);
    expect(result).toContain("morning-summary");
    // Should have first 300 chars + "..."
    expect(result).toContain("A".repeat(300) + "...");
    expect(result).not.toContain("A".repeat(301));
  });

  test("routine message with short content and no summary — no trailing dots", () => {
    const msg = makeMsg({
      role: "assistant",
      content: "Short",
      created_at: hoursAgo(2),
      metadata: {
        source: "routine",
        routine: "ping",
      },
    });

    const result = formatMessage(msg, tz);
    expect(result).toContain("Short");
    expect(result).not.toContain("...");
  });
});

// ============================================================
// formatShortTermContext
// ============================================================

describe("formatShortTermContext", () => {
  const tz = "Asia/Singapore";

  test("returns empty string when context is empty", () => {
    const ctx: ShortTermContext = {
      verbatimMessages: [],
      summaries: [],
      totalMessages: 0,
    };
    expect(formatShortTermContext(ctx, tz)).toBe("");
  });

  test("same-day verbatim messages get single day header", () => {
    const ts = "2026-02-18T10:00:00+08:00";
    const ctx: ShortTermContext = {
      verbatimMessages: [
        makeMsg({ role: "user", content: "Hi", created_at: ts }),
        makeMsg({ role: "assistant", content: "Hello", created_at: ts }),
      ],
      summaries: [],
      totalMessages: 2,
    };

    const result = formatShortTermContext(ctx, tz);
    // Should have exactly one day header
    const headers = result.split("\n").filter((l) => l.startsWith("\u2500\u2500\u2500"));
    expect(headers.length).toBe(1);
    expect(headers[0]).toContain("Wednesday");
    expect(headers[0]).toContain("18 February 2026");
  });

  test("messages across 2 different days get 2 day headers", () => {
    const ctx: ShortTermContext = {
      verbatimMessages: [
        makeMsg({ role: "user", content: "Day 1", created_at: "2026-02-17T10:00:00+08:00" }),
        makeMsg({ role: "user", content: "Day 2", created_at: "2026-02-18T10:00:00+08:00" }),
      ],
      summaries: [],
      totalMessages: 2,
    };

    const result = formatShortTermContext(ctx, tz);
    const headers = result.split("\n").filter((l) => l.startsWith("\u2500\u2500\u2500"));
    expect(headers.length).toBe(2);
    expect(headers[0]).toContain("Tuesday");
    expect(headers[1]).toContain("Wednesday");
  });

  test("summaries only — shows summary entries", () => {
    const ctx: ShortTermContext = {
      verbatimMessages: [],
      summaries: [
        {
          id: "s1",
          summary: "Discussed project setup",
          message_count: 10,
          from_timestamp: "2026-02-15T08:00:00Z",
          to_timestamp: "2026-02-16T10:00:00Z",
          created_at: "2026-02-16T12:00:00Z",
        },
      ],
      totalMessages: 10,
    };

    const result = formatShortTermContext(ctx, tz);
    expect(result).toContain("[Summary |");
    expect(result).toContain("Discussed project setup");
  });

  test("summaries + verbatim — shows both with blank line separator", () => {
    const ctx: ShortTermContext = {
      verbatimMessages: [
        makeMsg({ role: "user", content: "Latest msg", created_at: "2026-02-18T10:00:00+08:00" }),
      ],
      summaries: [
        {
          id: "s1",
          summary: "Earlier convo summary",
          message_count: 5,
          from_timestamp: "2026-02-16T08:00:00Z",
          to_timestamp: "2026-02-16T10:00:00Z",
          created_at: "2026-02-16T12:00:00Z",
        },
      ],
      totalMessages: 6,
    };

    const result = formatShortTermContext(ctx, tz);
    expect(result).toContain("[Summary |");
    expect(result).toContain("Earlier convo summary");
    expect(result).toContain("Latest msg");
    // Blank line separator between summaries and verbatim
    expect(result).toContain("\n\n");
  });
});

// ============================================================
// shouldSummarize
// ============================================================

describe("shouldSummarize", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  test("returns false when message count is 0", async () => {
    mockQuery.mockReturnValue({
      get: mock(() => ({ last_summary_ts: null, count: 0 })),
      all: mock(() => []),
    });
    // Mock: first query gets last_summary_ts = null, second query gets count = 0
    let callCount = 0;
    mockQuery.mockImplementation((_sql: string) => ({
      get: mock((..._args: any[]) => {
        callCount++;
        if (callCount === 1) return { last_summary_ts: null };
        return { count: 0 };
      }),
      all: mock(() => []),
    }));
    const result = await shouldSummarize(123);
    expect(result).toBe(false);
  });

  test("returns true when message count exceeds VERBATIM_LIMIT", async () => {
    let callCount = 0;
    mockQuery.mockImplementation((_sql: string) => ({
      get: mock((..._args: any[]) => {
        callCount++;
        if (callCount === 1) return { last_summary_ts: null };
        return { count: 25 };
      }),
      all: mock(() => []),
    }));
    const result = await shouldSummarize(123);
    expect(result).toBe(true);
  });

  test("returns false when message count is exactly 20 (not > 20)", async () => {
    let callCount = 0;
    mockQuery.mockImplementation((_sql: string) => ({
      get: mock((..._args: any[]) => {
        callCount++;
        if (callCount === 1) return { last_summary_ts: null };
        return { count: 20 };
      }),
      all: mock(() => []),
    }));
    const result = await shouldSummarize(123);
    expect(result).toBe(false);
  });

  test("returns false on DB error", async () => {
    mockQuery.mockImplementation(() => {
      throw new Error("DB down");
    });
    const result = await shouldSummarize(123);
    expect(result).toBe(false);
  });
});

// ============================================================
// getRecentMessages
// ============================================================

describe("getRecentMessages", () => {
  test("delegates to getRecentMessagesLocal and returns results", async () => {
    const ascData = [
      makeMsg({ content: "oldest", created_at: "2026-02-18T10:00:00Z" }),
      makeMsg({ content: "middle", created_at: "2026-02-18T11:00:00Z" }),
      makeMsg({ content: "newest", created_at: "2026-02-18T12:00:00Z" }),
    ];
    mockGetRecentMessagesLocal.mockResolvedValue(ascData);

    const result = await getRecentMessages(123);

    expect(result[0].content).toBe("oldest");
    expect(result[1].content).toBe("middle");
    expect(result[2].content).toBe("newest");
  });

  test("returns empty array when backend returns empty", async () => {
    mockGetRecentMessagesLocal.mockResolvedValue([]);
    const result = await getRecentMessages(123);
    expect(result).toEqual([]);
  });
});

// ============================================================
// summarizeOldMessages
// ============================================================

describe("summarizeOldMessages", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    mockQuery.mockReset();
  });

  function makeMessages(count: number): ConversationMessage[] {
    return Array.from({ length: count }, (_, i) =>
      makeMsg({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}`, created_at: new Date(Date.now() + i * 1000).toISOString() })
    );
  }

  test("does not insert when messages array is empty", async () => {
    mockInsertSummaryRecord.mockClear();
    // summary query returns null, messages query returns []
    let callCount = 0;
    mockQuery.mockImplementation((_sql: string) => ({
      get: mock(() => { callCount++; return null; }),
      all: mock(() => []),
    }));

    await summarizeOldMessages(123);

    expect(mockInsertSummaryRecord).not.toHaveBeenCalled();
  });

  test("inserts Ollama summary when Ollama succeeds", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: "A concise summary of the conversation." }),
      })
    ) as any;

    mockInsertSummaryRecord.mockClear();
    const msgs = makeMessages(3);
    // First query: latest summary timestamp (null), second query: messages
    let callCount = 0;
    mockQuery.mockImplementation((_sql: string) => ({
      get: mock(() => { callCount++; return null; }),
      all: mock(() => msgs),
    }));

    await summarizeOldMessages(123);

    expect(mockInsertSummaryRecord).toHaveBeenCalledTimes(1);
    const insertedRow = mockInsertSummaryRecord.mock.calls[0][0] as any;
    expect(insertedRow.summary).toBe("A concise summary of the conversation.");
    expect(insertedRow.chat_id).toBe(123);
    expect(insertedRow.message_count).toBe(3);
  });

  test("uses concatenation fallback when Ollama throws", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Ollama down"))) as any;

    mockInsertSummaryRecord.mockClear();
    const msgs = makeMessages(3);
    mockQuery.mockImplementation((_sql: string) => ({
      get: mock(() => null),
      all: mock(() => msgs),
    }));

    await summarizeOldMessages(123);

    expect(mockInsertSummaryRecord).toHaveBeenCalledTimes(1);
    const insertedRow = mockInsertSummaryRecord.mock.calls[0][0] as any;
    // Fallback: concatenates first 100 chars of each message content, joined by " | "
    expect(insertedRow.summary).toContain("Message 0");
    expect(insertedRow.summary).toContain(" | ");
  });
});

// ============================================================
// getLastRoutineMessage / getLastRealAssistantTurn
// ============================================================

describe("getLastRoutineMessage", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  test("returns null when no routine message exists (empty data)", async () => {
    mockQuery.mockImplementation(() => ({
      get: mock(() => null),
      all: mock(() => []),
    }));
    const result = await getLastRoutineMessage(123);
    expect(result).toBeNull();
  });

  test("returns the message when a routine message exists", async () => {
    const routineMsg = {
      id: "r1",
      role: "assistant",
      content: "Do you need time blocked this week?",
      created_at: "2026-03-06T09:00:00.000Z",
      metadata: JSON.stringify({ source: "routine", routine: "smart-checkin", summary: "Check-in summary" }),
    };
    mockQuery.mockImplementation(() => ({
      get: mock(() => routineMsg),
      all: mock(() => [routineMsg]),
    }));
    const result = await getLastRoutineMessage(123);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("r1");
  });
});

describe("getConversationSummaries", () => {
  test("returns empty array when backend returns empty", async () => {
    mockGetConversationSummariesLocal.mockReturnValue([]);
    const result = await getConversationSummaries(123);
    expect(result).toEqual([]);
  });

  test("returns summaries in chronological order (oldest first)", async () => {
    // Use recent dates (within 14-day maxAgeDays window) so they aren't filtered out
    const now = new Date();
    const day1 = new Date(now.getTime() - 3 * 86400000).toISOString();
    const day2 = new Date(now.getTime() - 2 * 86400000).toISOString();
    const day3 = new Date(now.getTime() - 1 * 86400000).toISOString();
    const descData = [
      { id: "s3", summary: "newest", message_count: 5, from_timestamp: null, to_timestamp: null, created_at: day3 },
      { id: "s2", summary: "middle", message_count: 5, from_timestamp: null, to_timestamp: null, created_at: day2 },
      { id: "s1", summary: "oldest", message_count: 5, from_timestamp: null, to_timestamp: null, created_at: day1 },
    ];
    mockGetConversationSummariesLocal.mockReturnValue(descData);
    const result = await getConversationSummaries(123);

    // Should be sorted oldest first
    expect(result[0].summary).toBe("oldest");
    expect(result[result.length - 1].summary).toBe("newest");
  });
});

describe("getLastRealAssistantTurn", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  test("returns null when no real assistant turn exists (empty data)", async () => {
    mockQuery.mockImplementation(() => ({
      get: mock(() => null),
      all: mock(() => []),
    }));
    const result = await getLastRealAssistantTurn(123);
    expect(result).toBeNull();
  });

  test("returns the message when a real assistant turn exists", async () => {
    const realMsg = {
      id: "a1",
      role: "assistant",
      content: "Here is my analysis.",
      created_at: "2026-03-06T08:00:00.000Z",
      metadata: JSON.stringify({}),
    };
    mockQuery.mockImplementation(() => ({
      get: mock(() => realMsg),
      all: mock(() => [realMsg]),
    }));
    const result = await getLastRealAssistantTurn(123);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("a1");
  });
});
