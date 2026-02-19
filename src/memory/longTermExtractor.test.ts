/**
 * Tests for long-term memory extractor
 *
 * Run: bun test src/memory/longTermExtractor.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// Mock claudeText so tests exercise the Ollama fallback path via mocked fetch.
// This must be declared before importing the module under test.
mock.module("../claude-process.ts", () => ({
  claudeText: mock(() => Promise.reject(new Error("Claude unavailable in tests"))),
}));

import {
  extractMemoriesFromExchange,
  storeExtractedMemories,
  getUserProfile,
  hasMemoryItems,
  _filterPlaceholders,
  _isMemoryQuery,
  type ExtractedMemories,
  type ExchangeExtractionResult,
} from "./longTermExtractor.ts";

// Supabase DB interactions are tested via a mock factory.
// The fetch mock controls Ollama responses in extractMemoriesFromExchange tests.

// ============================================================
// Supabase mock factory
// ============================================================

function mockSupabase(overrides?: {
  insertFn?: ReturnType<typeof mock>;
  selectData?: any;
  selectError?: any;
}) {
  const {
    insertFn = mock(() => Promise.resolve({ data: null, error: null })),
    selectData = null,
    selectError = null,
  } = overrides ?? {};

  const singleQuery = {
    select: mock(() => singleQuery),
    eq: mock(() => singleQuery),
    single: mock(() => Promise.resolve({ data: selectData, error: selectError })),
  };

  return {
    from: mock(() => ({
      insert: insertFn,
      select: singleQuery.select,
      eq: singleQuery.eq,
      single: singleQuery.single,
    })),
    _insertFn: insertFn,
  } as any;
}

// ============================================================
// storeExtractedMemories
// ============================================================

describe("storeExtractedMemories", () => {
  test("inserts facts with correct fields", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });

    await storeExtractedMemories(sb, 123, {
      facts: ["Works at GovTech", "Lives in Singapore"],
    });

    expect(insertFn).toHaveBeenCalledTimes(1);
    const insertedRows = insertFn.mock.calls[0][0];
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0]).toEqual({
      type: "fact",
      content: "Works at GovTech",
      chat_id: 123,
      category: "personal",
      extracted_from_exchange: true,
      confidence: 0.9,
      importance: 0.85,
      stability: 0.9,
    });
  });

  test("inserts goals with type 'goal' and category 'goal'", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });

    await storeExtractedMemories(sb, 123, {
      goals: ["Ship v2 by March"],
    });

    const insertedRows = insertFn.mock.calls[0][0];
    expect(insertedRows[0].type).toBe("goal");
    expect(insertedRows[0].category).toBe("goal");
    expect(insertedRows[0].content).toBe("Ship v2 by March");
  });

  test("inserts preferences with type 'preference' and category 'preference'", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });

    await storeExtractedMemories(sb, 123, {
      preferences: ["Prefers TypeScript over JavaScript"],
    });

    const insertedRows = insertFn.mock.calls[0][0];
    expect(insertedRows[0].type).toBe("preference");
    expect(insertedRows[0].category).toBe("preference");
  });

  test("inserts dates as type 'fact' with category 'date'", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });

    await storeExtractedMemories(sb, 123, {
      dates: ["Birthday is March 15"],
    });

    const insertedRows = insertFn.mock.calls[0][0];
    expect(insertedRows[0].type).toBe("fact");
    expect(insertedRows[0].category).toBe("date");
  });

  test("skips junk entries — empty strings and strings < 5 chars", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });

    await storeExtractedMemories(sb, 123, {
      facts: ["", "abc", "   ", "Valid fact about user"],
    });

    const insertedRows = insertFn.mock.calls[0][0];
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].content).toBe("Valid fact about user");
  });

  test("does not call insert when all items are junk", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });

    await storeExtractedMemories(sb, 123, {
      facts: ["", "ab"],
    });

    expect(insertFn).not.toHaveBeenCalled();
  });

  test("does not call insert for empty memories object", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });

    await storeExtractedMemories(sb, 123, {});

    expect(insertFn).not.toHaveBeenCalled();
  });

  test("inserts combined facts, goals, and preferences in one call", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });

    await storeExtractedMemories(sb, 123, {
      facts: ["Works at GovTech"],
      goals: ["Launch API by March"],
      preferences: ["Prefers dark mode"],
    });

    expect(insertFn).toHaveBeenCalledTimes(1);
    const insertedRows = insertFn.mock.calls[0][0];
    expect(insertedRows).toHaveLength(3);

    const types = insertedRows.map((r: any) => r.type);
    expect(types).toContain("fact");
    expect(types).toContain("goal");
    expect(types).toContain("preference");
  });

  test("trims whitespace from content", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });

    await storeExtractedMemories(sb, 123, {
      facts: ["  Padded fact  "],
    });

    const insertedRows = insertFn.mock.calls[0][0];
    expect(insertedRows[0].content).toBe("Padded fact");
  });

  test("handles facts as object {} without throwing", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    // Should not throw even with malformed input
    await storeExtractedMemories(sb, 123, { facts: {} as any });
    expect(insertFn).not.toHaveBeenCalled();
  });

  test("filters non-string items from array, only inserts valid strings", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    await storeExtractedMemories(sb, 123, { facts: [{}, 123, null, "Valid fact about user"] as any });
    const rows = insertFn.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Valid fact about user");
  });

  test("handles all fields as objects {} without throwing or inserting", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    await storeExtractedMemories(sb, 123, {
      facts: {} as any,
      preferences: {} as any,
      goals: {} as any,
      dates: {} as any,
    });
    expect(insertFn).not.toHaveBeenCalled();
  });

  test("skips tag fragment goals from MEMORY MANAGEMENT template echoed in assistant response", async () => {
    // Root cause: Ollama extracts `]`/`[DONE:` or `[GOAL: goal text]` from the MEMORY
    // MANAGEMENT instructions block when it appears in the assistant response or context.
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });

    await storeExtractedMemories(sb, 123, {
      goals: [
        "]`/`[DONE:",                                         // partial tag fragment
        "]`/`[GOAL:",                                         // partial tag fragment
        "[GOAL: goal text | DEADLINE: optional date]",        // template example
        "[DONE: search text for completed goal]",             // template example
        "[REMEMBER: fact to store]",                          // template example
      ],
    });

    expect(insertFn).not.toHaveBeenCalled();
  });

  test("skips tag fragment facts from MEMORY MANAGEMENT template", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });

    await storeExtractedMemories(sb, 123, {
      facts: ["[REMEMBER: fact to store]", "Valid user fact about location"],
    });

    const rows = insertFn.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Valid user fact about location");
  });
});

// ============================================================
// getUserProfile
// ============================================================

describe("getUserProfile", () => {
  test("returns empty string when data is null", async () => {
    const sb = mockSupabase({ selectData: null });
    const result = await getUserProfile(sb, 999);
    expect(result).toBe("");
  });

  test("returns empty string on error", async () => {
    const sb = mockSupabase({ selectError: new Error("DB error") });
    const result = await getUserProfile(sb, 999);
    expect(result).toBe("");
  });

  test("includes profile_summary at the top", async () => {
    const sb = mockSupabase({
      selectData: {
        profile_summary: "John is a software engineer at GovTech.",
        raw_facts: [],
        raw_preferences: [],
        raw_goals: [],
        raw_dates: [],
        updated_at: new Date().toISOString(),
      },
    });

    const result = await getUserProfile(sb, 999);
    expect(result).toContain("John is a software engineer at GovTech.");
    // Should be at the start
    expect(result.startsWith("John is a software engineer")).toBe(true);
  });

  test("formats facts as bullet points", async () => {
    const sb = mockSupabase({
      selectData: {
        profile_summary: "Summary here",
        raw_facts: [{ fact: "Works at GovTech" }, { fact: "Based in Singapore" }],
        raw_preferences: [],
        raw_goals: [],
        raw_dates: [],
        updated_at: new Date().toISOString(),
      },
    });

    const result = await getUserProfile(sb, 999);
    expect(result).toContain("Personal Facts:");
    expect(result).toContain("\u2022 Works at GovTech");
    expect(result).toContain("\u2022 Based in Singapore");
  });

  test("formats goals with deadlines", async () => {
    const sb = mockSupabase({
      selectData: {
        profile_summary: "",
        raw_facts: [],
        raw_preferences: [],
        raw_goals: [
          { goal: "Ship v2", deadline: "2026-03-15T00:00:00Z" },
          { goal: "Learn Rust", deadline: null },
        ],
        raw_dates: [],
        updated_at: new Date().toISOString(),
      },
    });

    const result = await getUserProfile(sb, 999);
    expect(result).toContain("Active Goals:");
    expect(result).toContain("\u2022 Ship v2");
    expect(result).toContain("(by ");
    expect(result).toContain("\u2022 Learn Rust");
  });

  test("formats preferences", async () => {
    const sb = mockSupabase({
      selectData: {
        profile_summary: "",
        raw_facts: [],
        raw_preferences: [{ preference: "Dark mode" }, { preference: "Concise replies" }],
        raw_goals: [],
        raw_dates: [],
        updated_at: new Date().toISOString(),
      },
    });

    const result = await getUserProfile(sb, 999);
    expect(result).toContain("Preferences:");
    expect(result).toContain("\u2022 Dark mode");
    expect(result).toContain("\u2022 Concise replies");
  });

  test("formats important dates", async () => {
    const sb = mockSupabase({
      selectData: {
        profile_summary: "",
        raw_facts: [],
        raw_preferences: [],
        raw_goals: [],
        raw_dates: [{ event: "Birthday March 15" }],
        updated_at: new Date().toISOString(),
      },
    });

    const result = await getUserProfile(sb, 999);
    expect(result).toContain("Important Dates:");
    expect(result).toContain("\u2022 Birthday March 15");
  });

  test("handles null arrays gracefully (treats as empty)", async () => {
    const sb = mockSupabase({
      selectData: {
        profile_summary: "Just a summary",
        raw_facts: null,
        raw_preferences: null,
        raw_goals: null,
        raw_dates: null,
        updated_at: new Date().toISOString(),
      },
    });

    const result = await getUserProfile(sb, 999);
    expect(result).toBe("Just a summary");
    expect(result).not.toContain("Personal Facts:");
  });
});

// ============================================================
// extractMemoriesFromExchange
//
// These tests invoke the real function which spawns a process.
// Since we cannot easily mock `spawn` in bun, we test the
// function's error-handling path: when claude CLI is not
// available (common in CI), it should return {}.
// ============================================================

describe("extractMemoriesFromExchange", () => {
  test("returns empty certain and uncertain when extraction process fails", async () => {
    // callOllamaGenerate uses fetch — mock it to throw a network error
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.reject(new Error("network error"))) as any;

    const result = await extractMemoriesFromExchange("Hi I work at GovTech");
    expect(result).toEqual({ certain: {}, uncertain: {} });

    globalThis.fetch = origFetch;
  });

  test("accepts optional parameters: assistantResponse, chatId, traceId, injectedContext", async () => {
    const fn = extractMemoriesFromExchange;
    // 5 params: userMessage, assistantResponse?, chatId?, traceId?, injectedContext?
    expect(fn.length).toBe(5);
  });
});

// ============================================================
// Hallucination prevention — filterPlaceholders (direct unit tests)
// ============================================================

// Test _filterPlaceholders directly — no LLM mock needed, no Ollama fetch spy.
// This avoids the test-isolation issue where globalThis.fetch mocks are unreliable
// when multiple test files run in the same Bun process.

describe("hallucination prevention — _filterPlaceholders", () => {
  test("strips {userName} placeholder from text", () => {
    expect(_filterPlaceholders("You are speaking with {userName}")).toBe(
      "You are speaking with"
    );
  });

  test("strips multiple placeholders in one pass", () => {
    expect(
      _filterPlaceholders("Hello {user_name}, your {profile_type} is ready")
    ).toBe("Hello , your  is ready");
  });

  test("real content (GovTech, Singapore) is preserved after stripping", () => {
    const result = _filterPlaceholders(
      "I work at GovTech {placeholder} and live in Singapore"
    );
    expect(result).toContain("GovTech");
    expect(result).toContain("Singapore");
    expect(result).not.toMatch(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/);
  });

  test("text without placeholders is unchanged", () => {
    expect(_filterPlaceholders("I work at GovTech")).toBe("I work at GovTech");
  });

  test("trims surrounding whitespace left by stripped leading/trailing placeholder", () => {
    expect(_filterPlaceholders("{prefix} hello")).toBe("hello");
    expect(_filterPlaceholders("hello {suffix}")).toBe("hello");
  });
});

// ============================================================
// Hallucination prevention — memory query detection
// ============================================================

describe("hallucination prevention — memory query skip", () => {
  // Test _isMemoryQuery directly (no LLM mock needed).
  const memoryQueryMessages = [
    "what's in my goals",
    "what is in my goals",
    "what's my profile",
    "what do you know about me",
    "what do you remember about me",
    "what have I told you",
    "what have I said to you",
    "show me my memory",
    "show me my facts",
    "show my goals",
    "list my preferences",
  ];

  describe("_isMemoryQuery returns true for memory-read phrases", () => {
    for (const msg of memoryQueryMessages) {
      test(`"${msg}"`, () => {
        expect(_isMemoryQuery(msg)).toBe(true);
      });
    }
  });

  test("_isMemoryQuery returns true for slash memory commands", () => {
    // Slash commands display stored data — no new facts to extract.
    // Without this, /goals response echoes junk entries back to Ollama (positive feedback loop).
    expect(_isMemoryQuery("/goals")).toBe(true);
    expect(_isMemoryQuery("/facts")).toBe(true);
    expect(_isMemoryQuery("/memory")).toBe(true);
    expect(_isMemoryQuery("/history")).toBe(true);
    expect(_isMemoryQuery("/remember some fact")).toBe(true);
    expect(_isMemoryQuery("/forget some fact")).toBe(true);
  });

  test("_isMemoryQuery returns false for regular messages", () => {
    expect(_isMemoryQuery("I work at GovTech")).toBe(false);
    expect(_isMemoryQuery("Tell me about AI")).toBe(false);
    expect(_isMemoryQuery("What is the weather today?")).toBe(false);
    expect(_isMemoryQuery("I just got promoted")).toBe(false);
  });

  test("extractMemoriesFromExchange returns empty {} for memory-query messages", async () => {
    for (const msg of memoryQueryMessages) {
      const result = await extractMemoriesFromExchange(msg, "Here are your goals: ...");
      expect(result).toEqual({ certain: {}, uncertain: {} });
    }
  });
});

// ============================================================
// extractMemoriesFromExchange — sanitization of malformed Ollama output
// ============================================================

describe("extractMemoriesFromExchange - sanitization of malformed Ollama JSON", () => {
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test("returns empty certain/uncertain when Ollama returns flat objects instead of nested certain/uncertain", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: '{"facts": {}, "preferences": {}}' }),
      })
    ) as any;

    const result = await extractMemoriesFromExchange("hello");
    expect(result).toEqual({ certain: {}, uncertain: {} });
  });

  test("filters non-string items from certain.facts, preserves valid strings", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            response: '{"certain": {"facts": [{}, "Works at GovTech", 123, null]}, "uncertain": {}}',
          }),
      })
    ) as any;

    const result = await extractMemoriesFromExchange("hello");
    expect(result.certain.facts).toEqual(["Works at GovTech"]);
  });

  test("returns empty certain/uncertain when array fields contain only non-strings after sanitization", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            response: '{"certain": {"facts": [{}], "preferences": [42]}, "uncertain": {}}',
          }),
      })
    ) as any;

    const result = await extractMemoriesFromExchange("hello");
    expect(result.certain.facts).toBeUndefined();
    expect(result.certain.preferences).toBeUndefined();
  });

  test("correctly parses uncertain items into uncertain field", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            response: '{"certain": {"facts": ["Works at GovTech"]}, "uncertain": {"goals": ["Might want to improve fitness"]}}',
          }),
      })
    ) as any;

    const result = await extractMemoriesFromExchange("I work at GovTech and maybe I should exercise more");
    expect(result.certain.facts).toEqual(["Works at GovTech"]);
    expect(result.uncertain.goals).toEqual(["Might want to improve fitness"]);
  });

  test("extraction prompt does NOT include assistant response text", async () => {
    let capturedBody: string | null = null;
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      capturedBody = init?.body as string ?? null;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: "{}" }),
      });
    }) as any;

    await extractMemoriesFromExchange("I live in Singapore");

    expect(capturedBody).not.toBeNull();
    const bodyParsed = JSON.parse(capturedBody!);
    // Prompt should contain user message but not any "Assistant:" label
    expect(bodyParsed.prompt).toContain("I live in Singapore");
    expect(bodyParsed.prompt).not.toMatch(/^Assistant:/m);
    expect(bodyParsed.prompt).not.toContain("Assistant:");
  });
});

// ============================================================
// hasMemoryItems
// ============================================================

describe("hasMemoryItems", () => {
  test("returns false for empty object", () => {
    expect(hasMemoryItems({})).toBe(false);
  });

  test("returns false for empty arrays", () => {
    expect(hasMemoryItems({ facts: [], preferences: [], goals: [], dates: [] })).toBe(false);
  });

  test("returns true when facts has items", () => {
    expect(hasMemoryItems({ facts: ["Works at GovTech"] })).toBe(true);
  });

  test("returns true when only goals has items", () => {
    expect(hasMemoryItems({ goals: ["Ship v2"] })).toBe(true);
  });

  test("returns true when only dates has items", () => {
    expect(hasMemoryItems({ dates: ["Birthday March 15"] })).toBe(true);
  });
});
