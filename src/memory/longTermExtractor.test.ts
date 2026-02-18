/**
 * Tests for long-term memory extractor
 *
 * Run: bun test src/memory/longTermExtractor.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  extractMemoriesFromExchange,
  storeExtractedMemories,
  getUserProfile,
  type ExtractedMemories,
} from "./longTermExtractor.ts";

// We need to mock `spawn` from bun. Since bun:test doesn't have module mocking
// built-in, we test the public functions via their actual behavior where possible,
// and mock Supabase for DB interactions.

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
  test("returns empty object when extraction process fails", async () => {
    // callOllamaGenerate uses fetch — mock it to throw a network error
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.reject(new Error("network error"))) as any;

    const result = await extractMemoriesFromExchange("Hi I work at GovTech", "Nice!");
    expect(result).toEqual({});

    globalThis.fetch = origFetch;
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

  test("returns empty object when Ollama returns objects instead of arrays", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: '{"facts": {}, "preferences": {}}' }),
      })
    ) as any;

    const result = await extractMemoriesFromExchange("hello", "hi");
    expect(result).toEqual({});
  });

  test("filters non-string array items, preserves valid strings", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            response: '{"facts": [{}, "Works at GovTech", 123, null]}',
          }),
      })
    ) as any;

    const result = await extractMemoriesFromExchange("hello", "hi");
    expect(result.facts).toEqual(["Works at GovTech"]);
  });

  test("returns empty object when array fields are empty objects after sanitization", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            response: '{"facts": [{}], "preferences": [42]}',
          }),
      })
    ) as any;

    const result = await extractMemoriesFromExchange("hello", "hi");
    expect(result.facts).toBeUndefined();
    expect(result.preferences).toBeUndefined();
  });
});
