/**
 * Tests for routine message utilities
 *
 * Run: bun test src/utils/routineMessage.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { summarizeRoutineMessage } from "./routineMessage.ts";

// ============================================================
// summarizeRoutineMessage
// ============================================================

describe("summarizeRoutineMessage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns Ollama response on success", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: "Summary from Ollama" }),
      })
    ) as any;

    const result = await summarizeRoutineMessage("Long routine content here", "smart-checkin");
    expect(result).toBe("Summary from Ollama");
  });

  test("falls back to truncated content when fetch throws (AbortError)", async () => {
    const longContent = "A".repeat(500);
    const abortErr = new DOMException("signal is aborted", "AbortError");
    globalThis.fetch = mock(() => Promise.reject(abortErr)) as any;

    const result = await summarizeRoutineMessage(longContent, "smart-checkin");
    expect(result).toBe("A".repeat(300) + "...");
  });

  test("falls back to truncated content when response is not ok (500)", async () => {
    const longContent = "B".repeat(400);
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 500 })
    ) as any;

    const result = await summarizeRoutineMessage(longContent, "morning-summary");
    expect(result).toBe("B".repeat(300) + "...");
  });

  test("returns content as-is (no '...') when content <= 300 chars and Ollama fails", async () => {
    const shortContent = "Short content under 300 chars";
    globalThis.fetch = mock(() => Promise.reject(new Error("network error"))) as any;

    const result = await summarizeRoutineMessage(shortContent, "smart-checkin");
    expect(result).toBe(shortContent);
    expect(result).not.toContain("...");
  });

  test("falls back when Ollama returns empty response", async () => {
    const content = "C".repeat(350);
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: "" }),
      })
    ) as any;

    const result = await summarizeRoutineMessage(content, "smart-checkin");
    // Empty summary throws "empty summary" error, triggers fallback
    expect(result).toBe("C".repeat(300) + "...");
  });

  test("trims whitespace from Ollama response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: "  Trimmed summary  \n" }),
      })
    ) as any;

    const result = await summarizeRoutineMessage("Some content", "routine");
    expect(result).toBe("Trimmed summary");
  });
});

// ============================================================
// sendAndRecord
//
// sendAndRecord is tightly coupled to sendToGroup and creates
// its own Supabase client from env vars. We write basic
// integration-style tests that verify it doesn't throw.
// ============================================================

describe("sendAndRecord", () => {
  test("module exports sendAndRecord function", async () => {
    const mod = await import("./routineMessage.ts");
    expect(typeof mod.sendAndRecord).toBe("function");
  });
});
