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

  test("[GOAL:] stores chat_id=chatId for provenance (reads are globally scoped)", async () => {
    // Provenance model: goals store the originating chatId for audit trail.
    // Global visibility is achieved by removing chat_id filter from read queries.
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "Noted! [GOAL: Global goal visible everywhere]";
    await processMemoryIntents(sb, response, 12345);
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.type).toBe("goal");
    expect(inserted.chat_id).toBe(12345); // provenance: records where goal was created
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

  test("strips [REMEMBER_GLOBAL: ...] tags and stores with null chat_id when no chatId provided", async () => {
    // Provenance model: without chatId (CLI/DM context), stores null (no provenance).
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "OK [REMEMBER_GLOBAL: Shared fact across groups]";
    const result = await processMemoryIntents(sb, response); // no chatId
    expect(result).not.toContain("[REMEMBER_GLOBAL:");
    expect(insertFn).toHaveBeenCalled();
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.chat_id).toBeNull(); // no chatId → null is correct provenance
    expect(inserted.category).toBe("personal");
  });
});

// ============================================================
// Provenance model — processMemoryIntents write paths (RED)
//
// Under the provenance model, chat_id stores WHERE a memory was created
// (audit trail), not its scope.  Scope is always global.
// [REMEMBER_GLOBAL:] and [GOAL:] should store the real chatId instead of
// hardcoded null.  Reads ignore chat_id (except date facts in AI context).
// ============================================================

describe("processMemoryIntents — provenance model write paths", () => {
  test("[REMEMBER_GLOBAL:] stores chat_id=chatId for provenance (not hardcoded null)", async () => {
    // RED: fails until W2 is implemented (currently hardcodes chat_id: null).
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "OK [REMEMBER_GLOBAL: Shared fact across groups]";
    await processMemoryIntents(sb, response, 99999);
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.chat_id).toBe(99999);
  });

  test("[REMEMBER_GLOBAL:] without chatId stores chat_id=null (CLI/DM provenance)", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "OK [REMEMBER_GLOBAL: CLI-origin fact]";
    await processMemoryIntents(sb, response); // no chatId
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.chat_id).toBeNull();
  });

  test("[GOAL:] stores chat_id=chatId for provenance (not hardcoded null)", async () => {
    // Provenance model: goals record which group created them for audit.
    // Read queries have no chat_id filter so they remain globally visible.
    // RED: fails until W3 is implemented (currently hardcodes chat_id: null).
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "Noted! [GOAL: Ship the provenance model]";
    await processMemoryIntents(sb, response, 12345);
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.chat_id).toBe(12345);
  });

  test("[GOAL:] without chatId stores chat_id=null (CLI/DM provenance)", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase({ insertFn });
    const response = "Noted! [GOAL: CLI goal]";
    await processMemoryIntents(sb, response); // no chatId
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.chat_id).toBeNull();
  });
});

// ============================================================
// [GOAL:] text-based dedup pre-check
//
// Regression for the race condition where a [GOAL:] AI tag is processed
// immediately after a /goals +text command, before the async embedding
// webhook has generated the vector — causing checkSemanticDuplicate to
// miss the duplicate and insert a second copy.
// ============================================================

describe("processMemoryIntents — [GOAL:] text dedup pre-check", () => {
  /** Builds a mock supabase where the first from("memory") call (existing goals
   *  query) returns existingGoals, and the second call has an insert method. */
  function mockSupabaseGoalDedup(
    existingGoals: { id: string; content: string }[],
    insertFn = mock(() => Promise.resolve({ data: null, error: null }))
  ) {
    let callCount = 0;

    // Chain for the "select existing goals" query
    const readChain: any = {
      select: mock(() => readChain),
      eq:     mock(() => readChain),
      limit:  mock(() => Promise.resolve({ data: existingGoals, error: null })),
      insert: insertFn,
    };

    // Chain for subsequent calls (insert path)
    const writeChain: any = {
      select: mock(() => writeChain),
      eq:     mock(() => writeChain),
      limit:  mock(() => Promise.resolve({ data: [], error: null })),
      insert: insertFn,
    };

    return {
      from: mock((_table: string) => {
        callCount++;
        return callCount === 1 ? readChain : writeChain;
      }),
      functions: {
        invoke: mock(() => Promise.resolve({ data: [], error: null })),
      },
    } as any;
  }

  test("skips [GOAL:] insert when exact match already in DB (catches embedding race)", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const existing = [{ id: "1", content: "update James on EDEN's userbase size" }];
    const sb = mockSupabaseGoalDedup(existing, insertFn);

    // AI tag has same text as existing goal — should be deduplicated
    const response = "Noted! [GOAL: update James on EDEN's userbase size]";
    const result = await processMemoryIntents(sb, response, 12345);

    expect(insertFn).not.toHaveBeenCalled();
    expect(result).not.toContain("[GOAL:");
  });

  test("skips [GOAL:] insert when AI tag wording differs slightly (catches /userbase/userbase vs /userbase)", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    // The exact text saved by /goals +text
    const existing = [{ id: "1", content: "update James on EDEN's userbase size" }];
    const sb = mockSupabaseGoalDedup(existing, insertFn);

    // AI tag has slightly different wording — still a duplicate
    const response = "Noted! [GOAL: update James on EDEN's userbase/userbase size]";
    const result = await processMemoryIntents(sb, response, 12345);

    expect(insertFn).not.toHaveBeenCalled();
    expect(result).not.toContain("[GOAL:");
  });

  test("inserts [GOAL:] when genuinely different from all existing goals", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const existing = [{ id: "1", content: "Deploy TRO pipeline to production" }];
    const sb = mockSupabaseGoalDedup(existing, insertFn);

    const response = "Noted! [GOAL: update James on EDEN's userbase size]";
    await processMemoryIntents(sb, response, 12345);

    expect(insertFn).toHaveBeenCalledTimes(1);
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.type).toBe("goal");
    expect(inserted.content).toBe("update James on EDEN's userbase size");
  });

  test("inserts [GOAL:] when no existing goals in DB", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabaseGoalDedup([], insertFn);

    const response = "Noted! [GOAL: update James on EDEN's userbase size]";
    await processMemoryIntents(sb, response, 12345);

    expect(insertFn).toHaveBeenCalledTimes(1);
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
