/**
 * Tests for saveCommandInteraction utility
 *
 * Run: bun test src/utils/saveMessage.test.ts
 */

import { describe, test, expect, mock } from "bun:test";

// Mock storageBackend so tests don't hit SQLite/Qdrant/Ollama
const mockInsertMessageRecord = mock(async () => ({ id: "test-id", error: null }));
mock.module("../local/storageBackend", () => ({
  insertMessageRecord: mockInsertMessageRecord,
}));

const { saveCommandInteraction } = await import("./saveMessage.ts");

describe("saveCommandInteraction", () => {
  test("inserts user and assistant messages as a pair", async () => {
    mockInsertMessageRecord.mockClear();

    await saveCommandInteraction(12345, "/status", "Session active");

    // insertMessageRecord is called twice (user + assistant)
    expect(mockInsertMessageRecord).toHaveBeenCalledTimes(2);

    const userRow = mockInsertMessageRecord.mock.calls[0][0] as any;
    expect(userRow.role).toBe("user");
    expect(userRow.content).toBe("/status");
    expect(userRow.chat_id).toBe(12345);
    expect(userRow.metadata).toEqual({ source: "command" });

    const assistantRow = mockInsertMessageRecord.mock.calls[1][0] as any;
    expect(assistantRow.role).toBe("assistant");
    expect(assistantRow.content).toBe("Session active");
    expect(assistantRow.chat_id).toBe(12345);
    expect(assistantRow.metadata).toEqual({ source: "command" });
  });

  test("catches and logs insert errors without throwing", async () => {
    mockInsertMessageRecord.mockImplementation(async () => { throw new Error("DB error"); });

    // Should not throw
    await expect(
      saveCommandInteraction(12345, "/cmd", "reply")
    ).resolves.toBeUndefined();

    // Restore default
    mockInsertMessageRecord.mockImplementation(async () => ({ id: "test-id", error: null }));
  });
});
