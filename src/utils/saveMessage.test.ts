/**
 * Tests for saveCommandInteraction utility
 *
 * Run: bun test src/utils/saveMessage.test.ts
 */

import { describe, test, expect, mock } from "bun:test";
import { saveCommandInteraction } from "./saveMessage.ts";

describe("saveCommandInteraction", () => {
  test("inserts user and assistant messages as a pair", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const supabase = { from: mock(() => ({ insert: insertFn })) } as any;

    await saveCommandInteraction(supabase, 12345, "/status", "Session active");

    expect(insertFn).toHaveBeenCalledTimes(1);
    const rows = insertFn.mock.calls[0][0] as any[];
    expect(rows).toHaveLength(2);

    const [userRow, assistantRow] = rows;
    expect(userRow.role).toBe("user");
    expect(userRow.content).toBe("/status");
    expect(userRow.chat_id).toBe(12345);
    expect(userRow.channel).toBe("telegram");
    expect(userRow.metadata).toEqual({ source: "command" });

    expect(assistantRow.role).toBe("assistant");
    expect(assistantRow.content).toBe("Session active");
    expect(assistantRow.chat_id).toBe(12345);
    expect(assistantRow.channel).toBe("telegram");
    expect(assistantRow.metadata).toEqual({ source: "command" });
  });

  test("is a no-op when supabase is null", async () => {
    // Should resolve without throwing
    await expect(
      saveCommandInteraction(null, 12345, "/status", "reply")
    ).resolves.toBeUndefined();
  });

  test("catches and logs insert errors without throwing", async () => {
    const insertFn = mock(() => Promise.reject(new Error("DB error")));
    const supabase = { from: mock(() => ({ insert: insertFn })) } as any;

    // Should not throw
    await expect(
      saveCommandInteraction(supabase, 12345, "/cmd", "reply")
    ).resolves.toBeUndefined();
  });

  test("inserts into the 'messages' table", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const fromFn = mock(() => ({ insert: insertFn }));
    const supabase = { from: fromFn } as any;

    await saveCommandInteraction(supabase, 99, "/memory", "result");

    expect(fromFn).toHaveBeenCalledWith("messages");
  });
});
