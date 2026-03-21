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

// ── Mock storageBackend so tests don't hit SQLite/Qdrant/Ollama ────────────

const mockSemanticSearchMemory = mock(async () => []);
const mockInsertMemoryRecord = mock(async () => ({ id: "test-id", error: null }));

mock.module("../local/storageBackend", () => ({
  semanticSearchMemory: mockSemanticSearchMemory,
  insertMemoryRecord: mockInsertMemoryRecord,
  getExistingMemories: mock(async () => []),
  insertMessageRecord: mock(async () => {}),
}));

import {
  checkSemanticDuplicate,
  type DuplicateCheckResult,
} from "../utils/semanticDuplicateChecker.ts";

// ============================================================
// Shared helpers
// ============================================================

const CHAT_ID = 77001;

// ============================================================
// 1. checkSemanticDuplicate — unit tests
// ============================================================

describe("checkSemanticDuplicate", () => {
  beforeEach(() => {
    mockSemanticSearchMemory.mockReset();
  });

  it("returns isDuplicate=true when search finds match above threshold", async () => {
    mockSemanticSearchMemory.mockResolvedValue([
      { id: "abc", content: "Buy groceries weekly", type: "goal", similarity: 0.92 },
    ]);

    const result = await checkSemanticDuplicate("Buy groceries every week", "goal", CHAT_ID);

    expect(result.isDuplicate).toBe(true);
    expect(result.match).toBeDefined();
    expect(result.match!.id).toBe("abc");
    expect(result.match!.content).toBe("Buy groceries weekly");
    expect(result.match!.similarity).toBe(0.92);
  });

  it("returns isDuplicate=false when search returns empty results", async () => {
    mockSemanticSearchMemory.mockResolvedValue([]);

    const result = await checkSemanticDuplicate("A brand new fact", "fact", CHAT_ID);

    expect(result.isDuplicate).toBe(false);
    expect(result.match).toBeUndefined();
  });

  it("returns isDuplicate=false when search throws (graceful degradation)", async () => {
    mockSemanticSearchMemory.mockRejectedValue(new Error("Search unavailable"));

    const result = await checkSemanticDuplicate("test content", "fact", CHAT_ID);

    expect(result.isDuplicate).toBe(false);
    expect(result.match).toBeUndefined();
  });

  it("post-filters results by type — same content different type is NOT a duplicate", async () => {
    mockSemanticSearchMemory.mockResolvedValue([
      { id: "x1", content: "Learn Rust", type: "goal", similarity: 0.95 },
    ]);

    // Searching as type "fact" — the match is type "goal", so it should NOT be a duplicate
    const result = await checkSemanticDuplicate("Learn Rust", "fact", CHAT_ID);

    expect(result.isDuplicate).toBe(false);
  });

  it("matches when type matches among multiple results", async () => {
    mockSemanticSearchMemory.mockResolvedValue([
      { id: "x1", content: "Learn Rust", type: "goal", similarity: 0.95 },
      { id: "x2", content: "User is learning Rust", type: "fact", similarity: 0.88 },
    ]);

    const result = await checkSemanticDuplicate("User studies Rust", "fact", CHAT_ID);

    expect(result.isDuplicate).toBe(true);
    expect(result.match!.id).toBe("x2");
    expect(result.match!.similarity).toBe(0.88);
  });

  it("uses default threshold of 0.80", async () => {
    // Match at 0.79 — just below default threshold, should NOT be duplicate
    mockSemanticSearchMemory.mockResolvedValue([
      { id: "low", content: "somewhat similar", type: "fact", similarity: 0.79 },
    ]);

    const result = await checkSemanticDuplicate("test", "fact");

    expect(result.isDuplicate).toBe(false);
  });

  it("respects custom threshold", async () => {
    mockSemanticSearchMemory.mockResolvedValue([
      { id: "mid", content: "close match", type: "fact", similarity: 0.75 },
    ]);

    // With a lower threshold of 0.70, this should be a duplicate
    const result = await checkSemanticDuplicate("test", "fact", null, 0.70);

    expect(result.isDuplicate).toBe(true);
    expect(result.match!.similarity).toBe(0.75);
  });
});

// ============================================================
// 2. processMemoryIntents — dedup integration
// ============================================================

describe("processMemoryIntents with semantic dedup", () => {
  it("strips [REMEMBER:] tag but does NOT insert when duplicate found", async () => {
    const { processMemoryIntents } = await import("../memory.ts");

    mockSemanticSearchMemory.mockResolvedValue([
      { id: "dup1", content: "User likes coffee", type: "fact", similarity: 0.92 },
    ]);
    mockInsertMemoryRecord.mockClear();

    const response = "Got it [REMEMBER: User likes coffee]";
    const result = await processMemoryIntents(response, CHAT_ID);

    // Tag must always be stripped from user-visible response
    expect(result).not.toContain("[REMEMBER:");
    expect(result).toContain("Got it");
    // Insert should be skipped because duplicate was found
    expect(mockInsertMemoryRecord).not.toHaveBeenCalled();
  });

  it("inserts when no duplicate found", async () => {
    const { processMemoryIntents } = await import("../memory.ts");

    mockSemanticSearchMemory.mockResolvedValue([]);
    mockInsertMemoryRecord.mockClear();

    const response = "Noted [REMEMBER: User works at GovTech]";
    const result = await processMemoryIntents(response, CHAT_ID);

    expect(result).not.toContain("[REMEMBER:");
    expect(mockInsertMemoryRecord).toHaveBeenCalled();
    const inserted = mockInsertMemoryRecord.mock.calls[0][0] as any;
    expect(inserted.content).toBe("User works at GovTech");
    expect(inserted.type).toBe("fact");
  });

  it("strips [GOAL:] tag but does NOT insert when goal duplicate found", async () => {
    const { processMemoryIntents } = await import("../memory.ts");

    mockSemanticSearchMemory.mockResolvedValue([
      { id: "dup-goal", content: "Ship API v2", type: "goal", similarity: 0.90 },
    ]);
    mockInsertMemoryRecord.mockClear();

    const response = "Let's do it [GOAL: Ship API v2 soon]";
    const result = await processMemoryIntents(response, CHAT_ID);

    expect(result).not.toContain("[GOAL:");
    expect(result).toContain("Let's do it");
    expect(mockInsertMemoryRecord).not.toHaveBeenCalled();
  });

  it("still strips tags even when search throws", async () => {
    const { processMemoryIntents } = await import("../memory.ts");

    mockSemanticSearchMemory.mockRejectedValue(new Error("Search down"));
    mockInsertMemoryRecord.mockClear();

    const response = "OK [REMEMBER: Test fact] and [GOAL: Test goal]";
    const result = await processMemoryIntents(response, CHAT_ID);

    // Tags must be stripped regardless of dedup errors
    expect(result).not.toContain("[REMEMBER:");
    expect(result).not.toContain("[GOAL:");
    // Fail-open: inserts should still happen since dedup returned false
    expect(mockInsertMemoryRecord).toHaveBeenCalled();
  });
});

// ============================================================
// 3. /remember command — dedup integration
// ============================================================

describe("/remember with semantic dedup", () => {
  it("detects duplicate when similar memory exists", async () => {
    mockSemanticSearchMemory.mockResolvedValue([
      { id: "existing", content: "User works at GovTech Singapore", type: "fact", similarity: 0.91 },
    ]);

    const fact = "Works at GovTech";
    const dupResult = await checkSemanticDuplicate(fact, "fact", CHAT_ID);

    expect(dupResult.isDuplicate).toBe(true);
    expect(dupResult.match!.content).toContain("GovTech");
  });

  it("allows insert when no duplicate found", async () => {
    mockSemanticSearchMemory.mockResolvedValue([]);

    const fact = "User lives in a completely unique place";
    const dupResult = await checkSemanticDuplicate(fact, "fact", CHAT_ID);

    expect(dupResult.isDuplicate).toBe(false);
  });
});

// ============================================================
// 4. storeExtractedMemories — dedup integration
// ============================================================

describe("storeExtractedMemories with semantic dedup", () => {
  it("skips duplicates and only allows non-duplicate items", async () => {
    // "User likes coffee" is a duplicate, others are not
    mockSemanticSearchMemory.mockImplementation(async (query: string) => {
      if (query.includes("likes coffee")) {
        return [{ id: "dup", content: "User enjoys coffee", type: "fact", similarity: 0.93 }];
      }
      return [];
    });

    const items = [
      { content: "User likes coffee", type: "fact" },
      { content: "User works at GovTech", type: "fact" },
      { content: "Learn Kubernetes", type: "goal" },
    ];

    const nonDuplicates: typeof items = [];
    for (const item of items) {
      const result = await checkSemanticDuplicate(item.content, item.type, CHAT_ID);
      if (!result.isDuplicate) {
        nonDuplicates.push(item);
      }
    }

    expect(nonDuplicates).toHaveLength(2);
    expect(nonDuplicates[0].content).toBe("User works at GovTech");
    expect(nonDuplicates[1].content).toBe("Learn Kubernetes");
  });

  it("allows all items when no duplicates found", async () => {
    mockSemanticSearchMemory.mockResolvedValue([]);

    const items = [
      { content: "Fact A", type: "fact" },
      { content: "Fact B", type: "fact" },
      { content: "Goal C", type: "goal" },
    ];

    const nonDuplicates: typeof items = [];
    for (const item of items) {
      const result = await checkSemanticDuplicate(item.content, item.type, CHAT_ID);
      if (!result.isDuplicate) {
        nonDuplicates.push(item);
      }
    }

    expect(nonDuplicates).toHaveLength(3);
  });

  it("allows all items when search is unavailable (fail-open)", async () => {
    mockSemanticSearchMemory.mockRejectedValue(new Error("Network error"));

    const items = [
      { content: "Fact X", type: "fact" },
      { content: "Goal Y", type: "goal" },
    ];

    const nonDuplicates: typeof items = [];
    for (const item of items) {
      const result = await checkSemanticDuplicate(item.content, item.type, CHAT_ID);
      if (!result.isDuplicate) {
        nonDuplicates.push(item);
      }
    }

    // Fail-open: all items should pass through
    expect(nonDuplicates).toHaveLength(2);
  });
});
