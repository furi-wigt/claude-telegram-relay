/**
 * Unit tests for routines/memory-dedup-review.ts
 *
 * Run: bun test routines/memory-dedup-review.test.ts
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import {
  detectJunkItems,
  collectCandidateIds,
  buildConfirmationMessage,
  savePendingCandidates,
  loadPendingCandidates,
  clearPendingCandidates,
  type PendingDedup,
} from "./memory-dedup-review.ts";
import type { MemoryItem, DuplicateCluster } from "./memory-cleanup.ts";

// ============================================================
// Helpers
// ============================================================

function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: crypto.randomUUID(),
    content: "User works at GovTech Singapore",
    type: "fact",
    created_at: "2024-01-01T00:00:00Z",
    confidence: 0.9,
    chat_id: null,
    ...overrides,
  };
}

function makeCluster(
  keeper: MemoryItem,
  dups: Array<{ item: MemoryItem; similarity: number }>
): DuplicateCluster {
  return { keeper, duplicates: dups };
}

const TEST_FILE = "/tmp/test-pending-dedup.json";

// ============================================================
// detectJunkItems
// ============================================================

describe("detectJunkItems", () => {
  it("flags items with content shorter than minLength", () => {
    const items = [
      makeItem({ content: "short" }), // 5 chars < 10
      makeItem({ content: "This is a valid fact with enough detail" }),
    ];
    const junk = detectJunkItems(items, 10);
    expect(junk).toHaveLength(1);
    expect(junk[0].content).toBe("short");
  });

  it("flags noise pattern: bare 'fact'", () => {
    const items = [makeItem({ content: "fact" })];
    expect(detectJunkItems(items)).toHaveLength(1);
  });

  it("flags noise pattern: 'fact to store'", () => {
    const items = [makeItem({ content: "fact to store" })];
    expect(detectJunkItems(items)).toHaveLength(1);
  });

  it("flags noise pattern: 'age: not specified' (case-insensitive)", () => {
    const items = [makeItem({ content: "Age: Not specified" })];
    expect(detectJunkItems(items)).toHaveLength(1);
  });

  it("flags noise pattern: 'unknown' (case-insensitive)", () => {
    const items = [makeItem({ content: "Unknown" })];
    expect(detectJunkItems(items)).toHaveLength(1);
  });

  it("flags noise pattern: 'not specified'", () => {
    const items = [makeItem({ content: "Not specified" })];
    expect(detectJunkItems(items)).toHaveLength(1);
  });

  it("flags items that are only whitespace", () => {
    const items = [makeItem({ content: "   " })];
    expect(detectJunkItems(items)).toHaveLength(1);
  });

  it("does not flag legitimate items", () => {
    const items = [
      makeItem({ content: "User prefers dark mode in development tools" }),
      makeItem({ content: "Works at GovTech as a Solution Architect" }),
      makeItem({ content: "Goal: Complete TRO PCM by March 2026" }),
    ];
    expect(detectJunkItems(items)).toHaveLength(0);
  });

  it("uses default minLength of 10", () => {
    const items = [makeItem({ content: "123456789" })]; // 9 chars < 10
    expect(detectJunkItems(items)).toHaveLength(1);
  });

  it("does not flag item with exactly minLength characters", () => {
    const items = [makeItem({ content: "1234567890" })]; // exactly 10 chars, no pattern match
    expect(detectJunkItems(items)).toHaveLength(0);
  });

  it("handles empty input", () => {
    expect(detectJunkItems([])).toHaveLength(0);
  });

  it("flags multiple junk items in one pass", () => {
    const items = [
      makeItem({ content: "fact" }),
      makeItem({ content: "hi" }),
      makeItem({ content: "This is a valid item with sufficient length" }),
      makeItem({ content: "unknown" }),
    ];
    expect(detectJunkItems(items)).toHaveLength(3);
  });
});

// ============================================================
// collectCandidateIds
// ============================================================

describe("collectCandidateIds", () => {
  it("collects IDs from junk items", () => {
    const junk = [makeItem({ id: "junk-1" }), makeItem({ id: "junk-2" })];
    const ids = collectCandidateIds(junk, []);
    expect(ids).toContain("junk-1");
    expect(ids).toContain("junk-2");
    expect(ids).toHaveLength(2);
  });

  it("collects duplicate IDs from clusters (not the keeper)", () => {
    const keeper = makeItem({ id: "keeper-1" });
    const dup1 = makeItem({ id: "dup-1" });
    const dup2 = makeItem({ id: "dup-2" });
    const clusters = [makeCluster(keeper, [
      { item: dup1, similarity: 0.95 },
      { item: dup2, similarity: 0.87 },
    ])];
    const ids = collectCandidateIds([], clusters);
    expect(ids).toContain("dup-1");
    expect(ids).toContain("dup-2");
    expect(ids).not.toContain("keeper-1");
  });

  it("does not include keeper IDs from clusters", () => {
    const keeper = makeItem({ id: "keeper-1" });
    const dup = makeItem({ id: "dup-1" });
    const clusters = [makeCluster(keeper, [{ item: dup, similarity: 0.9 }])];
    const ids = collectCandidateIds([], clusters);
    expect(ids).not.toContain("keeper-1");
  });

  it("deduplicates if the same item appears as junk and duplicate", () => {
    const shared = makeItem({ id: "shared-1" });
    const clusters = [
      makeCluster(makeItem({ id: "keeper-1" }), [{ item: shared, similarity: 0.9 }]),
    ];
    const ids = collectCandidateIds([shared], clusters);
    const count = ids.filter((id) => id === "shared-1").length;
    expect(count).toBe(1);
  });

  it("combines junk and duplicate IDs together", () => {
    const junk = [makeItem({ id: "junk-1" })];
    const dup = makeItem({ id: "dup-1" });
    const clusters = [makeCluster(makeItem({ id: "k-1" }), [{ item: dup, similarity: 0.9 }])];
    const ids = collectCandidateIds(junk, clusters);
    expect(ids).toContain("junk-1");
    expect(ids).toContain("dup-1");
    expect(ids).toHaveLength(2);
  });

  it("returns empty array when nothing to delete", () => {
    expect(collectCandidateIds([], [])).toHaveLength(0);
  });
});

// ============================================================
// buildConfirmationMessage
// ============================================================

describe("buildConfirmationMessage", () => {
  it("returns a non-empty string", () => {
    const msg = buildConfirmationMessage([], []);
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
  });

  it("indicates no candidates when lists are empty", () => {
    const msg = buildConfirmationMessage([], []);
    expect(msg).toContain("clean");
  });

  it("shows junk count when present", () => {
    const junk = [makeItem({ content: "fact" })];
    const msg = buildConfirmationMessage(junk, []);
    expect(msg).toContain("1 junk");
  });

  it("shows near-duplicate count when present", () => {
    const clusters = [
      makeCluster(makeItem({ id: "k-1" }), [
        { item: makeItem({ id: "d-1" }), similarity: 0.93 },
      ]),
    ];
    const msg = buildConfirmationMessage([], clusters);
    expect(msg).toContain("1 near-duplicate");
  });

  it("shows total items count when both junk and dups present", () => {
    const junk = [makeItem({ content: "fact" }), makeItem({ content: "test" })];
    const clusters = [
      makeCluster(makeItem({ id: "k-1" }), [
        { item: makeItem({ id: "d-1" }), similarity: 0.9 },
      ]),
    ];
    const msg = buildConfirmationMessage(junk, clusters);
    // 2 junk + 1 dup = 3 total
    expect(msg).toContain("3");
  });

  it("includes a snippet of junk items", () => {
    const junk = [makeItem({ content: "fact to store" })];
    const msg = buildConfirmationMessage(junk, []);
    expect(msg).toContain("fact to store");
  });

  it("includes near-duplicate snippet with similarity score", () => {
    const clusters = [
      makeCluster(
        makeItem({ content: "GovTech Solution Architect", id: "k-1" }),
        [{ item: makeItem({ content: "Solution Architect at GovTech", id: "d-1" }), similarity: 0.91 }]
      ),
    ];
    const msg = buildConfirmationMessage([], clusters);
    expect(msg).toContain("Solution Architect at GovTech");
    expect(msg).toContain("0.91");
  });

  it("includes a call-to-action asking for confirmation", () => {
    const junk = [makeItem({ content: "fact" })];
    const msg = buildConfirmationMessage(junk, []);
    // Should mention confirm/skip action
    expect(msg.toLowerCase()).toMatch(/confirm|skip/i);
  });

  it("pluralises 'junk items' correctly", () => {
    const junk = [
      makeItem({ content: "fact" }),
      makeItem({ content: "test" }),
    ];
    const msg = buildConfirmationMessage(junk, []);
    expect(msg).toContain("2 junk items");
  });

  it("uses singular 'junk item' for exactly 1", () => {
    const junk = [makeItem({ content: "fact" })];
    const msg = buildConfirmationMessage(junk, []);
    expect(msg).toContain("1 junk item");
    expect(msg).not.toContain("1 junk items");
  });
});

// ============================================================
// Pending state: savePendingCandidates / loadPendingCandidates / clearPendingCandidates
// ============================================================

// ============================================================
// Import safety — module must NOT trigger main() on import
// ============================================================

describe("import safety", () => {
  it("importing the module does NOT trigger main()", async () => {
    const mod = await import("./memory-dedup-review.ts");
    expect(typeof mod.loadPendingCandidates).toBe("function");
    expect(typeof mod.clearPendingCandidates).toBe("function");
  });
});

describe("pendingCandidates (file I/O)", () => {
  afterEach(async () => {
    await clearPendingCandidates(TEST_FILE);
  });

  it("loadPendingCandidates returns null when file does not exist", async () => {
    const result = await loadPendingCandidates("/tmp/nonexistent-dedup-review-xyz.json");
    expect(result).toBeNull();
  });

  it("saves and loads candidates correctly", async () => {
    const ids = ["uuid-1", "uuid-2", "uuid-3"];
    const summary = "2 junk items, 1 near-duplicate";

    await savePendingCandidates(ids, summary, TEST_FILE);
    const loaded = await loadPendingCandidates(TEST_FILE);

    expect(loaded).not.toBeNull();
    expect(loaded!.ids).toEqual(ids);
    expect(loaded!.count).toBe(3);
    expect(loaded!.summary).toBe(summary);
  });

  it("saved entry has a future expiresAt", async () => {
    await savePendingCandidates(["id-1"], "test", TEST_FILE);
    const loaded = await loadPendingCandidates(TEST_FILE);
    const expiresAt = new Date(loaded!.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it("loadPendingCandidates returns null for expired entries", async () => {
    const past = new Date(Date.now() - 1000).toISOString(); // already expired
    const data: PendingDedup = {
      ids: ["id-1"],
      count: 1,
      expiresAt: past,
      summary: "expired",
    };
    await mkdir("/tmp", { recursive: true });
    await writeFile(TEST_FILE, JSON.stringify(data), "utf-8");

    const loaded = await loadPendingCandidates(TEST_FILE);
    expect(loaded).toBeNull();
  });

  it("clearPendingCandidates removes the file", async () => {
    await savePendingCandidates(["id-1"], "test", TEST_FILE);
    await clearPendingCandidates(TEST_FILE);
    const loaded = await loadPendingCandidates(TEST_FILE);
    expect(loaded).toBeNull();
  });

  it("clearPendingCandidates does not throw if file does not exist", async () => {
    await expect(
      clearPendingCandidates("/tmp/definitely-no-file-xyz.json")
    ).resolves.toBeUndefined();
  });

  it("overwriting an existing pending file replaces the old data", async () => {
    await savePendingCandidates(["old-id"], "old summary", TEST_FILE);
    await savePendingCandidates(["new-id-1", "new-id-2"], "new summary", TEST_FILE);
    const loaded = await loadPendingCandidates(TEST_FILE);
    expect(loaded!.ids).toEqual(["new-id-1", "new-id-2"]);
    expect(loaded!.summary).toBe("new summary");
  });
});
