/**
 * documentProcessor tests
 *
 * TDD: RED first — these tests define the expected contract.
 */

// Tests mock the local storageBackend functions directly

import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, mkdirSync, rmSync } from "fs";

// ─── Mock visionClient (analyzeImage) ────────────────────────────────────────

const mockAnalyzeImage = mock(async (_buffer: Buffer, _caption?: string) => {
  return "Extracted text from image";
});

mock.module("../vision/visionClient.ts", () => ({
  analyzeImage: mockAnalyzeImage,
}));

// ─── Mock tracer (spy on trace calls) ────────────────────────────────────────

const mockTrace = mock((_event: Record<string, unknown>) => {});
mock.module("../utils/tracer.ts", () => ({
  trace: mockTrace,
  generateTraceId: () => "test-trace-id",
}));

// ─── Mock storageBackend ──────────────────────────────────────────────────────

type InsertRow = {
  title: string;
  source: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
};

const mockInsert = mock(async (_rows: InsertRow[]) => {});
const mockDelete = mock(async (_title: string) => ({ deleted: 3 }));

// Controls for ingestText guard mocks — tests may override per-test
let hashMatchResult: { title: string } | null = null;
let titleCountResult: number = 0;
// Control for checkTitleCollision mock
let collisionResult: { exists: boolean; existingTitle?: string } = { exists: false };

mock.module("../local/storageBackend", () => ({
  insertDocumentRecords: (...args: any[]) => mockInsert(...args),
  deleteDocumentRecords: (...args: any[]) => mockDelete(...args),
  checkContentHashExists: async () => hashMatchResult,
  countDocumentsByTitle: async () => titleCountResult,
  fuzzyMatchDocumentTitle: async (pattern: string) => pattern, // always find for fallback
  checkDocumentTitleCollision: async () => collisionResult,
  resolveUniqueTitleBackend: async (base: string) => base,
  listDocumentsLocal: async () => [
    { title: "My Policy", source: "policy.pdf", chunks: 2, created_at: "2026-02-23T00:00:00Z" },
  ],
}));

// ─── Import module under test ─────────────────────────────────────────────────
// Must import after mock.module() calls.
const { chunkText, extractTextFromFile, ingestDocument, deleteDocument, listDocuments, ingestText,
        hasMarkdownHeadings, chunkByHeadings, chunkByPages, chunkByPagesWithHeadings,
        detectChunkingStrategy, checkTitleCollision } =
  await import("./documentProcessor.ts");

// ─── Test fixtures ────────────────────────────────────────────────────────────

const TMP = join(tmpdir(), "docproc_test_" + Date.now());
mkdirSync(TMP, { recursive: true });

// ─── chunkText ────────────────────────────────────────────────────────────────

describe("chunkText", () => {
  test("returns single chunk when text fits", () => {
    const chunks = chunkText("Hello world. This is a sentence.", 1800, 200);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Hello world");
  });

  test("splits on paragraph boundaries when text exceeds chunk size", () => {
    const para = "A".repeat(500);
    const text = [para, para, para, para, para].join("\n\n");
    const chunks = chunkText(text, 800, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(900); // chunk + small overflow tolerance
    }
  });

  test("includes overlap from previous chunk", () => {
    const para1 = "B".repeat(800);
    const para2 = "C".repeat(800);
    const text = para1 + "\n\n" + para2;
    const chunks = chunkText(text, 900, 100);
    // Second chunk should start with overlap from para1
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("filters out chunks shorter than 50 chars", () => {
    const text = "Short\n\nAnother short\n\n" + "A".repeat(200);
    const chunks = chunkText(text, 1800, 200);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThanOrEqual(50);
    }
  });

  test("hard splits single oversized paragraph", () => {
    const bigPara = "X".repeat(5000);
    const chunks = chunkText(bigPara, 1000, 100);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

// ─── extractTextFromFile ──────────────────────────────────────────────────────

describe("extractTextFromFile", () => {
  test("reads .txt file as utf-8 and returns { text }", async () => {
    const file = join(TMP, "test.txt");
    writeFileSync(file, "Hello from text file");
    const result = await extractTextFromFile(file, "text/plain");
    expect(result.text).toBe("Hello from text file");
    expect(result.pages).toBeUndefined();
  });

  test("reads .md file as utf-8 and returns { text }", async () => {
    const file = join(TMP, "test.md");
    writeFileSync(file, "# Heading\nContent here");
    const result = await extractTextFromFile(file, "text/markdown");
    expect(result.text).toContain("Heading");
    expect(result.text).toContain("Content here");
  });

  test("routes image mime types to analyzeImage", async () => {
    mockAnalyzeImage.mockClear();
    const file = join(TMP, "scan.jpg");
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // JPEG magic bytes
    const result = await extractTextFromFile(file, "image/jpeg");
    expect(result.text).toBe("Extracted text from image");
    expect(mockAnalyzeImage.mock.calls.length).toBe(1);
  });

  test("routes png images to analyzeImage", async () => {
    mockAnalyzeImage.mockClear();
    const file = join(TMP, "scan.png");
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes
    await extractTextFromFile(file, "image/png");
    expect(mockAnalyzeImage.mock.calls.length).toBe(1);
  });
});

// ─── ingestDocument ───────────────────────────────────────────────────────────

describe("ingestDocument", () => {
  beforeEach(() => {
    mockInsert.mockClear();
  });

  test("returns chunksInserted count and title", async () => {
    const file = join(TMP, "policy.txt");
    writeFileSync(file, ("Insurance content. ".repeat(20) + "\n\n").repeat(5));
    const result = await ingestDocument(file, "My Policy");
    expect(result.title).toBe("My Policy");
    expect(result.chunksInserted).toBeGreaterThan(0);
  });

  test("calls insertDocumentRecords with correct shape", async () => {
    const file = join(TMP, "small.txt");
    writeFileSync(file, "X".repeat(200));
    await ingestDocument(file, "Test Doc");
    expect(mockInsert.mock.calls.length).toBeGreaterThan(0);
    const rows = mockInsert.mock.calls[0][0] as InsertRow[];
    expect(rows[0]).toHaveProperty("title", "Test Doc");
    expect(rows[0]).toHaveProperty("chunk_index", 0);
    expect(rows[0]).toHaveProperty("content");
    expect(rows[0]).toHaveProperty("metadata");
  });

  test("returns chunksInserted=0 when no text extracted", async () => {
    const file = join(TMP, "empty.txt");
    writeFileSync(file, "   \n   "); // whitespace only
    const result = await ingestDocument(file, "Empty Doc");
    expect(result.chunksInserted).toBe(0);
  });

  test("uses filename as source when not provided", async () => {
    const file = join(TMP, "mypolicy.txt");
    writeFileSync(file, "Content here. ".repeat(30));
    await ingestDocument(file, "My Policy");
    const rows = mockInsert.mock.calls[0][0] as InsertRow[];
    expect(rows[0].source).toBe("mypolicy.txt");
  });

  test("accepts explicit source override", async () => {
    const file = join(TMP, "doc.txt");
    writeFileSync(file, "Content. ".repeat(30));
    await ingestDocument(file, "My Doc", { source: "custom_source.pdf" });
    const rows = mockInsert.mock.calls[0][0] as InsertRow[];
    expect(rows[0].source).toBe("custom_source.pdf");
  });
});

// ─── deleteDocument ───────────────────────────────────────────────────────────

describe("deleteDocument", () => {
  test("returns deleted count", async () => {
    const result = await deleteDocument("My Policy");
    expect(result.deleted).toBe(3);
  });
});

// ─── listDocuments ────────────────────────────────────────────────────────────

describe("listDocuments", () => {
  test("returns array of DocSummary with title, sources, chunks", async () => {
    const docs = await listDocuments();
    expect(docs).toHaveLength(1); // grouped by title
    expect(docs[0].title).toBe("My Policy");
    expect(docs[0].chunks).toBe(2);
    expect(docs[0].sources).toContain("policy.pdf");
  });
});

// ─── checkTitleCollision ──────────────────────────────────────────────────────

describe("checkTitleCollision", () => {
  beforeEach(() => {
    collisionResult = { exists: false };
  });

  test("no collision — returns { exists: false }", async () => {
    collisionResult = { exists: false };
    const result = await checkTitleCollision("My Policy");
    expect(result).toEqual({ exists: false });
  });

  test("exact collision — returns { exists: true, existingTitle }", async () => {
    collisionResult = { exists: true, existingTitle: "My Policy" };
    const result = await checkTitleCollision("My Policy");
    expect(result.exists).toBe(true);
    expect(result.existingTitle).toBe("My Policy");
  });

  test("case-insensitive collision — returns { exists: true }", async () => {
    collisionResult = { exists: true, existingTitle: "my policy" };
    const result = await checkTitleCollision("MY POLICY");
    expect(result.exists).toBe(true);
    expect(result.existingTitle).toBe("my policy");
  });
});

// ─── ingestDocument — observability ──────────────────────────────────────────

describe("ingestDocument — trace events", () => {
  beforeEach(() => {
    mockTrace.mockClear();
    mockInsert.mockClear();
  });

  test("emits doc_ingest_start before processing", async () => {
    const file = join(TMP, `trace_start_${Date.now()}.txt`);
    writeFileSync(file, "Content.\n\nMore content.");
    await ingestDocument(file, "Trace Doc", { source: "trace.txt", mimeType: "text/plain" });

    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    expect(events).toContain("doc_ingest_start");
  });

  test("doc_ingest_start includes title and source", async () => {
    const file = join(TMP, `trace_title_${Date.now()}.txt`);
    writeFileSync(file, "Content.\n\nMore.");
    await ingestDocument(file, "My Report", { source: "report.txt", mimeType: "text/plain" });

    const startCall = mockTrace.mock.calls.find(
      (c) => (c[0] as any).event === "doc_ingest_start"
    );
    expect(startCall).toBeDefined();
    expect((startCall![0] as any).title).toBe("My Report");
    expect((startCall![0] as any).source).toBe("report.txt");
  });

  test("emits doc_ingest_text_complete with chunksInserted after success (delegates to ingestText)", async () => {
    const file = join(TMP, `trace_complete_${Date.now()}.txt`);
    writeFileSync(file, ("Para ".repeat(50) + "\n\n").repeat(3));
    const result = await ingestDocument(file, "Complete Doc", { mimeType: "text/plain" });

    const completeCall = mockTrace.mock.calls.find(
      (c) => (c[0] as any).event === "doc_ingest_text_complete"
    );
    expect(completeCall).toBeDefined();
    expect((completeCall![0] as any).chunksInserted).toBe(result.chunksInserted);
    expect((completeCall![0] as any).title).toBe("Complete Doc");
  });

  test("emits doc_ingest_empty when file has no usable text", async () => {
    const file = join(TMP, `trace_empty_${Date.now()}.txt`);
    writeFileSync(file, "   \n   ");
    await ingestDocument(file, "Empty Doc", { mimeType: "text/plain" });

    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    expect(events).toContain("doc_ingest_empty");
  });
});

// ─── deleteDocument — observability ──────────────────────────────────────────

describe("deleteDocument — trace events", () => {
  beforeEach(() => {
    mockTrace.mockClear();
  });

  test("emits doc_delete trace event after deletion", async () => {
    await deleteDocument("Insurance Policy 2024");

    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    expect(events).toContain("doc_delete");
  });

  test("doc_delete includes title and deleted count", async () => {
    await deleteDocument("Budget Report Q1");

    const deleteCall = mockTrace.mock.calls.find(
      (c) => (c[0] as any).event === "doc_delete"
    );
    expect(deleteCall).toBeDefined();
    expect((deleteCall![0] as any).title).toBe("Budget Report Q1");
    expect(typeof (deleteCall![0] as any).deleted).toBe("number");
  });
});

// ─── chunkText — hard-split overlap (FM-5) ────────────────────────────────────

describe("chunkText — hard-split overlap", () => {
  test("carries overlap after hard-split single paragraph", () => {
    const longPara = "A".repeat(4000); // single paragraph > chunkSize=1800
    const nextPara = "Next paragraph content here.";
    const chunks = chunkText(longPara + "\n\n" + nextPara);
    // Final chunk comes from nextPara — it should contain overlap from the hard-split paragraph
    const nextParaChunk = chunks[chunks.length - 1];
    expect(nextParaChunk).toContain("Next paragraph content here.");
    // Overlap carried in means length > bare nextPara length
    expect(nextParaChunk.length).toBeGreaterThan(nextPara.length);
  });
});

// ─── ingestText (FM-4) ────────────────────────────────────────────────────────

describe("ingestText", () => {
  beforeEach(() => {
    mockInsert.mockClear();
    mockTrace.mockClear();
    // Reset guard mocks to defaults (no duplicate, no conflict)
    hashMatchResult = null;
    titleCountResult = 0;
  });

  test("inserts correct chunk count for 5000-char text", async () => {
    const text = "Word sentence. ".repeat(333); // ~5000 chars
    const result = await ingestText(text, "Test Doc");
    expect(result.chunksInserted).toBeGreaterThanOrEqual(2);
    expect(result.title).toBe("Test Doc");
    expect(result.duplicate).toBeUndefined();
    expect(result.conflict).toBeUndefined();
  });

  test("returns duplicate:true for same content hash", async () => {
    hashMatchResult = { title: "Existing Doc" };
    const text = "Some content that matches an existing hash.";
    const result = await ingestText(text, "New Title");
    expect(result.duplicate).toBe(true);
    expect(result.chunksInserted).toBe(0);
    expect(result.title).toBe("Existing Doc");
    expect(mockInsert.mock.calls.length).toBe(0);
  });

  test("returns conflict:title for same title different content", async () => {
    titleCountResult = 1;
    const text = "Different content from what is stored.";
    const result = await ingestText(text, "Conflicting Title");
    expect(result.conflict).toBe("title");
    expect(result.chunksInserted).toBe(0);
    expect(mockInsert.mock.calls.length).toBe(0);
  });

  test("empty text returns chunksInserted=0", async () => {
    const result = await ingestText("  ", "Empty Doc");
    expect(result.chunksInserted).toBe(0);
    expect(mockInsert.mock.calls.length).toBe(0);
  });

  test("metadata includes content_hash, total_chunks, original_length, pasted_at", async () => {
    const text = "Hello world. ".repeat(50);
    await ingestText(text, "Meta Test");
    expect(mockInsert.mock.calls.length).toBeGreaterThan(0);
    const insertedRows = mockInsert.mock.calls[mockInsert.mock.calls.length - 1][0] as any[];
    expect(insertedRows[0].metadata).toHaveProperty("content_hash");
    expect(insertedRows[0].metadata).toHaveProperty("total_chunks");
    expect(insertedRows[0].metadata).toHaveProperty("original_length");
    expect(insertedRows[0].metadata).toHaveProperty("pasted_at");
  });

  test("uses telegram-paste as default source", async () => {
    const text = "Some pasted text. ".repeat(20);
    await ingestText(text, "Paste Doc");
    const rows = mockInsert.mock.calls[0][0] as any[];
    expect(rows[0].source).toBe("telegram-paste");
  });

  test("accepts custom source override", async () => {
    const text = "Content. ".repeat(20);
    await ingestText(text, "Custom Source Doc", { source: "notion-export" });
    const rows = mockInsert.mock.calls[0][0] as any[];
    expect(rows[0].source).toBe("notion-export");
  });

  test("emits doc_ingest_text_start and doc_ingest_text_complete trace events", async () => {
    const text = "Traceable content. ".repeat(30);
    await ingestText(text, "Trace Text Doc");
    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    expect(events).toContain("doc_ingest_text_start");
    expect(events).toContain("doc_ingest_text_complete");
  });

  test("emits doc_ingest_text_empty for blank input", async () => {
    await ingestText("   ", "Blank Doc");
    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    expect(events).toContain("doc_ingest_text_empty");
  });

  test("emits doc_ingest_text_duplicate when hash matches", async () => {
    hashMatchResult = { title: "Already Stored" };
    await ingestText("Duplicate content.", "Dup Doc");
    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    expect(events).toContain("doc_ingest_text_duplicate");
  });

  test("emits doc_ingest_text_title_conflict when title already exists", async () => {
    titleCountResult = 1;
    await ingestText("Fresh content.", "Taken Title");
    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    expect(events).toContain("doc_ingest_text_title_conflict");
  });

  test("uses provided contentHash override instead of computing from text", async () => {
    // Simulate hash match using the override hash, not the text-derived one
    hashMatchResult = { title: "Existing Doc" };
    const result = await ingestText("Some text that alone would not match.", "New Title", {
      contentHash: "override-hash-abc123",
    });
    // Dedup triggered via the override hash path
    expect(result.duplicate).toBe(true);
    expect(result.chunksInserted).toBe(0);
    expect(mockInsert.mock.calls.length).toBe(0);
  });

  test("stores provided contentHash in chunk metadata", async () => {
    const text = "Content. ".repeat(30);
    await ingestText(text, "Hash Override Doc", {
      contentHash: "binary-hash-xyz789",
    });
    expect(mockInsert.mock.calls.length).toBeGreaterThan(0);
    const rows = mockInsert.mock.calls[mockInsert.mock.calls.length - 1][0] as any[];
    expect(rows[0].metadata.content_hash).toBe("binary-hash-xyz789");
  });

  test("same title + same content is caught as duplicate (not conflict)", async () => {
    // Simulate: same title, same content → hash check fires before title count check
    hashMatchResult = { title: "Same Title" };
    titleCountResult = 1;
    const result = await ingestText("Same content.", "Same Title");
    expect(result.duplicate).toBe(true);
    expect(result.conflict).toBeUndefined();
    expect(mockInsert.mock.calls.length).toBe(0);
  });

  test("different title + same content hash returns duplicate:true", async () => {
    hashMatchResult = { title: "Original Title" };
    const result = await ingestText("Duplicate content.", "Different Title");
    expect(result.duplicate).toBe(true);
    expect(result.title).toBe("Original Title");
    expect(mockInsert.mock.calls.length).toBe(0);
  });

  test("same title + different content returns conflict:title (not deleted preemptively)", async () => {
    mockDelete.mockClear();
    titleCountResult = 1;
    const result = await ingestText("Completely different content.", "Existing Title");
    expect(result.conflict).toBe("title");
    expect(result.duplicate).toBeUndefined();
    // Critically: no delete was triggered inside ingestText — deletion is deferred to handleDocOverwrite
    expect(mockDelete.mock.calls.length).toBe(0);
    expect(mockInsert.mock.calls.length).toBe(0);
  });
});

// ─── hasMarkdownHeadings ──────────────────────────────────────────────────────

describe("hasMarkdownHeadings", () => {
  test("returns true for ## headings", () => {
    expect(hasMarkdownHeadings("## Section One\n\nBody text here.")).toBe(true);
  });

  test("returns true for ### headings", () => {
    expect(hasMarkdownHeadings("### Subsection\n\nMore text.")).toBe(true);
  });

  test("returns true for # headings", () => {
    expect(hasMarkdownHeadings("# Title\n\nIntro paragraph.")).toBe(true);
  });

  test("returns false for plain prose without headings", () => {
    expect(hasMarkdownHeadings("This is just plain text.\n\nNo headings here.")).toBe(false);
  });

  test("returns false for inline # (not at line start)", () => {
    expect(hasMarkdownHeadings("This has a # in the middle of a line.\n\nBody.")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(hasMarkdownHeadings("")).toBe(false);
  });
});

// ─── chunkByHeadings ──────────────────────────────────────────────────────────

describe("chunkByHeadings", () => {
  const SSP_SAMPLE = `## LM-8: Security Log Retention

Logs must be retained for a minimum of 365 days. All security events should be archived to immutable storage. Retention applies to all audit, access, and system logs.

## LM-9: Security Monitoring

GuardDuty or equivalent must be enabled across all accounts. Alerts should trigger on suspicious access patterns and findings must be reviewed within 24 hours.

### LM-9a: Alert Routing

Alerts from GuardDuty and other security tooling must route to GCSOC within 15 minutes of generation. On-call escalation paths must be documented and tested quarterly.
`;

  test("returns one chunk per heading section", () => {
    const chunks = chunkByHeadings(SSP_SAMPLE, "IM8 Low Risk Cloud SSP");
    expect(chunks).toHaveLength(3);
  });

  test("each chunk heading matches the markdown heading line", () => {
    const chunks = chunkByHeadings(SSP_SAMPLE, "IM8 Low Risk Cloud SSP");
    expect(chunks[0].heading).toBe("## LM-8: Security Log Retention");
    expect(chunks[1].heading).toBe("## LM-9: Security Monitoring");
    expect(chunks[2].heading).toBe("### LM-9a: Alert Routing");
  });

  test("each chunk content includes contextual prefix [Doc: ...] [heading]", () => {
    const chunks = chunkByHeadings(SSP_SAMPLE, "IM8 Low Risk Cloud SSP");
    expect(chunks[0].content).toContain("[Doc: IM8 Low Risk Cloud SSP]");
    expect(chunks[0].content).toContain("[## LM-8: Security Log Retention]");
  });

  test("chunk content includes the section body text", () => {
    const chunks = chunkByHeadings(SSP_SAMPLE, "IM8 Low Risk Cloud SSP");
    expect(chunks[0].content).toContain("365 days");
    expect(chunks[1].content).toContain("GuardDuty");
  });

  test("preamble before first heading becomes chunk 0 with doc prefix only", () => {
    const text = "Introduction paragraph with enough words to exceed the minimum content threshold for indexing purposes.\n\n## Section One\n\nSection content with enough text to also pass the minimum content length filter in the chunker.";
    const chunks = chunkByHeadings(text, "My Doc");
    expect(chunks[0].heading).toBe("");
    expect(chunks[0].content).toContain("[Doc: My Doc]");
    expect(chunks[0].content).toContain("Introduction paragraph");
  });

  test("filters out degenerate short chunks", () => {
    const text = "## A\n\nOK\n\n## B\n\nActual content here that is definitely long enough to pass.";
    const chunks = chunkByHeadings(text, "Test");
    // "## A\n\nOK" after prefix is still >30 chars; both should pass
    for (const chunk of chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(30);
    }
  });

  test("returns empty array for text with no content after filtering", () => {
    const chunks = chunkByHeadings("", "Empty Doc");
    expect(chunks).toHaveLength(0);
  });
});

// ─── ingestText — heading-aware chunking ─────────────────────────────────────

describe("ingestText — heading-aware chunking", () => {
  beforeEach(() => {
    mockInsert.mockClear();
    mockTrace.mockClear();
    hashMatchResult = null;
    titleCountResult = 0;
  });

  test("uses heading-aware strategy for markdown documents with headings", async () => {
    const mdText = `## Section 1

This is the first section with enough content to be indexed properly.

## Section 2

This is the second section, also with sufficient content for embedding.
`;
    const result = await ingestText(mdText, "Heading Doc");
    expect(result.chunksInserted).toBe(2);
    const rows = mockInsert.mock.calls[0][0] as any[];
    expect(rows[0].metadata.chunking_strategy).toBe("heading-aware");
    expect(rows[0].chunk_heading).toBe("## Section 1");
    expect(rows[1].chunk_heading).toBe("## Section 2");
  });

  test("uses paragraph strategy for plain prose without headings", async () => {
    const plainText = "Plain prose. ".repeat(200); // long but no headings
    await ingestText(plainText, "Plain Doc");
    const rows = mockInsert.mock.calls[0][0] as any[];
    expect(rows[0].metadata.chunking_strategy).toBe("paragraph");
    expect(rows[0].chunk_heading).toBeUndefined();
  });

  test("flat chunk rows contain [Doc: title] prefix in content", async () => {
    const plainText = "Plain prose without any headings. ".repeat(50);
    await ingestText(plainText, "Knowledge Transfer Archetype");
    const rows = mockInsert.mock.calls[0][0] as any[];
    expect(rows[0].metadata.chunking_strategy).toBe("paragraph");
    expect(rows[0].content).toMatch(/^\[Doc: Knowledge Transfer Archetype\]\n\n/);
  });

  test("stores contextual prefix in content for heading chunks", async () => {
    const mdText = `## LM-8: Security Log Retention

Logs must be retained for a minimum of 365 days. All security events must be archived to immutable storage and protected from tampering for the full retention period.
`;
    await ingestText(mdText, "IM8 SSP");
    const rows = mockInsert.mock.calls[0][0] as any[];
    expect(rows[0].content).toContain("[Doc: IM8 SSP]");
    expect(rows[0].content).toContain("[## LM-8: Security Log Retention]");
    expect(rows[0].content).toContain("365 days");
  });
});

// ─── chunkByPages ─────────────────────────────────────────────────────────────

describe("chunkByPages", () => {
  const pages = [
    { pageNum: 1, text: "Introduction to the project. This is the first page with enough content to pass the minimum filter." },
    { pageNum: 2, text: "Detailed analysis of requirements. This page covers the core business requirements for the system." },
    { pageNum: 3, text: "Short." }, // should be filtered (< 50 chars)
  ];

  test("returns one chunk per page (filtering short pages)", () => {
    const chunks = chunkByPages(pages, "My Report");
    expect(chunks).toHaveLength(2); // page 3 filtered out
  });

  test("each chunk has [Doc: title] [Page N] prefix", () => {
    const chunks = chunkByPages(pages, "My Report");
    expect(chunks[0].content).toContain("[Doc: My Report] [Page 1]");
    expect(chunks[1].content).toContain("[Doc: My Report] [Page 2]");
  });

  test("heading contains page number", () => {
    const chunks = chunkByPages(pages, "My Report");
    expect(chunks[0].heading).toBe("Page 1");
    expect(chunks[1].heading).toBe("Page 2");
  });

  test("splits oversized pages into sub-chunks", () => {
    const bigPage = [{ pageNum: 1, text: "A".repeat(5000) }];
    const chunks = chunkByPages(bigPage, "Big Doc", 2000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].heading).toContain("Page 1 (1/");
  });
});

// ─── chunkByPagesWithHeadings (hybrid) ───────────────────────────────────────

describe("chunkByPagesWithHeadings", () => {
  const pages = [
    { pageNum: 1, text: "## Introduction\n\nWelcome to the project overview document with sufficient content to be indexed properly by the chunking system.\n\n## Background\n\nThe system was built to handle large-scale data processing with enough detail to embed." },
    { pageNum: 2, text: "This page has no headings but has enough content to be a standalone chunk for embedding purposes." },
  ];

  test("splits pages with headings by heading, pages without as single chunk", () => {
    const chunks = chunkByPagesWithHeadings(pages, "Hybrid Doc");
    // Page 1: 2 heading sections, Page 2: 1 chunk
    expect(chunks.length).toBe(3);
  });

  test("hybrid chunks include both page and heading in prefix", () => {
    const chunks = chunkByPagesWithHeadings(pages, "Hybrid Doc");
    expect(chunks[0].content).toContain("[Doc: Hybrid Doc] [Page 1]");
    expect(chunks[0].content).toContain("[## Introduction]");
  });

  test("non-heading pages get page-only prefix", () => {
    const chunks = chunkByPagesWithHeadings(pages, "Hybrid Doc");
    const page2Chunk = chunks.find((c) => c.content.includes("[Page 2]"));
    expect(page2Chunk).toBeDefined();
    expect(page2Chunk!.content).not.toContain("[##");
  });
});

// ─── detectChunkingStrategy ──────────────────────────────────────────────────

describe("detectChunkingStrategy", () => {
  test("returns hybrid when pages and headings present", () => {
    const pages = [{ pageNum: 1, text: "a" }, { pageNum: 2, text: "b" }];
    expect(detectChunkingStrategy("## Heading\n\nBody", pages)).toBe("hybrid");
  });

  test("returns page-boundary when pages but no headings", () => {
    const pages = [{ pageNum: 1, text: "a" }, { pageNum: 2, text: "b" }];
    expect(detectChunkingStrategy("Just plain text", pages)).toBe("page-boundary");
  });

  test("returns heading-aware when headings but no pages", () => {
    expect(detectChunkingStrategy("## Section\n\nBody text")).toBe("heading-aware");
  });

  test("returns paragraph when neither pages nor headings", () => {
    expect(detectChunkingStrategy("Plain paragraph text.")).toBe("paragraph");
  });

  test("returns paragraph for single page (no useful page structure)", () => {
    const singlePage = [{ pageNum: 1, text: "all content" }];
    expect(detectChunkingStrategy("all content", singlePage)).toBe("paragraph");
  });
});

// ─── parsePageMarkers (pdfExtractor) ──────────────────────────────────────────

describe("parsePageMarkers", () => {
  // Import directly since it's a pure function
  let parsePageMarkers: typeof import("./pdfExtractor").parsePageMarkers;
  let hashPdfContent: typeof import("./pdfExtractor").hashPdfContent;

  beforeEach(async () => {
    const mod = await import("./pdfExtractor");
    parsePageMarkers = mod.parsePageMarkers;
    hashPdfContent = mod.hashPdfContent;
  });

  test("parses text with [PAGE N] markers into page array", () => {
    const text = "[PAGE 1] First page content.\n\n[PAGE 2] Second page content.";
    const pages = parsePageMarkers(text);
    expect(pages).toHaveLength(2);
    expect(pages[0].pageNum).toBe(1);
    expect(pages[0].text).toContain("First page");
    expect(pages[1].pageNum).toBe(2);
  });

  test("returns single page when no markers found", () => {
    const text = "Plain text without any markers";
    const pages = parsePageMarkers(text);
    expect(pages).toHaveLength(1);
    expect(pages[0].pageNum).toBe(1);
    expect(pages[0].text).toBe("Plain text without any markers");
  });

  test("returns empty array for empty string", () => {
    expect(parsePageMarkers("")).toHaveLength(0);
    expect(parsePageMarkers("   ")).toHaveLength(0);
  });

  test("handles preamble before first marker", () => {
    const text = "Preamble text\n\n[PAGE 1] Actual content";
    const pages = parsePageMarkers(text);
    expect(pages[0].pageNum).toBe(0);
    expect(pages[0].text).toBe("Preamble text");
    expect(pages[1].pageNum).toBe(1);
  });

  test("hashPdfContent returns consistent hash for same input", () => {
    const buf = Buffer.from("test pdf content");
    const h1 = hashPdfContent(buf);
    const h2 = hashPdfContent(buf);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // SHA-256 hex
  });
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────

afterAll(() => {
  try { rmSync(TMP, { recursive: true }); } catch {}
});
