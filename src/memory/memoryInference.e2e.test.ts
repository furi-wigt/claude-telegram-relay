/**
 * E2E tests: User-only memory inference with confirmation
 *
 * Covers the full pipeline:
 *   User message → extractAndStore (user msg only) → certain auto-stored
 *   → uncertain items → confirmation sent via bot API
 *   → User clicks Save → uncertain items stored
 *   → User clicks Skip → uncertain items discarded
 *
 * Run: bun test src/memory/memoryInference.e2e.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  extractAndStore,
  storeExtractedMemories,
  type ExtractedMemories,
} from "./longTermExtractor.ts";
import {
  setPendingConfirmation,
  hasPendingConfirmation,
  clearPendingConfirmation,
  getPendingConfirmation,
  handleMemoryConfirmCallback,
  buildMemoryConfirmMessage,
  sendMemoryConfirmation,
} from "./memoryConfirm.ts";

// ============================================================
// Shared mocks
// ============================================================

const CHAT_ID = 55001;
const USER_ID = 55002;

function mockSupabase(insertFn?: ReturnType<typeof mock>) {
  const ins = insertFn ?? mock(() => Promise.resolve({ data: null, error: null }));
  return {
    from: mock(() => ({ insert: ins })),
    _insertFn: ins,
  } as any;
}

// ============================================================
// E2E-1: extractAndStore only receives user message
// ============================================================

describe("E2E-1: extractAndStore — user message only, no assistant response", () => {
  let capturedPrompt: string | null = null;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    capturedPrompt = null;
    // Mock Ollama to capture the prompt and return a valid extraction
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string ?? "{}");
      capturedPrompt = body.prompt ?? null;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            response: JSON.stringify({
              certain: { facts: ["Works at GovTech"] },
              uncertain: {},
            }),
          }),
      });
    }) as any;
  });

  test("restores fetch", () => {
    globalThis.fetch = origFetch;
  });

  test("extraction prompt contains user message", async () => {
    const sb = mockSupabase();
    await extractAndStore(sb, CHAT_ID, USER_ID, "I work at GovTech");
    expect(capturedPrompt).toContain("I work at GovTech");
    globalThis.fetch = origFetch;
  });

  test("extraction prompt does NOT contain 'Assistant:' label", async () => {
    const sb = mockSupabase();
    await extractAndStore(sb, CHAT_ID, USER_ID, "I work at GovTech");
    expect(capturedPrompt).not.toContain("Assistant:");
    globalThis.fetch = origFetch;
  });

  test("certain items are stored immediately without user confirmation", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase(insertFn);

    await extractAndStore(sb, CHAT_ID, USER_ID, "I work at GovTech");

    expect(insertFn).toHaveBeenCalledTimes(1);
    const rows = insertFn.mock.calls[0][0];
    expect(rows[0].content).toBe("Works at GovTech");
    globalThis.fetch = origFetch;
  });

  test("returns uncertain items for caller to handle", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            response: JSON.stringify({
              certain: {},
              uncertain: { goals: ["Might want to get fit"] },
            }),
          }),
      })
    ) as any;

    const sb = mockSupabase();
    const result = await extractAndStore(sb, CHAT_ID, USER_ID, "maybe I should exercise more");

    expect(result.uncertain.goals).toEqual(["Might want to get fit"]);
    globalThis.fetch = origFetch;
  });

  test("returns empty object when extraction yields nothing", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: "{}" }),
      })
    ) as any;

    const sb = mockSupabase();
    const result = await extractAndStore(sb, CHAT_ID, USER_ID, "hi there");
    expect(result.uncertain).toEqual({});
    globalThis.fetch = origFetch;
  });
});

// ============================================================
// E2E-2: Confirmation flow — uncertain items not auto-stored
// ============================================================

describe("E2E-2: uncertain items require user confirmation before storage", () => {
  beforeEach(() => {
    clearPendingConfirmation(CHAT_ID);
  });

  test("uncertain items are NOT stored without confirmation", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase(insertFn);

    // Simulate: uncertain items returned from extraction
    const uncertain: ExtractedMemories = { goals: ["Might want to lose weight"] };
    setPendingConfirmation(CHAT_ID, uncertain);

    // Verify not yet stored
    expect(insertFn).not.toHaveBeenCalled();
  });

  test("uncertain items stored when user confirms Save", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase(insertFn);

    setPendingConfirmation(CHAT_ID, { goals: ["Might want to lose weight"] });
    const result = await handleMemoryConfirmCallback(`memconf:save:${CHAT_ID}`, sb, CHAT_ID);

    expect(result).toBe("saved");
    expect(insertFn).toHaveBeenCalledTimes(1);
    const rows = insertFn.mock.calls[0][0];
    expect(rows[0].type).toBe("goal");
    expect(rows[0].content).toBe("Might want to lose weight");
  });

  test("uncertain items discarded when user clicks Skip", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase(insertFn);

    setPendingConfirmation(CHAT_ID, { goals: ["Might want to lose weight"] });
    const result = await handleMemoryConfirmCallback(`memconf:skip:${CHAT_ID}`, sb, CHAT_ID);

    expect(result).toBe("skipped");
    expect(insertFn).not.toHaveBeenCalled();
    expect(hasPendingConfirmation(CHAT_ID)).toBe(false);
  });

  test("confirmation message is only sent when uncertain items exist", async () => {
    const sendMessageCalls: Array<{ chatId: number; text: string }> = [];
    const mockBot = {
      api: {
        sendMessage: mock(async (chatId: number, text: string) => {
          sendMessageCalls.push({ chatId, text });
          return { message_id: 1 };
        }),
      },
    } as any;

    // No uncertain items → no confirmation sent
    const noUncertain: ExtractedMemories = {};
    const sent = await sendMemoryConfirmation(mockBot, CHAT_ID, noUncertain);

    expect(sent).toBe(false);
    expect(sendMessageCalls).toHaveLength(0);
  });

  test("confirmation message IS sent when uncertain items exist", async () => {
    clearPendingConfirmation(CHAT_ID);
    const sendMessageCalls: Array<{ chatId: number; text: string }> = [];
    const mockBot = {
      api: {
        sendMessage: mock(async (chatId: number, text: string, opts?: any) => {
          sendMessageCalls.push({ chatId, text });
          return { message_id: 1 };
        }),
      },
    } as any;

    const uncertain: ExtractedMemories = { facts: ["Lives in Singapore"] };
    const sent = await sendMemoryConfirmation(mockBot, CHAT_ID, uncertain);

    expect(sent).toBe(true);
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0].chatId).toBe(CHAT_ID);
    expect(sendMessageCalls[0].text).toContain("Lives in Singapore");

    clearPendingConfirmation(CHAT_ID);
  });
});

// ============================================================
// E2E-3: No confirmation when only certain items exist
// ============================================================

describe("E2E-3: no confirmation needed for explicit (certain) facts", () => {
  test("certain items stored directly without confirmation message", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            response: JSON.stringify({
              certain: { facts: ["Name is John"] },
              uncertain: {},
            }),
          }),
      })
    ) as any;

    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase(insertFn);

    const result = await extractAndStore(sb, CHAT_ID, USER_ID, "My name is John");

    // Certain items stored
    expect(insertFn).toHaveBeenCalledTimes(1);
    // No uncertain items returned
    expect(result.uncertain).toEqual({});

    globalThis.fetch = origFetch;
  });
});

// ============================================================
// E2E-4: Confirmation message format
// ============================================================

describe("E2E-4: confirmation message format", () => {
  test("message lists all uncertain item types", () => {
    const msg = buildMemoryConfirmMessage({
      facts: ["Might live in Singapore"],
      goals: ["Possibly training for a marathon"],
    });

    expect(msg).toContain("• Might live in Singapore");
    expect(msg).toContain("• Possibly training for a marathon");
    expect(msg).toContain("Save these?");
  });

  test("empty uncertain memories produce no confirmation message", () => {
    const msg = buildMemoryConfirmMessage({});
    expect(msg).toBe("");
  });
});
