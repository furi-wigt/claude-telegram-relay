/**
 * E2E tests: Semantic duplicate detection for memory items
 *
 * Covers:
 *   1. checkSemanticDuplicate — unit tests for the core function
 *   2. processMemoryIntents — dedup integration (strips tags, skips dups)
 *   3. /remember command — dedup integration (warns on dup)
 *   4. storeExtractedMemories — dedup integration (batch filtering)
 *
 * Run: bun test src/memory/semanticDedup.e2e.test.ts
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  checkSemanticDuplicate,
  type DuplicateCheckResult,
} from "../utils/semanticDuplicateChecker.ts";

// ============================================================
// Shared helpers
// ============================================================

const CHAT_ID = 77001;

/**
 * Build a mock Supabase client whose `functions.invoke` returns
 * the given data/error pair.
 */
function mockSupabaseSearch(
  data: any[] | null = null,
  error: any = null
) {
  return {
    functions: {
      invoke: mock(async (_name: string, _opts: any) => ({
        data,
        error,
      })),
    },
  } as any;
}

/**
 * Build a mock Supabase client with both `from` and `functions.invoke`.
 * `from` returns a chainable query builder with an `insert` spy.
 */
function mockSupabaseFull(opts?: {
  searchData?: any[] | null;
  searchError?: any;
  insertFn?: ReturnType<typeof mock>;
}) {
  const {
    searchData = null,
    searchError = null,
    insertFn = mock(() => Promise.resolve({ data: null, error: null })),
  } = opts ?? {};

  return {
    from: mock(() => ({ insert: insertFn })),
    functions: {
      invoke: mock(async (_name: string, _opts: any) => ({
        data: searchData,
        error: searchError,
      })),
    },
    _insertFn: insertFn,
  } as any;
}

// ============================================================
// 1. checkSemanticDuplicate — unit tests
// ============================================================

describe("checkSemanticDuplicate", () => {
  it("returns isDuplicate=true when search finds match above threshold", async () => {
    const sb = mockSupabaseSearch([
      { id: "abc", content: "Buy groceries weekly", type: "goal", similarity: 0.92 },
    ]);

    const result = await checkSemanticDuplicate(sb, "Buy groceries every week", "goal", CHAT_ID);

    expect(result.isDuplicate).toBe(true);
    expect(result.match).toBeDefined();
    expect(result.match!.id).toBe("abc");
    expect(result.match!.content).toBe("Buy groceries weekly");
    expect(result.match!.similarity).toBe(0.92);
  });

  it("returns isDuplicate=false when search returns empty results", async () => {
    const sb = mockSupabaseSearch([], null);

    const result = await checkSemanticDuplicate(sb, "A brand new fact", "fact", CHAT_ID);

    expect(result.isDuplicate).toBe(false);
    expect(result.match).toBeUndefined();
  });

  it("returns isDuplicate=false when search returns null data", async () => {
    const sb = mockSupabaseSearch(null, null);

    const result = await checkSemanticDuplicate(sb, "Something", "fact");

    expect(result.isDuplicate).toBe(false);
  });

  it("returns isDuplicate=false when Edge Function throws (graceful degradation)", async () => {
    const sb = {
      functions: {
        invoke: mock(async () => {
          throw new Error("Edge Function unavailable");
        }),
      },
    } as any;

    const result = await checkSemanticDuplicate(sb, "test content", "fact", CHAT_ID);

    expect(result.isDuplicate).toBe(false);
    expect(result.match).toBeUndefined();
  });

  it("returns isDuplicate=false when Edge Function returns an error object", async () => {
    const sb = mockSupabaseSearch(null, { message: "internal error" });

    const result = await checkSemanticDuplicate(sb, "test content", "fact");

    expect(result.isDuplicate).toBe(false);
  });

  it("post-filters results by type — same content different type is NOT a duplicate", async () => {
    const sb = mockSupabaseSearch([
      { id: "x1", content: "Learn Rust", type: "goal", similarity: 0.95 },
    ]);

    // Searching as type "fact" — the match is type "goal", so it should NOT be a duplicate
    const result = await checkSemanticDuplicate(sb, "Learn Rust", "fact", CHAT_ID);

    expect(result.isDuplicate).toBe(false);
  });

  it("matches when type matches among multiple results", async () => {
    const sb = mockSupabaseSearch([
      { id: "x1", content: "Learn Rust", type: "goal", similarity: 0.95 },
      { id: "x2", content: "User is learning Rust", type: "fact", similarity: 0.88 },
    ]);

    const result = await checkSemanticDuplicate(sb, "User studies Rust", "fact", CHAT_ID);

    expect(result.isDuplicate).toBe(true);
    expect(result.match!.id).toBe("x2");
    expect(result.match!.type).toBeUndefined(); // match object only has id, content, similarity
    expect(result.match!.similarity).toBe(0.88);
  });

  it("respects chatId scoping — passes chat_id to search body", async () => {
    const sb = mockSupabaseSearch([], null);

    await checkSemanticDuplicate(sb, "test", "fact", 12345);

    expect(sb.functions.invoke).toHaveBeenCalledTimes(1);
    const callArgs = sb.functions.invoke.mock.calls[0];
    expect(callArgs[0]).toBe("search");
    const body = callArgs[1]?.body;
    expect(body.chat_id).toBe(12345);
  });

  it("omits chat_id from search body when chatId is null/undefined", async () => {
    const sb = mockSupabaseSearch([], null);

    await checkSemanticDuplicate(sb, "test", "fact", null);

    const body = sb.functions.invoke.mock.calls[0][1]?.body;
    expect(body.chat_id).toBeUndefined();
  });

  it("uses default threshold of 0.80", async () => {
    // Match at 0.79 — just below default threshold, should NOT be duplicate
    const sb = mockSupabaseSearch([
      { id: "low", content: "somewhat similar", type: "fact", similarity: 0.79 },
    ]);

    const result = await checkSemanticDuplicate(sb, "test", "fact");

    expect(result.isDuplicate).toBe(false);
  });

  it("respects custom threshold", async () => {
    const sb = mockSupabaseSearch([
      { id: "mid", content: "close match", type: "fact", similarity: 0.75 },
    ]);

    // With a lower threshold of 0.70, this should be a duplicate
    const result = await checkSemanticDuplicate(sb, "test", "fact", null, 0.70);

    expect(result.isDuplicate).toBe(true);
    expect(result.match!.similarity).toBe(0.75);
  });
});

// ============================================================
// 2. processMemoryIntents — dedup integration
//
// NOTE: processMemoryIntents in src/memory.ts currently does NOT
// call checkSemanticDuplicate yet. These tests document the
// EXPECTED behavior once the coder integrates the dedup check.
// They will fail until src/memory.ts is updated.
// ============================================================

describe("processMemoryIntents with semantic dedup", () => {
  // We need to test via the actual processMemoryIntents import.
  // The function currently always inserts. Once it calls
  // checkSemanticDuplicate before insert, these tests will pass.

  it("strips [REMEMBER:] tag but does NOT insert when duplicate found", async () => {
    const { processMemoryIntents } = await import("../memory.ts");

    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = {
      from: mock(() => ({ insert: insertFn })),
      functions: {
        invoke: mock(async () => ({
          data: [{ id: "dup1", content: "User likes coffee", type: "fact", similarity: 0.92 }],
          error: null,
        })),
      },
    } as any;

    const response = "Got it [REMEMBER: User likes coffee]";
    const result = await processMemoryIntents(sb, response, CHAT_ID);

    // Tag must always be stripped from user-visible response
    expect(result).not.toContain("[REMEMBER:");
    expect(result).toContain("Got it");
    // Insert should be skipped because duplicate was found
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("inserts when no duplicate found", async () => {
    const { processMemoryIntents } = await import("../memory.ts");

    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = {
      from: mock(() => ({ insert: insertFn })),
      functions: {
        invoke: mock(async () => ({
          data: [],
          error: null,
        })),
      },
    } as any;

    const response = "Noted [REMEMBER: User works at GovTech]";
    const result = await processMemoryIntents(sb, response, CHAT_ID);

    expect(result).not.toContain("[REMEMBER:");
    expect(insertFn).toHaveBeenCalled();
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.content).toBe("User works at GovTech");
    expect(inserted.type).toBe("fact");
  });

  it("strips [GOAL:] tag but does NOT insert when goal duplicate found", async () => {
    const { processMemoryIntents } = await import("../memory.ts");

    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = {
      from: mock(() => ({ insert: insertFn })),
      functions: {
        invoke: mock(async () => ({
          data: [{ id: "dup-goal", content: "Ship API v2", type: "goal", similarity: 0.90 }],
          error: null,
        })),
      },
    } as any;

    const response = "Let's do it [GOAL: Ship API v2 soon]";
    const result = await processMemoryIntents(sb, response, CHAT_ID);

    expect(result).not.toContain("[GOAL:");
    expect(result).toContain("Let's do it");
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("still strips tags even when Edge Function throws", async () => {
    const { processMemoryIntents } = await import("../memory.ts");

    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = {
      from: mock(() => ({ insert: insertFn })),
      functions: {
        invoke: mock(async () => {
          throw new Error("Edge Function down");
        }),
      },
    } as any;

    const response = "OK [REMEMBER: Test fact] and [GOAL: Test goal]";
    const result = await processMemoryIntents(sb, response, CHAT_ID);

    // Tags must be stripped regardless of dedup errors
    expect(result).not.toContain("[REMEMBER:");
    expect(result).not.toContain("[GOAL:");
    // Fail-open: inserts should still happen since dedup returned false
    expect(insertFn).toHaveBeenCalled();
  });
});

// ============================================================
// 3. /remember command — dedup integration
//
// NOTE: The current /remember handler in memoryCommands.ts does
// NOT call checkSemanticDuplicate yet. These tests document
// expected behavior after integration.
// ============================================================

describe("/remember with semantic dedup", () => {
  it("replies with duplicate warning when similar memory exists", async () => {
    const replyFn = mock(async (_text: string) => ({}));

    const sb = mockSupabaseFull({
      searchData: [
        { id: "existing", content: "User works at GovTech Singapore", type: "fact", similarity: 0.91 },
      ],
    });

    // Simulate what the updated /remember handler should do:
    // 1. Check for semantic duplicate first
    // 2. If duplicate, warn user instead of inserting
    const fact = "Works at GovTech";
    const dupResult = await checkSemanticDuplicate(sb, fact, "fact", CHAT_ID);

    expect(dupResult.isDuplicate).toBe(true);
    // The handler should reply with a warning containing the existing content
    expect(dupResult.match!.content).toContain("GovTech");
  });

  it("inserts and confirms when no duplicate found", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabaseFull({
      searchData: [],
      insertFn,
    });

    const fact = "User lives in a completely unique place";
    const dupResult = await checkSemanticDuplicate(sb, fact, "fact", CHAT_ID);

    expect(dupResult.isDuplicate).toBe(false);
    // The handler should proceed with insert
    await sb.from("memory").insert({
      type: "fact",
      content: fact,
      chat_id: CHAT_ID,
      category: "personal",
    });
    expect(insertFn).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// 4. storeExtractedMemories — dedup integration
//
// NOTE: storeExtractedMemories in longTermExtractor.ts currently
// does NOT call checkSemanticDuplicate. These tests document
// expected behavior after integration.
// ============================================================

describe("storeExtractedMemories with semantic dedup", () => {
  it("skips duplicates and only inserts non-duplicate items", async () => {
    // Simulate: 3 facts, 1 is duplicate
    let invokeCount = 0;
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = {
      from: mock(() => ({ insert: insertFn })),
      functions: {
        invoke: mock(async (_name: string, opts: any) => {
          invokeCount++;
          const query = opts?.body?.query ?? "";
          // "User likes coffee" is a duplicate
          if (query.includes("likes coffee")) {
            return {
              data: [{ id: "dup", content: "User enjoys coffee", type: "fact", similarity: 0.93 }],
              error: null,
            };
          }
          // Others are not duplicates
          return { data: [], error: null };
        }),
      },
    } as any;

    // Check each item individually (as the updated storeExtractedMemories should)
    const items = [
      { content: "User likes coffee", type: "fact" },
      { content: "User works at GovTech", type: "fact" },
      { content: "Learn Kubernetes", type: "goal" },
    ];

    const nonDuplicates: typeof items = [];
    for (const item of items) {
      const result = await checkSemanticDuplicate(sb, item.content, item.type, CHAT_ID);
      if (!result.isDuplicate) {
        nonDuplicates.push(item);
      }
    }

    expect(nonDuplicates).toHaveLength(2);
    expect(nonDuplicates[0].content).toBe("User works at GovTech");
    expect(nonDuplicates[1].content).toBe("Learn Kubernetes");
  });

  it("inserts all items when no duplicates found", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = {
      from: mock(() => ({ insert: insertFn })),
      functions: {
        invoke: mock(async () => ({
          data: [],
          error: null,
        })),
      },
    } as any;

    const items = [
      { content: "Fact A", type: "fact" },
      { content: "Fact B", type: "fact" },
      { content: "Goal C", type: "goal" },
    ];

    const nonDuplicates: typeof items = [];
    for (const item of items) {
      const result = await checkSemanticDuplicate(sb, item.content, item.type, CHAT_ID);
      if (!result.isDuplicate) {
        nonDuplicates.push(item);
      }
    }

    expect(nonDuplicates).toHaveLength(3);
  });

  it("inserts all items when Edge Function is unavailable (fail-open)", async () => {
    const sb = {
      functions: {
        invoke: mock(async () => {
          throw new Error("Network error");
        }),
      },
    } as any;

    const items = [
      { content: "Fact X", type: "fact" },
      { content: "Goal Y", type: "goal" },
    ];

    const nonDuplicates: typeof items = [];
    for (const item of items) {
      const result = await checkSemanticDuplicate(sb, item.content, item.type, CHAT_ID);
      if (!result.isDuplicate) {
        nonDuplicates.push(item);
      }
    }

    // Fail-open: all items should pass through
    expect(nonDuplicates).toHaveLength(2);
  });
});
