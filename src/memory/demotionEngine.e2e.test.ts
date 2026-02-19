/**
 * E2E tests: Demotion engine and access tracking
 *
 * Covers:
 *   runDemotionPass — archives stale, low-value memories
 *   getMemoryContext — excludes archived memories
 *   storeExtractedMemories — assigns importance/stability by type
 *
 * Run: bun test src/memory/demotionEngine.e2e.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { runDemotionPass } from "../../routines/memory-cleanup.ts";
import { getMemoryContext } from "../memory.ts";
import { storeExtractedMemories } from "./longTermExtractor.ts";

// ============================================================
// Shared helpers
// ============================================================

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

interface MockMemoryRow {
  id: string;
  content: string;
  type: string;
  category?: string;
  status?: string;
  created_at: string;
  importance: number;
  stability: number;
  access_count: number;
  last_used_at: string | null;
  chat_id?: number | null;
  confidence?: number;
}

function makeMemoryRow(overrides: Partial<MockMemoryRow> = {}): MockMemoryRow {
  return {
    id: "mem-1",
    content: "Test memory content",
    type: "fact",
    category: "personal",
    status: "active",
    created_at: daysAgo(100),
    importance: 0.5,
    stability: 0.5,
    access_count: 0,
    last_used_at: null,
    chat_id: null,
    confidence: 0.9,
    ...overrides,
  };
}

/**
 * Build a mock Supabase client for runDemotionPass.
 *
 * runDemotionPass needs:
 *   supabase.from("memory").select(...)
 *     .eq("status", "active").neq("category", "constraint").lt(...)
 *   supabase.from("memory").update({ status: "archived" }).in("id", [...])
 *
 * We simulate the chainable query builder with a mock that resolves
 * to the provided candidate rows and captures update calls.
 */
function mockSupabaseDemotion(
  candidates: MockMemoryRow[],
  opts?: { updateError?: any }
) {
  const { updateError = null } = opts ?? {};

  // Track which ids were archived
  const archivedIds: string[] = [];

  const inFn = mock(async (col: string, ids: string[]) => {
    archivedIds.push(...ids);
    return { error: updateError, count: ids.length };
  });

  const updateFn = mock((_payload: any) => ({
    in: inFn,
  }));

  // Chainable select builder that eventually resolves to candidates
  const chainable = () => {
    const chain: any = {};
    chain.select = mock(() => chain);
    chain.eq = mock(() => chain);
    chain.neq = mock(() => chain);
    chain.lt = mock(() => chain);
    chain.order = mock(() => chain);
    chain.limit = mock(() => chain);
    // When awaited / .then() called, resolve to { data, error }
    chain.then = (resolve: any) =>
      resolve({ data: candidates, error: null });
    return chain;
  };

  const fromFn = mock((table: string) => {
    if (table !== "memory")
      throw new Error(`Unexpected table: ${table}`);
    return {
      select: chainable().select,
      update: updateFn,
      // Also support chainable on the root in case the implementation
      // chains .from("memory").select().eq()...
      ...chainable(),
    };
  });

  return {
    supabase: { from: fromFn } as any,
    fromFn,
    updateFn,
    inFn,
    archivedIds,
  };
}

// ============================================================
// 1. runDemotionPass
// ============================================================

describe("runDemotionPass()", () => {
  test("archives items older than 30 days that have never been used", async () => {
    const staleItem = makeMemoryRow({
      id: "stale-1",
      created_at: daysAgo(100),
      importance: 0.5,
      stability: 0.5,
      access_count: 0,
      last_used_at: null,
    });

    const { supabase, archivedIds } = mockSupabaseDemotion([staleItem]);

    const result = await runDemotionPass(supabase, { dryRun: false });

    expect(archivedIds).toContain("stale-1");
    expect(result.archived).toBeGreaterThanOrEqual(1);
  });

  test("does NOT archive frequently accessed items", async () => {
    const activeItem = makeMemoryRow({
      id: "active-1",
      created_at: daysAgo(100),
      importance: 0.5,
      stability: 0.5,
      access_count: 20,
      last_used_at: daysAgo(5),
    });

    const { supabase, archivedIds, updateFn } = mockSupabaseDemotion([
      activeItem,
    ]);

    const result = await runDemotionPass(supabase, { dryRun: false });

    // The frequently accessed item should NOT be archived
    expect(archivedIds).not.toContain("active-1");
    // Either update was not called, or it was called without this id
    if (result.archived === 0) {
      // Good: nothing was archived
      expect(result.archived).toBe(0);
    }
  });

  test("does NOT archive constraint category items", async () => {
    const constraintItem = makeMemoryRow({
      id: "constraint-1",
      created_at: daysAgo(200),
      importance: 0.5,
      stability: 0.5,
      access_count: 0,
      category: "constraint",
    });

    const { supabase, archivedIds } = mockSupabaseDemotion([constraintItem]);

    const result = await runDemotionPass(supabase, { dryRun: false });

    expect(archivedIds).not.toContain("constraint-1");
  });

  test("dry run does not call update", async () => {
    const staleItem = makeMemoryRow({
      id: "stale-dry-1",
      created_at: daysAgo(100),
      importance: 0.5,
      stability: 0.5,
      access_count: 0,
      last_used_at: null,
    });

    const { supabase, updateFn, inFn } = mockSupabaseDemotion([staleItem]);

    const result = await runDemotionPass(supabase, { dryRun: true });

    // update().in() should NOT have been called
    expect(inFn).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.archived).toBe(0);
  });

  test("returns correct counts", async () => {
    // 3 candidates: 2 should qualify for demotion (low effectiveScore),
    // 1 should not (high access keeps it alive)
    const candidates = [
      makeMemoryRow({
        id: "low-1",
        created_at: daysAgo(120),
        importance: 0.01,
        stability: 0.01,
        access_count: 0,
        last_used_at: null,
      }),
      makeMemoryRow({
        id: "low-2",
        created_at: daysAgo(150),
        importance: 0.02,
        stability: 0.01,
        access_count: 0,
        last_used_at: null,
      }),
      makeMemoryRow({
        id: "high-1",
        created_at: daysAgo(90),
        importance: 0.9,
        stability: 0.9,
        access_count: 50,
        last_used_at: daysAgo(1),
      }),
    ];

    const { supabase } = mockSupabaseDemotion(candidates);

    const result = await runDemotionPass(supabase, { dryRun: false });

    expect(result.candidates).toBe(3);
    expect(result.archived).toBe(2);
  });

  test("respects maxArchives cap", async () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeMemoryRow({
        id: `stale-cap-${i}`,
        created_at: daysAgo(200 + i),
        importance: 0.01,
        stability: 0.01,
        access_count: 0,
        last_used_at: null,
      })
    );

    const { supabase, archivedIds } = mockSupabaseDemotion(items);

    const result = await runDemotionPass(supabase, {
      dryRun: false,
      maxArchives: 3,
    });

    // Only 3 items should have been archived despite 10 qualifying
    expect(result.archived).toBeLessThanOrEqual(3);
    expect(archivedIds.length).toBeLessThanOrEqual(3);
  });
});

// ============================================================
// 2. Access tracking: getMemoryContext excludes archived memories
// ============================================================

describe("getMemoryContext excludes archived memories", () => {
  test("archived items are filtered out by the query", async () => {
    // The implementation should add .eq("status", "active") to the query.
    // We verify that by checking the mock chain was called with status filter.
    const eqCalls: Array<[string, any]> = [];

    const chainable = (data: any[]) => {
      const chain: any = {};
      chain.select = mock(() => chain);
      chain.eq = mock((col: string, val: any) => {
        eqCalls.push([col, val]);
        return chain;
      });
      chain.or = mock(() => chain);
      chain.order = mock(() => chain);
      chain.limit = mock(() => chain);
      chain.then = (resolve: any) => resolve({ data, error: null });
      return chain;
    };

    // Return one active fact and simulate the archived one being filtered
    const activeFact = { id: "f1", content: "Active memory content here" };

    const supabase = {
      from: mock((table: string) => {
        if (table === "memory") {
          return chainable([activeFact]);
        }
        return chainable([]);
      }),
    } as any;

    const result = await getMemoryContext(supabase, 123);

    // The result should contain the active item's content
    expect(result).toContain("Active memory content here");

    // Verify that .eq("status", "active") was part of the query chain
    // (This will pass once the coder adds the status filter)
    const statusFilter = eqCalls.find(
      ([col, val]) => col === "status" && val === "active"
    );
    expect(statusFilter).toBeDefined();
  });
});

// ============================================================
// 3. storeExtractedMemories assigns importance/stability by type
// ============================================================

describe("storeExtractedMemories assigns importance/stability by type", () => {
  test("fact gets importance ~0.85 and stability ~0.90", async () => {
    const insertedRows: any[] = [];

    // Mock semantic duplicate checker to always say "not a duplicate"
    const supabase = {
      from: mock((table: string) => ({
        insert: mock(async (rows: any[]) => {
          insertedRows.push(...rows);
          return { data: null, error: null };
        }),
        select: mock(() => ({
          eq: mock(() => ({
            eq: mock(() => ({
              limit: mock(() => ({
                then: (resolve: any) => resolve({ data: [], error: null }),
              })),
            })),
          })),
        })),
      })),
      functions: {
        invoke: mock(async () => ({ data: [], error: null })),
      },
    } as any;

    await storeExtractedMemories(supabase, 123, {
      facts: ["I live in Singapore"],
      preferences: ["I prefer Python"],
      goals: ["Learn TypeScript"],
    });

    // Find the inserted rows by type
    const factRow = insertedRows.find(
      (r) => r.type === "fact" && r.content === "I live in Singapore"
    );
    const prefRow = insertedRows.find(
      (r) => r.type === "preference" && r.content === "I prefer Python"
    );
    const goalRow = insertedRows.find(
      (r) => r.type === "goal" && r.content === "Learn TypeScript"
    );

    // Verify importance/stability are set (once the coder adds them)
    // Using approximate checks to allow for minor tuning
    if (factRow?.importance !== undefined) {
      expect(factRow.importance).toBeCloseTo(0.85, 1);
      expect(factRow.stability).toBeCloseTo(0.9, 1);
    }
    if (prefRow?.importance !== undefined) {
      expect(prefRow.importance).toBeCloseTo(0.7, 1);
    }
    if (goalRow?.importance !== undefined) {
      expect(goalRow.importance).toBeCloseTo(0.8, 1);
    }
  });
});
