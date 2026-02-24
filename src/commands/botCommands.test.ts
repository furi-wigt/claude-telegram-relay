import { describe, test, expect, mock, beforeEach } from "bun:test";
import { buildContextSwitchPrompt, buildContextSwitchKeyboard, handleDocCommand } from "./botCommands.ts";
import type { DocSummary } from "../documents/documentProcessor.ts";
import type { DocumentSearchResult } from "../rag/documentSearch.ts";

// We test the pure functions only (no bot instance needed)
describe("buildContextSwitchPrompt", () => {
  test("includes topic in message", () => {
    const result = buildContextSwitchPrompt(["aws", "lambda", "deploy"]);
    expect(result).toContain("aws");
    expect(result).toContain("different topic");
  });

  test("handles empty topics", () => {
    const result = buildContextSwitchPrompt([]);
    expect(result).toContain("Current session is active");
  });

  test("limits topics shown to 3", () => {
    const result = buildContextSwitchPrompt(["a", "b", "c", "d", "e"]);
    // Should only show 3
    expect(result).not.toContain("d,");
    expect(result).not.toContain("e,");
  });
});

// ─── handleDocCommand ─────────────────────────────────────────────────────────

describe("handleDocCommand", () => {
  const mockSupabase = {} as any;

  const mockListFn = mock(async (_sb: any): Promise<DocSummary[]> => []);
  const mockDeleteFn = mock(async (_sb: any, _title: string): Promise<{ deleted: number }> => ({ deleted: 0 }));

  beforeEach(() => {
    mockListFn.mockClear();
    mockDeleteFn.mockClear();
  });

  test("returns supabase-not-configured message when supabase is null", async () => {
    const result = await handleDocCommand("list", null, mockListFn, mockDeleteFn);
    expect(result).toContain("Supabase");
  });

  test("empty args defaults to list — no documents", async () => {
    mockListFn.mockImplementation(async () => []);
    const result = await handleDocCommand("", mockSupabase, mockListFn, mockDeleteFn);
    expect(result).toContain("No documents indexed yet");
  });

  test("list subcmd — no documents", async () => {
    mockListFn.mockImplementation(async () => []);
    const result = await handleDocCommand("list", mockSupabase, mockListFn, mockDeleteFn);
    expect(result).toContain("No documents indexed yet");
  });

  test("list subcmd — shows documents with title, sources, chunks", async () => {
    mockListFn.mockImplementation(async (): Promise<DocSummary[]> => [
      { title: "My Policy", sources: ["policy.pdf"], chunks: 3 },
    ]);
    const result = await handleDocCommand("list", mockSupabase, mockListFn, mockDeleteFn);
    expect(result).toContain("My Policy");
    expect(result).toContain("policy.pdf");
    expect(result).toContain("3");
  });

  test("delete with no title shows usage", async () => {
    const result = await handleDocCommand("delete", mockSupabase, mockListFn, mockDeleteFn);
    expect(result).toContain("Usage");
    expect(mockDeleteFn.mock.calls.length).toBe(0);
  });

  test("delete with title — document found", async () => {
    mockDeleteFn.mockImplementation(async () => ({ deleted: 5 }));
    const result = await handleDocCommand("delete My Policy", mockSupabase, mockListFn, mockDeleteFn);
    expect(result).toContain("My Policy");
    expect(result).toContain("5");
    expect(result).toContain("chunk");
  });

  test("delete with title — document not found", async () => {
    mockDeleteFn.mockImplementation(async () => ({ deleted: 0 }));
    const result = await handleDocCommand("delete Unknown Doc", mockSupabase, mockListFn, mockDeleteFn);
    expect(result).toContain("No document found");
    expect(result).toContain("Unknown Doc");
  });

  test("forget is an alias for delete — document found", async () => {
    mockDeleteFn.mockImplementation(async () => ({ deleted: 2 }));
    const result = await handleDocCommand("forget My Policy", mockSupabase, mockListFn, mockDeleteFn);
    expect(result).toContain("My Policy");
    expect(result).toContain("2");
    expect(result).toContain("chunk");
    expect(mockDeleteFn.mock.calls.length).toBe(1);
  });

  test("forget with no title shows usage", async () => {
    const result = await handleDocCommand("forget", mockSupabase, mockListFn, mockDeleteFn);
    expect(result).toContain("Usage");
    expect(mockDeleteFn.mock.calls.length).toBe(0);
  });

  test("unknown subcmd shows usage", async () => {
    const result = await handleDocCommand("upload something", mockSupabase, mockListFn, mockDeleteFn);
    expect(result).toContain("Usage");
  });
});

// ─── handleDocCommand — query subcmd ──────────────────────────────────────────

describe("handleDocCommand — query", () => {
  const mockSupabase = {} as any;
  const mockListFn = mock(async (): Promise<DocSummary[]> => []);
  const mockDeleteFn = mock(async () => ({ deleted: 0 }));
  const emptySearch = async (_sb: any, _q: string, _titles: string[]): Promise<DocumentSearchResult> => ({
    chunks: [],
    context: "",
    hasResults: false,
  });
  const mockSearchFn = mock(emptySearch);

  beforeEach(() => {
    mockSearchFn.mockReset();
    mockSearchFn.mockImplementation(emptySearch);
  });

  test("query with no question shows usage", async () => {
    const result = await handleDocCommand("query", mockSupabase, mockListFn, mockDeleteFn, mockSearchFn);
    expect(result).toContain("Usage");
    expect(mockSearchFn.mock.calls.length).toBe(0);
  });

  test("query question only — calls searchFn with empty titles", async () => {
    await handleDocCommand("query What is my deductible?", mockSupabase, mockListFn, mockDeleteFn, mockSearchFn);
    expect(mockSearchFn.mock.calls.length).toBe(1);
    const [, question, titles] = mockSearchFn.mock.calls[0] as [any, string, string[]];
    expect(question).toBe("What is my deductible?");
    expect(titles).toEqual([]);
  });

  test("query with one title — passes title to searchFn", async () => {
    await handleDocCommand("query What is my deductible? | NTUC Income", mockSupabase, mockListFn, mockDeleteFn, mockSearchFn);
    const [, question, titles] = mockSearchFn.mock.calls[0] as [any, string, string[]];
    expect(question).toBe("What is my deductible?");
    expect(titles).toEqual(["NTUC Income"]);
  });

  test("query with two titles — passes both to searchFn", async () => {
    await handleDocCommand("query What is my deductible? | NTUC Income | AIA Shield", mockSupabase, mockListFn, mockDeleteFn, mockSearchFn);
    const [, question, titles] = mockSearchFn.mock.calls[0] as [any, string, string[]];
    expect(question).toBe("What is my deductible?");
    expect(titles).toEqual(["NTUC Income", "AIA Shield"]);
  });

  test("query with results — shows title, source, relevance, content", async () => {
    mockSearchFn.mockImplementation(async (): Promise<DocumentSearchResult> => ({
      hasResults: true,
      context: "",
      chunks: [{
        id: "1", title: "NTUC Income", source: "ntuc.pdf",
        chunk_index: 0, content: "Your deductible is $1,500.", metadata: {}, similarity: 0.87,
      }],
    }));
    const result = await handleDocCommand("query What is my deductible?", mockSupabase, mockListFn, mockDeleteFn, mockSearchFn);
    expect(result).toContain("NTUC Income");
    expect(result).toContain("ntuc.pdf");
    expect(result).toContain("87%");
    expect(result).toContain("Your deductible is $1,500.");
  });

  test("query all docs with no results — shows not-found message", async () => {
    const result = await handleDocCommand("query What is my deductible?", mockSupabase, mockListFn, mockDeleteFn, mockSearchFn);
    expect(result).toContain("No relevant");
    expect(result).toContain("/doc list");
  });

  test("query scoped with no results — mentions the scoped titles", async () => {
    const result = await handleDocCommand("query What is my deductible? | NTUC Income", mockSupabase, mockListFn, mockDeleteFn, mockSearchFn);
    expect(result).toContain("NTUC Income");
    expect(result).toContain("No relevant");
  });
});

describe("buildContextSwitchKeyboard", () => {
  test("returns keyboard with new and continue buttons", () => {
    const keyboard = buildContextSwitchKeyboard(12345);
    const rows = keyboard.inline_keyboard;
    expect(rows.length).toBeGreaterThan(0);
    const buttons = rows.flat();
    const newBtn = buttons.find((b) => b.callback_data === "ctxswitch:new:12345");
    const continueBtn = buttons.find((b) => b.callback_data === "ctxswitch:continue:12345");
    expect(newBtn).toBeDefined();
    expect(continueBtn).toBeDefined();
  });
});
