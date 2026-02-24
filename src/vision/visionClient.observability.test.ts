/**
 * Observability tests for src/vision/visionClient.ts
 *
 * Verifies that analyzeImage() emits trace events (vision_start,
 * vision_complete, vision_error) for each analysis attempt.
 * Uses a separate file so mock.module declarations for tracer.ts
 * don't interfere with the main visionClient.test.ts.
 *
 * Run: bun test src/vision/visionClient.observability.test.ts
 */

import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";

// ── Mocks (must precede await import) ────────────────────────────────────────

const mockClaudeText = mock(() =>
  Promise.resolve("Image shows a Telegram chat interface.")
);
mock.module("../claude-process.ts", () => ({
  claudeText: mockClaudeText,
}));

const mockTrace = mock((_event: Record<string, unknown>) => {});
mock.module("../utils/tracer.ts", () => ({
  trace: mockTrace,
  generateTraceId: () => "test-trace-id",
}));

const { analyzeImage, analyzeImages, VISION_MODEL } = await import(
  "./visionClient.ts"
);

// ── Helpers ───────────────────────────────────────────────────────────────────

const jpegBuf = () => Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const pngBuf = () =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ── analyzeImage — trace events ───────────────────────────────────────────────

describe("analyzeImage — trace events", () => {
  beforeEach(() => {
    mockTrace.mockClear();
    mockClaudeText.mockClear();
    mockClaudeText.mockResolvedValue("Image shows a Telegram chat interface.");
    spyOn(Bun, "write").mockResolvedValue(0 as unknown as number);
  });

  test("emits vision_start before calling claudeText", async () => {
    await analyzeImage(jpegBuf(), "What is this?");

    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    expect(events).toContain("vision_start");

    const startIdx = events.indexOf("vision_start");
    expect(startIdx).toBeGreaterThanOrEqual(0);
  });

  test("vision_start includes imageSizeBytes", async () => {
    const buf = jpegBuf();
    await analyzeImage(buf, "Describe");

    const startCall = mockTrace.mock.calls.find(
      (c) => (c[0] as any).event === "vision_start"
    );
    expect(startCall).toBeDefined();
    expect((startCall![0] as any).imageSizeBytes).toBe(buf.length);
  });

  test("vision_start includes model name", async () => {
    await analyzeImage(jpegBuf(), "Describe");

    const startCall = mockTrace.mock.calls.find(
      (c) => (c[0] as any).event === "vision_start"
    );
    expect((startCall![0] as any).model).toBe(VISION_MODEL);
  });

  test("emits vision_complete after successful analysis", async () => {
    await analyzeImage(jpegBuf(), "What is this?");

    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    expect(events).toContain("vision_complete");
  });

  test("vision_complete includes durationMs as a number", async () => {
    await analyzeImage(jpegBuf(), "Describe");

    const completeCall = mockTrace.mock.calls.find(
      (c) => (c[0] as any).event === "vision_complete"
    );
    expect(completeCall).toBeDefined();
    expect(typeof (completeCall![0] as any).durationMs).toBe("number");
    expect((completeCall![0] as any).durationMs).toBeGreaterThanOrEqual(0);
  });

  test("vision_complete includes responseLength", async () => {
    const response = "A detailed image description here.";
    mockClaudeText.mockResolvedValue(response);

    await analyzeImage(jpegBuf(), "Describe");

    const completeCall = mockTrace.mock.calls.find(
      (c) => (c[0] as any).event === "vision_complete"
    );
    expect((completeCall![0] as any).responseLength).toBe(response.length);
  });

  test("emits vision_error when claudeText throws", async () => {
    mockClaudeText.mockRejectedValueOnce(new Error("CLI spawn failed"));

    await expect(analyzeImage(jpegBuf(), "What?")).rejects.toThrow(
      "CLI spawn failed"
    );

    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    expect(events).toContain("vision_error");
  });

  test("vision_error includes error message", async () => {
    mockClaudeText.mockRejectedValueOnce(new Error("timeout after 60s"));

    await expect(analyzeImage(jpegBuf(), "What?")).rejects.toThrow();

    const errorCall = mockTrace.mock.calls.find(
      (c) => (c[0] as any).event === "vision_error"
    );
    expect(errorCall).toBeDefined();
    expect((errorCall![0] as any).error).toContain("timeout after 60s");
  });

  test("vision_error still rethrows so caller receives the error", async () => {
    mockClaudeText.mockRejectedValueOnce(new Error("service unavailable"));

    await expect(analyzeImage(jpegBuf(), "What?")).rejects.toThrow(
      "service unavailable"
    );
  });

  test("no vision_error emitted on success", async () => {
    await analyzeImage(jpegBuf(), "Describe");

    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    expect(events).not.toContain("vision_error");
  });

  test("vision_start emitted before vision_complete (ordering)", async () => {
    await analyzeImage(jpegBuf(), "What is this?");

    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    const startIdx = events.indexOf("vision_start");
    const completeIdx = events.indexOf("vision_complete");
    expect(startIdx).toBeLessThan(completeIdx);
  });
});

// ── analyzeImages — batch trace events ───────────────────────────────────────

describe("analyzeImages — batch trace events", () => {
  beforeEach(() => {
    mockTrace.mockClear();
    mockClaudeText.mockClear();
    mockClaudeText.mockResolvedValue("described");
    spyOn(Bun, "write").mockResolvedValue(0 as unknown as number);
  });

  test("emits vision_batch_start before processing images", async () => {
    await analyzeImages([jpegBuf(), pngBuf()], "describe each");

    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    expect(events).toContain("vision_batch_start");
  });

  test("vision_batch_start includes imageCount", async () => {
    await analyzeImages([jpegBuf(), pngBuf(), jpegBuf()], "describe");

    const batchStart = mockTrace.mock.calls.find(
      (c) => (c[0] as any).event === "vision_batch_start"
    );
    expect((batchStart![0] as any).imageCount).toBe(3);
  });

  test("emits vision_batch_complete after all images processed", async () => {
    await analyzeImages([jpegBuf(), pngBuf()], "describe each");

    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    expect(events).toContain("vision_batch_complete");
  });

  test("vision_batch_complete tracks successCount and failCount", async () => {
    mockClaudeText
      .mockResolvedValueOnce("first ok")
      .mockRejectedValueOnce(new Error("second failed"));

    await analyzeImages([jpegBuf(), pngBuf()], "describe");

    const batchComplete = mockTrace.mock.calls.find(
      (c) => (c[0] as any).event === "vision_batch_complete"
    );
    expect(batchComplete).toBeDefined();
    expect((batchComplete![0] as any).successCount).toBe(1);
    expect((batchComplete![0] as any).failCount).toBe(1);
  });

  test("empty array → no batch trace events emitted", async () => {
    await analyzeImages([]);
    expect(mockTrace).not.toHaveBeenCalled();
  });
});
