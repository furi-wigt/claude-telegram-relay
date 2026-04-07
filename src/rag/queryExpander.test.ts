/**
 * Tests for queryExpander — LLM query expansion
 *
 * Tests the expansion logic with a mocked ModelRegistry.
 * Run: bun test src/rag/queryExpander.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ─── Mock ModelRegistry ──────────────────────────────────────────────────────

let mockChatResponse = "disaster recovery plan for EDEN project\nbusiness continuity planning government agency\nEDEN project resilience strategy";

const mockChat = mock(async () => mockChatResponse);

mock.module("../models/index.ts", () => ({
  getRegistry: () => ({
    chat: mockChat,
  }),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

const { expandQuery } = await import("./queryExpander.ts");

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("expandQuery", () => {
  beforeEach(() => {
    mockChat.mockClear();
    mockChatResponse = "disaster recovery plan for EDEN project\nbusiness continuity planning government agency\nEDEN project resilience strategy";
  });

  test("returns original query plus expansions", async () => {
    const result = await expandQuery("how should I build a BCP for EDEN?");

    expect(result).toHaveLength(4); // original + 3 expansions
    expect(result[0]).toBe("how should I build a BCP for EDEN?");
    expect(result[1]).toContain("disaster recovery");
  });

  test("always includes original query first", async () => {
    const result = await expandQuery("test query");

    // Short queries (<10 chars) bypass expansion
    // "test query" is 10 chars exactly, should try expansion
    expect(result[0]).toBe("test query");
  });

  test("returns only original for very short queries", async () => {
    const result = await expandQuery("BCP");
    expect(result).toEqual(["BCP"]);
    expect(mockChat.mock.calls.length).toBe(0);
  });

  test("returns only original for slash commands", async () => {
    const result = await expandQuery("/doc query BCP");
    expect(result).toEqual(["/doc query BCP"]);
    expect(mockChat.mock.calls.length).toBe(0);
  });

  test("caps expansions at 3", async () => {
    mockChatResponse = "expansion 1\nexpansion 2\nexpansion 3\nexpansion 4\nexpansion 5";
    const result = await expandQuery("what is the EDEN project plan?");

    // original + max 3 expansions = 4
    expect(result.length).toBeLessThanOrEqual(4);
    expect(result[0]).toBe("what is the EDEN project plan?");
  });

  test("filters out empty lines from LLM response", async () => {
    mockChatResponse = "expansion one\n\n\nexpansion two\n\n";
    const result = await expandQuery("test query for expansion");

    // Should have original + 2 valid expansions (empty lines filtered)
    expect(result).toHaveLength(3);
  });

  test("filters out numbered/bulleted lines from LLM response", async () => {
    mockChatResponse = "1. numbered expansion\n- bulleted expansion\nclean expansion";
    const result = await expandQuery("test query for expansion");

    // Only "clean expansion" passes the filter
    expect(result).toHaveLength(2);
    expect(result[1]).toBe("clean expansion");
  });

  test("gracefully degrades on LLM error", async () => {
    mockChat.mockImplementationOnce(async () => {
      throw new Error("LLM timeout");
    });

    const result = await expandQuery("what is the BCP for EDEN?");

    // Should return just the original query
    expect(result).toEqual(["what is the BCP for EDEN?"]);
  });

  test("gracefully degrades on empty LLM response", async () => {
    mockChatResponse = "";
    const result = await expandQuery("what is the BCP?");

    expect(result).toEqual(["what is the BCP?"]);
  });

  test("calls registry with classify slot", async () => {
    await expandQuery("how to build a BCP for EDEN?");

    expect(mockChat.mock.calls.length).toBe(1);
    const [slot, messages, opts] = mockChat.mock.calls[0] as any[];
    expect(slot).toBe("classify");
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("how to build a BCP for EDEN?");
    expect(opts.maxTokens).toBe(128);
    expect(opts.label).toBe("query-expand");
  });
});
