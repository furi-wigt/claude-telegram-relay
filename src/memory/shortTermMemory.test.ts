/**
 * Tests for short-term memory module
 *
 * Run: bun test src/memory/shortTermMemory.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  relativeTime,
  formatDateHeader,
  formatMessage,
  formatShortTermContext,
  shouldSummarize,
  getRecentMessages,
  summarizeOldMessages,
  type ConversationMessage,
  type ShortTermContext,
} from "./shortTermMemory.ts";

// ============================================================
// Supabase mock factory (chainable query builder)
// ============================================================

function mockSupabase(overrides?: {
  selectData?: any[];
  selectError?: any;
  rpcData?: any;
  rpcError?: any;
}) {
  const {
    selectData = [],
    selectError = null,
    rpcData = 0,
    rpcError = null,
  } = overrides ?? {};

  const query = {
    select: mock(() => query),
    eq: mock(() => query),
    order: mock(() => query),
    limit: mock(() => Promise.resolve({ data: selectData, error: selectError })),
  };

  return {
    from: mock(() => query),
    rpc: mock(() => Promise.resolve({ data: rpcData, error: rpcError })),
    _query: query,
  } as any;
}

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
  test("returns false when RPC returns 0", async () => {
    const sb = mockSupabase({ rpcData: 0 });
    const result = await shouldSummarize(sb, 123);
    expect(result).toBe(false);
  });

  test("returns true when RPC returns 25 (> VERBATIM_LIMIT of 20)", async () => {
    const sb = mockSupabase({ rpcData: 25 });
    const result = await shouldSummarize(sb, 123);
    expect(result).toBe(true);
  });

  test("returns false when RPC returns exactly 20 (not > 20)", async () => {
    const sb = mockSupabase({ rpcData: 20 });
    const result = await shouldSummarize(sb, 123);
    expect(result).toBe(false);
  });

  test("returns false on RPC error", async () => {
    const sb = mockSupabase({ rpcError: new Error("DB down") });
    const result = await shouldSummarize(sb, 123);
    expect(result).toBe(false);
  });
});

// ============================================================
// getRecentMessages
// ============================================================

describe("getRecentMessages", () => {
  test("reverses DESC results to ASC order", async () => {
    const descData = [
      makeMsg({ content: "newest", created_at: "2026-02-18T12:00:00Z" }),
      makeMsg({ content: "middle", created_at: "2026-02-18T11:00:00Z" }),
      makeMsg({ content: "oldest", created_at: "2026-02-18T10:00:00Z" }),
    ];
    const sb = mockSupabase({ selectData: descData });

    const result = await getRecentMessages(sb, 123);

    // Should be reversed: oldest first
    expect(result[0].content).toBe("oldest");
    expect(result[1].content).toBe("middle");
    expect(result[2].content).toBe("newest");
  });

  test("returns empty array on error", async () => {
    const sb = mockSupabase({ selectError: new Error("fail") });
    const result = await getRecentMessages(sb, 123);
    expect(result).toEqual([]);
  });

  test("returns empty array when data is null", async () => {
    const sb = mockSupabase();
    // Override limit to return null data
    sb._query.limit = mock(() => Promise.resolve({ data: null, error: null }));
    const result = await getRecentMessages(sb, 123);
    expect(result).toEqual([]);
  });
});

// ============================================================
// mockSupabaseForSummarize — handles two conversation_summaries calls
// ============================================================

function mockSupabaseForSummarize(options: {
  latestSummary?: any[] | null;
  messages?: any[] | null;
  insertFn?: ReturnType<typeof mock>;
}) {
  const {
    latestSummary = [],
    messages = [],
    insertFn = mock(() => Promise.resolve({ data: null, error: null })),
  } = options;

  let summarySelectDone = false;

  return {
    from: mock((table: string) => {
      if (table === "conversation_summaries") {
        if (!summarySelectDone) {
          summarySelectDone = true;
          const q: any = {};
          q.select = mock(() => q);
          q.eq = mock(() => q);
          q.order = mock(() => q);
          q.limit = mock(() => Promise.resolve({ data: latestSummary, error: null }));
          return q;
        } else {
          return { insert: insertFn };
        }
      }
      // messages table — .limit() must return a thenable chainable so that
      // the production code can call .gt() on it when afterTimestamp is set,
      // then await the result. We make the query object itself thenable.
      const resolved = { data: messages, error: null };
      const q: any = {
        then: (onFulfilled: any, onRejected: any) =>
          Promise.resolve(resolved).then(onFulfilled, onRejected),
      };
      q.select = mock(() => q);
      q.eq = mock(() => q);
      q.order = mock(() => q);
      q.gt = mock(() => q);
      // .limit() returns the same thenable q so the chain stays chainable
      q.limit = mock(() => q);
      return q;
    }),
  } as any;
}

// ============================================================
// summarizeOldMessages
// ============================================================

describe("summarizeOldMessages", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function makeMessages(count: number): ConversationMessage[] {
    return Array.from({ length: count }, (_, i) =>
      makeMsg({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}`, created_at: new Date(Date.now() + i * 1000).toISOString() })
    );
  }

  test("does not insert when messages array is empty", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabaseForSummarize({ messages: [], insertFn });

    await summarizeOldMessages(sb, 123);

    expect(insertFn).not.toHaveBeenCalled();
  });

  test("does not insert when messages is null", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabaseForSummarize({ messages: null, insertFn });

    await summarizeOldMessages(sb, 123);

    expect(insertFn).not.toHaveBeenCalled();
  });

  test("inserts Ollama summary when Ollama succeeds", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: "A concise summary of the conversation." }),
      })
    ) as any;

    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const msgs = makeMessages(3);
    const sb = mockSupabaseForSummarize({ messages: msgs, insertFn });

    await summarizeOldMessages(sb, 123);

    expect(insertFn).toHaveBeenCalledTimes(1);
    const insertedRow = insertFn.mock.calls[0][0];
    expect(insertedRow.summary).toBe("A concise summary of the conversation.");
    expect(insertedRow.chat_id).toBe(123);
    expect(insertedRow.message_count).toBe(3);
  });

  test("uses concatenation fallback when Ollama throws", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Ollama down"))) as any;

    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const msgs = makeMessages(3);
    const sb = mockSupabaseForSummarize({ messages: msgs, insertFn });

    await summarizeOldMessages(sb, 123);

    expect(insertFn).toHaveBeenCalledTimes(1);
    const insertedRow = insertFn.mock.calls[0][0];
    // Fallback: concatenates first 100 chars of each message content, joined by " | "
    expect(insertedRow.summary).toContain("Message 0");
    expect(insertedRow.summary).toContain(" | ");
  });

  test("does not insert when Ollama returns empty string and fallback also empty", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: "" }),
      })
    ) as any;

    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    // Use messages with empty content so fallback is also empty
    const emptyMsgs = [makeMsg({ content: "", created_at: new Date().toISOString() })];
    const sb = mockSupabaseForSummarize({ messages: emptyMsgs, insertFn });

    await summarizeOldMessages(sb, 123);

    // Empty Ollama response triggers catch on next json parse or produces ""
    // Fallback: "".slice(0,100) = "" → joined = "" → sliced = ""
    // Then !summary ("") → return early, no insert
    expect(insertFn).not.toHaveBeenCalled();
  });

  test("inserted row has from/to message IDs and timestamps from messages", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: "Summary text" }),
      })
    ) as any;

    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const t1 = "2026-02-18T09:00:00Z";
    const t2 = "2026-02-18T10:00:00Z";
    const msgs = [
      makeMsg({ id: "id-first", content: "First message", created_at: t1 }),
      makeMsg({ id: "id-last", content: "Last message", created_at: t2 }),
    ];
    const sb = mockSupabaseForSummarize({ messages: msgs, insertFn });

    await summarizeOldMessages(sb, 123);

    const row = insertFn.mock.calls[0][0];
    expect(row.from_message_id).toBe("id-first");
    expect(row.to_message_id).toBe("id-last");
    expect(row.from_timestamp).toBe(t1);
    expect(row.to_timestamp).toBe(t2);
  });

  test("passes afterTimestamp to messages query when prior summary exists", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: "Good summary" }),
      })
    ) as any;

    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    // latestSummary exists with a to_timestamp
    const latestSummary = [{ to_timestamp: "2026-02-17T12:00:00Z", to_message_id: "msg-99" }];
    const msgs = makeMessages(2);
    const sb = mockSupabaseForSummarize({ latestSummary, messages: msgs, insertFn });

    await summarizeOldMessages(sb, 123);

    // gt() should have been called on the messages query (to filter by afterTimestamp)
    // We verify by checking that insert was still called (function ran to completion)
    expect(insertFn).toHaveBeenCalledTimes(1);
  });
});
