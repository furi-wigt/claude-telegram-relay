/**
 * Tests for documentSearch — RRF fusion logic (pure function tests)
 *
 * Run: bun test src/rag/documentSearch.test.ts
 */

import { describe, test, expect } from "bun:test";
import { reciprocalRankFusion, type DocumentChunk } from "./documentSearch";

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeChunk(id: string, overrides?: Partial<DocumentChunk>): DocumentChunk {
  return {
    id,
    title: overrides?.title ?? "Doc",
    source: overrides?.source ?? "test",
    chunk_index: overrides?.chunk_index ?? 0,
    content: overrides?.content ?? `Content for ${id}`,
    metadata: overrides?.metadata ?? {},
    similarity: overrides?.similarity ?? 0,
    ...overrides,
  };
}

// ─── reciprocalRankFusion ───────────────────────────────────────────────────

describe("reciprocalRankFusion", () => {
  test("returns empty array for empty inputs", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[]])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  test("single list returns items in same order", () => {
    const list = [makeChunk("a"), makeChunk("b"), makeChunk("c")];
    const fused = reciprocalRankFusion([list]);
    expect(fused.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  test("document in both lists gets higher score than single-list document", () => {
    const vectorList = [makeChunk("shared"), makeChunk("vector-only")];
    const bm25List = [makeChunk("shared"), makeChunk("bm25-only")];

    const fused = reciprocalRankFusion([vectorList, bm25List]);

    // "shared" should be ranked first (appears in both)
    expect(fused[0].id).toBe("shared");

    // "shared" score should be higher than either single-signal result
    const sharedScore = fused.find((c) => c.id === "shared")!.similarity;
    const vectorOnlyScore = fused.find((c) => c.id === "vector-only")!.similarity;
    const bm25OnlyScore = fused.find((c) => c.id === "bm25-only")!.similarity;
    expect(sharedScore).toBeGreaterThan(vectorOnlyScore);
    expect(sharedScore).toBeGreaterThan(bm25OnlyScore);
  });

  test("false positive demoted: irrelevant doc in vector-only is outranked by dual-signal", () => {
    // Simulates the BCP query scenario:
    // - "bcp-doc" appears in both vector and BM25 (relevant)
    // - "blackboard-doc" appears in vector only (false positive, no lexical match)
    const vectorList = [
      makeChunk("blackboard-doc", { title: "Constrained Mesh Blackboard" }),
      makeChunk("bcp-doc", { title: "Business Continuity Plan" }),
    ];
    const bm25List = [
      makeChunk("bcp-doc", { title: "Business Continuity Plan" }),
    ];

    const fused = reciprocalRankFusion([vectorList, bm25List]);

    // BCP doc should rank higher than blackboard doc
    const bcpRank = fused.findIndex((c) => c.id === "bcp-doc");
    const blackboardRank = fused.findIndex((c) => c.id === "blackboard-doc");
    expect(bcpRank).toBeLessThan(blackboardRank);
  });

  test("k parameter affects score distribution", () => {
    const list = [makeChunk("a"), makeChunk("b")];

    const k1 = reciprocalRankFusion([list], 1);
    const k60 = reciprocalRankFusion([list], 60);

    // With small k, rank difference matters more
    const k1Diff = k1[0].similarity - k1[1].similarity;
    const k60Diff = k60[0].similarity - k60[1].similarity;
    expect(k1Diff).toBeGreaterThan(k60Diff);
  });

  test("preserves chunk data (title, content, metadata)", () => {
    const chunk = makeChunk("test", {
      title: "My Title",
      content: "My Content",
      metadata: { key: "value" },
      chunk_index: 3,
    });
    const fused = reciprocalRankFusion([[chunk]]);
    expect(fused[0].title).toBe("My Title");
    expect(fused[0].content).toBe("My Content");
    expect(fused[0].metadata).toEqual({ key: "value" });
    expect(fused[0].chunk_index).toBe(3);
  });

  test("deduplicates by id across lists", () => {
    const vectorList = [makeChunk("dup"), makeChunk("a")];
    const bm25List = [makeChunk("dup"), makeChunk("b")];

    const fused = reciprocalRankFusion([vectorList, bm25List]);

    // Should have 3 unique results, not 4
    expect(fused).toHaveLength(3);
    const ids = fused.map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
  });

  test("works with three result lists", () => {
    const list1 = [makeChunk("a"), makeChunk("b")];
    const list2 = [makeChunk("b"), makeChunk("c")];
    const list3 = [makeChunk("a"), makeChunk("c")];

    const fused = reciprocalRankFusion([list1, list2, list3]);

    // "a" appears in list1 and list3, "b" in list1 and list2, "c" in list2 and list3
    // All should have equal RRF scores (same rank positions across 2 lists each)
    expect(fused).toHaveLength(3);
  });

  test("similarity field is set to RRF score", () => {
    const list = [makeChunk("a")];
    const fused = reciprocalRankFusion([list], 60);

    // Single item at rank 0: RRF score = 1/(60 + 0 + 1) = 1/61
    expect(fused[0].similarity).toBeCloseTo(1 / 61, 6);
  });
});
