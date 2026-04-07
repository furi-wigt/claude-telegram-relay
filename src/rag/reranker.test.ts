/**
 * Tests for reranker — LLM re-ranking of document chunks
 *
 * Run: bun test src/rag/reranker.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { DocumentChunk } from "./documentSearch";

// ─── Mock ModelRegistry ──────────────────────────────────────────────────────

let mockChatResponse = "8\n3\n9";

const mockChat = mock(async () => mockChatResponse);

mock.module("../models/index.ts", () => ({
  getRegistry: () => ({
    chat: mockChat,
  }),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

const { rerankChunks } = await import("./reranker.ts");

// ─── Helper ──────────────────────────────────────────────────────────────────

function makeChunk(id: string, title: string, content: string): DocumentChunk {
  return {
    id,
    title,
    source: "test",
    chunk_index: 0,
    content,
    metadata: {},
    similarity: 0.5,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("rerankChunks", () => {
  beforeEach(() => {
    mockChat.mockClear();
    mockChatResponse = "8\n3\n9";
  });

  test("filters out low-scoring chunks (below minScore)", async () => {
    const chunks = [
      makeChunk("high", "BCP", "Business continuity plan for EDEN"),
      makeChunk("low", "Mesh", "Constrained mesh blackboard architecture"),
      makeChunk("top", "DR", "Disaster recovery procedures"),
    ];

    const result = await rerankChunks("BCP for EDEN", chunks, 5);

    // Score "3" for "low" chunk is below minScore=5, should be filtered
    expect(result.length).toBe(2);
    const ids = result.map((c) => c.id);
    expect(ids).toContain("high");
    expect(ids).toContain("top");
    expect(ids).not.toContain("low");
  });

  test("sorts by score descending", async () => {
    mockChatResponse = "6\n9\n3";
    const chunks = [
      makeChunk("a", "A", "Content A"),
      makeChunk("b", "B", "Content B"),
      makeChunk("c", "C", "Content C"),
    ];

    const result = await rerankChunks("query", chunks, 5);

    // b=9, a=6 (c=3 filtered)
    expect(result[0].id).toBe("b");
    expect(result[1].id).toBe("a");
  });

  test("normalizes scores to 0-1 range", async () => {
    mockChatResponse = "8\n6\n10";
    const chunks = [
      makeChunk("a", "A", "Content A"),
      makeChunk("b", "B", "Content B"),
      makeChunk("c", "C", "Content C"),
    ];

    const result = await rerankChunks("query", chunks, 5);

    for (const chunk of result) {
      expect(chunk.similarity).toBeGreaterThanOrEqual(0);
      expect(chunk.similarity).toBeLessThanOrEqual(1);
    }
    // Score 10 → similarity 1.0
    const topChunk = result.find((c) => c.id === "c");
    expect(topChunk?.similarity).toBe(1.0);
  });

  test("returns empty array when all scores below threshold", async () => {
    mockChatResponse = "2\n1\n3";
    const chunks = [
      makeChunk("a", "A", "Content A"),
      makeChunk("b", "B", "Content B"),
      makeChunk("c", "C", "Content C"),
    ];

    const result = await rerankChunks("query", chunks, 5);
    expect(result).toHaveLength(0);
  });

  test("returns candidates unchanged on LLM error", async () => {
    mockChat.mockImplementationOnce(async () => {
      throw new Error("LLM timeout");
    });

    const chunks = [
      makeChunk("a", "A", "Content A"),
      makeChunk("b", "B", "Content B"),
      makeChunk("c", "C", "Content C"),
    ];

    const result = await rerankChunks("query", chunks);
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  test("returns candidates unchanged when score count mismatches", async () => {
    mockChatResponse = "8\n5"; // Only 2 scores for 3 chunks
    const chunks = [
      makeChunk("a", "A", "Content A"),
      makeChunk("b", "B", "Content B"),
      makeChunk("c", "C", "Content C"),
    ];

    const result = await rerankChunks("query", chunks);
    expect(result).toHaveLength(3); // Unchanged
  });

  test("skips re-ranking for 2 or fewer candidates", async () => {
    const chunks = [
      makeChunk("a", "A", "Content A"),
      makeChunk("b", "B", "Content B"),
    ];

    const result = await rerankChunks("query", chunks);
    expect(result).toHaveLength(2);
    expect(mockChat.mock.calls.length).toBe(0); // No LLM call
  });

  test("returns empty for empty input", async () => {
    const result = await rerankChunks("query", []);
    expect(result).toHaveLength(0);
    expect(mockChat.mock.calls.length).toBe(0);
  });

  test("calls registry with classify slot and rerank label", async () => {
    const chunks = [
      makeChunk("a", "A", "Content A"),
      makeChunk("b", "B", "Content B"),
      makeChunk("c", "C", "Content C"),
    ];

    await rerankChunks("test query", chunks);

    expect(mockChat.mock.calls.length).toBe(1);
    const [slot, _messages, opts] = mockChat.mock.calls[0] as any[];
    expect(slot).toBe("classify");
    expect(opts.label).toBe("rerank");
    expect(opts.maxTokens).toBe(64);
  });
});
