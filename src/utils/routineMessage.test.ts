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
}));

// ── Mock sendToGroup so sendAndRecord can be called without real network ─────
const sendToGroupMock = mock(async (_chatId: number, _message: string, _opts?: unknown): Promise<number | undefined> => undefined);

mock.module("./sendToGroup.ts", () => ({
  sendToGroup: sendToGroupMock,
}));

// ── Mock storage dependencies ────────────────────────────────────────────────
mock.module("../local/storageBackend", () => ({
  insertMessageRecord: mock(async () => undefined),
}));

mock.module("../memory/shortTermMemory.ts", () => ({
  ROUTINE_SOURCE: "routine",
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
// sendAndRecord — HTML overflow guard
// ============================================================

describe("sendAndRecord", () => {
  beforeEach(() => {
    sendToGroupMock.mockReset();
    callRoutineModelMock.mockResolvedValue("summary");
  });

  test("module exports sendAndRecord function", () => {
    expect(typeof sendAndRecord).toBe("function");
  });

  test("sends normal markdown as HTML when converted length <= 4096", async () => {
    const markdown = "**Hello world**";

    await sendAndRecord(-1001234567, markdown, {
      routineName: "night-summary",
      agentId: "general-assistant",
      topicId: null,
    });

    expect(sendToGroupMock).toHaveBeenCalledTimes(1);
    const [, sentText, sentOpts] = sendToGroupMock.mock.calls[0] as [number, string, Record<string, unknown>];
    expect(sentOpts.parseMode).toBe("HTML");
    expect(sentText).toContain("<b>Hello world</b>");
  });

  test("strips tags and sends plain text when HTML exceeds 4096 chars", async () => {
    // Build markdown that expands heavily. Use H1 headings — each `# Heading\n`
    // (63 chars) → `<b><u>Heading</u></b>\n` (75 chars HTML, ~19% expansion).
    // 62 lines = 3906 chars md. splitMarkdown splits at ~3781 producing chunk 0
    // of 4501 HTML chars (> 4096) and a small tail chunk of 136 HTML chars.
    const headingLine = "# " + "A".repeat(60) + "\n";
    const mdChunk = headingLine.repeat(62);

    await sendAndRecord(-1001234567, mdChunk, {
      routineName: "night-summary",
      agentId: "general-assistant",
      topicId: null,
    });

    // At least one sendToGroup call must have been plain text (overflow path)
    const plainCalls = sendToGroupMock.mock.calls.filter(c => {
      const opts = c[2] as Record<string, unknown> | undefined;
      return opts?.parseMode === undefined;
    });
    expect(plainCalls.length).toBeGreaterThan(0);

    // The plain-text calls must contain heading content without HTML tags
    const plainTexts = plainCalls.map(c => c[1] as string).join("");
    expect(plainTexts).not.toMatch(/<[^>]+>/);
    expect(plainTexts).toContain("A".repeat(60));
  });

  test("attaches reply_markup only to the last sub-chunk on overflow", async () => {
    // Force the first markdown chunk to overflow by using 62 × H1 headings.
    // The overflow path splits into multiple sub-chunks; reply_markup must only
    // go on the very last call across ALL sub-chunks and normal chunks.
    const headingLine = "# " + "B".repeat(60) + "\n";
    const mdChunk = headingLine.repeat(62);
    const fakeMarkup = { inline_keyboard: [[{ text: "btn", callback_data: "x" }]] };

    await sendAndRecord(-1001234567, mdChunk, {
      routineName: "night-summary",
      agentId: "general-assistant",
      topicId: null,
      reply_markup: fakeMarkup,
    });

    const calls = sendToGroupMock.mock.calls;
    expect(calls.length).toBeGreaterThan(1);

    // Only the very last call should carry reply_markup
    const lastOpts = calls[calls.length - 1][2] as Record<string, unknown>;
    expect(lastOpts.reply_markup).toBe(fakeMarkup);
    for (let i = 0; i < calls.length - 1; i++) {
      const opts = calls[i][2] as Record<string, unknown>;
      expect(opts.reply_markup).toBeUndefined();
    }
  });
});
