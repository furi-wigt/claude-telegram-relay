/**
 * Unit tests for src/documents/diagnosticAnalyzer.ts
 *
 * Mocks visionClient — no real Claude CLI calls or file I/O.
 * Run: bun test src/documents/diagnosticAnalyzer.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Mock visionClient before importing diagnosticAnalyzer ─────────────────────

const mockAnalyzeImages = mock(() =>
  Promise.resolve([{ index: 0, context: "Extracted diagnostic data." }])
);

const mockCombineImageContexts = mock(
  (results: { index: number; context: string; error?: string }[]) =>
    results.map((r) => r.context).join("\n\n")
);

mock.module("../vision/visionClient.ts", () => ({
  analyzeImages: mockAnalyzeImages,
  combineImageContexts: mockCombineImageContexts,
}));

const {
  BUILT_IN_DEFAULTS,
  loadExtractionPrompt,
  analyzeDiagnosticImages,
} = await import("./diagnosticAnalyzer.ts");

// ── BUILT_IN_DEFAULTS ─────────────────────────────────────────────────────────

describe("BUILT_IN_DEFAULTS", () => {
  test("has aws-architect entry", () => {
    expect(BUILT_IN_DEFAULTS["aws-architect"]).toBeDefined();
    expect(BUILT_IN_DEFAULTS["aws-architect"].length).toBeGreaterThan(0);
  });

  test("has code-quality-coach entry", () => {
    expect(BUILT_IN_DEFAULTS["code-quality-coach"]).toBeDefined();
    expect(BUILT_IN_DEFAULTS["code-quality-coach"].length).toBeGreaterThan(0);
  });

  test("has security-analyst entry", () => {
    expect(BUILT_IN_DEFAULTS["security-analyst"]).toBeDefined();
    expect(BUILT_IN_DEFAULTS["security-analyst"].length).toBeGreaterThan(0);
  });

  test("aws-architect prompt mentions CloudWatch", () => {
    expect(BUILT_IN_DEFAULTS["aws-architect"]).toContain("CloudWatch");
  });

  test("code-quality-coach prompt mentions test output", () => {
    expect(BUILT_IN_DEFAULTS["code-quality-coach"].toLowerCase()).toContain("test");
  });

  test("security-analyst prompt mentions CVE", () => {
    expect(BUILT_IN_DEFAULTS["security-analyst"]).toContain("CVE");
  });
});

// ── loadExtractionPrompt ──────────────────────────────────────────────────────

describe("loadExtractionPrompt", () => {
  test("returns built-in default when config file does not exist", () => {
    const result = loadExtractionPrompt("aws-architect", "/nonexistent/path");
    expect(result).toBe(BUILT_IN_DEFAULTS["aws-architect"]);
  });

  test("returns undefined for unknown agentId with no config file", () => {
    const result = loadExtractionPrompt("unknown-agent", "/nonexistent/path");
    expect(result).toBeUndefined();
  });

  test("returns config file content when file exists (overrides built-in)", () => {
    const tmpRoot = join(tmpdir(), `test_diag_${Date.now()}`);
    const diagDir = join(tmpRoot, "config", "prompts", "diagnostics");
    mkdirSync(diagDir, { recursive: true });
    writeFileSync(join(diagDir, "aws-architect.md"), "Custom AWS extraction prompt");

    const result = loadExtractionPrompt("aws-architect", tmpRoot);
    expect(result).toBe("Custom AWS extraction prompt");
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("returns built-in default when config file is empty", () => {
    const tmpRoot = join(tmpdir(), `test_diag_empty_${Date.now()}`);
    const diagDir = join(tmpRoot, "config", "prompts", "diagnostics");
    mkdirSync(diagDir, { recursive: true });
    writeFileSync(join(diagDir, "aws-architect.md"), "");

    const result = loadExtractionPrompt("aws-architect", tmpRoot);
    expect(result).toBe(BUILT_IN_DEFAULTS["aws-architect"]);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("returns built-in default for code-quality-coach", () => {
    const result = loadExtractionPrompt("code-quality-coach", "/nonexistent/path");
    expect(result).toBe(BUILT_IN_DEFAULTS["code-quality-coach"]);
  });

  test("returns built-in default for security-analyst", () => {
    const result = loadExtractionPrompt("security-analyst", "/nonexistent/path");
    expect(result).toBe(BUILT_IN_DEFAULTS["security-analyst"]);
  });
});

// ── analyzeDiagnosticImages ───────────────────────────────────────────────────

describe("analyzeDiagnosticImages", () => {
  const jpegBuf = () => Buffer.from([0xff, 0xd8, 0xff, 0x00]);

  beforeEach(() => {
    mockAnalyzeImages.mockClear();
    mockCombineImageContexts.mockClear();
    mockAnalyzeImages.mockResolvedValue([{ index: 0, context: "Extracted diagnostic data." }]);
    mockCombineImageContexts.mockImplementation(
      (results: { index: number; context: string; error?: string }[]) =>
        results.map((r) => r.context).join("\n\n")
    );
  });

  test("calls analyzeImages with the aws-architect extraction prompt", async () => {
    await analyzeDiagnosticImages([jpegBuf()], "aws-architect", "/nonexistent");
    const [, promptArg] = mockAnalyzeImages.mock.calls[0] as [unknown, string];
    expect(promptArg).toBe(BUILT_IN_DEFAULTS["aws-architect"]);
  });

  test("calls analyzeImages with code-quality-coach prompt", async () => {
    await analyzeDiagnosticImages([jpegBuf()], "code-quality-coach", "/nonexistent");
    const [, promptArg] = mockAnalyzeImages.mock.calls[0] as [unknown, string];
    expect(promptArg).toBe(BUILT_IN_DEFAULTS["code-quality-coach"]);
  });

  test("calls analyzeImages with security-analyst prompt", async () => {
    await analyzeDiagnosticImages([jpegBuf()], "security-analyst", "/nonexistent");
    const [, promptArg] = mockAnalyzeImages.mock.calls[0] as [unknown, string];
    expect(promptArg).toBe(BUILT_IN_DEFAULTS["security-analyst"]);
  });

  test("uses generic fallback prompt for unknown agentId", async () => {
    await analyzeDiagnosticImages([jpegBuf()], "unknown-agent", "/nonexistent");
    const [, promptArg] = mockAnalyzeImages.mock.calls[0] as [unknown, string];
    expect(promptArg).toContain("structured bullet points");
  });

  test("passes image buffers to analyzeImages", async () => {
    const buf1 = jpegBuf();
    const buf2 = jpegBuf();
    await analyzeDiagnosticImages([buf1, buf2], "aws-architect", "/nonexistent");
    const [bufsArg] = mockAnalyzeImages.mock.calls[0] as [Buffer[]];
    expect(bufsArg).toHaveLength(2);
  });

  test("returns combined context from combineImageContexts", async () => {
    mockCombineImageContexts.mockReturnValueOnce("Combined diagnostic output.");
    const result = await analyzeDiagnosticImages([jpegBuf()], "aws-architect", "/nonexistent");
    expect(result).toBe("Combined diagnostic output.");
  });

  test("uses custom config file prompt when it exists", async () => {
    const tmpRoot = join(tmpdir(), `test_diag_relay_${Date.now()}`);
    const diagDir = join(tmpRoot, "config", "prompts", "diagnostics");
    mkdirSync(diagDir, { recursive: true });
    writeFileSync(join(diagDir, "aws-architect.md"), "Custom team AWS prompt");

    await analyzeDiagnosticImages([jpegBuf()], "aws-architect", tmpRoot);
    const [, promptArg] = mockAnalyzeImages.mock.calls[0] as [unknown, string];
    expect(promptArg).toBe("Custom team AWS prompt");
    rmSync(tmpRoot, { recursive: true, force: true });
  });
});
