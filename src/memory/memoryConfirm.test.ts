/**
 * Tests for memory confirmation module
 *
 * Run: bun test src/memory/memoryConfirm.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  setPendingConfirmation,
  hasPendingConfirmation,
  clearPendingConfirmation,
  getPendingConfirmation,
  buildMemoryConfirmMessage,
  buildMemoryConfirmKeyboard,
  handleMemoryConfirmCallback,
} from "./memoryConfirm.ts";

// ============================================================
// Supabase mock
// ============================================================

function mockSupabase(insertFn?: ReturnType<typeof mock>) {
  const defaultInsert = insertFn ?? mock(() => Promise.resolve({ data: null, error: null }));
  return {
    from: mock(() => ({
      insert: defaultInsert,
    })),
    _insertFn: defaultInsert,
  } as any;
}

// ============================================================
// Pending confirmation state
// ============================================================

describe("pending confirmation state", () => {
  const CHAT_ID = 42001;

  beforeEach(() => {
    clearPendingConfirmation(CHAT_ID);
  });

  test("hasPendingConfirmation returns false when nothing is set", () => {
    expect(hasPendingConfirmation(CHAT_ID)).toBe(false);
  });

  test("hasPendingConfirmation returns true after setPendingConfirmation", () => {
    setPendingConfirmation(CHAT_ID, { facts: ["Works at GovTech"] });
    expect(hasPendingConfirmation(CHAT_ID)).toBe(true);
  });

  test("getPendingConfirmation returns the stored memories", () => {
    const memories = { facts: ["Works at GovTech"], goals: ["Ship v2"] };
    setPendingConfirmation(CHAT_ID, memories);
    expect(getPendingConfirmation(CHAT_ID)).toEqual(memories);
  });

  test("getPendingConfirmation returns undefined when nothing is set", () => {
    expect(getPendingConfirmation(CHAT_ID)).toBeUndefined();
  });

  test("clearPendingConfirmation removes the state", () => {
    setPendingConfirmation(CHAT_ID, { facts: ["Works at GovTech"] });
    clearPendingConfirmation(CHAT_ID);
    expect(hasPendingConfirmation(CHAT_ID)).toBe(false);
    expect(getPendingConfirmation(CHAT_ID)).toBeUndefined();
  });

  test("overwriting an existing entry replaces it", () => {
    setPendingConfirmation(CHAT_ID, { facts: ["Old fact"] });
    setPendingConfirmation(CHAT_ID, { facts: ["New fact"] });
    expect(getPendingConfirmation(CHAT_ID)?.facts).toEqual(["New fact"]);
  });
});

// ============================================================
// buildMemoryConfirmMessage
// ============================================================

describe("buildMemoryConfirmMessage", () => {
  test("returns empty string for empty memories object", () => {
    expect(buildMemoryConfirmMessage({})).toBe("");
  });

  test("returns empty string for memories with only empty arrays", () => {
    expect(buildMemoryConfirmMessage({ facts: [], preferences: [], goals: [], dates: [] })).toBe("");
  });

  test("formats facts as bullet points", () => {
    const msg = buildMemoryConfirmMessage({ facts: ["Works at GovTech", "Lives in Singapore"] });
    expect(msg).toContain("• Works at GovTech");
    expect(msg).toContain("• Lives in Singapore");
  });

  test("formats preferences as bullet points", () => {
    const msg = buildMemoryConfirmMessage({ preferences: ["Prefers dark mode"] });
    expect(msg).toContain("• Prefers dark mode");
  });

  test("formats goals as bullet points", () => {
    const msg = buildMemoryConfirmMessage({ goals: ["Ship v2 by March"] });
    expect(msg).toContain("• Ship v2 by March");
  });

  test("formats dates as bullet points", () => {
    const msg = buildMemoryConfirmMessage({ dates: ["Birthday March 15"] });
    expect(msg).toContain("• Birthday March 15");
  });

  test("includes intro and 'Save these?' footer", () => {
    const msg = buildMemoryConfirmMessage({ facts: ["Works at GovTech"] });
    expect(msg).toContain("I noticed a few things you might want me to remember");
    expect(msg).toContain("Save these?");
  });

  test("combines all memory types into one message", () => {
    const msg = buildMemoryConfirmMessage({
      facts: ["Works at GovTech"],
      goals: ["Ship v2"],
      preferences: ["Dark mode"],
      dates: ["Birthday March 15"],
    });
    expect(msg).toContain("• Works at GovTech");
    expect(msg).toContain("• Ship v2");
    expect(msg).toContain("• Dark mode");
    expect(msg).toContain("• Birthday March 15");
  });
});

// ============================================================
// buildMemoryConfirmKeyboard
// ============================================================

describe("buildMemoryConfirmKeyboard", () => {
  test("keyboard contains Save callback data", () => {
    const keyboard = buildMemoryConfirmKeyboard(12345);
    const flat = keyboard.inline_keyboard.flat();
    const saveBtn = flat.find((b: any) => b.callback_data === "memconf:save:12345");
    expect(saveBtn).toBeDefined();
  });

  test("keyboard contains Skip callback data", () => {
    const keyboard = buildMemoryConfirmKeyboard(12345);
    const flat = keyboard.inline_keyboard.flat();
    const skipBtn = flat.find((b: any) => b.callback_data === "memconf:skip:12345");
    expect(skipBtn).toBeDefined();
  });

  test("keyboard embeds the chatId in callback data", () => {
    const keyboard = buildMemoryConfirmKeyboard(99999);
    const flat = keyboard.inline_keyboard.flat();
    const saveBtn = flat.find((b: any) => b.callback_data?.includes("99999"));
    expect(saveBtn).toBeDefined();
  });
});

// ============================================================
// handleMemoryConfirmCallback
// ============================================================

describe("handleMemoryConfirmCallback", () => {
  const CHAT_ID = 42002;

  beforeEach(() => {
    clearPendingConfirmation(CHAT_ID);
  });

  test("returns 'unknown' for non-memconf data", async () => {
    const sb = mockSupabase();
    const result = await handleMemoryConfirmCallback("routine_target:personal:123", sb, CHAT_ID);
    expect(result).toBe("unknown");
  });

  test("returns 'unknown' when there is no pending confirmation", async () => {
    const sb = mockSupabase();
    const result = await handleMemoryConfirmCallback(`memconf:save:${CHAT_ID}`, sb, CHAT_ID);
    expect(result).toBe("unknown");
  });

  test("returns 'saved' and stores memories when action is 'save'", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase(insertFn);

    setPendingConfirmation(CHAT_ID, { facts: ["Works at GovTech"] });
    const result = await handleMemoryConfirmCallback(`memconf:save:${CHAT_ID}`, sb, CHAT_ID);

    expect(result).toBe("saved");
    expect(insertFn).toHaveBeenCalledTimes(1);
    const rows = insertFn.mock.calls[0][0];
    expect(rows[0].content).toBe("Works at GovTech");
  });

  test("returns 'skipped' and does NOT store memories when action is 'skip'", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase(insertFn);

    setPendingConfirmation(CHAT_ID, { facts: ["Works at GovTech"] });
    const result = await handleMemoryConfirmCallback(`memconf:skip:${CHAT_ID}`, sb, CHAT_ID);

    expect(result).toBe("skipped");
    expect(insertFn).not.toHaveBeenCalled();
  });

  test("clears pending confirmation after save", async () => {
    const sb = mockSupabase();
    setPendingConfirmation(CHAT_ID, { facts: ["Works at GovTech"] });
    await handleMemoryConfirmCallback(`memconf:save:${CHAT_ID}`, sb, CHAT_ID);
    expect(hasPendingConfirmation(CHAT_ID)).toBe(false);
  });

  test("clears pending confirmation after skip", async () => {
    const sb = mockSupabase();
    setPendingConfirmation(CHAT_ID, { facts: ["Works at GovTech"] });
    await handleMemoryConfirmCallback(`memconf:skip:${CHAT_ID}`, sb, CHAT_ID);
    expect(hasPendingConfirmation(CHAT_ID)).toBe(false);
  });

  test("stores all memory types (facts, goals, preferences, dates) on save", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const sb = mockSupabase(insertFn);

    setPendingConfirmation(CHAT_ID, {
      facts: ["Works at GovTech"],
      goals: ["Ship v2"],
      preferences: ["Dark mode"],
      dates: ["Birthday March 15"],
    });
    const result = await handleMemoryConfirmCallback(`memconf:save:${CHAT_ID}`, sb, CHAT_ID);

    expect(result).toBe("saved");
    const rows = insertFn.mock.calls[0][0];
    expect(rows).toHaveLength(4);
    const types = rows.map((r: any) => r.type);
    expect(types).toContain("fact");
    expect(types).toContain("goal");
    expect(types).toContain("preference");
  });
});
