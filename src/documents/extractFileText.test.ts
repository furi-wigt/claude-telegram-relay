/**
 * Unit tests for extractFileText — Task 5 (bare-file handler) and Task 1 Path B.
 *
 * Covers:
 *   - Supported types: txt, md → Bun read; pdf, docx, pptx, xlsx → callClaude
 *   - buildExtractPrompt: correct filePath and type label in prompt
 *   - SUPPORTED_DOC_EXTS: all 6 types present; .zip absent
 *
 * Run: bun test src/documents/extractFileText.test.ts
 */

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync } from "fs";

import {
  extractFileText,
  buildExtractPrompt,
  SUPPORTED_DOC_EXTS,
  DOC_TYPE_LABELS,
} from "./extractFileText.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TMP = join(tmpdir(), "extract_file_text_test_" + Date.now());
mkdirSync(TMP, { recursive: true });

const mockCallClaude = mock(async (_prompt: string): Promise<string> => "Claude extracted text");

beforeEach(() => {
  mockCallClaude.mockClear();
  mockCallClaude.mockImplementation(async (_prompt: string) => "Claude extracted text");
});

afterAll(() => {
  try { rmSync(TMP, { recursive: true }); } catch {}
});

// ─── SUPPORTED_DOC_EXTS ───────────────────────────────────────────────────────

describe("SUPPORTED_DOC_EXTS", () => {
  test("contains all 6 supported extensions", () => {
    expect(SUPPORTED_DOC_EXTS.has(".pdf")).toBe(true);
    expect(SUPPORTED_DOC_EXTS.has(".docx")).toBe(true);
    expect(SUPPORTED_DOC_EXTS.has(".pptx")).toBe(true);
    expect(SUPPORTED_DOC_EXTS.has(".xlsx")).toBe(true);
    expect(SUPPORTED_DOC_EXTS.has(".txt")).toBe(true);
    expect(SUPPORTED_DOC_EXTS.has(".md")).toBe(true);
  });

  test("does not contain unsupported extensions", () => {
    expect(SUPPORTED_DOC_EXTS.has(".zip")).toBe(false);
    expect(SUPPORTED_DOC_EXTS.has(".exe")).toBe(false);
    expect(SUPPORTED_DOC_EXTS.has(".mp4")).toBe(false);
    expect(SUPPORTED_DOC_EXTS.has(".jpg")).toBe(false);
  });

  test("has exactly 6 entries", () => {
    expect(SUPPORTED_DOC_EXTS.size).toBe(6);
  });
});

// ─── buildExtractPrompt ───────────────────────────────────────────────────────

describe("buildExtractPrompt", () => {
  test("includes the exact filePath in the prompt", () => {
    const prompt = buildExtractPrompt("/tmp/test.pdf", ".pdf");
    expect(prompt).toContain("/tmp/test.pdf");
  });

  test(".pdf → label 'PDF document'", () => {
    expect(buildExtractPrompt("/tmp/f.pdf", ".pdf")).toContain(DOC_TYPE_LABELS[".pdf"]);
  });

  test(".docx → label 'Word document'", () => {
    expect(buildExtractPrompt("/tmp/f.docx", ".docx")).toContain(DOC_TYPE_LABELS[".docx"]);
  });

  test(".pptx → label mentions 'PowerPoint'", () => {
    expect(buildExtractPrompt("/tmp/f.pptx", ".pptx")).toContain("PowerPoint");
  });

  test(".xlsx → label mentions 'Excel'", () => {
    expect(buildExtractPrompt("/tmp/f.xlsx", ".xlsx")).toContain("Excel");
  });

  test("unknown extension → fallback label 'document'", () => {
    const prompt = buildExtractPrompt("/tmp/f.xyz", ".xyz");
    expect(prompt).toContain("document");
  });

  test("instructs Claude to return ONLY extracted text", () => {
    const prompt = buildExtractPrompt("/tmp/f.pdf", ".pdf");
    expect(prompt).toContain("Return ONLY the extracted text");
  });
});

// ─── extractFileText — .txt / .md (direct Bun read) ─────────────────────────

describe("extractFileText — plain text types (no callClaude)", () => {
  test(".txt → reads file content directly, does NOT call callClaude", async () => {
    const file = join(TMP, "sample.txt");
    writeFileSync(file, "Hello from text file");
    const text = await extractFileText(file, ".txt", mockCallClaude);
    expect(text).toBe("Hello from text file");
    expect(mockCallClaude.mock.calls.length).toBe(0);
  });

  test(".md → reads file content directly, does NOT call callClaude", async () => {
    const file = join(TMP, "sample.md");
    writeFileSync(file, "# Heading\n\nContent here");
    const text = await extractFileText(file, ".md", mockCallClaude);
    expect(text).toContain("# Heading");
    expect(text).toContain("Content here");
    expect(mockCallClaude.mock.calls.length).toBe(0);
  });
});

// ─── extractFileText — binary types (callClaude delegation) ──────────────────

describe("extractFileText — binary types (delegates to callClaude)", () => {
  test(".pdf → calls callClaude (not Bun read)", async () => {
    const file = join(TMP, "doc.pdf");
    writeFileSync(file, "%PDF-1.4 fake");
    const text = await extractFileText(file, ".pdf", mockCallClaude);
    expect(text).toBe("Claude extracted text");
    expect(mockCallClaude.mock.calls.length).toBe(1);
  });

  test(".pdf → prompt includes filePath and 'PDF document'", async () => {
    const file = join(TMP, "report.pdf");
    writeFileSync(file, "%PDF-1.4 fake");
    await extractFileText(file, ".pdf", mockCallClaude);
    const prompt = mockCallClaude.mock.calls[0][0] as string;
    expect(prompt).toContain(file);
    expect(prompt).toContain("PDF document");
  });

  test(".docx → calls callClaude with 'Word document' label", async () => {
    const file = join(TMP, "doc.docx");
    writeFileSync(file, "PK fake docx bytes");
    await extractFileText(file, ".docx", mockCallClaude);
    const prompt = mockCallClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("Word document");
    expect(mockCallClaude.mock.calls.length).toBe(1);
  });

  test(".pptx → calls callClaude with 'PowerPoint' label", async () => {
    const file = join(TMP, "deck.pptx");
    writeFileSync(file, "PK fake pptx bytes");
    await extractFileText(file, ".pptx", mockCallClaude);
    const prompt = mockCallClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("PowerPoint");
    expect(mockCallClaude.mock.calls.length).toBe(1);
  });

  test(".xlsx → calls callClaude with 'Excel' label", async () => {
    const file = join(TMP, "data.xlsx");
    writeFileSync(file, "PK fake xlsx bytes");
    await extractFileText(file, ".xlsx", mockCallClaude);
    const prompt = mockCallClaude.mock.calls[0][0] as string;
    expect(prompt).toContain("Excel");
    expect(mockCallClaude.mock.calls.length).toBe(1);
  });

  test("callClaude return value is returned as-is", async () => {
    mockCallClaude.mockImplementation(async () => "Specific extracted content from PDF");
    const file = join(TMP, "specific.pdf");
    writeFileSync(file, "%PDF fake");
    const text = await extractFileText(file, ".pdf", mockCallClaude);
    expect(text).toBe("Specific extracted content from PDF");
  });
});
