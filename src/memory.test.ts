/**
 * Tests for memory module — getMemoryContext and processMemoryIntents
 *
 * Run: bun test src/memory.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { getMemoryContext, processMemoryIntents, detectMemoryCategory } from "./memory.ts";

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
    expect(result).toContain("📌 FACTS");
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
    expect(result).toContain("🎯 GOALS");
    expect(result).toContain("Ship v2 launch");
  });

  test("goals query does not filter by chatId (goals are globally scoped)", async () => {
    // Bug: getMemoryContext called .or("chat_id.eq.X,chat_id.is.null") on the goals query,
    // hiding goals from other groups. Fix: goals must be unfiltered (globally visible).
    const goalData = [{ id: "g1", content: "Global goal", deadline: null, priority: 1 }];

    // Build a mock where .limit() returns the chain (chainable + thenable), so
    // the current code's .or() call on the result of .limit() is trackable.
    const goalsOrFn = mock((_arg: string) => goalsChain);
    const goalsChain: any = {
      select: mock(() => goalsChain),
      eq: mock(() => goalsChain),
      or: goalsOrFn,
      order: mock(() => goalsChain),
      limit: mock(() => goalsChain), // returns chain (not Promise) so .or() is chainable
      then: (resolve: any) => resolve({ data: goalData, error: null }),
    };

    const factsChain: any = {
      select: mock(() => factsChain),
      eq: mock(() => factsChain),
      or: mock(() => factsChain),
      order: mock(() => factsChain),
      limit: mock(() => factsChain),
      then: (resolve: any) => resolve({ data: [], error: null }),
    };

    let callCount = 0;
    const sb = {
      from: mock((_table: string) => {
        callCount++;
        const chain = callCount % 2 === 1 ? factsChain : goalsChain;
        return {
          select: chain.select,
          eq: chain.eq,
          or: chain.or,
          order: chain.order,
          limit: chain.limit,
          insert: mock(() => Promise.resolve({ data: null, error: null })),
          update: mock(() => ({ eq: mock(() => Promise.resolve({ data: null, error: null })) })),
        };
      }),
    } as any;

    const result = await getMemoryContext(sb, 12345);

    // Goals must still appear (globally scoped, not filtered away)
    expect(result).toContain("🎯 GOALS");
    expect(result).toContain("Global goal");

    // FAIL currently: .or("chat_id.eq.12345,...") IS called on the goals chain
    const goalOrCallArgs = goalsOrFn.mock.calls.map((c: any[]) => c[0] as string);
    const chatIdFilterFound = goalOrCallArgs.some((arg: string) =>
      arg.includes("chat_id.eq.12345")
    );
    expect(chatIdFilterFound).toBe(false);
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

  test("[REMEMBER:] inserts with detected category 'personal' for generic facts", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "Noted [REMEMBER: User lives in Singapore]";
    await processMemoryIntents(sb, response, 12345);
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.category).toBe("personal");
    expect(inserted.type).toBe("fact");
  });

  test("[REMEMBER:] inserts with category 'preference' for preference facts", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "Got it [REMEMBER: User prefers concise responses]";
    await processMemoryIntents(sb, response, 12345);
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.category).toBe("preference");
  });

  test("[REMEMBER:] inserts with category 'date' for date facts", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "OK [REMEMBER: Meeting on Monday 9am]";
    await processMemoryIntents(sb, response, 12345);
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.category).toBe("date");
  });

  test("[GOAL:] inserts with category 'goal'", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "Noted! [GOAL: Complete migration by Friday]";
    await processMemoryIntents(sb, response, 12345);
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.type).toBe("goal");
    expect(inserted.category).toBe("goal");
  });

  test("[GOAL:] stores with chat_id=null even when chatId is provided (globally scoped)", async () => {
    // Bug: goals stored via [GOAL:] tag use chat_id=chatId, making them invisible
    // in other groups. Fix: goals must always be stored with chat_id=null.
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "Noted! [GOAL: Global goal visible everywhere]";
    await processMemoryIntents(sb, response, 12345); // chatId = 12345 (a group)
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.type).toBe("goal");
    expect(inserted.chat_id).toBeNull(); // FAIL: currently stores chat_id=12345
  });

  test("[GOAL: ... | DEADLINE: ...] inserts with category 'goal'", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "Got it [GOAL: Deploy app | DEADLINE: 2026-03-01]";
    const result = await processMemoryIntents(sb, response, 12345);
    expect(result).not.toContain("[GOAL:");
    expect(result).not.toContain("DEADLINE:");
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.category).toBe("goal");
    expect(inserted.deadline).toBe("2026-03-01");
  });

  test("strips [REMEMBER_GLOBAL: ...] tags with null chat_id and detected category", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "OK [REMEMBER_GLOBAL: Shared fact across groups]";
    const result = await processMemoryIntents(sb, response);
    expect(result).not.toContain("[REMEMBER_GLOBAL:");
    expect(insertFn).toHaveBeenCalled();
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.chat_id).toBeNull();
    expect(inserted.category).toBe("personal");
  });
});

// ============================================================
// detectMemoryCategory
// ============================================================

describe("detectMemoryCategory", () => {
  test("returns 'personal' for generic facts", () => {
    expect(detectMemoryCategory("User lives in Singapore")).toBe("personal");
    expect(detectMemoryCategory("My AWS account is 123456789")).toBe("personal");
    expect(detectMemoryCategory("Name is Alex")).toBe("personal");
  });

  test("returns 'preference' for preference-related content", () => {
    expect(detectMemoryCategory("User prefers concise responses")).toBe("preference");
    expect(detectMemoryCategory("Always respond formally")).toBe("preference");
    expect(detectMemoryCategory("I like bullet points")).toBe("preference");
    expect(detectMemoryCategory("Never use jargon")).toBe("preference");
  });

  test("returns 'date' for date-related content", () => {
    expect(detectMemoryCategory("Meeting on Monday 9am")).toBe("date");
    expect(detectMemoryCategory("Deadline on 15 Jan")).toBe("date");
    expect(detectMemoryCategory("standup every friday")).toBe("date");
  });
});
