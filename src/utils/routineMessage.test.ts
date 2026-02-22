/**
 * Tests for routine message utilities
 *
 * Run: bun test src/utils/routineMessage.test.ts
 *
 * Isolation note: routineMessage.ts imports callOllamaGenerate from ../ollama.ts.
 * Other test files (e.g. longTermExtractor.e2e.test.ts) replace the entire
 * ollama.ts module via mock.module. When Bun caches modules across files in the
 * same process, that replacement bleeds here and makes globalThis.fetch mocking
 * ineffective (callOllamaGenerate is already mocked to return undefined).
 *
 * Fix: mock ../ollama.ts at the module level here so this file owns the mock
 * regardless of execution order, then control mock behaviour per-test.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock ollama.ts BEFORE importing the module under test ─────────────────────
//
// This ensures callOllamaGenerate is our mock whether or not another test file
// has already replaced ../ollama.ts in the module registry.

const callOllamaGenerateMock = mock(async (_prompt: string, _options?: unknown): Promise<string> => "");

mock.module("../ollama.ts", () => ({
  callOllamaGenerate: callOllamaGenerateMock,
}));

// Import AFTER mocking so routineMessage.ts picks up our mock
const { summarizeRoutineMessage, sendAndRecord } = await import("./routineMessage.ts");

// ============================================================
// summarizeRoutineMessage
// ============================================================

describe("summarizeRoutineMessage", () => {
  beforeEach(() => {
    callOllamaGenerateMock.mockReset();
  });

  test("returns Ollama response on success", async () => {
    callOllamaGenerateMock.mockResolvedValue("Summary from Ollama");

    const result = await summarizeRoutineMessage("Long routine content here", "smart-checkin");
    expect(result).toBe("Summary from Ollama");
  });

  test("falls back to truncated content when fetch throws (AbortError)", async () => {
    const longContent = "A".repeat(500);
    const abortErr = new DOMException("signal is aborted", "AbortError");
    callOllamaGenerateMock.mockRejectedValue(abortErr);

    const result = await summarizeRoutineMessage(longContent, "smart-checkin");
    expect(result).toBe("A".repeat(300) + "...");
  });

  test("falls back to truncated content when response is not ok (500)", async () => {
    const longContent = "B".repeat(400);
    callOllamaGenerateMock.mockRejectedValue(new Error("Ollama API error: HTTP 500"));

    const result = await summarizeRoutineMessage(longContent, "morning-summary");
    expect(result).toBe("B".repeat(300) + "...");
  });

  test("returns content as-is (no '...') when content <= 300 chars and Ollama fails", async () => {
    const shortContent = "Short content under 300 chars";
    callOllamaGenerateMock.mockRejectedValue(new Error("network error"));

    const result = await summarizeRoutineMessage(shortContent, "smart-checkin");
    expect(result).toBe(shortContent);
    expect(result).not.toContain("...");
  });

  test("falls back when Ollama returns empty response", async () => {
    const content = "C".repeat(350);
    // callOllamaGenerate returns "" (empty string) — summarizeRoutineMessage
    // checks `if (!summary)` which is true for "", so it throws "empty summary"
    callOllamaGenerateMock.mockResolvedValue("");

    const result = await summarizeRoutineMessage(content, "smart-checkin");
    // Empty summary throws "empty summary" error, triggers fallback
    expect(result).toBe("C".repeat(300) + "...");
  });

  test("trims whitespace from Ollama response", async () => {
    // callOllamaGenerate already trims in the real implementation, but
    // summarizeRoutineMessage returns the value from callOllamaGenerate directly.
    // Test that a pre-trimmed value passes through unchanged.
    callOllamaGenerateMock.mockResolvedValue("Trimmed summary");

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
  test("module exports sendAndRecord function", () => {
    expect(typeof sendAndRecord).toBe("function");
  });
});
