/**
 * Unit tests for src/vision/visionClient.ts
 *
 * Vision has two backends:
 *   1. Local LLM (LM Studio) — tried first via fetch()
 *   2. Anthropic API        — fallback when local fails
 *
 * Strategy:
 *   - Mock fetch() to fail by default → Anthropic fallback path is exercised
 *   - Mock fetch() to succeed in local-LLM tests → local path is exercised
 *   - Mock @anthropic-ai/sdk for the fallback tests
 *
 * Run: bun test src/vision/visionClient.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// Set API key so Anthropic fallback doesn't throw "key not set"
process.env.ANTHROPIC_API_KEY = "test-key";

// ── Mock Anthropic SDK before importing visionClient ──────────────────────────

const mockCreate = mock(() =>
  Promise.resolve({
    content: [{ type: "text", text: "A screenshot showing a code editor." }],
  })
);

mock.module("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

// ── Mock fetch to fail by default (local LLM unavailable) ─────────────────────
const mockFetch = mock(() =>
  Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:1234"))
);
global.fetch = mockFetch as unknown as typeof fetch;

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

// ── analyzeImage — Anthropic fallback path (local LLM fails) ─────────────────

describe("analyzeImage (Anthropic fallback — local LLM unavailable)", () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockFetch.mockClear();
    mockFetch.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:1234"));
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "A screenshot showing a code editor." }],
    });
  });

  test("throws if image exceeds size limit", async () => {
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    await expect(analyzeImage(oversized)).rejects.toThrow("Image too large");
  });

  test("falls back to Anthropic when local LLM fails", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const result = await analyzeImage(buf);
    expect(result).toBe("A screenshot showing a code editor.");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test("calls Anthropic messages.create with correct model", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf, "What is this?");

    const [body] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(body.model).toBe(VISION_MODEL);
  });

  test("does NOT use dangerouslySkipPermissions (security regression guard)", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf);

    const [body] = mockCreate.mock.calls[0] as [Record<string, unknown>];
    expect(JSON.stringify(body)).not.toContain("dangerouslySkipPermissions");
    expect(JSON.stringify(body)).not.toContain("dangerously-skip-permissions");
  });

  test("sends image as base64 in Anthropic message content", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf, "What is this?");

    const [body] = mockCreate.mock.calls[0] as [{ messages: Array<{ content: unknown[] }> }];
    const content = body.messages[0].content;
    const imageBlock = content.find(
      (b: unknown) => (b as Record<string, unknown>).type === "image"
    ) as Record<string, unknown> | undefined;
    expect(imageBlock).toBeDefined();
    const source = imageBlock!.source as Record<string, unknown>;
    expect(source.type).toBe("base64");
    expect(source.data).toBe(buf.toString("base64"));
  });

  test("sends correct media type for JPEG to Anthropic", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf);

    const [body] = mockCreate.mock.calls[0] as [{ messages: Array<{ content: unknown[] }> }];
    const imageBlock = body.messages[0].content.find(
      (b: unknown) => (b as Record<string, unknown>).type === "image"
    ) as Record<string, unknown> | undefined;
    const source = imageBlock!.source as Record<string, unknown>;
    expect(source.media_type).toBe("image/jpeg");
  });

  test("includes user prompt as text block in Anthropic call", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf, "What errors do you see?");

    const [body] = mockCreate.mock.calls[0] as [{ messages: Array<{ content: unknown[] }> }];
    const textBlock = body.messages[0].content.find(
      (b: unknown) => (b as Record<string, unknown>).type === "text"
    ) as Record<string, unknown> | undefined;
    expect(textBlock?.text).toContain("What errors do you see?");
  });

  test("returns text from Anthropic response", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const result = await analyzeImage(buf);
    expect(result).toBe("A screenshot showing a code editor.");
  });

  test("uses default prompt when none provided", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf);

    const [body] = mockCreate.mock.calls[0] as [{ messages: Array<{ content: unknown[] }> }];
    const textBlock = body.messages[0].content.find(
      (b: unknown) => (b as Record<string, unknown>).type === "text"
    ) as Record<string, unknown> | undefined;
    expect(textBlock?.text).toContain("Describe this image in detail.");
  });

  test("throws when both backends fail", async () => {
    mockCreate.mockRejectedValueOnce(new Error("Anthropic down"));
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await expect(analyzeImage(buf)).rejects.toThrow("Anthropic down");
  });

  test("strips leading slash commands from caption", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf, "/new what's in this picture?");

    const [body] = mockCreate.mock.calls[0] as [{ messages: Array<{ content: unknown[] }> }];
    const textBlock = body.messages[0].content.find(
      (b: unknown) => (b as Record<string, unknown>).type === "text"
    ) as Record<string, unknown> | undefined;
    expect(textBlock?.text).not.toContain("/new");
    expect(textBlock?.text).toContain("what's in this picture?");
  });
});

// ── analyzeImage — local LLM path ────────────────────────────────────────────

describe("analyzeImage (local LLM — LM Studio available)", () => {
  const localResponse = (text: string) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({ choices: [{ message: { content: text } }] }),
    } as Response);

  beforeEach(() => {
    process.env.VISION_BACKEND = "local";
    mockCreate.mockClear();
    mockFetch.mockClear();
  });

  afterEach(() => {
    delete process.env.VISION_BACKEND;
  });

  test("returns local LLM response when fetch succeeds", async () => {
    mockFetch.mockResolvedValueOnce(localResponse("A local LLM description."));
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const result = await analyzeImage(buf, "describe it");
    expect(result).toBe("A local LLM description.");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("sends POST to /v1/chat/completions", async () => {
    mockFetch.mockResolvedValueOnce(localResponse("ok"));
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/chat/completions");
    expect(init.method).toBe("POST");
  });

  test("sends image as base64 data URI in fetch body", async () => {
    mockFetch.mockResolvedValueOnce(localResponse("ok"));
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await analyzeImage(buf);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const imageBlock = body.messages[0].content.find(
      (b: Record<string, unknown>) => b.type === "image_url"
    );
    expect(imageBlock).toBeDefined();
    expect(imageBlock.image_url.url).toStartWith("data:image/jpeg;base64,");
  });

  test("falls back to Anthropic when local returns HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: () => Promise.resolve("Service Unavailable"),
    } as Response);
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Anthropic fallback." }],
    });
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const result = await analyzeImage(buf);
    expect(result).toBe("Anthropic fallback.");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test("falls back to Anthropic when local returns empty content", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: "" } }] }),
    } as Response);
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Anthropic fallback." }],
    });
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const result = await analyzeImage(buf);
    expect(result).toBe("Anthropic fallback.");
  });
});

// ── analyzeImages ─────────────────────────────────────────────────────────────

describe("analyzeImages — parallel batch analysis", () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockFetch.mockClear();
    // local LLM unavailable → Anthropic fallback exercises the batch paths
    mockFetch.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:1234"));
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "A screenshot showing a code editor." }],
    });
  });

  const jpegBuf = () => Buffer.from([0xff, 0xd8, 0xff, 0x00]);

  test("empty array → returns empty array", async () => {
    const results = await analyzeImages([]);
    expect(results).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("single buffer → returns one result with correct index", async () => {
    const results = await analyzeImages([jpegBuf()], "describe it");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ index: 0, context: "A screenshot showing a code editor." });
    expect(results[0].error).toBeUndefined();
  });

  test("single buffer → Anthropic called once (after local fails)", async () => {
    await analyzeImages([jpegBuf()], "describe it");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test("two buffers → both calls fired, results in order", async () => {
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "First image: a cat." }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Second image: a dog." }] });
    const results = await analyzeImages([jpegBuf(), jpegBuf()], "describe each");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ index: 0, context: "First image: a cat." });
    expect(results[1]).toMatchObject({ index: 1, context: "Second image: a dog." });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  test("default prompt used when none provided", async () => {
    await analyzeImages([jpegBuf()]);
    const [body] = mockCreate.mock.calls[0] as [{ messages: Array<{ content: unknown[] }> }];
    const textBlock = body.messages[0].content.find(
      (b: unknown) => (b as Record<string, unknown>).type === "text"
    ) as Record<string, unknown> | undefined;
    expect(textBlock?.text).toContain("Describe this image in detail.");
  });

  test("one image fails → error captured, other result succeeds, no throw", async () => {
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "First ok." }] })
      .mockRejectedValueOnce(new Error("CLI crash"));
    const results = await analyzeImages([jpegBuf(), jpegBuf()], "describe");
    expect(results[0]).toMatchObject({ index: 0, context: "First ok." });
    expect(results[0].error).toBeUndefined();
    expect(results[1]).toMatchObject({ index: 1, context: "", error: expect.stringContaining("CLI crash") });
  });

  test("all images fail → all errors captured, no throw", async () => {
    mockCreate.mockRejectedValue(new Error("service down"));
    const results = await analyzeImages([jpegBuf(), jpegBuf()], "describe");
    expect(results[0]).toMatchObject({ index: 0, context: "", error: "service down" });
    expect(results[1]).toMatchObject({ index: 1, context: "", error: "service down" });
    expect(results.every((r) => !!r.error)).toBe(true);
  });

  test("three images → API called three times", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    await analyzeImages([jpegBuf(), jpegBuf(), jpegBuf()], "describe");
    expect(mockCreate).toHaveBeenCalledTimes(3);
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
