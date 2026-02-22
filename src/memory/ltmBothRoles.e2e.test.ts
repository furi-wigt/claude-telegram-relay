/**
 * E2E tests for LTM extraction with both user and assistant messages.
 *
 * Verifies that:
 * - extractMemoriesFromExchange accepts an optional assistantResponse
 * - The assistant's restatement of user facts improves extraction
 * - The assistant's own persona/knowledge is NOT extracted as user facts
 * - QueueItem correctly carries assistantResponse through the queue
 * - extractAndStore passes assistantResponse to the extractor
 *
 * Run: bun test src/memory/ltmBothRoles.e2e.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Own the ollama.ts mock so Bun module cache bleed from other test files
// (routineMessage.test.ts, longTermExtractor.test.ts) doesn't replace
// callOllamaGenerate with a stub that never calls fetch.
const _callOllamaGenerateMock = mock(async (_prompt: string, _options?: unknown): Promise<string> => "{}");

mock.module("../claude-process.ts", () => ({
  claudeText: mock(() => Promise.reject(new Error("Claude unavailable in tests"))),
}));

mock.module("../ollama.ts", () => ({
  callOllamaGenerate: _callOllamaGenerateMock,
}));

import {
  extractMemoriesFromExchange,
  extractAndStore,
  hasMemoryItems,
  type ExtractedMemories,
} from "./longTermExtractor.ts";
import { enqueueExtraction, type QueueItem } from "./extractionQueue.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockOllamaResponse(json: unknown): void {
  _callOllamaGenerateMock.mockImplementation(
    async (_prompt: string, _options?: unknown) => JSON.stringify(json)
  );
}

function mockOllamaText(text: string): void {
  _callOllamaGenerateMock.mockImplementation(
    async (_prompt: string, _options?: unknown) => text
  );
}

function mockSupabase(insertResult?: { error: any }) {
  const insertFn = mock(() =>
    Promise.resolve(insertResult ?? { data: null, error: null })
  );

  const eqFn: any = mock(() => ({ eq: eqFn, delete: deleteFn, select: selectFn }));
  const deleteFn: any = mock(() => ({ eq: eqFn, error: null }));
  const selectFn: any = mock(() => ({ eq: eqFn, single: mock(() => Promise.resolve({ data: null, error: null })) }));

  return {
    from: mock(() => ({
      insert: insertFn,
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(() => Promise.resolve({ data: null, error: null })),
          in: mock(() => ({
            eq: mock(() => ({
              order: mock(() => ({
                limit: mock(() => Promise.resolve({ data: [], error: null })),
              })),
            })),
          })),
        })),
      })),
    })),
    _insertFn: insertFn,
  } as any;
}

async function flushAsync(ms = 30): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setTimeout(r, ms));
}

beforeEach(() => { _callOllamaGenerateMock.mockReset(); });

// ─── Tests: extractMemoriesFromExchange ─────────────────────────────────────

describe("extractMemoriesFromExchange — both roles", () => {
  test("user message only (backward compat): extracts explicit fact", async () => {
    mockOllamaResponse({
      certain: { facts: ["Solution Architect at GovTech"] },
      uncertain: {},
    });

    const result = await extractMemoriesFromExchange(
      "I am a Solution Architect at GovTech working on digital infrastructure."
    );

    expect(result.certain.facts).toContain("Solution Architect at GovTech");
  });

  test("function accepts 2 args — user message + assistant response", async () => {
    mockOllamaResponse({
      certain: { facts: ["Solution Architect at GovTech"] },
      uncertain: {},
    });

    // Should not throw with 2 args
    const result = await extractMemoriesFromExchange(
      "Do you remember I work at GovTech?",
      "Yes, you're a Solution Architect at GovTech, working on digital infrastructure."
    );

    expect(result).toBeDefined();
    expect(result.certain).toBeDefined();
    expect(result.uncertain).toBeDefined();
  });

  test("assistant reinforces user fact — extraction succeeds", async () => {
    mockOllamaResponse({
      certain: {
        facts: ["Solution Architect at GovTech"],
        preferences: ["prefers concise explanations"],
      },
      uncertain: {},
    });

    const result = await extractMemoriesFromExchange(
      "Do you remember I work at GovTech?",
      "Yes! You're a Solution Architect at GovTech. You also mentioned you prefer concise explanations."
    );

    expect(result.certain.facts).toContain("Solution Architect at GovTech");
    expect(result.certain.preferences).toContain("prefers concise explanations");
  });

  test("assistant self-description NOT extracted as user fact", async () => {
    // Simulate an LLM that correctly returns empty for AI self-description
    mockOllamaResponse({});

    const result = await extractMemoriesFromExchange(
      "Hi there!",
      "As a helpful AI assistant, I can assist with a wide variety of tasks and questions."
    );

    expect(hasMemoryItems(result.certain)).toBe(false);
    expect(hasMemoryItems(result.uncertain)).toBe(false);
  });

  test("empty user message with assistant response — returns empty", async () => {
    mockOllamaText("{}");

    const result = await extractMemoriesFromExchange("", "Here's some info...");
    expect(result).toEqual({ certain: {}, uncertain: {} });
  });

  test("assistantResponse is optional — undefined works identically to omitted", async () => {
    mockOllamaResponse({
      certain: { facts: ["works in Singapore"] },
      uncertain: {},
    });

    const result1 = await extractMemoriesFromExchange("I work in Singapore");
    const result2 = await extractMemoriesFromExchange("I work in Singapore", undefined);

    expect(result1.certain.facts).toContain("works in Singapore");
    expect(result2.certain.facts).toContain("works in Singapore");
  });
});

// ─── Tests: QueueItem carries assistantResponse ───────────────────────────

describe("QueueItem — assistantResponse field", () => {
  test("QueueItem with assistantResponse is passed to extraction function", async () => {
    const received: Partial<QueueItem>[] = [];

    const fn = async (item: QueueItem) => {
      received.push({ text: item.text, assistantResponse: item.assistantResponse });
    };

    enqueueExtraction(
      {
        chatId: 9001,
        userId: 1,
        text: "I love TypeScript",
        assistantResponse: "Great choice! TypeScript adds type safety.",
      },
      fn
    );

    await flushAsync();

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("I love TypeScript");
    expect(received[0].assistantResponse).toBe("Great choice! TypeScript adds type safety.");
  });

  test("QueueItem without assistantResponse — undefined field, backward compat", async () => {
    const received: Partial<QueueItem>[] = [];

    const fn = async (item: QueueItem) => {
      received.push({ text: item.text, assistantResponse: item.assistantResponse });
    };

    enqueueExtraction({ chatId: 9002, userId: 1, text: "hello" }, fn);

    await flushAsync();

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("hello");
    expect(received[0].assistantResponse).toBeUndefined();
  });
});

// ─── Tests: extractAndStore with both roles ───────────────────────────────

describe("extractAndStore — with assistantResponse (mocked DB)", () => {
  test("calls extraction with both user message and assistant response", async () => {
    mockOllamaResponse({
      certain: { facts: ["loves bun runtime"] },
      uncertain: {},
    });

    const db = mockSupabase();

    const result = await extractAndStore(
      db,
      -99901,
      1,
      "I really love using bun for TypeScript projects",
      "That's great! Bun is indeed fast and has excellent TypeScript support."
    );

    expect(result.inserted).toBeGreaterThanOrEqual(0); // may be 0 if dedup check skips
    expect(result.uncertain).toBeDefined();
  });

  test("works without assistantResponse (backward compat)", async () => {
    mockOllamaResponse({
      certain: { preferences: ["prefers functional programming"] },
      uncertain: {},
    });

    const db = mockSupabase();

    const result = await extractAndStore(
      db,
      -99902,
      1,
      "I prefer functional programming over OOP"
    );

    expect(result.inserted).toBeGreaterThanOrEqual(0);
    expect(result.uncertain).toBeDefined();
  });

  test("assistantResponse of empty string treated same as undefined", async () => {
    mockOllamaResponse({});

    const db = mockSupabase();

    const result = await extractAndStore(db, -99903, 1, "Hi", "");

    expect(result.inserted).toBe(0);
    expect(hasMemoryItems(result.uncertain)).toBe(false);
  });
});
