import { describe, test, expect, mock, beforeEach } from "bun:test";
import { buildContextSwitchPrompt, buildContextSwitchKeyboard, handleDocCommand, HELP_TREE, buildCategoryKeyboard, buildCommandBackKeyboard } from "./botCommands.ts";
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
  const mockListFn = mock(async (): Promise<DocSummary[]> => []);
  const mockDeleteFn = mock(async (_title: string): Promise<{ deleted: number }> => ({ deleted: 0 }));

  beforeEach(() => {
    mockListFn.mockClear();
    mockDeleteFn.mockClear();
  });

  test("empty args defaults to list — no documents", async () => {
    mockListFn.mockImplementation(async () => []);
    const result = await handleDocCommand("", mockListFn, mockDeleteFn);
    expect(result).toContain("No documents saved yet");
  });

  test("list subcmd — no documents", async () => {
    mockListFn.mockImplementation(async () => []);
    const result = await handleDocCommand("list", mockListFn, mockDeleteFn);
    expect(result).toContain("No documents saved yet");
  });

  test("list subcmd — shows numbered list with title and date", async () => {
    mockListFn.mockImplementation(async (): Promise<DocSummary[]> => [
      { title: "My Policy", sources: ["policy.pdf"], chunks: 3, latestAt: "2026-03-07T10:00:00Z" },
      { title: "Old Notes", sources: ["notes.md"], chunks: 1, latestAt: "2026-01-15T08:00:00Z" },
    ]);
    const result = await handleDocCommand("list", mockListFn, mockDeleteFn);
    expect(result).toContain("1. My Policy — 2026-03-07");
    expect(result).toContain("2. Old Notes — 2026-01-15");
    expect(result).toContain("Your documents (2)");
  });

  test("list subcmd — 0 docs returns 'No documents saved yet.'", async () => {
    mockListFn.mockImplementation(async (): Promise<DocSummary[]> => []);
    const result = await handleDocCommand("list", mockListFn, mockDeleteFn);
    expect(result).toBe("No documents saved yet.");
  });

  test("delete with no title shows usage", async () => {
    const result = await handleDocCommand("delete", mockListFn, mockDeleteFn);
    expect(result).toContain("Usage");
    expect(mockDeleteFn.mock.calls.length).toBe(0);
  });

  test("delete with title — document found", async () => {
    mockDeleteFn.mockImplementation(async () => ({ deleted: 5 }));
    const result = await handleDocCommand("delete My Policy", mockListFn, mockDeleteFn);
    expect(result).toContain("My Policy");
    expect(result).toContain("5");
    expect(result).toContain("chunk");
  });

  test("delete with title — document not found", async () => {
    mockDeleteFn.mockImplementation(async () => ({ deleted: 0 }));
    const result = await handleDocCommand("delete Unknown Doc", mockListFn, mockDeleteFn);
    expect(result).toContain("No document found");
    expect(result).toContain("Unknown Doc");
  });

  test("delete with partial title — fuzzy match shows matched title", async () => {
    mockDeleteFn.mockImplementation(async () => ({ deleted: 3, matchedTitle: "Claude Skills Reference" }));
    const result = await handleDocCommand("delete claude skills", mockListFn, mockDeleteFn);
    expect(result).toContain("Claude Skills Reference");
    expect(result).toContain("matched");
    expect(result).toContain("3");
  });

  test("forget is an alias for delete — document found", async () => {
    mockDeleteFn.mockImplementation(async () => ({ deleted: 2 }));
    const result = await handleDocCommand("forget My Policy", mockListFn, mockDeleteFn);
    expect(result).toContain("My Policy");
    expect(result).toContain("2");
    expect(result).toContain("chunk");
    expect(mockDeleteFn.mock.calls.length).toBe(1);
  });

  test("forget with no title shows usage", async () => {
    const result = await handleDocCommand("forget", mockListFn, mockDeleteFn);
    expect(result).toContain("Usage");
    expect(mockDeleteFn.mock.calls.length).toBe(0);
  });

  test("unknown subcmd shows usage", async () => {
    const result = await handleDocCommand("upload something", mockListFn, mockDeleteFn);
    expect(result).toContain("Usage");
  });
});

// ─── handleDocCommand — query subcmd ──────────────────────────────────────────

describe("handleDocCommand — query", () => {
  const mockListFn = mock(async (): Promise<DocSummary[]> => []);
  const mockDeleteFn = mock(async () => ({ deleted: 0 }));
  const emptySearch = async (_q: string, _titles: string[]): Promise<DocumentSearchResult> => ({
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
    const result = await handleDocCommand("query", mockListFn, mockDeleteFn, mockSearchFn);
    expect(result).toContain("Usage");
    expect(mockSearchFn.mock.calls.length).toBe(0);
  });

  test("query question only — calls searchFn with empty titles", async () => {
    await handleDocCommand("query What is my deductible?", mockListFn, mockDeleteFn, mockSearchFn);
    expect(mockSearchFn.mock.calls.length).toBe(1);
    const [question, titles] = mockSearchFn.mock.calls[0] as [string, string[]];
    expect(question).toBe("What is my deductible?");
    expect(titles).toEqual([]);
  });

  test("query with one title — passes title to searchFn", async () => {
    await handleDocCommand("query What is my deductible? | NTUC Income", mockListFn, mockDeleteFn, mockSearchFn);
    const [question, titles] = mockSearchFn.mock.calls[0] as [string, string[]];
    expect(question).toBe("What is my deductible?");
    expect(titles).toEqual(["NTUC Income"]);
  });

  test("query with two titles — passes both to searchFn", async () => {
    await handleDocCommand("query What is my deductible? | NTUC Income | AIA Shield", mockListFn, mockDeleteFn, mockSearchFn);
    const [question, titles] = mockSearchFn.mock.calls[0] as [string, string[]];
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
    const result = await handleDocCommand("query What is my deductible?", mockListFn, mockDeleteFn, mockSearchFn);
    expect(result).toContain("NTUC Income");
    expect(result).toContain("ntuc.pdf");
    expect(result).toContain("87%");
    expect(result).toContain("Your deductible is $1,500.");
  });

  test("query all docs with no results — shows not-found message", async () => {
    const result = await handleDocCommand("query What is my deductible?", mockListFn, mockDeleteFn, mockSearchFn);
    expect(result).toContain("No relevant");
    expect(result).toContain("/doc list");
  });

  test("query scoped with no results — mentions the scoped titles", async () => {
    const result = await handleDocCommand("query What is my deductible? | NTUC Income", mockListFn, mockDeleteFn, mockSearchFn);
    expect(result).toContain("NTUC Income");
    expect(result).toContain("No relevant");
  });

  test("search edge function error — shows error message not 'no results'", async () => {
    mockSearchFn.mockImplementation(async (): Promise<DocumentSearchResult> => ({
      chunks: [],
      context: "",
      hasResults: false,
      searchError: "Search error: function not found",
    }));
    const result = await handleDocCommand("query What is my deductible?", mockListFn, mockDeleteFn, mockSearchFn);
    expect(result).toContain("❌ Search failed");
    expect(result).toContain("Search error: function not found");
    expect(result).not.toContain("No relevant");
  });
});

// ─── handleDocCommand — save subcmd ───────────────────────────────────────────

describe("handleDocCommand — save", () => {
  const mockListFn = mock(async (): Promise<any[]> => []);
  const mockDeleteFn = mock(async () => ({ deleted: 0 }));
  const mockSearchFn = mock(async (): Promise<any> => ({ chunks: [], context: "", hasResults: false }));

  const LARGE_TEXT = "A".repeat(300);

  test("no recent paste — returns guidance message", async () => {
    const result = await handleDocCommand("save", mockListFn, mockDeleteFn, mockSearchFn, undefined);
    expect(result).toContain("No recent paste found");
    expect(result).toContain("/doc save");
  });

  test("save with paste and no title — auto-generates title from content", async () => {
    const mockIngestFn = mock(async (_text: string, title: string) => ({ chunksInserted: 2, title }));
    const mockResolveFn = mock(async (t: string) => t);
    const result = await handleDocCommand("save", mockListFn, mockDeleteFn, mockSearchFn, LARGE_TEXT, mockIngestFn, mockResolveFn);
    expect(result).toContain("✅ Saved");
    expect(result).toContain("2 chunks");
    expect(mockIngestFn.mock.calls.length).toBe(1);
    const [, title] = mockIngestFn.mock.calls[0] as [string, string];
    // Auto-title: no heading or short line → 60-char fallback with ellipsis
    expect(title).toMatch(/^A+…$/);
  });

  test("save with paste and custom title — uses provided title", async () => {
    const mockIngestFn = mock(async (_text: string, title: string) => ({ chunksInserted: 3, title }));
    const mockResolveFn = mock(async (t: string) => t);
    const result = await handleDocCommand("save My Custom Title", mockListFn, mockDeleteFn, mockSearchFn, LARGE_TEXT, mockIngestFn, mockResolveFn);
    expect(result).toContain("My Custom Title");
    expect(result).toContain("3 chunks");
    const [, title] = mockIngestFn.mock.calls[0] as [string, string];
    expect(title).toBe("My Custom Title");
  });

  test("save with duplicate content — returns info message", async () => {
    const mockIngestFn = mock(async (_text: string, _title: string) => ({
      chunksInserted: 0,
      title: "Existing Title",
      duplicate: true,
    }));
    const mockResolveFn = mock(async (t: string) => t);
    const result = await handleDocCommand("save", mockListFn, mockDeleteFn, mockSearchFn, LARGE_TEXT, mockIngestFn, mockResolveFn);
    expect(result).toContain("Already in your knowledge base");
    expect(result).toContain("Existing Title");
  });

  test("save with title conflict — auto-versions the title", async () => {
    let callCount = 0;
    const mockIngestFn = mock(async (_text: string, title: string) => {
      callCount++;
      if (callCount === 1) return { chunksInserted: 0, title, conflict: "title" as const };
      return { chunksInserted: 4, title };
    });
    const mockResolveFn = mock(async (t: string) => `${t} (2)`);
    const result = await handleDocCommand("save My Title", mockListFn, mockDeleteFn, mockSearchFn, LARGE_TEXT, mockIngestFn, mockResolveFn);
    expect(result).toContain("My Title (2)");
    expect(result).toContain("4 chunks");
    expect(mockResolveFn.mock.calls.length).toBe(1);
    expect(mockIngestFn.mock.calls.length).toBe(2);
  });

  test("save with ingest error — returns error message", async () => {
    const mockIngestFn = mock(async () => { throw new Error("DB connection failed"); });
    const mockResolveFn = mock(async (t: string) => t);
    const result = await handleDocCommand("save", mockListFn, mockDeleteFn, mockSearchFn, LARGE_TEXT, mockIngestFn, mockResolveFn);
    expect(result).toContain("❌ Save failed");
    expect(result).toContain("DB connection failed");
  });
});

describe("handleDocCommand — ingest subcommand", () => {
  const mockListFn = mock(async (): Promise<any[]> => []);
  const mockDeleteFn = mock(async () => ({ deleted: 0 }));
  const mockSearchFn = mock(async (): Promise<any> => ({ chunks: [], context: "", hasResults: false }));
  const noopIngest = mock(async (_text: string, title: string) => ({ chunksInserted: 3, title }));
  const noopResolve = mock(async (t: string) => t);

  test("no filepath — returns usage", async () => {
    const result = await handleDocCommand("ingest", mockListFn, mockDeleteFn, mockSearchFn, undefined, noopIngest, noopResolve);
    expect(result).toContain("Usage: /doc ingest");
    expect(result).toContain("<filepath>");
  });

  test("file not found — returns error", async () => {
    const throwingRead = (_p: string): string => { throw new Error("ENOENT"); };
    const result = await handleDocCommand("ingest /no/such/file.md", mockListFn, mockDeleteFn, mockSearchFn, undefined, noopIngest, noopResolve, throwingRead);
    expect(result).toContain("❌ Cannot read file");
    expect(result).toContain("/no/such/file.md");
  });

  test("tilde path — expands to homedir before read", async () => {
    const { homedir } = await import("os");
    let capturedPath = "";
    const capturingRead = (p: string): string => { capturedPath = p; return "content"; };
    await handleDocCommand("ingest ~/docs/notes.md", mockListFn, mockDeleteFn, mockSearchFn, undefined, noopIngest, noopResolve, capturingRead);
    expect(capturedPath).toBe(homedir() + "/docs/notes.md");
  });

  test("empty file — returns error", async () => {
    const emptyRead = (_p: string): string => "   ";
    const result = await handleDocCommand("ingest /path/empty.md", mockListFn, mockDeleteFn, mockSearchFn, undefined, noopIngest, noopResolve, emptyRead);
    expect(result).toContain("❌ File is empty");
  });

  test("ingest without title — auto-titles from filename", async () => {
    const mockIngestFn = mock(async (_text: string, title: string) => ({ chunksInserted: 2, title }));
    const fakeRead = (_p: string): string => "Some document content here.";
    const result = await handleDocCommand("ingest /path/to/my-notes.md", mockListFn, mockDeleteFn, mockSearchFn, undefined, mockIngestFn, noopResolve, fakeRead);
    expect(result).toContain("✅ Saved");
    const [, title] = mockIngestFn.mock.calls[0] as [string, string];
    expect(title).toBe("my-notes");
  });

  test("ingest with explicit title via pipe — uses provided title", async () => {
    const mockIngestFn = mock(async (_text: string, title: string) => ({ chunksInserted: 5, title }));
    const fakeRead = (_p: string): string => "Document content.";
    const result = await handleDocCommand("ingest /path/to/file.md | My Custom Doc", mockListFn, mockDeleteFn, mockSearchFn, undefined, mockIngestFn, noopResolve, fakeRead);
    const [, title] = mockIngestFn.mock.calls[0] as [string, string];
    expect(title).toBe("My Custom Doc");
    expect(result).toContain("My Custom Doc");
    expect(result).toContain("5 chunks");
  });

  test("duplicate content — returns info message", async () => {
    const dupIngest = mock(async (_text: string, _title: string) => ({ chunksInserted: 0, title: "Existing", duplicate: true }));
    const fakeRead = (_p: string): string => "content";
    const result = await handleDocCommand("ingest /path/file.md", mockListFn, mockDeleteFn, mockSearchFn, undefined, dupIngest, noopResolve, fakeRead);
    expect(result).toContain("Already in your knowledge base");
  });

  test("title conflict — auto-versions title", async () => {
    let callCount = 0;
    const conflictIngest = mock(async (_text: string, title: string) => {
      callCount++;
      if (callCount === 1) return { chunksInserted: 0, title, conflict: "title" as const };
      return { chunksInserted: 3, title };
    });
    const versionResolve = mock(async (t: string) => `${t} (2)`);
    const fakeRead = (_p: string): string => "content";
    const result = await handleDocCommand("ingest /path/file.md | My Doc", mockListFn, mockDeleteFn, mockSearchFn, undefined, conflictIngest, versionResolve, fakeRead);
    expect(result).toContain("My Doc (2)");
    expect(result).toContain("3 chunks");
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

// ─── HELP_TREE structure ───────────────────────────────────────────────────────

describe("HELP_TREE", () => {
  const EXPECTED_CATEGORIES = ["session", "memory", "docs", "jobs", "agents", "system"];

  test("has all 6 categories", () => {
    for (const cat of EXPECTED_CATEGORIES) {
      expect(HELP_TREE[cat]).toBeDefined();
    }
  });

  test("every category has icon, name, and at least one command", () => {
    for (const [cat, category] of Object.entries(HELP_TREE)) {
      expect(category.icon).toBeTruthy();
      expect(category.name).toBeTruthy();
      expect(Object.keys(category.commands).length).toBeGreaterThan(0);
    }
  });

  test("every command has a non-empty label and detail", () => {
    for (const [cat, category] of Object.entries(HELP_TREE)) {
      for (const [cmdId, cmd] of Object.entries(category.commands)) {
        expect(cmd.label.length).toBeGreaterThan(0);
        expect(cmd.detail.length).toBeGreaterThan(0);
      }
    }
  });

  test("every command detail contains a Usage: or Examples: section", () => {
    for (const [cat, category] of Object.entries(HELP_TREE)) {
      for (const [cmdId, cmd] of Object.entries(category.commands)) {
        const hasSection = cmd.detail.includes("Usage:") || cmd.detail.includes("Examples:");
        expect(hasSection).toBe(true);
      }
    }
  });

  test("all callback data lengths are within Telegram 64-byte limit", () => {
    for (const [cat, category] of Object.entries(HELP_TREE)) {
      for (const cmdId of Object.keys(category.commands)) {
        const data = `help:cmd:${cat}:${cmdId}`;
        expect(data.length).toBeLessThanOrEqual(64);
      }
    }
  });
});

// ─── buildCategoryKeyboard ────────────────────────────────────────────────────

describe("buildCategoryKeyboard", () => {
  test("session keyboard contains a button for each command", () => {
    const kb = buildCategoryKeyboard("session");
    const buttons = kb.inline_keyboard.flat();
    const cmdIds = Object.keys(HELP_TREE.session.commands);
    for (const cmdId of cmdIds) {
      const btn = buttons.find((b) => b.callback_data === `help:cmd:session:${cmdId}`);
      expect(btn).toBeDefined();
    }
  });

  test("keyboard always ends with a ← Back button pointing to help:back", () => {
    for (const cat of Object.keys(HELP_TREE)) {
      const kb = buildCategoryKeyboard(cat);
      const buttons = kb.inline_keyboard.flat();
      const backBtn = buttons.find((b) => b.callback_data === "help:back");
      expect(backBtn).toBeDefined();
    }
  });

  test("unknown category returns a keyboard with only the Back button", () => {
    const kb = buildCategoryKeyboard("nonexistent");
    const buttons = kb.inline_keyboard.flat();
    expect(buttons.length).toBe(1);
    expect(buttons[0].callback_data).toBe("help:back");
  });
});

// ─── buildCommandBackKeyboard ─────────────────────────────────────────────────

describe("buildCommandBackKeyboard", () => {
  test("contains a button back to the category (help:cat:<cat>)", () => {
    const kb = buildCommandBackKeyboard("session");
    const buttons = kb.inline_keyboard.flat();
    const catBtn = buttons.find((b) => b.callback_data === "help:cat:session");
    expect(catBtn).toBeDefined();
  });

  test("contains a Home button (help:back)", () => {
    const kb = buildCommandBackKeyboard("memory");
    const buttons = kb.inline_keyboard.flat();
    const homeBtn = buttons.find((b) => b.callback_data === "help:back");
    expect(homeBtn).toBeDefined();
  });

  test("category button label includes the category icon and name", () => {
    const kb = buildCommandBackKeyboard("docs");
    const buttons = kb.inline_keyboard.flat();
    const catBtn = buttons.find((b) => b.callback_data === "help:cat:docs");
    expect(catBtn?.text).toContain("📄");
    expect(catBtn?.text).toContain("Documents");
  });
});
