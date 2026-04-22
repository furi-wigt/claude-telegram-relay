/**
 * Unit tests for ccDocuments helpers.
 *
 * Covers:
 * - sanitizeDocFilename: path traversal, NUL, whitespace, empty, leading dots, clamping
 * - uniquifyFilename: collision suffixing with extension preservation
 * - buildDocumentContext: formatting, empty array → undefined, optional mime/size
 */

import { describe, it, expect } from "bun:test";
import { sanitizeDocFilename, uniquifyFilename, buildDocumentContext } from "./ccDocuments";

describe("sanitizeDocFilename", () => {
  it("keeps a normal filename unchanged", () => {
    expect(sanitizeDocFilename("report.pdf", "fallback.bin")).toBe("report.pdf");
  });

  it("strips path traversal components", () => {
    const out = sanitizeDocFilename("../../etc/passwd", "fallback.bin");
    expect(out).not.toContain("/");
    expect(out).not.toContain("..");
    expect(out).toBe("passwd");
  });

  it("strips Windows-style backslashes", () => {
    const out = sanitizeDocFilename("C:\\Users\\evil\\shell.exe", "fallback.bin");
    expect(out).not.toContain("\\");
    expect(out).toBe("shell.exe");
  });

  it("replaces NUL, spaces, and shell meta chars with underscore", () => {
    const out = sanitizeDocFilename("bad\0name with $(danger).pdf", "fallback.bin");
    expect(out).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(out).toContain(".pdf");
  });

  it("collapses repeated underscores", () => {
    const out = sanitizeDocFilename("a   b   c.pdf", "fallback.bin");
    expect(out).toBe("a_b_c.pdf");
  });

  it("returns fallback when raw is empty/null/whitespace", () => {
    expect(sanitizeDocFilename(null, "fallback.bin")).toBe("fallback.bin");
    expect(sanitizeDocFilename("", "fallback.bin")).toBe("fallback.bin");
    expect(sanitizeDocFilename("   ", "fallback.bin")).toBe("fallback.bin");
  });

  it("strips leading dots so no accidental dotfile is created", () => {
    expect(sanitizeDocFilename(".hidden", "fallback.bin")).toBe("hidden");
    expect(sanitizeDocFilename("..secret.pdf", "fallback.bin")).toBe("secret.pdf");
  });

  it("falls back when leaf is only dots/dashes after sanitisation", () => {
    expect(sanitizeDocFilename("...", "fallback.bin")).toBe("file.bin");
    expect(sanitizeDocFilename("---", "fallback.bin")).toBe("file.bin");
  });

  it("clamps to 120 chars while preserving short extensions", () => {
    const long = "a".repeat(200) + ".pdf";
    const out = sanitizeDocFilename(long, "fallback.bin");
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith(".pdf")).toBe(true);
  });
});

describe("uniquifyFilename", () => {
  it("returns original when no collision", () => {
    expect(uniquifyFilename("report.pdf", new Set())).toBe("report.pdf");
  });

  it("suffixes -1 on first collision preserving extension", () => {
    const seen = new Set(["report.pdf"]);
    expect(uniquifyFilename("report.pdf", seen)).toBe("report-1.pdf");
  });

  it("increments suffix until a free slot is found", () => {
    const seen = new Set(["report.pdf", "report-1.pdf", "report-2.pdf"]);
    expect(uniquifyFilename("report.pdf", seen)).toBe("report-3.pdf");
  });

  it("handles extensionless filenames", () => {
    const seen = new Set(["README"]);
    expect(uniquifyFilename("README", seen)).toBe("README-1");
  });
});

describe("buildDocumentContext", () => {
  it("returns undefined for an empty list", () => {
    expect(buildDocumentContext([])).toBeUndefined();
  });

  it("formats a single entry with mime and size", () => {
    const out = buildDocumentContext([
      {
        fileName: "report.pdf",
        localPath: "/tmp/x/report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1_258_291, // ~1.2 MB
      },
    ]);
    expect(out).toContain("report.pdf");
    expect(out).toContain("application/pdf");
    expect(out).toContain("1.2 MB");
    expect(out).toContain("/tmp/x/report.pdf");
    expect(out!.startsWith("- ")).toBe(true);
  });

  it("omits size when unknown and omits mime when unknown", () => {
    const out = buildDocumentContext([
      { fileName: "notes.txt", localPath: "/tmp/y/notes.txt" },
    ]);
    expect(out).toContain("notes.txt");
    expect(out).toContain("/tmp/y/notes.txt");
    // no parenthetical metadata
    expect(out).not.toContain("(");
  });

  it("produces one line per entry", () => {
    const out = buildDocumentContext([
      { fileName: "a.pdf", localPath: "/t/a.pdf" },
      { fileName: "b.csv", localPath: "/t/b.csv" },
      { fileName: "c.xlsx", localPath: "/t/c.xlsx" },
    ]);
    const lines = out!.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("a.pdf");
    expect(lines[1]).toContain("b.csv");
    expect(lines[2]).toContain("c.xlsx");
  });

  it("formats small files in bytes and mid-size in KB", () => {
    const out = buildDocumentContext([
      { fileName: "a", localPath: "/t/a", sizeBytes: 512 },
      { fileName: "b", localPath: "/t/b", sizeBytes: 4_400 },
    ]);
    expect(out).toContain("512 B");
    expect(out).toContain("4.3 KB");
  });
});
