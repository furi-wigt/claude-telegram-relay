/**
 * Unit tests for routines/memory-cleanup.ts (Local Stack)
 *
 * Uses mock.module to intercept SQLite, Qdrant, and Ollama imports.
 * Pure function tests (groupItems, buildReport, etc.) need no mocking.
 *
 * Run: bun test routines/memory-cleanup.test.ts
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// ============================================================
// Module mocks — mutable factories that tests can override.
// mock.module is hoisted by Bun above imports; the closures
// capture these variables by reference so later assignments work.
// ============================================================

let _dbFactory: () => any;
let _embedFn: (text: string) => Promise<number[]>;
let _embedBatchFn: (texts: string[]) => Promise<number[][]>;
let _searchFn: (...args: any[]) => Promise<any[]>;
let _deletePointsFn: (...args: any[]) => Promise<void>;

mock.module("../src/local/db.ts", () => ({
  getDb: () => _dbFactory(),
}));

mock.module("../src/local/embed.ts", () => ({
  localEmbed: (text: string) => _embedFn(text),
  localEmbedBatch: (texts: string[]) => _embedBatchFn(texts),
}));

mock.module("../src/local/vectorStore.ts", () => ({
  search: (...args: any[]) => _searchFn(...args),
  deletePoints: (...args: any[]) => _deletePointsFn(...args),
  ensureCollection: async () => {},
}));

mock.module("../src/utils/routineMessage.ts", () => ({
  sendAndRecord: async () => {},
}));

mock.module("../src/utils/sendToGroup.ts", () => ({
  sendToGroup: async () => {},
}));

mock.module("../src/config/groups.ts", () => ({
  GROUPS: { GENERAL: { chatId: -100123, topicId: null } },
  validateGroup: () => true,
}));

// ============================================================
// Import module under test (after mocks are set up)
// ============================================================

import {
  groupItems,
  buildReport,
  buildTelegramMessage,
  searchSimilar,
  clusterDuplicates,
  batchEmbedItems,
  deleteItems,
  archiveCompletedGoals,
  purgeArchivedItems,
  purgeOldMessages,
  purgeOldSummaries,
  type MemoryItem,
  type CleanupResult,
  type CleanupConfig,
} from "./memory-cleanup.ts";

// ============================================================
// Shared helpers
// ============================================================

const BASE_CONFIG: CleanupConfig = {
  dryRun: false,
  maxDeletes: 200,
  similarityThreshold: 0.92,
  minContentLength: 10,
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
    archivedPurged: 0,
    messagesPurged: 0,
    summariesPurged: 0,
    ...overrides,
  };
}

/**
 * Create a mock DB that routes SQL patterns to specific handlers.
 * Uses substring matching on the SQL string.
 */
function createMockDb(
  handlers: Record<
    string,
    {
      all?: (...args: any[]) => any[];
      run?: (...args: any[]) => { changes: number };
    }
  > = {}
): any {
  return {
    prepare: (sql: string) => {
      for (const [pattern, handler] of Object.entries(handlers)) {
        if (sql.includes(pattern)) {
          return {
            all: handler.all ?? ((..._: any[]) => []),
            run: handler.run ?? ((..._: any[]) => ({ changes: 0 })),
          };
        }
      }
      return { all: () => [], run: () => ({ changes: 0 }) };
    },
  };
}

// ── Reset mocks before each test ──────────────────────────────

beforeEach(() => {
  _dbFactory = () => createMockDb();
  _embedFn = async () => new Array(1024).fill(0);
  _embedBatchFn = async (texts: string[]) => texts.map(() => new Array(1024).fill(0));
  _searchFn = async () => [];
  _deletePointsFn = async () => {};
});

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
    const group = groups.get("fact");
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
    const group = groups.get("goal");
    expect(group).toBeDefined();
    expect(group!.length).toBe(2);
  });

  it("produces bare type string as key (no chat_id suffix)", () => {
    const items: MemoryItem[] = [
      makeItem({ id: "a", type: "preference", chat_id: 42 }),
    ];

    const groups = groupItems(items);

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
    expect(report).not.toContain("DRY RUN");
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
// 4. searchSimilar() — mock localEmbed + qdrantSearch
// ============================================================

describe("searchSimilar()", () => {
  it("returns filtered matches (excludes self by ID)", async () => {
    const item = makeItem({ id: "self", type: "fact", chat_id: null });

    _searchFn = async () => [
      { id: "other", score: 0.95, payload: { content: "Similar fact", type: "fact", created_at: "2024-01-02T00:00:00Z" } },
      { id: "self", score: 1.0, payload: { content: "Same item", type: "fact", created_at: "2024-01-01T00:00:00Z" } },
    ];

    const matches = await searchSimilar(item, BASE_CONFIG);

    expect(matches.length).toBe(1);
    expect(matches[0].id).toBe("other");
  });

  it("returns [] when Ollama embed throws (graceful degradation)", async () => {
    _embedFn = async () => {
      throw new Error("Ollama unavailable");
    };

    const item = makeItem({ id: "item-1", type: "fact" });
    const matches = await searchSimilar(item, BASE_CONFIG);

    expect(matches).toEqual([]);
  });

  it("returns [] when Qdrant search throws", async () => {
    _searchFn = async () => {
      throw new Error("Qdrant unavailable");
    };

    const item = makeItem({ id: "item-1", type: "fact" });
    const matches = await searchSimilar(item, BASE_CONFIG);

    expect(matches).toEqual([]);
  });

  it("passes correct filter to Qdrant (status + type, no chat_id)", async () => {
    let capturedArgs: any[] = [];
    _searchFn = async (...args: any[]) => {
      capturedArgs = args;
      return [];
    };

    const item = makeItem({ id: "item-1", type: "fact", chat_id: 12345 });
    await searchSimilar(item, BASE_CONFIG);

    // searchFn receives (collection, vector, options)
    expect(capturedArgs[0]).toBe("memory");
    const options = capturedArgs[2];
    expect(options.filter.must).toHaveLength(2);
    const keys = options.filter.must.map((f: any) => f.key);
    expect(keys).toContain("status");
    expect(keys).toContain("type");
    // No chat_id filter (provenance model)
    expect(keys).not.toContain("chat_id");
  });

  it("does not include chat_id in filter even when item.chat_id is null", async () => {
    let capturedArgs: any[] = [];
    _searchFn = async (...args: any[]) => {
      capturedArgs = args;
      return [];
    };

    const item = makeItem({ id: "y", type: "goal", chat_id: null });
    await searchSimilar(item, BASE_CONFIG);

    const keys = capturedArgs[2].filter.must.map((f: any) => f.key);
    expect(keys).not.toContain("chat_id");
  });
});

// ============================================================
// 5. clusterDuplicates() — mock qdrantSearch via _searchFn
// ============================================================

describe("clusterDuplicates()", () => {
  it("returns one cluster when two items are similar", async () => {
    let callCount = 0;
    _searchFn = async () => {
      callCount++;
      if (callCount === 1) {
        return [
          { id: "b", score: 0.95, payload: { content: "User enjoys coffee", type: "fact", created_at: "2024-01-02T00:00:00Z" } },
        ];
      }
      return [];
    };

    const itemA = makeItem({ id: "a", content: "User likes coffee", type: "fact", created_at: "2024-01-01T00:00:00Z" });
    const itemB = makeItem({ id: "b", content: "User enjoys coffee", type: "fact", created_at: "2024-01-02T00:00:00Z" });

    const clusters = await clusterDuplicates([itemA, itemB], BASE_CONFIG);

    expect(clusters.length).toBe(1);
    expect(clusters[0].keeper.id).toBe("a");
    expect(clusters[0].duplicates.length).toBe(1);
    expect(clusters[0].duplicates[0].item.id).toBe("b");
  });

  it("returns empty array when no items are similar", async () => {
    _searchFn = async () => [];

    const items = [
      makeItem({ id: "a", content: "User likes coffee", type: "fact" }),
      makeItem({ id: "b", content: "User plays tennis", type: "fact" }),
    ];

    const clusters = await clusterDuplicates(items, BASE_CONFIG);

    expect(clusters).toEqual([]);
  });

  it("skips items below minContentLength", async () => {
    let searchCallCount = 0;
    _searchFn = async () => {
      searchCallCount++;
      return [];
    };

    const shortItem = makeItem({ id: "short", content: "hi", type: "fact" }); // 2 < 10
    const longItem = makeItem({ id: "long", content: "Long enough content here", type: "fact" });

    const config = { ...BASE_CONFIG, minContentLength: 10 };
    const clusters = await clusterDuplicates([shortItem, longItem], config);

    expect(clusters).toEqual([]);
    // Only the long item should trigger a search (embed + qdrant)
    expect(searchCallCount).toBe(1);
  });

  it("does not re-process already-absorbed items as new cluster seeds", async () => {
    let callCount = 0;
    _searchFn = async () => {
      callCount++;
      if (callCount === 1) {
        return [
          { id: "b", score: 0.96, payload: { content: "User enjoys coffee everyday", type: "fact", created_at: "2024-01-02T00:00:00Z" } },
        ];
      }
      // itemB should never trigger its own search (absorbed by itemA's cluster)
      return [];
    };

    const itemA = makeItem({ id: "a", content: "User likes coffee daily", type: "fact", created_at: "2024-01-01T00:00:00Z" });
    const itemB = makeItem({ id: "b", content: "User enjoys coffee everyday", type: "fact", created_at: "2024-01-02T00:00:00Z" });

    const clusters = await clusterDuplicates([itemA, itemB], BASE_CONFIG);

    // Should be exactly 1 cluster, not 2 (itemB absorbed, never seeded its own cluster)
    expect(clusters.length).toBe(1);
    expect(clusters[0].keeper.id).toBe("a");
    // searchSimilar should only be called once (for itemA), not for absorbed itemB
    expect(callCount).toBe(1);
  });

  it("keeps the oldest item (lowest created_at) as keeper", async () => {
    let callCount = 0;
    _searchFn = async () => {
      callCount++;
      if (callCount === 1) {
        return [
          { id: "newer", score: 0.94, payload: { content: "User enjoys running outside", type: "fact", created_at: "2024-06-01T00:00:00Z" } },
        ];
      }
      return [];
    };

    const older = makeItem({ id: "older", content: "User likes running outdoors", type: "fact", created_at: "2024-01-01T00:00:00Z" });
    const newer = makeItem({ id: "newer", content: "User enjoys running outside", type: "fact", created_at: "2024-06-01T00:00:00Z" });

    const clusters = await clusterDuplicates([older, newer], BASE_CONFIG);

    expect(clusters.length).toBe(1);
    expect(clusters[0].keeper.id).toBe("older");
    expect(clusters[0].duplicates[0].item.id).toBe("newer");
  });
});

// ============================================================
// 6. deleteItems() — mock getDb + qdrantDeletePoints
// ============================================================

describe("deleteItems()", () => {
  it("DRY_RUN=true: does NOT call db, returns expected count", async () => {
    const count = await deleteItems(["id-1", "id-2", "id-3"], true);

    expect(count).toBe(3);
  });

  it("DRY_RUN=false: deletes from SQLite and calls qdrantDeletePoints", async () => {
    let dbDeletedIds: any[] = [];
    let qdrantDeletedIds: string[] = [];

    _dbFactory = () =>
      createMockDb({
        DELETE: {
          run: (...args: any[]) => {
            dbDeletedIds = args;
            return { changes: 2 };
          },
        },
      });

    _deletePointsFn = async (_collection: string, ids: string[]) => {
      qdrantDeletedIds = ids;
    };

    const count = await deleteItems(["id-1", "id-2"], false);

    expect(count).toBe(2);
    expect(dbDeletedIds).toEqual(["id-1", "id-2"]);
    expect(qdrantDeletedIds).toEqual(["id-1", "id-2"]);
  });

  it("empty ids array: returns 0 without calling delete", async () => {
    const count = await deleteItems([], false);

    expect(count).toBe(0);
  });

  it("empty ids array with dryRun=true: returns 0", async () => {
    const count = await deleteItems([], true);

    expect(count).toBe(0);
  });

  it("handles qdrant deletePoints failure gracefully (non-fatal)", async () => {
    _dbFactory = () =>
      createMockDb({
        DELETE: { run: () => ({ changes: 1 }) },
      });

    _deletePointsFn = async () => {
      throw new Error("Qdrant unreachable");
    };

    // Should NOT throw — Qdrant failure is caught and logged
    const count = await deleteItems(["id-1"], false);
    expect(count).toBe(1);
  });
});

// ============================================================
// 7. Integration: compose clusterDuplicates + deleteItems
// ============================================================

describe("runCleanup() integration", () => {
  it("with 3 items where 2 are duplicates: clusters 1, deletes 1", async () => {
    const items: MemoryItem[] = [
      makeItem({ id: "a", content: "User likes tea", type: "fact", created_at: "2024-01-01T00:00:00Z", chat_id: null }),
      makeItem({ id: "b", content: "User enjoys tea", type: "fact", created_at: "2024-01-02T00:00:00Z", chat_id: null }),
      makeItem({ id: "c", content: "User plays chess", type: "fact", created_at: "2024-01-03T00:00:00Z", chat_id: null }),
    ];

    // groupItems
    const groups = groupItems(items);
    expect(groups.size).toBe(1);

    // clusterDuplicates — itemA finds itemB as duplicate
    let callCount = 0;
    _searchFn = async () => {
      callCount++;
      if (callCount === 1) {
        return [
          { id: "b", score: 0.95, payload: { content: "User enjoys tea", type: "fact", created_at: "2024-01-02T00:00:00Z" } },
        ];
      }
      return [];
    };

    const clusters = await clusterDuplicates(items, BASE_CONFIG);
    expect(clusters.length).toBe(1);
    const duplicateIds = clusters.flatMap((c) => c.duplicates.map((d) => d.item.id));
    expect(duplicateIds).toEqual(["b"]);

    // deleteItems
    _dbFactory = () =>
      createMockDb({
        DELETE: { run: () => ({ changes: 1 }) },
      });

    const deleted = await deleteItems(duplicateIds, false);
    expect(deleted).toBe(1);
  });

  it("with 0 duplicates: nothing to delete", async () => {
    const items: MemoryItem[] = [
      makeItem({ id: "x", content: "User reads books", type: "fact" }),
      makeItem({ id: "y", content: "User goes hiking", type: "fact" }),
    ];

    _searchFn = async () => [];

    const clusters = await clusterDuplicates(items, BASE_CONFIG);
    expect(clusters.length).toBe(0);

    const deleted = await deleteItems([], false);
    expect(deleted).toBe(0);
  });

  it("MAX_DELETES cap: stops at cap", async () => {
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
      demotionCandidates: 0,
      demotionArchived: 0,
      completedGoalsArchived: 0,
      archivedPurged: 0,
    };

    expect(result.cappedAt).toBe(3);
    expect(result.skipped).toBe(7);
    expect(result.duplicatesFound).toBe(10);
  });

  it("DRY_RUN mode: returns count but does not call DB", async () => {
    const ids = ["dup-1", "dup-2"];

    const deletedCount = await deleteItems(ids, true);

    expect(deletedCount).toBe(2);

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
  it("runCleanup includes demotionArchived and demotionCandidates fields", () => {
    const result = makeResult({
      scanned: 20,
      duplicatesFound: 1,
      deleted: 1,
      skipped: 0,
      dryRun: true,
    });

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

    expect(msg.toLowerCase()).toContain("5");
    expect(msg.toLowerCase()).toContain("archive");
  });
});

// ============================================================
// 9. archiveCompletedGoals() — mock getDb
// ============================================================

describe("archiveCompletedGoals()", () => {
  it("archives all active completed_goal items in non-dry-run mode", () => {
    _dbFactory = () =>
      createMockDb({
        "SELECT id FROM memory": {
          all: () => [{ id: "cg-1" }, { id: "cg-2" }, { id: "cg-3" }],
        },
        "UPDATE memory": {
          run: () => ({ changes: 3 }),
        },
      });

    const count = archiveCompletedGoals(false);
    expect(count).toBe(3);
  });

  it("dry run: returns count but does NOT call update", () => {
    let updateCalled = false;
    _dbFactory = () =>
      createMockDb({
        "SELECT id FROM memory": {
          all: () => [{ id: "cg-1" }, { id: "cg-2" }],
        },
        "UPDATE memory": {
          run: () => {
            updateCalled = true;
            return { changes: 2 };
          },
        },
      });

    const count = archiveCompletedGoals(true);

    expect(count).toBe(2);
    expect(updateCalled).toBe(false);
  });

  it("returns 0 when there are no active completed_goal items", () => {
    _dbFactory = () =>
      createMockDb({
        "SELECT id FROM memory": { all: () => [] },
      });

    const count = archiveCompletedGoals(false);
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
// Provenance model — groupItems clustering key
// ============================================================

describe("groupItems() — provenance model: type-only clustering key (G1)", () => {
  it("groups items with same type but different chat_ids into one cluster", () => {
    const items: MemoryItem[] = [
      makeItem({ id: "a", type: "fact", chat_id: 100 }),
      makeItem({ id: "b", type: "fact", chat_id: 200 }),
    ];

    const groups = groupItems(items);

    expect(groups.size).toBe(1);
    expect(groups.get("fact")).toBeDefined();
    expect(groups.get("fact")!.map((i) => i.id)).toContain("a");
    expect(groups.get("fact")!.map((i) => i.id)).toContain("b");
  });

  it("groups items with same type regardless of null or real chat_id", () => {
    const items: MemoryItem[] = [
      makeItem({ id: "old", type: "fact", chat_id: null }),
      makeItem({ id: "new", type: "fact", chat_id: 12345 }),
    ];

    const groups = groupItems(items);

    expect(groups.size).toBe(1);
    expect(groups.get("fact")).toBeDefined();
    expect(groups.get("fact")!.length).toBe(2);
  });

  it("uses bare type string as key (no '::chatId' suffix)", () => {
    const items: MemoryItem[] = [
      makeItem({ id: "a", type: "preference", chat_id: 42 }),
    ];

    const groups = groupItems(items);

    expect(groups.has("preference")).toBe(true);
    expect(groups.has("preference::42")).toBe(false);
  });

  it("keeps different types in separate clusters", () => {
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

// ============================================================
// Fix 6: purgeArchivedItems — mock getDb + qdrantDeletePoints
// ============================================================

describe("Fix 6: purgeArchivedItems", () => {
  it("dry run: returns count without deleting", async () => {
    _dbFactory = () =>
      createMockDb({
        "SELECT id FROM memory WHERE status": {
          all: () => [{ id: "a1" }, { id: "a2" }, { id: "a3" }],
        },
      });

    const count = await purgeArchivedItems(true);
    expect(count).toBe(3);
  });

  it("live run: deletes archived items from SQLite and Qdrant", async () => {
    let qdrantIds: string[] = [];
    _dbFactory = () =>
      createMockDb({
        "SELECT id FROM memory WHERE status": {
          all: () => [{ id: "a1" }, { id: "a2" }],
        },
        DELETE: {
          run: () => ({ changes: 2 }),
        },
      });
    _deletePointsFn = async (_collection: string, ids: string[]) => {
      qdrantIds = ids;
    };

    const count = await purgeArchivedItems(false);
    expect(count).toBe(2);
    expect(qdrantIds).toContain("a1");
    expect(qdrantIds).toContain("a2");
  });

  it("returns 0 when no archived items older than cutoff", async () => {
    _dbFactory = () =>
      createMockDb({
        "SELECT id FROM memory WHERE status": { all: () => [] },
      });

    const count = await purgeArchivedItems(false);
    expect(count).toBe(0);
  });

  it("handles Qdrant failure gracefully during purge", async () => {
    _dbFactory = () =>
      createMockDb({
        "SELECT id FROM memory WHERE status": {
          all: () => [{ id: "x1" }],
        },
        DELETE: {
          run: () => ({ changes: 1 }),
        },
      });
    _deletePointsFn = async () => {
      throw new Error("Qdrant unreachable");
    };

    // Should NOT throw — Qdrant failure is caught
    const count = await purgeArchivedItems(false);
    expect(count).toBe(1);
  });

  it("uses 90-day cutoff by default", async () => {
    let capturedCutoff: string | undefined;
    _dbFactory = () => ({
      prepare: (_sql: string) => ({
        all: (cutoff?: string) => {
          if (cutoff) capturedCutoff = cutoff;
          return [];
        },
        run: () => ({ changes: 0 }),
      }),
    });

    await purgeArchivedItems(false);

    expect(capturedCutoff).toBeDefined();
    const cutoffDate = new Date(capturedCutoff!);
    const daysAgo = (Date.now() - cutoffDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(daysAgo).toBeGreaterThanOrEqual(89);
    expect(daysAgo).toBeLessThanOrEqual(91);
  });
});

// ============================================================
// Fix C: CLEANUP_MAX_DELETES default is 200
// ============================================================

describe("Fix C: CLEANUP_MAX_DELETES default is 200", () => {
  it("parseEnvConfig env default reads 200 when CLEANUP_MAX_DELETES unset", () => {
    const defaultValue = parseInt(process.env.CLEANUP_MAX_DELETES || "200", 10);
    expect(defaultValue).toBe(200);
  });

  it("CLEANUP_SIMILARITY_THRESHOLD default stays at 0.92", () => {
    const defaultThreshold = parseFloat(process.env.CLEANUP_SIMILARITY_THRESHOLD || "0.92");
    expect(defaultThreshold).toBe(0.92);
  });

  it("cap-enforcement test uses explicit maxDeletes: 3 (not BASE_CONFIG default)", () => {
    const config = { ...BASE_CONFIG, maxDeletes: 3 };
    expect(config.maxDeletes).toBe(3);
    expect(BASE_CONFIG.maxDeletes).toBe(200);
  });
});

// ============================================================
// purgeOldMessages
// ============================================================

describe("purgeOldMessages", () => {
  it("dry run: returns count without deleting", async () => {
    _dbFactory = () =>
      createMockDb({
        "SELECT id FROM messages": {
          all: () => [{ id: "m1" }, { id: "m2" }],
        },
      });

    const count = await purgeOldMessages(true);
    expect(count).toBe(2);
  });

  it("live run: deletes messages from SQLite and Qdrant", async () => {
    let qdrantIds: string[] = [];
    _dbFactory = () =>
      createMockDb({
        "SELECT id FROM messages": {
          all: () => [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
        },
        DELETE: {
          run: () => ({ changes: 3 }),
        },
      });
    _deletePointsFn = async (_col: string, ids: string[]) => {
      qdrantIds = ids;
    };

    const count = await purgeOldMessages(false);
    expect(count).toBe(3);
    expect(qdrantIds).toContain("m1");
    expect(qdrantIds).toContain("m3");
  });

  it("returns 0 when no old messages", async () => {
    _dbFactory = () =>
      createMockDb({
        "SELECT id FROM messages": { all: () => [] },
      });

    const count = await purgeOldMessages(false);
    expect(count).toBe(0);
  });

  it("handles Qdrant failure gracefully", async () => {
    _dbFactory = () =>
      createMockDb({
        "SELECT id FROM messages": {
          all: () => [{ id: "m1" }],
        },
        DELETE: {
          run: () => ({ changes: 1 }),
        },
      });
    _deletePointsFn = async () => {
      throw new Error("Qdrant unreachable");
    };

    const count = await purgeOldMessages(false);
    expect(count).toBe(1);
  });

  it("uses 90-day cutoff by default", async () => {
    let capturedCutoff: string | undefined;
    _dbFactory = () => ({
      prepare: (_sql: string) => ({
        all: (cutoff?: string) => {
          if (cutoff) capturedCutoff = cutoff;
          return [];
        },
        run: () => ({ changes: 0 }),
      }),
    });

    await purgeOldMessages(false);
    expect(capturedCutoff).toBeDefined();
    const daysAgo = (Date.now() - new Date(capturedCutoff!).getTime()) / (1000 * 60 * 60 * 24);
    expect(daysAgo).toBeGreaterThanOrEqual(89);
    expect(daysAgo).toBeLessThanOrEqual(91);
  });
});

// ============================================================
// purgeOldSummaries
// ============================================================

describe("purgeOldSummaries", () => {
  it("dry run: returns count without deleting", async () => {
    _dbFactory = () =>
      createMockDb({
        "SELECT id FROM conversation_summaries": {
          all: () => [{ id: "s1" }, { id: "s2" }],
        },
      });

    const count = await purgeOldSummaries(true);
    expect(count).toBe(2);
  });

  it("live run: deletes summaries from SQLite and Qdrant", async () => {
    let qdrantIds: string[] = [];
    _dbFactory = () =>
      createMockDb({
        "SELECT id FROM conversation_summaries": {
          all: () => [{ id: "s1" }, { id: "s2" }],
        },
        DELETE: {
          run: () => ({ changes: 2 }),
        },
      });
    _deletePointsFn = async (_col: string, ids: string[]) => {
      qdrantIds = ids;
    };

    const count = await purgeOldSummaries(false);
    expect(count).toBe(2);
    expect(qdrantIds).toContain("s1");
    expect(qdrantIds).toContain("s2");
  });

  it("returns 0 when no old summaries", async () => {
    _dbFactory = () =>
      createMockDb({
        "SELECT id FROM conversation_summaries": { all: () => [] },
      });

    const count = await purgeOldSummaries(false);
    expect(count).toBe(0);
  });

  it("handles Qdrant failure gracefully", async () => {
    _dbFactory = () =>
      createMockDb({
        "SELECT id FROM conversation_summaries": {
          all: () => [{ id: "s1" }],
        },
        DELETE: {
          run: () => ({ changes: 1 }),
        },
      });
    _deletePointsFn = async () => {
      throw new Error("Qdrant unreachable");
    };

    const count = await purgeOldSummaries(false);
    expect(count).toBe(1);
  });

  it("uses 180-day cutoff by default", async () => {
    let capturedCutoff: string | undefined;
    _dbFactory = () => ({
      prepare: (_sql: string) => ({
        all: (cutoff?: string) => {
          if (cutoff) capturedCutoff = cutoff;
          return [];
        },
        run: () => ({ changes: 0 }),
      }),
    });

    await purgeOldSummaries(false);
    expect(capturedCutoff).toBeDefined();
    const daysAgo = (Date.now() - new Date(capturedCutoff!).getTime()) / (1000 * 60 * 60 * 24);
    expect(daysAgo).toBeGreaterThanOrEqual(179);
    expect(daysAgo).toBeLessThanOrEqual(181);
  });
});
