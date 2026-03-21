/**
 * Unit tests for src/vision/visionClient.ts
 *
 * Mocks claudeText and Bun.write — no real CLI calls or file I/O made.
 * Run: bun test src/vision/visionClient.test.ts
 */

import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
import { tmpdir } from "node:os";

// ── Mock claudeText before importing visionClient ─────────────────────────────

const mockClaudeText = mock(() =>
  Promise.resolve("A screenshot showing a code editor.")
);

mock.module("../claude-process.ts", () => ({
  claudeText: mockClaudeText,
}));

const {
  detectMediaType,
  analyzeImage,
  analyzeImages,
  combineImageContexts,
  sanitizeCaptionForVision,
  MAX_IMAGE_BYTES,
  VISION_MODEL,
} = await import("./visionClient");

// ── detectMediaType ──────────────────────────────────────────────────────────

describe("detectMediaType", () => {
  test("detects JPEG from magic bytes", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    expect(detectMediaType(buf)).toBe("image/jpeg");
  });

  test("detects PNG from magic bytes", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectMediaType(buf)).toBe("image/png");
  });

  test("detects GIF from magic bytes", () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectMediaType(buf)).toBe("image/gif");
  });

  test("detects WebP from magic bytes", () => {
    const buf = Buffer.alloc(12);
    buf.write("RIFF", 0, "ascii");
    buf.write("WEBP", 8, "ascii");
    expect(detectMediaType(buf)).toBe("image/webp");
  });

  test("defaults to JPEG for unknown format", () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(detectMediaType(buf)).toBe("image/jpeg");
  });

  test("defaults to JPEG for short buffer", () => {
    const buf = Buffer.from([0xff]);
    expect(detectMediaType(buf)).toBe("image/jpeg");
  });
});

// ── analyzeImage ─────────────────────────────────────────────────────────────

describe("analyzeImage", () => {
  beforeEach(() => {
    mockClaudeText.mockClear();
    // Stub Bun.write so no real file I/O happens during tests.
    spyOn(Bun, "write").mockResolvedValue(0 as unknown as number);
  });

  test("throws if image exceeds size limit", async () => {
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    await expect(analyzeImage(oversized)).rejects.toThrow("Image too large");
  });

  test("calls claudeText with cwd set to tmpdir()", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf, "What is this?");

    const [, opts] = mockClaudeText.mock.calls[0] as [string, Record<string, unknown>];
    expect(opts.cwd).toBe(tmpdir());
  });

  test("calls claudeText with dangerouslySkipPermissions: true", async () => {
    // --dangerously-skip-permissions is required in -p (non-interactive) mode
    // to allow Claude CLI to read the image file without hanging on a permission prompt.
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf);

    const [, opts] = mockClaudeText.mock.calls[0] as [string, Record<string, unknown>];
    expect(opts.dangerouslySkipPermissions).toBe(true);
  });

  test("calls claudeText with correct vision model", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf);

    const [, opts] = mockClaudeText.mock.calls[0] as [string, Record<string, unknown>];
    expect(opts.model).toBe(VISION_MODEL);
  });

  test("includes user prompt in claudeText call", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf, "What errors do you see?");

    const [prompt] = mockClaudeText.mock.calls[0] as [string];
    expect(prompt).toContain("What errors do you see?");
  });

  test("prompt uses relative filename (no directory separators)", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf);

    const [prompt] = mockClaudeText.mock.calls[0] as [string];
    // Extract the image reference line
    const imageRef = prompt.match(/^Image: (.+)$/m)?.[1];
    expect(imageRef).toBeDefined();
    expect(imageRef).toMatch(/^telegram_img_.*\.jpeg$/);  // filename only
    expect(imageRef).not.toContain("/");                  // no directory path
  });

  test("temp file uses correct extension for PNG", async () => {
    const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await analyzeImage(pngBuf);

    const [prompt] = mockClaudeText.mock.calls[0] as [string];
    const imageRef = prompt.match(/^Image: (.+)$/m)?.[1];
    expect(imageRef).toMatch(/\.png$/);
  });

  test("returns text from claudeText response", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const result = await analyzeImage(buf);
    expect(result).toBe("A screenshot showing a code editor.");
  });

  test("uses default prompt when none provided", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf);

    const [prompt] = mockClaudeText.mock.calls[0] as [string];
    expect(prompt).toContain("Describe this image in detail.");
  });

  test("propagates claudeText errors", async () => {
    mockClaudeText.mockImplementationOnce(() =>
      Promise.reject(new Error("CLI spawn failed"))
    );
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await expect(analyzeImage(buf)).rejects.toThrow("CLI spawn failed");
  });

  test("strips leading slash commands from caption before sending to claudeText", async () => {
    // Regression: /new caption caused Claude CLI to interpret /new as a slash
    // command, resetting the session instead of analyzing the image.
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf, "/new what's in this picture?");

    const [prompt] = mockClaudeText.mock.calls[0] as [string];
    expect(prompt).not.toContain("/new");
    expect(prompt).toContain("what's in this picture?");
  });
});

// ── analyzeImages ─────────────────────────────────────────────────────────────

describe("analyzeImages — parallel batch analysis", () => {
  beforeEach(() => {
    mockClaudeText.mockClear();
    mockClaudeText.mockResolvedValue("A screenshot showing a code editor.");
    spyOn(Bun, "write").mockResolvedValue(0 as unknown as number);
  });

  const jpegBuf = () => Buffer.from([0xff, 0xd8, 0xff, 0x00]);

  test("empty array → returns empty array", async () => {
    const results = await analyzeImages([]);
    expect(results).toEqual([]);
    expect(mockClaudeText).not.toHaveBeenCalled();
  });

  test("single buffer → returns one result with correct index", async () => {
    const results = await analyzeImages([jpegBuf()], "describe it");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ index: 0, context: "A screenshot showing a code editor." });
    expect(results[0].error).toBeUndefined();
  });

  test("single buffer → claudeText called once", async () => {
    await analyzeImages([jpegBuf()], "describe it");
    expect(mockClaudeText).toHaveBeenCalledTimes(1);
  });

  test("two buffers → both claudeText calls fired, results in order", async () => {
    mockClaudeText
      .mockResolvedValueOnce("First image: a cat.")
      .mockResolvedValueOnce("Second image: a dog.");
    const results = await analyzeImages([jpegBuf(), jpegBuf()], "describe each");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ index: 0, context: "First image: a cat." });
    expect(results[1]).toMatchObject({ index: 1, context: "Second image: a dog." });
    expect(mockClaudeText).toHaveBeenCalledTimes(2);
  });

  test("two buffers → shared prompt used for both claudeText calls", async () => {
    mockClaudeText.mockResolvedValue("ok");
    await analyzeImages([jpegBuf(), jpegBuf()], "What colour is the sky?");
    for (const call of mockClaudeText.mock.calls) {
      const [prompt] = call as [string];
      expect(prompt).toContain("What colour is the sky?");
    }
  });

  test("default prompt used when none provided", async () => {
    await analyzeImages([jpegBuf()]);
    const [prompt] = mockClaudeText.mock.calls[0] as [string];
    expect(prompt).toContain("Describe this image in detail.");
  });

  test("one image fails → error captured, other result succeeds, no throw", async () => {
    mockClaudeText
      .mockResolvedValueOnce("First ok.")
      .mockRejectedValueOnce(new Error("CLI crash"));
    const results = await analyzeImages([jpegBuf(), jpegBuf()], "describe");
    expect(results[0]).toMatchObject({ index: 0, context: "First ok." });
    expect(results[0].error).toBeUndefined();
    expect(results[1]).toMatchObject({ index: 1, context: "", error: "CLI crash" });
  });

  test("all images fail → all errors captured, no throw", async () => {
    mockClaudeText.mockRejectedValue(new Error("service down"));
    const results = await analyzeImages([jpegBuf(), jpegBuf()], "describe");
    expect(results[0]).toMatchObject({ index: 0, context: "", error: "service down" });
    expect(results[1]).toMatchObject({ index: 1, context: "", error: "service down" });
    expect(results.every((r) => !!r.error)).toBe(true);
  });

  test("three images → claudeText called three times", async () => {
    mockClaudeText.mockResolvedValue("image described");
    await analyzeImages([jpegBuf(), jpegBuf(), jpegBuf()], "describe");
    expect(mockClaudeText).toHaveBeenCalledTimes(3);
  });
});

// ── combineImageContexts ──────────────────────────────────────────────────────

describe("combineImageContexts", () => {
  test("empty array → empty string", () => {
    expect(combineImageContexts([])).toBe("");
  });

  test("single success → context returned as-is (no numbering)", () => {
    const result = combineImageContexts([{ index: 0, context: "A cat sitting on a mat." }]);
    expect(result).toBe("A cat sitting on a mat.");
  });

  test("single failure → error description returned", () => {
    const result = combineImageContexts([{ index: 0, context: "", error: "image too large" }]);
    expect(result).toContain("image too large");
  });

  test("two successes → both contexts included with numbering", () => {
    const results = [
      { index: 0, context: "First: a sunset." },
      { index: 1, context: "Second: a mountain." },
    ];
    const combined = combineImageContexts(results);
    expect(combined).toContain("Image 1");
    expect(combined).toContain("First: a sunset.");
    expect(combined).toContain("Image 2");
    expect(combined).toContain("Second: a mountain.");
  });

  test("mixed success + failure in batch → failure labeled, success included", () => {
    const results = [
      { index: 0, context: "A dog." },
      { index: 1, context: "", error: "file too large" },
    ];
    const combined = combineImageContexts(results);
    expect(combined).toContain("A dog.");
    expect(combined).toContain("analysis failed");
    expect(combined).toContain("file too large");
  });

  test("all failed → all errors described, no valid context", () => {
    const results = [
      { index: 0, context: "", error: "crash" },
      { index: 1, context: "", error: "timeout" },
    ];
    const combined = combineImageContexts(results);
    expect(combined).toContain("crash");
    expect(combined).toContain("timeout");
  });
});

// ── sanitizeCaptionForVision ──────────────────────────────────────────────────

describe("sanitizeCaptionForVision", () => {
  test("returns caption unchanged when no slash command prefix", () => {
    expect(sanitizeCaptionForVision("Describe this image")).toBe("Describe this image");
  });

  test("strips /new prefix", () => {
    expect(sanitizeCaptionForVision("/new what's in this picture")).toBe("what's in this picture");
  });

  test("strips /help prefix", () => {
    expect(sanitizeCaptionForVision("/help describe this")).toBe("describe this");
  });

  test("strips any /command prefix", () => {
    expect(sanitizeCaptionForVision("/memory what did I say?")).toBe("what did I say?");
  });

  test("returns empty string when caption is only a command with no text", () => {
    expect(sanitizeCaptionForVision("/new")).toBe("");
  });

  test("handles extra whitespace after command", () => {
    expect(sanitizeCaptionForVision("/new  what's this?")).toBe("what's this?");
  });

  test("does not strip mid-string slash", () => {
    expect(sanitizeCaptionForVision("explain this/that")).toBe("explain this/that");
  });

  test("returns empty string for empty input", () => {
    expect(sanitizeCaptionForVision("")).toBe("");
  });
});
