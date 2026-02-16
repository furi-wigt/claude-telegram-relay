/**
 * Tests for memory module — getMemoryContext and processMemoryIntents
 *
 * Run: bun test src/memory.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { getMemoryContext, processMemoryIntents } from "./memory.ts";

// ============================================================
// Supabase client mock factory
// ============================================================

function mockSupabase(overrides?: {
  factsData?: any[];
  goalsData?: any[];
  factsError?: any;
  goalsError?: any;
  insertFn?: ReturnType<typeof mock>;
  updateFn?: ReturnType<typeof mock>;
  selectFn?: ReturnType<typeof mock>;
}) {
  const {
    factsData = [],
    goalsData = [],
    factsError = null,
    goalsError = null,
    insertFn = mock(() => Promise.resolve({ data: null, error: null })),
  } = overrides ?? {};

  // Build chainable query builders for facts and goals
  const factsQuery = {
    select: mock(() => factsQuery),
    eq: mock(() => factsQuery),
    order: mock(() => factsQuery),
    ilike: mock(() => factsQuery),
    limit: mock(() => Promise.resolve({ data: factsData, error: factsError })),
    then: (resolve: any) =>
      resolve({ data: factsData, error: factsError }),
  };

  const goalsQuery = {
    select: mock(() => goalsQuery),
    eq: mock(() => goalsQuery),
    order: mock(() => goalsQuery),
    ilike: mock(() => goalsQuery),
    limit: mock(() => Promise.resolve({ data: goalsData, error: goalsError })),
    then: (resolve: any) =>
      resolve({ data: goalsData, error: goalsError }),
  };

  // Track which table is being queried to return the right chain
  let callCount = 0;
  const fromFn = mock((table: string) => {
    if (table === "memory") {
      // For getMemoryContext, first call is facts, second is goals
      // For processMemoryIntents, it uses insert directly
      callCount++;
      const chain = callCount % 2 === 1 ? factsQuery : goalsQuery;
      return {
        select: chain.select,
        eq: chain.eq,
        order: chain.order,
        ilike: chain.ilike,
        limit: chain.limit,
        insert: insertFn,
        update: mock(() => ({
          eq: mock(() => Promise.resolve({ data: null, error: null })),
        })),
      };
    }
    return { select: mock(), insert: insertFn };
  });

  return {
    from: fromFn,
    functions: {
      invoke: mock(() => Promise.resolve({ data: [], error: null })),
    },
    _resetCallCount: () => { callCount = 0; },
  } as any;
}

// ============================================================
// getMemoryContext
// ============================================================

describe("getMemoryContext", () => {
  test("returns empty string when supabase is null", async () => {
    const result = await getMemoryContext(null);
    expect(result).toBe("");
  });

  test("returns empty string when no facts or goals exist", async () => {
    const sb = mockSupabase({ factsData: [], goalsData: [] });
    const result = await getMemoryContext(sb);
    expect(result).toBe("");
  });

  test("returns FACTS section when facts exist", async () => {
    const sb = mockSupabase({
      factsData: [
        { id: 1, content: "User works at GovTech" },
        { id: 2, content: "Prefers TypeScript" },
      ],
    });
    const result = await getMemoryContext(sb);
    expect(result).toContain("FACTS:");
    expect(result).toContain("User works at GovTech");
    expect(result).toContain("Prefers TypeScript");
  });

  test("returns GOALS section when goals exist", async () => {
    const sb = mockSupabase({
      factsData: [],
      goalsData: [
        { id: 1, content: "Ship v2 launch", deadline: null, priority: 1 },
      ],
    });
    const result = await getMemoryContext(sb);
    expect(result).toContain("GOALS:");
    expect(result).toContain("Ship v2 launch");
  });

  test("handles Supabase query error gracefully", async () => {
    const errorSb = {
      from: mock(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            order: mock(() => {
              throw new Error("DB connection failed");
            }),
          })),
        })),
      })),
    } as any;
    // Should not throw, should return empty string
    const result = await getMemoryContext(errorSb);
    expect(result).toBe("");
  });
});

// ============================================================
// processMemoryIntents
// ============================================================

describe("processMemoryIntents", () => {
  test("returns response unchanged when supabase is null", async () => {
    const response = "Hello world [REMEMBER: test]";
    const result = await processMemoryIntents(null, response);
    expect(result).toBe(response);
  });

  test("strips [REMEMBER: ...] tags and inserts into supabase", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "Here is your answer [REMEMBER: User likes coffee]";
    const result = await processMemoryIntents(sb, response);
    expect(result).not.toContain("[REMEMBER:");
    expect(result).toContain("Here is your answer");
    expect(insertFn).toHaveBeenCalled();
  });

  test("strips [GOAL: ...] tags", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "Noted! [GOAL: Complete migration by Friday]";
    const result = await processMemoryIntents(sb, response);
    expect(result).not.toContain("[GOAL:");
    expect(result).toContain("Noted!");
  });

  test("strips [GOAL: ... | DEADLINE: ...] tags", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "Got it [GOAL: Deploy app | DEADLINE: 2026-03-01]";
    const result = await processMemoryIntents(sb, response);
    expect(result).not.toContain("[GOAL:");
    expect(result).not.toContain("DEADLINE:");
  });

  test("strips [REMEMBER_GLOBAL: ...] tags with null chat_id", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "OK [REMEMBER_GLOBAL: Shared fact across groups]";
    const result = await processMemoryIntents(sb, response);
    expect(result).not.toContain("[REMEMBER_GLOBAL:");
    expect(insertFn).toHaveBeenCalled();
  });
});
