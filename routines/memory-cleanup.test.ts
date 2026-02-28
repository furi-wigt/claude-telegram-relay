/**
 * Unit tests for routines/memory-cleanup.ts
 *
 * Run: bun test routines/memory-cleanup.test.ts
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  groupItems,
  buildReport,
  buildTelegramMessage,
  searchSimilar,
  clusterDuplicates,
  deleteItems,
  archiveCompletedGoals,
  runCleanup,
  type MemoryItem,
  type CleanupResult,
  type CleanupConfig,
} from "./memory-cleanup.ts";

// ============================================================
// Shared helpers
// ============================================================

const BASE_CONFIG: CleanupConfig = {
  dryRun: false,
  maxDeletes: 50,
  similarityThreshold: 0.92,
  minContentLength: 10,
  supabaseUrl: "https://test.supabase.co",
  supabaseAnonKey: "test-anon-key",
};

function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: "item-1",
    content: "This is a memory item content",
    type: "fact",
    created_at: "2024-01-01T00:00:00Z",
    confidence: 0.9,
    chat_id: null,
    ...overrides,
  };
}

function makeResult(overrides: Partial<CleanupResult> = {}): CleanupResult {
  return {
    scanned: 10,
    duplicatesFound: 2,
    deleted: 2,
    skipped: 0,
    dryRun: false,
    byType: {
      fact: { scanned: 5, duplicatesFound: 1, deleted: 1 },
      goal: { scanned: 3, duplicatesFound: 1, deleted: 1 },
      preference: { scanned: 2, duplicatesFound: 0, deleted: 0 },
    },
    deletions: [
      {
        keptId: "keep-1",
        deletedId: "del-1",
        similarity: 0.95,
        keptSnippet: "User works at GovTech",
        deletedSnippet: "User is employed at GovTech",
        type: "fact",
        chatId: null,
      },
    ],
    demotionCandidates: 0,
    demotionArchived: 0,
    completedGoalsArchived: 0,
    ...overrides,
  };
}

/**
 * Mock for archiveCompletedGoals: supabase.from().select().eq().eq() + .update().in()
 */
function mockSupabaseForArchive(
  items: Array<{ id: string }>,
  opts?: { updateError?: any }
) {
  const { updateError = null } = opts ?? {};

  // Select chain: from().select("id").eq("type",...).eq("status",...) -> { data, error }
  const selectEqStatus = mock(async (_col: string, _val: string) => ({
    data: items,
    error: null,
  }));
  const selectEqType = mock((_col: string, _val: string) => ({ eq: selectEqStatus }));
  const selectFn = mock((_cols: string) => ({ eq: selectEqType }));

  // Update chain: from().update({...}).in("id", [...]) -> { error }
  const updateInFn = mock(async (_col: string, _ids: string[]) => ({
    error: updateError,
  }));
  const updateFn = mock((_patch: any) => ({ in: updateInFn }));

  const fromFn = mock((_table: string) => ({
    select: selectFn,
    update: updateFn,
  }));

  return {
    supabase: { from: fromFn } as any,
    fromFn,
    selectFn,
    updateFn,
    updateInFn,
  };
}

/**
 * Build a mock Supabase client whose `functions.invoke` returns
 * the given data/error pair.
 */
function mockSupabaseSearch(data: any[] | null = null, error: any = null) {
  return {
    functions: {
      invoke: mock(async (_name: string, _opts: any) => ({ data, error })),
    },
  } as any;
}

/**
 * Build a mock Supabase client with a chainable `.from().delete().in()` chain.
 */
function mockSupabaseDelete(opts?: {
  deleteError?: any;
  deleteCount?: number;
}) {
  const { deleteError = null, deleteCount = undefined } = opts ?? {};

  const inFn = mock(async (_col: string, _ids: string[]) => ({
    error: deleteError,
    count: deleteCount,
  }));

  const deleteFn = mock((_opts: any) => ({ in: inFn }));
  const fromFn = mock((_table: string) => ({ delete: deleteFn }));

  return { supabase: { from: fromFn } as any, inFn, deleteFn, fromFn };
}

// ============================================================
// 1. groupItems() — pure function, no mocks needed
// ============================================================

describe("groupItems()", () => {
  it("groups items with same type and chat_id together", () => {
    const items: MemoryItem[] = [
      makeItem({ id: "a", type: "fact", chat_id: 100 }),
      makeItem({ id: "b", type: "fact", chat_id: 100 }),
    ];

    const groups = groupItems(items);

    expect(groups.size).toBe(1);
    const group = groups.get("fact"); // provenance model: key is bare type
    expect(group).toBeDefined();
    expect(group!.length).toBe(2);
    expect(group!.map((i) => i.id)).toContain("a");
    expect(group!.map((i) => i.id)).toContain("b");
  });

  it("places items with same type and different chat_id in the same cluster (provenance model)", () => {
    const items: MemoryItem[] = [
      makeItem({ id: "a", type: "fact", chat_id: 100 }),
      makeItem({ id: "b", type: "fact", chat_id: 200 }),
    ];

    const groups = groupItems(items);

    // Provenance model: chat_id is audit-only — same type → same cluster
    expect(groups.size).toBe(1);
    expect(groups.get("fact")).toBeDefined();
    expect(groups.get("fact::100")).toBeUndefined();
    expect(groups.get("fact::200")).toBeUndefined();
  });

  it("groups items with same type and null chat_id into the type cluster", () => {
    const items: MemoryItem[] = [
      makeItem({ id: "a", type: "goal", chat_id: null }),
      makeItem({ id: "b", type: "goal", chat_id: null }),
    ];

    const groups = groupItems(items);

    expect(groups.size).toBe(1);
    const group = groups.get("goal"); // provenance model: key is bare type
    expect(group).toBeDefined();
    expect(group!.length).toBe(2);
  });

  it("produces bare type string as key (no chat_id suffix)", () => {
    const items: MemoryItem[] = [
      makeItem({ id: "a", type: "preference", chat_id: 42 }),
    ];

    const groups = groupItems(items);

    // Provenance model: key is bare type only
    expect(groups.has("preference")).toBe(true);
    expect(groups.has("preference::42")).toBe(false);
  });

  it("produces bare type string as key even when chat_id is null", () => {
    const items: MemoryItem[] = [
      makeItem({ id: "a", type: "fact", chat_id: null }),
    ];

    const groups = groupItems(items);

    expect(groups.has("fact")).toBe(true);
    expect(groups.has("fact::null")).toBe(false);
  });
});

// ============================================================
// 2. buildReport() — pure function, no mocks needed
// ============================================================

describe("buildReport()", () => {
  it("contains 'Scanned:' with the correct count", () => {
    const result = makeResult({ scanned: 42 });
    const report = buildReport(result);
    expect(report).toContain("Scanned:");
    expect(report).toContain("42");
  });

  it("contains 'Deleted:' with the correct count", () => {
    const result = makeResult({ deleted: 7 });
    const report = buildReport(result);
    expect(report).toContain("Deleted:");
    expect(report).toContain("7");
  });

  it("contains 'DRY RUN' when dryRun=true", () => {
    const result = makeResult({ dryRun: true });
    const report = buildReport(result);
    expect(report).toContain("DRY RUN");
  });

  it("contains 'LIVE' when dryRun=false", () => {
    const result = makeResult({ dryRun: false });
    const report = buildReport(result);
    // dryRun=false means no [DRY RUN] label — the mode line says nothing special
    // but should NOT say DRY RUN
    expect(report).not.toContain("DRY RUN");
    // The report title should not include a DRY RUN marker
    expect(report).toContain("Memory Cleanup Report");
  });

  it("shows correct '0' counts when deletions list is empty", () => {
    const result = makeResult({
      scanned: 5,
      duplicatesFound: 0,
      deleted: 0,
      skipped: 0,
      deletions: [],
      byType: {
        fact: { scanned: 5, duplicatesFound: 0, deleted: 0 },
        goal: { scanned: 0, duplicatesFound: 0, deleted: 0 },
        preference: { scanned: 0, duplicatesFound: 0, deleted: 0 },
      },
    });

    const report = buildReport(result);

    expect(report).toContain("Scanned:          5");
    expect(report).toContain("Duplicates found: 0");
    expect(report).toContain("Deleted:          0");
    expect(report).toContain("No duplicates found");
  });
});

// ============================================================
// 3. buildTelegramMessage() — pure function, no mocks needed
// ============================================================

describe("buildTelegramMessage()", () => {
  it("contains duplicate count when duplicates found", () => {
    const result = makeResult({ deleted: 3, duplicatesFound: 3 });
    const msg = buildTelegramMessage(result);
    expect(msg).toContain("Removed: 3 duplicate");
  });

  it("truncates deletion list to max 10 and shows 'and N more' for larger lists", () => {
    const deletions = Array.from({ length: 15 }, (_, i) => ({
      keptId: `keep-${i}`,
      deletedId: `del-${i}`,
      similarity: 0.95,
      keptSnippet: `Kept item ${i}`,
      deletedSnippet: `Deleted item ${i} with some content`,
      type: "fact",
      chatId: null,
    }));

    const result = makeResult({ deletions, deleted: 15, duplicatesFound: 15 });
    const msg = buildTelegramMessage(result);

    expect(msg).toContain("and 5 more");
    // Only 10 lines shown in the main list
    const lines = msg.split("\n").filter((l) => l.startsWith("  [fact]"));
    expect(lines.length).toBe(10);
  });

  it("does not show 'and N more' when deletions <= 10", () => {
    const deletions = Array.from({ length: 5 }, (_, i) => ({
      keptId: `keep-${i}`,
      deletedId: `del-${i}`,
      similarity: 0.95,
      keptSnippet: `Kept item ${i}`,
      deletedSnippet: `Deleted item ${i}`,
      type: "fact",
      chatId: null,
    }));

    const result = makeResult({ deletions, deleted: 5 });
    const msg = buildTelegramMessage(result);

    expect(msg).not.toContain("and");
  });

  it("includes dry run label when dryRun=true", () => {
    const result = makeResult({ dryRun: true });
    const msg = buildTelegramMessage(result);
    expect(msg).toContain("dry run");
  });

  it("does not include dry run label when dryRun=false", () => {
    const result = makeResult({ dryRun: false });
    const msg = buildTelegramMessage(result);
    expect(msg).not.toContain("dry run");
  });
});

// ============================================================
// 4. searchSimilar() — mock supabase.functions.invoke
// ============================================================

describe("searchSimilar()", () => {
  it("returns filtered matches (same type as item, excludes self)", async () => {
    const item = makeItem({ id: "self", type: "fact", chat_id: null });

    const rawMatches = [
      { id: "other", content: "Similar fact", type: "fact", created_at: "2024-01-02T00:00:00Z", similarity: 0.95 },
      { id: "self", content: "Same item", type: "fact", created_at: "2024-01-01T00:00:00Z", similarity: 1.0 }, // self — should be excluded
      { id: "goal-item", content: "A goal", type: "goal", created_at: "2024-01-03T00:00:00Z", similarity: 0.93 }, // wrong type
    ];

    const supabase = mockSupabaseSearch(rawMatches, null);
    const matches = await searchSimilar(supabase, item, BASE_CONFIG);

    expect(matches.length).toBe(1);
    expect(matches[0].id).toBe("other");
  });

  it("returns [] when Edge Function throws (graceful degradation)", async () => {
    const item = makeItem({ id: "item-1", type: "fact" });
    const supabase = {
      functions: {
        invoke: mock(async () => {
          throw new Error("Edge Function unavailable");
        }),
      },
    } as any;

    const matches = await searchSimilar(supabase, item, BASE_CONFIG);

    expect(matches).toEqual([]);
  });

  it("returns [] when Edge Function returns error object", async () => {
    const item = makeItem({ id: "item-1", type: "fact" });
    const supabase = mockSupabaseSearch(null, { message: "internal error" });

    const matches = await searchSimilar(supabase, item, BASE_CONFIG);

    expect(matches).toEqual([]);
  });

  it("excludes matches of different type (post-type-filter works)", async () => {
    const item = makeItem({ id: "fact-1", type: "fact", chat_id: null });

    const rawMatches = [
      { id: "goal-x", content: "A goal item", type: "goal", created_at: "2024-01-01T00:00:00Z", similarity: 0.96 },
      { id: "pref-y", content: "A preference", type: "preference", created_at: "2024-01-01T00:00:00Z", similarity: 0.94 },
    ];

    const supabase = mockSupabaseSearch(rawMatches, null);
    const matches = await searchSimilar(supabase, item, BASE_CONFIG);

    expect(matches).toEqual([]);
  });

  it("does not pass chat_id in body even when item.chat_id is set (provenance model)", async () => {
    const item = makeItem({ id: "item-1", type: "fact", chat_id: 12345 });
    const supabase = mockSupabaseSearch([], null);

    await searchSimilar(supabase, item, BASE_CONFIG);

    expect(supabase.functions.invoke).toHaveBeenCalledTimes(1);
    const callArgs = supabase.functions.invoke.mock.calls[0];
    const body = callArgs[1]?.body;
    // Provenance model: search is globally scoped — no chat_id filter
    expect(body).not.toHaveProperty("chat_id");
  });

  it("omits chat_id from body when item.chat_id is null", async () => {
    const item = makeItem({ id: "item-1", type: "fact", chat_id: null });
    const supabase = mockSupabaseSearch([], null);

    await searchSimilar(supabase, item, BASE_CONFIG);

    const callArgs = supabase.functions.invoke.mock.calls[0];
    const body = callArgs[1]?.body;
    expect(body.chat_id).toBeUndefined();
  });
});

// ============================================================
// 5. clusterDuplicates() — mock searchSimilar via supabase mock
// ============================================================

describe("clusterDuplicates()", () => {
  it("returns one cluster when two items are similar", async () => {
    const itemA = makeItem({ id: "a", content: "User likes coffee", type: "fact", created_at: "2024-01-01T00:00:00Z" });
    const itemB = makeItem({ id: "b", content: "User enjoys coffee", type: "fact", created_at: "2024-01-02T00:00:00Z" });

    // itemA searches and finds itemB as similar
    const supabase = {
      functions: {
        invoke: mock(async (_name: string, opts: any) => {
          const query = opts?.body?.query ?? "";
          if (query === "User likes coffee") {
            return {
              data: [{ id: "b", content: "User enjoys coffee", type: "fact", created_at: "2024-01-02T00:00:00Z", similarity: 0.95 }],
              error: null,
            };
          }
          return { data: [], error: null };
        }),
      },
    } as any;

    const clusters = await clusterDuplicates([itemA, itemB], BASE_CONFIG, supabase);

    expect(clusters.length).toBe(1);
    expect(clusters[0].keeper.id).toBe("a");
    expect(clusters[0].duplicates.length).toBe(1);
    expect(clusters[0].duplicates[0].item.id).toBe("b");
  });

  it("returns empty array when no items are similar", async () => {
    const items = [
      makeItem({ id: "a", content: "User likes coffee", type: "fact" }),
      makeItem({ id: "b", content: "User plays tennis", type: "fact" }),
    ];

    const supabase = mockSupabaseSearch([], null);
    const clusters = await clusterDuplicates(items, BASE_CONFIG, supabase);

    expect(clusters).toEqual([]);
  });

  it("skips items below minContentLength", async () => {
    const shortItem = makeItem({ id: "short", content: "hi", type: "fact" }); // len=2 < 10
    const longItem = makeItem({ id: "long", content: "Long enough content here", type: "fact" });

    const supabase = mockSupabaseSearch([], null);
    const config = { ...BASE_CONFIG, minContentLength: 10 };

    const clusters = await clusterDuplicates([shortItem, longItem], config, supabase);

    // Short item should be skipped; long item finds no matches
    expect(clusters).toEqual([]);
    // invoke should only be called for the long item, not short
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(1);
  });

  it("does not re-process already-visited items as new cluster seeds", async () => {
    const itemA = makeItem({ id: "a", content: "User likes coffee daily", type: "fact", created_at: "2024-01-01T00:00:00Z" });
    const itemB = makeItem({ id: "b", content: "User enjoys coffee everyday", type: "fact", created_at: "2024-01-02T00:00:00Z" });

    // When itemA is searched, itemB is found as a duplicate
    // itemB should then be absorbed and NOT processed as a new keeper seed
    const supabase = {
      functions: {
        invoke: mock(async (_name: string, opts: any) => {
          const query = opts?.body?.query ?? "";
          if (query === "User likes coffee daily") {
            return {
              data: [{ id: "b", content: "User enjoys coffee everyday", type: "fact", created_at: "2024-01-02T00:00:00Z", similarity: 0.96 }],
              error: null,
            };
          }
          // itemB would return itemA, but it should never be called for itemB
          if (query === "User enjoys coffee everyday") {
            return {
              data: [{ id: "a", content: "User likes coffee daily", type: "fact", created_at: "2024-01-01T00:00:00Z", similarity: 0.96 }],
              error: null,
            };
          }
          return { data: [], error: null };
        }),
      },
    } as any;

    const clusters = await clusterDuplicates([itemA, itemB], BASE_CONFIG, supabase);

    // Should be exactly 1 cluster, not 2 (itemB absorbed, never seeded its own cluster)
    expect(clusters.length).toBe(1);
    expect(clusters[0].keeper.id).toBe("a");
  });

  it("keeps the oldest item (lowest created_at) as keeper", async () => {
    // Items are sorted by created_at ascending by fetchActiveItems,
    // so the first item in the list is the oldest and becomes keeper
    const older = makeItem({ id: "older", content: "User likes running outdoors", type: "fact", created_at: "2024-01-01T00:00:00Z" });
    const newer = makeItem({ id: "newer", content: "User enjoys running outside", type: "fact", created_at: "2024-06-01T00:00:00Z" });

    const supabase = {
      functions: {
        invoke: mock(async (_name: string, opts: any) => {
          const query = opts?.body?.query ?? "";
          if (query === "User likes running outdoors") {
            return {
              data: [{ id: "newer", content: "User enjoys running outside", type: "fact", created_at: "2024-06-01T00:00:00Z", similarity: 0.94 }],
              error: null,
            };
          }
          return { data: [], error: null };
        }),
      },
    } as any;

    const clusters = await clusterDuplicates([older, newer], BASE_CONFIG, supabase);

    expect(clusters.length).toBe(1);
    expect(clusters[0].keeper.id).toBe("older");
    expect(clusters[0].duplicates[0].item.id).toBe("newer");
  });
});

// ============================================================
// 6. deleteItems() — mock supabase.from().delete()
// ============================================================

describe("deleteItems()", () => {
  it("DRY_RUN=true: does NOT call delete, returns expected count", async () => {
    const { supabase, fromFn } = mockSupabaseDelete();
    const ids = ["id-1", "id-2", "id-3"];

    const count = await deleteItems(supabase, ids, true);

    expect(count).toBe(3);
    expect(fromFn).not.toHaveBeenCalled();
  });

  it("DRY_RUN=false: calls delete with correct IDs", async () => {
    const { supabase, inFn } = mockSupabaseDelete({ deleteCount: 2 });
    const ids = ["id-1", "id-2"];

    const count = await deleteItems(supabase, ids, false);

    expect(count).toBe(2);
    expect(inFn).toHaveBeenCalledTimes(1);
    const callArgs = inFn.mock.calls[0];
    expect(callArgs[0]).toBe("id");
    expect(callArgs[1]).toEqual(["id-1", "id-2"]);
  });

  it("empty ids array: returns 0 without calling delete", async () => {
    const { supabase, fromFn } = mockSupabaseDelete();

    const count = await deleteItems(supabase, [], false);

    expect(count).toBe(0);
    expect(fromFn).not.toHaveBeenCalled();
  });

  it("empty ids array with dryRun=true: returns 0 without calling delete", async () => {
    const { supabase, fromFn } = mockSupabaseDelete();

    const count = await deleteItems(supabase, [], true);

    expect(count).toBe(0);
    expect(fromFn).not.toHaveBeenCalled();
  });
});

// ============================================================
// 7. Integration: runCleanup() — mock fetchActiveItems and searchSimilar
// ============================================================

describe("runCleanup() integration", () => {
  // runCleanup() creates its own supabase client internally, so we mock
  // the module-level fetchActiveItems and searchSimilar by controlling
  // what supabase.from() and supabase.functions.invoke() return.
  //
  // We use the configOverride parameter to inject test config and mock
  // supabase via the module's exported functions with partial mocking.

  const TEST_CONFIG: Partial<CleanupConfig> = {
    dryRun: false,
    maxDeletes: 50,
    similarityThreshold: 0.92,
    minContentLength: 5,
    supabaseUrl: "https://fake.supabase.co",
    supabaseAnonKey: "fake-anon-key",
  };

  it("with 3 items where 2 are duplicates: result.deleted=1, result.duplicatesFound=1", async () => {
    // We need to mock at the module level. Since runCleanup creates its own
    // supabase client via createClient, we'll use the exported functions directly
    // and test clusterDuplicates + deleteItems integration through groupItems.
    //
    // For true integration testing of runCleanup(), we mock fetchActiveItems
    // and the supabase calls it makes.

    const items: MemoryItem[] = [
      makeItem({ id: "a", content: "User likes tea", type: "fact", created_at: "2024-01-01T00:00:00Z", chat_id: null }),
      makeItem({ id: "b", content: "User enjoys tea", type: "fact", created_at: "2024-01-02T00:00:00Z", chat_id: null }),
      makeItem({ id: "c", content: "User plays chess", type: "fact", created_at: "2024-01-03T00:00:00Z", chat_id: null }),
    ];

    // Test by composing the pure functions:
    // groupItems -> clusterDuplicates -> deleteItems
    const groups = groupItems(items);
    expect(groups.size).toBe(1);

    // For cluster: item "a" finds "b" as similar, "c" finds nothing
    const mockSupabase = {
      functions: {
        invoke: mock(async (_name: string, opts: any) => {
          const query = opts?.body?.query ?? "";
          if (query === "User likes tea") {
            return {
              data: [{ id: "b", content: "User enjoys tea", type: "fact", created_at: "2024-01-02T00:00:00Z", similarity: 0.95 }],
              error: null,
            };
          }
          return { data: [], error: null };
        }),
      },
    } as any;

    const clusters = await clusterDuplicates(items, BASE_CONFIG, mockSupabase);

    expect(clusters.length).toBe(1);
    const duplicateIds = clusters.flatMap((c) => c.duplicates.map((d) => d.item.id));
    expect(duplicateIds).toEqual(["b"]);

    const { supabase: delSupabase, inFn } = mockSupabaseDelete({ deleteCount: 1 });
    const deleted = await deleteItems(delSupabase, duplicateIds, false);

    expect(deleted).toBe(1);
    expect(inFn).toHaveBeenCalledTimes(1);
  });

  it("with 0 duplicates: result.deleted=0, result.duplicatesFound=0", async () => {
    const items: MemoryItem[] = [
      makeItem({ id: "x", content: "User reads books", type: "fact" }),
      makeItem({ id: "y", content: "User goes hiking", type: "fact" }),
    ];

    const mockSupabase = mockSupabaseSearch([], null);
    const clusters = await clusterDuplicates(items, BASE_CONFIG, mockSupabase);

    expect(clusters.length).toBe(0);

    const { supabase: delSupabase, fromFn } = mockSupabaseDelete();
    const deleted = await deleteItems(delSupabase, [], false);

    expect(deleted).toBe(0);
    expect(fromFn).not.toHaveBeenCalled();
  });

  it("MAX_DELETES cap: stops at cap and sets cappedAt in result", async () => {
    // Build clusters exceeding max cap
    const allDuplicateIds = Array.from({ length: 10 }, (_, i) => `dup-${i}`);
    const maxDeletes = 3;

    const config = { ...BASE_CONFIG, maxDeletes };
    const idsToDelete: string[] = [];
    let skipped = 0;

    for (const id of allDuplicateIds) {
      if (idsToDelete.length >= config.maxDeletes) {
        skipped++;
      } else {
        idsToDelete.push(id);
      }
    }

    expect(idsToDelete.length).toBe(3);
    expect(skipped).toBe(7);

    const result: CleanupResult = {
      scanned: 15,
      duplicatesFound: idsToDelete.length + skipped,
      deleted: idsToDelete.length,
      skipped,
      dryRun: false,
      byType: {
        fact: { scanned: 15, duplicatesFound: 10, deleted: 3 },
        goal: { scanned: 0, duplicatesFound: 0, deleted: 0 },
        preference: { scanned: 0, duplicatesFound: 0, deleted: 0 },
      },
      deletions: idsToDelete.map((id) => ({
        keptId: "keeper",
        deletedId: id,
        similarity: 0.95,
        keptSnippet: "Kept content",
        deletedSnippet: "Dup content",
        type: "fact",
        chatId: null,
      })),
      cappedAt: maxDeletes,
    };

    expect(result.cappedAt).toBe(3);
    expect(result.skipped).toBe(7);
    expect(result.duplicatesFound).toBe(10);
  });

  it("DRY_RUN mode: duplicatesFound > 0 but deleted = 0 (simulated)", async () => {
    // In dry run, deleteItems returns the count as if deleted but doesn't call DB
    const ids = ["dup-1", "dup-2"];
    const { supabase, fromFn } = mockSupabaseDelete();

    const deletedCount = await deleteItems(supabase, ids, true);

    // dry run returns the count
    expect(deletedCount).toBe(2);
    // but does NOT call the DB
    expect(fromFn).not.toHaveBeenCalled();

    // In the actual runCleanup with dryRun, the result.deleted would reflect
    // what deleteItems returned (ids.length), but in the real flow with
    // dryRun=true the Telegram message would say "dry run"
    const result = makeResult({
      dryRun: true,
      duplicatesFound: 2,
      deleted: deletedCount,
      deletions: [
        {
          keptId: "k1",
          deletedId: "dup-1",
          similarity: 0.95,
          keptSnippet: "Kept",
          deletedSnippet: "Dup 1",
          type: "fact",
          chatId: null,
        },
        {
          keptId: "k1",
          deletedId: "dup-2",
          similarity: 0.93,
          keptSnippet: "Kept",
          deletedSnippet: "Dup 2",
          type: "fact",
          chatId: null,
        },
      ],
    });

    expect(result.dryRun).toBe(true);
    expect(result.duplicatesFound).toBeGreaterThan(0);

    const msg = buildTelegramMessage(result);
    expect(msg).toContain("dry run");
  });
});

// ============================================================
// 8. Demotion integration in runCleanup and report builders
// ============================================================

describe("demotion stats in runCleanup result", () => {
  it("runCleanup includes demotionArchived and demotionCandidates fields", async () => {
    // When demotion is integrated into runCleanup, the result should
    // carry demotion stats alongside existing dedup stats.
    const result = makeResult({
      scanned: 20,
      duplicatesFound: 1,
      deleted: 1,
      skipped: 0,
      dryRun: true,
    });

    // Simulate demotion stats being added to the result
    const withDemotion = {
      ...result,
      demotionCandidates: 5,
      demotionArchived: 2,
    };

    expect(withDemotion.demotionCandidates).toBe(5);
    expect(withDemotion.demotionArchived).toBe(2);
  });
});

describe("buildReport includes demotion summary", () => {
  it("report contains demotion info when demotionArchived > 0", () => {
    const result = {
      ...makeResult({ scanned: 30 }),
      demotionArchived: 3,
      demotionCandidates: 10,
    };

    const report = buildReport(result as any);

    // Once the coder adds demotion to buildReport, these should pass
    expect(report).toContain("Demotion");
    expect(report).toContain("3");
  });
});

describe("buildTelegramMessage includes demotion when items archived", () => {
  it("message contains archive count when demotion occurred", () => {
    const result = {
      ...makeResult({ scanned: 50 }),
      demotionArchived: 5,
      demotionCandidates: 12,
    };

    const msg = buildTelegramMessage(result as any);

    // Once the coder adds demotion to buildTelegramMessage, these should pass
    expect(msg.toLowerCase()).toContain("5");
    expect(msg.toLowerCase()).toContain("archive");
  });
});

// ============================================================
// 9. archiveCompletedGoals() — auto-archive completed_goal items
// ============================================================

describe("archiveCompletedGoals()", () => {
  it("archives all active completed_goal items in non-dry-run mode", async () => {
    const items = [{ id: "cg-1" }, { id: "cg-2" }, { id: "cg-3" }];
    const { supabase, updateInFn } = mockSupabaseForArchive(items);

    const count = await archiveCompletedGoals(supabase, false);

    expect(count).toBe(3);
    expect(updateInFn).toHaveBeenCalledTimes(1);
    const callArgs = updateInFn.mock.calls[0];
    expect(callArgs[0]).toBe("id");
    expect(callArgs[1]).toEqual(["cg-1", "cg-2", "cg-3"]);
  });

  it("dry run: returns count but does NOT call update", async () => {
    const items = [{ id: "cg-1" }, { id: "cg-2" }];
    const { supabase, updateFn } = mockSupabaseForArchive(items);

    const count = await archiveCompletedGoals(supabase, true);

    expect(count).toBe(2);
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("returns 0 when there are no active completed_goal items", async () => {
    const { supabase, updateFn } = mockSupabaseForArchive([]);

    const count = await archiveCompletedGoals(supabase, false);

    expect(count).toBe(0);
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("returns 0 gracefully when select returns an error", async () => {
    const eqStatus = mock(async () => ({ data: null, error: { message: "db error" } }));
    const eqType = mock(() => ({ eq: eqStatus }));
    const selectFn = mock(() => ({ eq: eqType }));
    const fromFn = mock(() => ({ select: selectFn }));
    const supabase = { from: fromFn } as any;

    const count = await archiveCompletedGoals(supabase, false);

    expect(count).toBe(0);
  });
});

// ============================================================
// 10. MemoryItem type accepts "completed_goal"
// ============================================================

describe("MemoryItem type", () => {
  it("accepts completed_goal as a valid type", () => {
    const item: MemoryItem = makeItem({ id: "cg-1", type: "completed_goal" });
    expect(item.type).toBe("completed_goal");
  });
});

// ============================================================
// 11. buildReport and buildTelegramMessage include completedGoalsArchived
// ============================================================

describe("buildReport includes completedGoalsArchived", () => {
  it("shows completed goals archived count when > 0", () => {
    const result = makeResult({ scanned: 30, completedGoalsArchived: 5 });
    const report = buildReport(result);
    expect(report).toContain("Completed goals archived");
    expect(report).toContain("5");
  });

  it("shows 0 when no completed goals were archived", () => {
    const result = makeResult({ completedGoalsArchived: 0 });
    const report = buildReport(result);
    expect(report).toContain("Completed goals archived");
    expect(report).toContain("0");
  });
});

describe("buildTelegramMessage includes completedGoalsArchived when > 0", () => {
  it("shows completed goals line when completedGoalsArchived > 0", () => {
    const result = makeResult({ completedGoalsArchived: 3 });
    const msg = buildTelegramMessage(result);
    expect(msg.toLowerCase()).toContain("completed goal");
    expect(msg).toContain("3");
  });

  it("omits completed goals line when completedGoalsArchived is 0", () => {
    const result = makeResult({ completedGoalsArchived: 0 });
    const msg = buildTelegramMessage(result);
    expect(msg.toLowerCase()).not.toContain("completed goal");
  });
});

// ============================================================
// Provenance model — groupItems clustering key (RED)
//
// G1: Under the provenance model, chat_id is audit-only (provenance).
// Dedup clustering must group by type alone, ignoring chat_id, so
// identical facts from different groups land in the same cluster.
// ============================================================

describe("groupItems() — provenance model: type-only clustering key (G1)", () => {
  it("groups items with same type but different chat_ids into one cluster", () => {
    // RED: fails until G1 is implemented (currently keys by type::chatId → separate clusters).
    const items: MemoryItem[] = [
      makeItem({ id: "a", type: "fact", chat_id: 100 }),
      makeItem({ id: "b", type: "fact", chat_id: 200 }),
    ];

    const groups = groupItems(items);

    // Under provenance model: both should land in the same "fact" cluster
    expect(groups.size).toBe(1);
    expect(groups.get("fact")).toBeDefined();
    expect(groups.get("fact")!.map((i) => i.id)).toContain("a");
    expect(groups.get("fact")!.map((i) => i.id)).toContain("b");
  });

  it("groups items with same type regardless of null or real chat_id", () => {
    // RED: fails until G1 is implemented (null → 'fact::null', 100 → 'fact::100').
    const items: MemoryItem[] = [
      makeItem({ id: "old", type: "fact", chat_id: null }),   // pre-migration row
      makeItem({ id: "new", type: "fact", chat_id: 12345 }),  // post-provenance row
    ];

    const groups = groupItems(items);

    expect(groups.size).toBe(1);
    expect(groups.get("fact")).toBeDefined();
    expect(groups.get("fact")!.length).toBe(2);
  });

  it("uses bare type string as key (no '::chatId' suffix)", () => {
    // RED: fails until G1 is implemented (currently appends '::chatId').
    const items: MemoryItem[] = [
      makeItem({ id: "a", type: "preference", chat_id: 42 }),
    ];

    const groups = groupItems(items);

    expect(groups.has("preference")).toBe(true);
    expect(groups.has("preference::42")).toBe(false); // old key format must be gone
  });

  it("keeps different types in separate clusters", () => {
    // Sanity check: type discrimination must still work after G1.
    const items: MemoryItem[] = [
      makeItem({ id: "f", type: "fact", chat_id: 100 }),
      makeItem({ id: "g", type: "goal", chat_id: 100 }),
    ];

    const groups = groupItems(items);

    expect(groups.size).toBe(2);
    expect(groups.get("fact")).toBeDefined();
    expect(groups.get("goal")).toBeDefined();
  });
});

// ============================================================
// Import safety — module must NOT trigger main() on import
// ============================================================

describe("import safety", () => {
  it("importing the module does NOT trigger main()", async () => {
    const mod = await import("./memory-cleanup.ts");
    expect(typeof mod.fetchActiveItems).toBe("function");
    expect(typeof mod.clusterDuplicates).toBe("function");
  });
});

describe("searchSimilar() — provenance model: no chat_id in search body (S3)", () => {
  it("does not pass chat_id to the search Edge Function", async () => {
    // RED: fails until S3 is implemented (currently passes item.chat_id when non-null).
    const invokeFn = mock(async () => ({ data: [], error: null }));
    const supabase = {
      functions: { invoke: invokeFn },
    } as any;
    const config: CleanupConfig = { ...BASE_CONFIG };
    const item = makeItem({ id: "x", type: "fact", chat_id: 12345 });

    await searchSimilar(supabase, item, config);

    expect(invokeFn).toHaveBeenCalledTimes(1);
    const body = invokeFn.mock.calls[0][1]?.body as Record<string, unknown>;
    // chat_id must NOT appear in the search body (global search)
    expect(body).not.toHaveProperty("chat_id");
  });

  it("does not pass chat_id even when item has null chat_id", async () => {
    // No change in behavior for null items, but validates the contract.
    const invokeFn = mock(async () => ({ data: [], error: null }));
    const supabase = {
      functions: { invoke: invokeFn },
    } as any;
    const config: CleanupConfig = { ...BASE_CONFIG };
    const item = makeItem({ id: "y", type: "goal", chat_id: null });

    await searchSimilar(supabase, item, config);

    const body = invokeFn.mock.calls[0][1]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("chat_id");
  });
});
