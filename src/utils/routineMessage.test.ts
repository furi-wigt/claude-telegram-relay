/**
 * Tests for routine message utilities
 *
 * Run: bun test src/utils/routineMessage.test.ts
 *
 * Isolation note: routineMessage.ts imports callRoutineModel from ../routines/routineModel.ts.
 * We mock the module before importing so this file owns the mock.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock routineModel.ts BEFORE importing the module under test ─────────────
const callRoutineModelMock = mock(async (_prompt: string, _options?: unknown): Promise<string> => "");

mock.module("../routines/routineModel.ts", () => ({
  callRoutineModel: callRoutineModelMock,
  getLastProvider: () => "mlx",
}));

// Import AFTER mocking so routineMessage.ts picks up our mock
const { summarizeRoutineMessage, sendAndRecord } = await import("./routineMessage.ts");

// ============================================================
// summarizeRoutineMessage
// ============================================================

describe("summarizeRoutineMessage", () => {
  beforeEach(() => {
    callRoutineModelMock.mockReset();
  });

  test("returns model response on success", async () => {
    callRoutineModelMock.mockResolvedValue("Summary from MLX");

    const result = await summarizeRoutineMessage("Long routine content here", "smart-checkin");
    expect(result).toBe("Summary from MLX");
  });

  test("falls back to truncated content when model throws (AbortError)", async () => {
    const longContent = "A".repeat(500);
    const abortErr = new DOMException("signal is aborted", "AbortError");
    callRoutineModelMock.mockRejectedValue(abortErr);

    const result = await summarizeRoutineMessage(longContent, "smart-checkin");
    expect(result).toBe("A".repeat(300) + "...");
  });

  test("falls back to truncated content when model returns HTTP 500", async () => {
    const longContent = "B".repeat(400);
    callRoutineModelMock.mockRejectedValue(new Error("Ollama API error: HTTP 500"));

    const result = await summarizeRoutineMessage(longContent, "morning-summary");
    expect(result).toBe("B".repeat(300) + "...");
  });

  test("returns content as-is (no '...') when content <= 300 chars and model fails", async () => {
    const shortContent = "Short content under 300 chars";
    callRoutineModelMock.mockRejectedValue(new Error("network error"));

    const result = await summarizeRoutineMessage(shortContent, "smart-checkin");
    expect(result).toBe(shortContent);
    expect(result).not.toContain("...");
  });

  test("falls back when model returns empty response", async () => {
    const content = "C".repeat(350);
    callRoutineModelMock.mockResolvedValue("");

    const result = await summarizeRoutineMessage(content, "smart-checkin");
    expect(result).toBe("C".repeat(300) + "...");
  });

  test("passes through trimmed response unchanged", async () => {
    callRoutineModelMock.mockResolvedValue("Trimmed summary");

    const result = await summarizeRoutineMessage("Some content", "routine");
    expect(result).toBe("Trimmed summary");
  });
});

// ============================================================
// sendAndRecord
// ============================================================

describe("sendAndRecord", () => {
  test("module exports sendAndRecord function", () => {
    expect(typeof sendAndRecord).toBe("function");
  });
});
