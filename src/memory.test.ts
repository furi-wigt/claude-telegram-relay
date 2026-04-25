/**
 * Tests for memory module — getMemoryContext, processMemoryIntents, getRelevantContext
 *
 * Mocks storageBackend (local SQLite + Qdrant) so tests run without real DB/vector store.
 *
 * Run: bun test src/memory.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ============================================================
// Mock state — controlled by individual tests
// ============================================================

let factsData: any[] = [];
let goalsData: any[] = [];
let existingMemories: any[] = [];
let insertedRecords: any[] = [];
let updatedRecords: { id: string; updates: Record<string, unknown> }[] = [];
let touchedIds: string[] = [];
let messageSearchResults: any[] = [];
let memorySearchResults: any[] = [];
let foundGoal: { id: string } | null = null;

const mockInsertMemoryRecord = mock(async (record: any) => {
  insertedRecords.push(record);
  return { id: `mock-${insertedRecords.length}`, error: null };
});
const mockUpdateMemoryRecord = mock(async (id: string, updates: Record<string, unknown>) => {
  updatedRecords.push({ id, updates });
});
const mockGetMemoryFacts = mock(async (opts?: any) => factsData);
const mockGetMemoryGoals = mock(async (opts?: any) => goalsData);
const mockTouchMemoryAccess = mock((ids: string[]) => { touchedIds.push(...ids); });
const mockGetExistingMemories = mock(async (type: string, opts?: any) => existingMemories);
const mockSemanticSearchMessages = mock(async (query: string, opts?: any) => messageSearchResults);
const mockSemanticSearchMemory = mock(async (query: string, opts?: any) => memorySearchResults);
const mockFindGoalByContent = mock(async (searchText: string) => foundGoal);
const mockGetAllMemoryForDisplay = mock(async () => ({
  goals: goalsData,
  completedGoals: [],
  facts: factsData,
  dates: [],
}));

mock.module("./local/storageBackend", () => ({
  insertMemoryRecord: mockInsertMemoryRecord,
  updateMemoryRecord: mockUpdateMemoryRecord,
  getMemoryFacts: mockGetMemoryFacts,
  getMemoryGoals: mockGetMemoryGoals,
  touchMemoryAccess: mockTouchMemoryAccess,
  getExistingMemories: mockGetExistingMemories,
  semanticSearchMessages: mockSemanticSearchMessages,
  semanticSearchMemory: mockSemanticSearchMemory,
  findGoalByContent: mockFindGoalByContent,
  getAllMemoryForDisplay: mockGetAllMemoryForDisplay,
}));

// Mock local/db for getRelevantContext which uses getDb() for metadata queries
mock.module("./local/db", () => ({
  getDb: () => ({
    query: () => ({
      all: () => [],
      get: () => null,
    }),
  }),
  insertMessage: mock(async () => {}),
  getActiveMemories: () => [],
}));

// Mock semantic duplicate checker (used by processMemoryIntents)
mock.module("./utils/semanticDuplicateChecker", () => ({
  checkSemanticDuplicate: mock(async () => ({ isDuplicate: false, match: null })),
}));

// Mock goal duplicate checker (used by processMemoryIntents)
mock.module("./utils/goalDuplicateChecker", () => ({
  isTextDuplicateGoal: mock(() => false),
  isTextDuplicate: mock(() => false),
}));

// Mock long-term extractor
mock.module("./memory/longTermExtractor", () => ({
  getMemoryScores: (type: string, category?: string) => ({
    importance: type === "goal" ? 0.80 : 0.85,
    stability: type === "goal" ? 0.60 : 0.90,
  }),
  rebuildProfileSummary: mock(async () => {}),
}));

// Mock profile rebuild counter
mock.module("./memory/profileRebuildCounter", () => ({
  incrementProfileRebuildCounter: mock(() => 0),
  resetProfileRebuildCounter: mock(() => {}),
}));

// Mock chatNames
mock.module("./utils/chatNames", () => ({
  resolveSourceLabel: mock(() => "DM"),
}));

const { getMemoryContext, processMemoryIntents, detectMemoryCategory, getRelevantContext, extractContentSnippet, stripMemoryTags } = await import("./memory.ts");
const { isJunkMemoryContent } = await import("./memory/junkFilter.ts");

// ============================================================
// Reset mocks before each test
// ============================================================

beforeEach(() => {
  factsData = [];
  goalsData = [];
  existingMemories = [];
  insertedRecords = [];
  updatedRecords = [];
  touchedIds = [];
  messageSearchResults = [];
  memorySearchResults = [];
  foundGoal = null;
  mockInsertMemoryRecord.mockClear();
  mockUpdateMemoryRecord.mockClear();
  mockGetMemoryFacts.mockClear();
  mockGetMemoryGoals.mockClear();
  mockTouchMemoryAccess.mockClear();
  mockGetExistingMemories.mockClear();
  mockSemanticSearchMessages.mockClear();
  mockSemanticSearchMemory.mockClear();
  mockFindGoalByContent.mockClear();
  mockGetAllMemoryForDisplay.mockClear();
});

// ============================================================
// getMemoryContext
// ============================================================

describe("getMemoryContext", () => {
  test("returns empty string when no facts or goals exist", async () => {
    const result = await getMemoryContext();
    expect(result).toBe("");
  });

  test("returns FACTS section when facts exist", async () => {
    factsData = [
      { id: "1", content: "User works at GovTech", importance: 0.85, stability: 0.9 },
      { id: "2", content: "Prefers TypeScript", importance: 0.85, stability: 0.9 },
    ];
    const result = await getMemoryContext();
    expect(result).toContain("FACTS");
    expect(result).toContain("User works at GovTech");
    expect(result).toContain("Prefers TypeScript");
  });

  test("returns GOALS section when goals exist", async () => {
    goalsData = [
      { id: "1", content: "Ship v2 launch", deadline: null, priority: 1 },
    ];
    const result = await getMemoryContext();
    expect(result).toContain("GOALS");
    expect(result).toContain("Ship v2 launch");
  });

  test("handles error gracefully and returns empty string", async () => {
    mockGetMemoryFacts.mockImplementation(async () => { throw new Error("DB error"); });
    const result = await getMemoryContext();
    expect(result).toBe("");
    // Restore default
    mockGetMemoryFacts.mockImplementation(async () => factsData);
  });
});

// ============================================================
// processMemoryIntents
// ============================================================

describe("processMemoryIntents", () => {
  test("strips [REMEMBER: ...] tags and inserts memory record", async () => {
    const response = "Here is your answer [REMEMBER: User likes coffee]";
    const result = await processMemoryIntents(response, 12345);
    expect(result).not.toContain("[REMEMBER:");
    expect(result).toContain("Here is your answer");
    expect(mockInsertMemoryRecord).toHaveBeenCalled();
  });

  test("[REMEMBER:] inserts with detected category 'personal' for generic facts", async () => {
    await processMemoryIntents("Noted [REMEMBER: User lives in Singapore]", 12345);
    const inserted = insertedRecords[0];
    expect(inserted.category).toBe("personal");
    expect(inserted.type).toBe("fact");
  });

  test("[REMEMBER:] inserts with category 'preference' for preference facts", async () => {
    await processMemoryIntents("Got it [REMEMBER: User prefers concise responses]", 12345);
    const inserted = insertedRecords[0];
    expect(inserted.category).toBe("preference");
  });

  test("[REMEMBER:] inserts with category 'date' for date facts", async () => {
    await processMemoryIntents("OK [REMEMBER: Meeting on Monday 9am]", 12345);
    const inserted = insertedRecords[0];
    expect(inserted.category).toBe("date");
  });

  test("[GOAL:] inserts with type 'goal' and category 'goal'", async () => {
    await processMemoryIntents("Noted! [GOAL: Complete migration by Friday]", 12345);
    const inserted = insertedRecords[0];
    expect(inserted.type).toBe("goal");
    expect(inserted.category).toBe("goal");
  });

  test("[GOAL:] stores chat_id=chatId for provenance", async () => {
    await processMemoryIntents("Noted! [GOAL: Global goal visible everywhere]", 12345);
    const inserted = insertedRecords[0];
    expect(inserted.type).toBe("goal");
    expect(inserted.chat_id).toBe(12345);
  });

  test("[GOAL: ... | DEADLINE: ...] inserts with deadline", async () => {
    const result = await processMemoryIntents("Got it [GOAL: Deploy app | DEADLINE: 2026-03-01]", 12345);
    expect(result).not.toContain("[GOAL:");
    expect(result).not.toContain("DEADLINE:");
    const inserted = insertedRecords[0];
    expect(inserted.category).toBe("goal");
    expect(inserted.deadline).toBe("2026-03-01");
  });

  test("strips [REMEMBER_GLOBAL: ...] tags and stores with chat_id=chatId for provenance", async () => {
    const result = await processMemoryIntents("OK [REMEMBER_GLOBAL: Shared fact across groups]", 12345);
    expect(result).not.toContain("[REMEMBER_GLOBAL:");
    expect(mockInsertMemoryRecord).toHaveBeenCalled();
    const inserted = insertedRecords[0];
    // Provenance model: [REMEMBER_GLOBAL:] stores chatId for audit
    expect(inserted.chat_id).toBe(12345);
    expect(inserted.category).toBe("personal");
  });

  test("[REMEMBER_GLOBAL:] without chatId stores chat_id=null", async () => {
    await processMemoryIntents("OK [REMEMBER_GLOBAL: CLI-origin fact]");
    const inserted = insertedRecords[0];
    expect(inserted.chat_id).toBeNull();
  });
});

// ============================================================
// Provenance model — processMemoryIntents write paths
// ============================================================

describe("processMemoryIntents — provenance model write paths", () => {
  test("[REMEMBER_GLOBAL:] stores chat_id=chatId for provenance", async () => {
    await processMemoryIntents("OK [REMEMBER_GLOBAL: Shared fact across groups]", 99999);
    const inserted = insertedRecords[0];
    expect(inserted.chat_id).toBe(99999);
  });

  test("[REMEMBER_GLOBAL:] without chatId stores chat_id=null", async () => {
    await processMemoryIntents("OK [REMEMBER_GLOBAL: CLI-origin fact]");
    const inserted = insertedRecords[0];
    expect(inserted.chat_id).toBeNull();
  });

  test("[GOAL:] stores chat_id=chatId for provenance", async () => {
    await processMemoryIntents("Noted! [GOAL: Ship the provenance model]", 12345);
    const inserted = insertedRecords[0];
    expect(inserted.chat_id).toBe(12345);
  });

  test("[GOAL:] without chatId stores chat_id=null", async () => {
    await processMemoryIntents("Noted! [GOAL: CLI goal]");
    const inserted = insertedRecords[0];
    expect(inserted.chat_id).toBeNull();
  });
});

// ============================================================
// [GOAL:] text-based dedup pre-check
// ============================================================

describe("processMemoryIntents — [GOAL:] text dedup pre-check", () => {
  test("skips [GOAL:] insert when text duplicate detected", async () => {
    // Mock isTextDuplicateGoal to return true for this test
    const { isTextDuplicateGoal } = await import("./utils/goalDuplicateChecker");
    (isTextDuplicateGoal as any).mockImplementation(() => true);

    const result = await processMemoryIntents("Noted! [GOAL: update James on EDEN's userbase size]", 12345);
    expect(mockInsertMemoryRecord).not.toHaveBeenCalled();
    expect(result).not.toContain("[GOAL:");

    // Restore
    (isTextDuplicateGoal as any).mockImplementation(() => false);
  });

  test("inserts [GOAL:] when genuinely different from existing goals", async () => {
    await processMemoryIntents("Noted! [GOAL: update James on EDEN's userbase size]", 12345);
    expect(mockInsertMemoryRecord).toHaveBeenCalledTimes(1);
    const inserted = insertedRecords[0];
    expect(inserted.type).toBe("goal");
    expect(inserted.content).toBe("update James on EDEN's userbase size");
  });

  test("inserts [GOAL:] when no existing goals in DB", async () => {
    await processMemoryIntents("Noted! [GOAL: update James on EDEN's userbase size]", 12345);
    expect(mockInsertMemoryRecord).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// [REMEMBER:] text-based dedup pre-check
// ============================================================

describe("processMemoryIntents — [REMEMBER:] text dedup pre-check", () => {
  test("skips [REMEMBER:] when text duplicate detected", async () => {
    const { isTextDuplicate } = await import("./utils/goalDuplicateChecker");
    (isTextDuplicate as any).mockImplementation(() => true);

    const result = await processMemoryIntents("Got it [REMEMBER: IDE preference is VS Code]", 12345);
    expect(mockInsertMemoryRecord).not.toHaveBeenCalled();
    expect(result).not.toContain("[REMEMBER:");

    (isTextDuplicate as any).mockImplementation(() => false);
  });

  test("inserts [REMEMBER:] when genuinely different from existing facts", async () => {
    await processMemoryIntents("OK [REMEMBER: User works at GovTech]", 12345);
    expect(mockInsertMemoryRecord).toHaveBeenCalledTimes(1);
    const inserted = insertedRecords[0];
    expect(inserted.type).toBe("fact");
    expect(inserted.content).toBe("User works at GovTech");
  });

  test("inserts [REMEMBER:] when no existing facts in DB", async () => {
    await processMemoryIntents("OK [REMEMBER: User lives in Singapore]", 12345);
    expect(mockInsertMemoryRecord).toHaveBeenCalledTimes(1);
  });

  test("skips [REMEMBER_GLOBAL:] when text duplicate detected", async () => {
    const { isTextDuplicate } = await import("./utils/goalDuplicateChecker");
    (isTextDuplicate as any).mockImplementation(() => true);

    const result = await processMemoryIntents("OK [REMEMBER_GLOBAL: User works at GovTech]", 12345);
    expect(mockInsertMemoryRecord).not.toHaveBeenCalled();
    expect(result).not.toContain("[REMEMBER_GLOBAL:");

    (isTextDuplicate as any).mockImplementation(() => false);
  });
});

// ============================================================
// getMemoryContext — Fix A (cap 25, ordering)
// ============================================================

describe("getMemoryContext — Fix A: cap and ordering", () => {
  test("facts query uses limit 25 (MAX_FACTS_IN_CONTEXT)", async () => {
    await getMemoryContext();
    expect(mockGetMemoryFacts).toHaveBeenCalled();
    const opts = mockGetMemoryFacts.mock.calls[0][0];
    expect(opts.limit).toBe(25);
  });

  test("returns all facts when exactly 25 are returned", async () => {
    factsData = Array.from({ length: 25 }, (_, i) => ({
      id: `f${i}`, content: `Fact ${i}`, importance: 0.8 - i * 0.01, stability: 0.9,
    }));
    const result = await getMemoryContext();
    expect(result).toContain("FACTS");
    expect(result).toContain("Fact 0");
    expect(result).toContain("Fact 24");
  });
});

// ============================================================
// getMemoryContext — Fix B (selective touch for high-importance facts)
// ============================================================

describe("getMemoryContext — Fix B: selective touch for high-importance facts", () => {
  test("touches facts with importance >= 0.80 (exact boundary)", async () => {
    factsData = [
      { id: "hi", content: "High importance fact", importance: 0.80, stability: 0.9 },
      { id: "lo", content: "Low importance fact", importance: 0.79, stability: 0.9 },
    ];
    await getMemoryContext();
    expect(touchedIds).toContain("hi");
    expect(touchedIds).not.toContain("lo");
  });

  test("touches importance 0.85 but not 0.70", async () => {
    factsData = [
      { id: "a", content: "Personal fact", importance: 0.85, stability: 0.9 },
      { id: "b", content: "Date fact", importance: 0.70, stability: 0.5 },
    ];
    await getMemoryContext();
    expect(touchedIds).toContain("a");
    expect(touchedIds).not.toContain("b");
  });

  test("touchMemoryAccess not called when no facts have importance >= 0.80", async () => {
    factsData = [
      { id: "x", content: "Low fact", importance: 0.60, stability: 0.5 },
    ];
    await getMemoryContext();
    expect(mockTouchMemoryAccess).not.toHaveBeenCalled();
  });

  test("touchMemoryAccess not called when facts list is empty", async () => {
    await getMemoryContext();
    expect(mockTouchMemoryAccess).not.toHaveBeenCalled();
  });
});

// ============================================================
// getRelevantContext — excludeIds filtering
// ============================================================

describe("getRelevantContext — excludeIds filtering", () => {
  test("when excludeIds is empty, all message results are returned", async () => {
    messageSearchResults = [
      { id: "m1", role: "assistant", content: "Message m1", similarity: 0.9 },
      { id: "m2", role: "assistant", content: "Message m2", similarity: 0.85 },
      { id: "m3", role: "assistant", content: "Message m3", similarity: 0.8 },
    ];
    const result = await getRelevantContext("unique-empty-exclude-" + Date.now(), 123, false, new Set());
    expect(result).toContain("Message m1");
    expect(result).toContain("Message m2");
    expect(result).toContain("Message m3");
  });

  test("when excludeIds contains IDs matching some results, those are filtered out", async () => {
    messageSearchResults = [
      { id: "m1", role: "assistant", content: "Message m1", similarity: 0.9 },
      { id: "m2", role: "assistant", content: "Message m2", similarity: 0.85 },
      { id: "m3", role: "assistant", content: "Message m3", similarity: 0.8 },
    ];
    const excludeIds = new Set(["m1", "m3"]);
    const result = await getRelevantContext("unique-partial-exclude-" + Date.now(), 123, false, excludeIds);
    expect(result).not.toContain("Message m1");
    expect(result).toContain("Message m2");
    expect(result).not.toContain("Message m3");
  });

  test("when all message results are excluded, returns empty or memory-only", async () => {
    messageSearchResults = [
      { id: "m1", role: "assistant", content: "Message m1", similarity: 0.9 },
      { id: "m2", role: "assistant", content: "Message m2", similarity: 0.85 },
    ];
    const excludeIds = new Set(["m1", "m2"]);
    const result = await getRelevantContext("unique-all-exclude-" + Date.now(), 123, false, excludeIds);
    expect(result).toBe("");
  });

  test("excludeIds does not affect memory hits, only message hits", async () => {
    messageSearchResults = [
      { id: "m1", role: "assistant", content: "Message m1", similarity: 0.9 },
    ];
    memorySearchResults = [
      { id: "mem1", content: "Related memory", type: "fact", similarity: 0.85 },
    ];
    const excludeIds = new Set(["m1"]);
    const result = await getRelevantContext("unique-mem-survives-" + Date.now(), 123, false, excludeIds);
    expect(result).not.toContain("Message m1");
    expect(result).toContain("Related memory");
  });
});

// ============================================================
// Fix 5: Cache key uniqueness (Bun.hash full query)
// ============================================================

describe("searchCache key uniqueness — Bun.hash on full query", () => {
  test("two queries sharing the same first 50 chars produce different cache keys", () => {
    const prefix = "A".repeat(50);
    const queryA = prefix + " — tell me about AWS Lambda pricing";
    const queryB = prefix + " — tell me about AWS S3 pricing";
    const keyA = Bun.hash(queryA).toString(36);
    const keyB = Bun.hash(queryB).toString(36);
    expect(keyA).not.toBe(keyB);
  });

  test("identical queries produce the same cache key", () => {
    const query = "What is the capital of France?";
    const keyA = Bun.hash(query).toString(36);
    const keyB = Bun.hash(query).toString(36);
    expect(keyA).toBe(keyB);
  });
});

// ============================================================
// detectMemoryCategory
// ============================================================

describe("detectMemoryCategory", () => {
  test("returns 'personal' for generic facts", () => {
    expect(detectMemoryCategory("User lives in Singapore")).toBe("personal");
    expect(detectMemoryCategory("My AWS account is 123456789")).toBe("personal");
    expect(detectMemoryCategory("Name is Alex")).toBe("personal");
  });

  test("returns 'preference' for preference-related content", () => {
    expect(detectMemoryCategory("User prefers concise responses")).toBe("preference");
    expect(detectMemoryCategory("Always respond formally")).toBe("preference");
    expect(detectMemoryCategory("I like bullet points")).toBe("preference");
    expect(detectMemoryCategory("Never use jargon")).toBe("preference");
  });

  test("returns 'date' for date-related content", () => {
    expect(detectMemoryCategory("Meeting on Monday 9am")).toBe("date");
    expect(detectMemoryCategory("Deadline on 15 Jan")).toBe("date");
    expect(detectMemoryCategory("standup every friday")).toBe("date");
  });
});

// ============================================================
// Fix F: processMemoryIntents sets importance + stability at insert
// ============================================================

describe("Fix F: processMemoryIntents inserts include importance and stability", () => {
  test("[REMEMBER:] sets importance=0.85 and stability=0.90", async () => {
    await processMemoryIntents("OK [REMEMBER: User lives in Singapore]", 1);
    const inserted = insertedRecords[0];
    expect(inserted.importance).toBe(0.85);
    expect(inserted.stability).toBe(0.90);
  });

  test("[REMEMBER_GLOBAL:] sets importance=0.85 and stability=0.90", async () => {
    await processMemoryIntents("OK [REMEMBER_GLOBAL: User works at GovTech]", 1);
    const inserted = insertedRecords[0];
    expect(inserted.importance).toBe(0.85);
    expect(inserted.stability).toBe(0.90);
  });

  test("[GOAL:] sets importance=0.80 and stability=0.60", async () => {
    await processMemoryIntents("OK [GOAL: Ship v2 by March]", 1);
    const goalInsert = insertedRecords.find((r: any) => r.type === "goal");
    expect(goalInsert).toBeDefined();
    expect(goalInsert!.importance).toBe(0.80);
    expect(goalInsert!.stability).toBe(0.60);
  });
});

// ============================================================
// Fix B: Unified isJunkMemoryContent filter
// ============================================================

describe("isJunkMemoryContent — unified junk filter", () => {
  test("filters empty/whitespace content", () => {
    expect(isJunkMemoryContent("")).toBe(true);
    expect(isJunkMemoryContent("   ")).toBe(true);
    expect(isJunkMemoryContent(null as any)).toBe(true);
    expect(isJunkMemoryContent(undefined as any)).toBe(true);
  });

  test("filters content shorter than 4 chars", () => {
    expect(isJunkMemoryContent("]")).toBe(true);
    expect(isJunkMemoryContent("ab")).toBe(true);
    expect(isJunkMemoryContent("abc")).toBe(true);
  });

  test("filters bracket/punctuation-only content", () => {
    expect(isJunkMemoryContent("[]`")).toBe(true);
    expect(isJunkMemoryContent("`/`")).toBe(true);
    expect(isJunkMemoryContent("----")).toBe(true);
    expect(isJunkMemoryContent("[...]")).toBe(true);
  });

  test("filters bracket-start tail fragments (starts with ])", () => {
    expect(isJunkMemoryContent("] handler's isTextDuplicateGoal guard")).toBe(true);
    expect(isJunkMemoryContent("]`) — These intentionally have chat_id=null")).toBe(true);
    expect(isJunkMemoryContent("]` and `[REMEMBER_GLOBAL:")).toBe(true);
  });

  test("filters un-stripped intent tags", () => {
    expect(isJunkMemoryContent("[REMEMBER: some fact]")).toBe(true);
    expect(isJunkMemoryContent("[REMEMBER_GLOBAL: shared fact]")).toBe(true);
    expect(isJunkMemoryContent("[GOAL: do something]")).toBe(true);
    expect(isJunkMemoryContent("[DONE: completed task]")).toBe(true);
  });

  test("passes valid memory content", () => {
    expect(isJunkMemoryContent("User works at GovTech")).toBe(false);
    expect(isJunkMemoryContent("user uses [kebab-case] for naming")).toBe(false);
    expect(isJunkMemoryContent("IDE preference is VS Code")).toBe(false);
  });
});

// ============================================================
// Fix C: Greedy regex captures bracket-containing facts
// ============================================================

describe("Fix C: greedy regex for bracket-containing facts", () => {
  test("[REMEMBER:] captures full content with inner brackets", async () => {
    const result = await processMemoryIntents("OK [REMEMBER: user uses [kebab-case] for naming]", 1);
    expect(result).not.toContain("[REMEMBER:");
    const inserted = insertedRecords[0];
    expect(inserted.content).toBe("user uses [kebab-case] for naming");
  });

  test("[REMEMBER_GLOBAL:] captures full content with inner brackets", async () => {
    const result = await processMemoryIntents("OK [REMEMBER_GLOBAL: prefers [dark-mode] in editors]", 1);
    expect(result).not.toContain("[REMEMBER_GLOBAL:");
    const inserted = insertedRecords[0];
    expect(inserted.content).toBe("prefers [dark-mode] in editors");
  });

  test("[DONE:] captures full content with inner brackets", async () => {
    const result = await processMemoryIntents("Done! [DONE: fix [bracket] parsing bug]", 1);
    expect(result).not.toContain("[DONE:");
  });

  test("cross-tag span: [GOAL:] does not absorb adjacent [DONE:] tag", async () => {
    // LLM writes tag syntax in explanations: `[GOAL:]`, `[DONE: x]`
    // Lazy regex must not capture `]`, `[DONE: x` as the goal content
    const response = "Use tags like `[GOAL:]`, `[DONE: search text]` in responses";
    await processMemoryIntents(response, 1);
    // No goal should be inserted (the span artifact starts with `]`)
    expect(insertedRecords.length).toBe(0);
  });

  test("cross-tag span: [REMEMBER:] does not absorb adjacent [DONE:] tag", async () => {
    const response = "Tags like `[REMEMBER: fact]`, `[DONE: goal]` are processed after reply";
    await processMemoryIntents(response, 1);
    // Only the REMEMBER tag with clean content `fact` should be inserted, not a span artifact
    if (insertedRecords.length > 0) {
      expect(insertedRecords[0].content).not.toMatch(/^\]/);
    }
  });
});

// ============================================================
// getRelevantContext — compact index format
// ============================================================

describe("getRelevantContext — compact index format", () => {
  test("output contains [R1] indexed format", async () => {
    messageSearchResults = [
      { id: "m1", role: "assistant", content: "Discussing AWS Lambda pricing strategies for production workloads", similarity: 0.9 },
      { id: "m2", role: "assistant", content: "Setting up CloudWatch alarms for cost monitoring", similarity: 0.85 },
    ];
    const result = await getRelevantContext("compact-index-test-" + Date.now(), 123, false);
    expect(result).toContain("[R1]");
    expect(result).toContain("[R2]");
    expect(result).toContain("Past Context");
  });

  test("memory hits appear as Related memories section with bullet format", async () => {
    messageSearchResults = [
      { id: "m20", role: "assistant", content: "Some message content for context", similarity: 0.9 },
    ];
    memorySearchResults = [
      { id: "mem1", content: "User prefers concise responses", type: "preference", similarity: 0.85 },
    ];
    const result = await getRelevantContext("mem-format-test-" + Date.now(), 123, false);
    expect(result).toContain("Related memories");
    expect(result).toContain("User prefers concise responses");
    expect(result).toContain("• User prefers concise responses");
  });

  test("content snippet is injected with actual content", async () => {
    messageSearchResults = [{
      id: "m30",
      role: "assistant",
      content: "The root cause of the issue was that WAL snapshots were stale. Fix: use BEGIN IMMEDIATE + verify-count pattern to ensure the delete actually happened before committing.",
      similarity: 0.9,
    }];
    const result = await getRelevantContext("snippet-inject-test-" + Date.now(), 123, false);
    expect(result).toContain("WAL snapshots were stale");
    expect(result).toContain("BEGIN IMMEDIATE");
  });

  test("content longer than 200 chars is truncated with ellipsis", async () => {
    messageSearchResults = [{
      id: "m31", role: "assistant", content: "a".repeat(250), similarity: 0.9,
    }];
    const result = await getRelevantContext("trunc-test-" + Date.now(), 123, false);
    expect(result).toContain("…");
  });

  test("hits block is capped at 1200 chars", async () => {
    const makeHit = (id: string, n: number) => ({
      id,
      role: "assistant",
      content: "word ".repeat(100).trim(),
      similarity: 0.9 - n * 0.05,
    });
    messageSearchResults = [makeHit("m40", 0), makeHit("m41", 1), makeHit("m42", 2)];
    const result = await getRelevantContext("cap-test-" + Date.now(), 123, false);
    const hitsBlock = result.split("Past Context:\n")[1]?.split("\n\n")[0] ?? result;
    expect(hitsBlock.length).toBeLessThanOrEqual(1200);
  });
});

// ============================================================
// extractContentSnippet unit tests
// ============================================================

describe("extractContentSnippet", () => {
  test("returns content as-is when under maxChars", () => {
    expect(extractContentSnippet("Short response.")).toBe("Short response.");
  });

  test("slices at word boundary and appends ellipsis when over maxChars", () => {
    const content = "word ".repeat(50).trim(); // 249 chars
    const result = extractContentSnippet(content, 200);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(201); // 200 + ellipsis char
  });

  test("strips leading 'Sure,' preamble", () => {
    expect(extractContentSnippet("Sure, here is the answer.")).toBe("here is the answer.");
  });

  test("strips leading 'Let me ' preamble", () => {
    expect(extractContentSnippet("Let me think about this carefully.")).toBe("think about this carefully.");
  });

  test("strips multiple preamble layers (max 3 passes)", () => {
    expect(extractContentSnippet("Sure, let me think about this.")).toBe("think about this.");
  });

  test("returns empty string for empty input", () => {
    expect(extractContentSnippet("")).toBe("");
  });

  test("returns empty string when preamble fills entire content", () => {
    expect(extractContentSnippet("Sure,")).toBe("");
  });

  test("falls back to char slice when content has no spaces and exceeds maxChars", () => {
    const noSpaces = "a".repeat(250);
    const result = extractContentSnippet(noSpaces, 200);
    expect(result).toBe("a".repeat(200) + "…");
  });

  test("uses default maxChars of 200", () => {
    const content = "b ".repeat(150).trim(); // 299 chars
    const result = extractContentSnippet(content);
    expect(result.length).toBeLessThanOrEqual(201);
    expect(result.endsWith("…")).toBe(true);
  });

  test("does not append ellipsis when content is exactly maxChars", () => {
    const content = "x".repeat(200);
    expect(extractContentSnippet(content, 200)).toBe(content);
    expect(extractContentSnippet(content, 200).endsWith("…")).toBe(false);
  });
});

// ============================================================
// stripMemoryTags — [SPEC_SAVED:] tag stripping
// ============================================================

describe("stripMemoryTags — [SPEC_SAVED:]", () => {
  test("strips [SPEC_SAVED:] tag with path and dir", () => {
    const input = "Here is your spec.\n[SPEC_SAVED: path=~/.claude-relay/specs/260425_1034_01_feature-spec.md, dir=~/projects/my-app]";
    const result = stripMemoryTags(input);
    expect(result).not.toContain("[SPEC_SAVED:");
    expect(result).toContain("Here is your spec.");
  });

  test("strips [SPEC_SAVED:] tag without dir", () => {
    const input = "Spec saved.\n[SPEC_SAVED: path=~/.claude-relay/specs/260425_01_foo.md]";
    const result = stripMemoryTags(input);
    expect(result).not.toContain("[SPEC_SAVED:");
    expect(result).toContain("Spec saved.");
  });

  test("strips [SPEC_SAVED:] tag with complex path containing slashes", () => {
    const input = "Documentation created [SPEC_SAVED: path=/home/user/.claude-relay/specs/my-spec.md]";
    const result = stripMemoryTags(input);
    expect(result).not.toContain("[SPEC_SAVED:");
    expect(result).toBe("Documentation created");
  });

  test("leaves response unchanged when no SPEC_SAVED tag", () => {
    const input = "Regular response with no tags.";
    expect(stripMemoryTags(input)).toBe("Regular response with no tags.");
  });

  test("handles multiple [SPEC_SAVED:] tags in single response", () => {
    const input = "First spec [SPEC_SAVED: path=~/specs/1.md] and second [SPEC_SAVED: path=~/specs/2.md] saved.";
    const result = stripMemoryTags(input);
    expect(result).not.toContain("[SPEC_SAVED:");
    expect(result).toContain("First spec");
    expect(result).toContain("and second");
    expect(result).toContain("saved.");
  });

  test("strips [SPEC_SAVED:] alongside other memory tags", async () => {
    const input = "Done [REMEMBER: User saved specs] [SPEC_SAVED: path=~/.claude-relay/specs/test.md] and ready.";
    const result = await processMemoryIntents(input, 12345);
    expect(result).not.toContain("[SPEC_SAVED:");
    expect(result).not.toContain("[REMEMBER:");
    expect(result).toContain("Done");
    expect(result).toContain("and ready.");
  });

  test("preserves whitespace structure after stripping tag", () => {
    const input = "Line 1\n[SPEC_SAVED: path=~/test.md]\nLine 2";
    const result = stripMemoryTags(input);
    expect(result).toContain("Line 1");
    expect(result).toContain("Line 2");
    // Should not have excessive whitespace from tag removal
    expect(result).not.toContain("[SPEC_SAVED:");
  });

  test("handles [SPEC_SAVED:] tag with equals signs in path values", () => {
    const input = "Created [SPEC_SAVED: path=/home/user/.conf/a=1/spec.md, dir=/tmp]";
    const result = stripMemoryTags(input);
    expect(result).not.toContain("[SPEC_SAVED:");
    expect(result).toContain("Created");
  });
});
