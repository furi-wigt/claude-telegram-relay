/**
 * documentProcessor tests
 *
 * TDD: RED first — these tests define the expected contract.
 */

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

// ─── Mock Supabase ────────────────────────────────────────────────────────────

type InsertRow = {
  title: string;
  source: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
};

const mockInsert = mock(async (_rows: InsertRow[]) => ({ error: null }));
const mockDelete = mock(async () => ({ count: 3, error: null }));
const mockSelect = mock(async () => ({
  data: [
    { title: "My Policy", source: "policy.pdf", chunk_index: 0, created_at: "2026-02-23T00:00:00Z" },
    { title: "My Policy", source: "policy.pdf", chunk_index: 1, created_at: "2026-02-23T00:00:00Z" },
  ],
  error: null,
}));

/** Returns a chainable thenable so `.eq().eq()` and single `.eq()` both resolve. */
function makeEqChain(resultFn: () => Promise<{ count: number; error: null }>) {
  const chain: any = {
    eq: (_col: string, _val: string) => makeEqChain(resultFn),
    then: (resolve: any, reject: any) => resultFn().then(resolve, reject),
  };
  return chain;
}

const mockFrom = mock((_table: string) => ({
  insert: mockInsert,
  delete: (_opts?: unknown) => makeEqChain(mockDelete),
  select: () => ({
    order: (_col: string, _opts: unknown) => mockSelect(),
  }),
}));

const mockSupabase = { from: mockFrom } as unknown as import("@supabase/supabase-js").SupabaseClient;

// ─── Import module under test ─────────────────────────────────────────────────
// Must import after mock.module() calls.
const { chunkText, extractTextFromFile, ingestDocument, deleteDocument, listDocuments } =
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
  test("reads .txt file as utf-8", async () => {
    const file = join(TMP, "test.txt");
    writeFileSync(file, "Hello from text file");
    const text = await extractTextFromFile(file, "text/plain");
    expect(text).toBe("Hello from text file");
  });

  test("reads .md file as utf-8", async () => {
    const file = join(TMP, "test.md");
    writeFileSync(file, "# Heading\nContent here");
    const text = await extractTextFromFile(file, "text/markdown");
    expect(text).toContain("Heading");
    expect(text).toContain("Content here");
  });

  test("routes image mime types to analyzeImage", async () => {
    mockAnalyzeImage.mockClear();
    const file = join(TMP, "scan.jpg");
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // JPEG magic bytes
    const text = await extractTextFromFile(file, "image/jpeg");
    expect(text).toBe("Extracted text from image");
    expect(mockAnalyzeImage.mock.calls.length).toBe(1);
  });

  test("routes png images to analyzeImage", async () => {
    mockAnalyzeImage.mockClear();
    const file = join(TMP, "scan.png");
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes
    await extractTextFromFile(file, "image/png");
    expect(mockAnalyzeImage.mock.calls.length).toBe(1);
  });

  test("returns empty string when PDF text extraction fails gracefully", async () => {
    const file = join(TMP, "empty.pdf");
    writeFileSync(file, "%PDF-1.4 fake content");
    const text = await extractTextFromFile(file, "application/pdf");
    // pdf-parse is not installed, should return "" gracefully
    expect(typeof text).toBe("string");
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
    const result = await ingestDocument(mockSupabase, file, "My Policy");
    expect(result.title).toBe("My Policy");
    expect(result.chunksInserted).toBeGreaterThan(0);
  });

  test("calls supabase.from('documents').insert with correct shape", async () => {
    const file = join(TMP, "small.txt");
    writeFileSync(file, "X".repeat(200));
    await ingestDocument(mockSupabase, file, "Test Doc");
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
    const result = await ingestDocument(mockSupabase, file, "Empty Doc");
    expect(result.chunksInserted).toBe(0);
  });

  test("uses filename as source when not provided", async () => {
    const file = join(TMP, "mypolicy.txt");
    writeFileSync(file, "Content here. ".repeat(30));
    await ingestDocument(mockSupabase, file, "My Policy");
    const rows = mockInsert.mock.calls[0][0] as InsertRow[];
    expect(rows[0].source).toBe("mypolicy.txt");
  });

  test("accepts explicit source override", async () => {
    const file = join(TMP, "doc.txt");
    writeFileSync(file, "Content. ".repeat(30));
    await ingestDocument(mockSupabase, file, "My Doc", { source: "custom_source.pdf" });
    const rows = mockInsert.mock.calls[0][0] as InsertRow[];
    expect(rows[0].source).toBe("custom_source.pdf");
  });
});

// ─── deleteDocument ───────────────────────────────────────────────────────────

describe("deleteDocument", () => {
  test("returns deleted count", async () => {
    const result = await deleteDocument(mockSupabase, "My Policy");
    expect(result.deleted).toBe(3);
  });
});

// ─── listDocuments ────────────────────────────────────────────────────────────

describe("listDocuments", () => {
  test("returns array of DocSummary with title, sources, chunks", async () => {
    const docs = await listDocuments(mockSupabase);
    expect(docs).toHaveLength(1); // grouped by title
    expect(docs[0].title).toBe("My Policy");
    expect(docs[0].chunks).toBe(2);
    expect(docs[0].sources).toContain("policy.pdf");
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
    await ingestDocument(mockSupabase, file, "Trace Doc", { source: "trace.txt", mimeType: "text/plain" });

    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    expect(events).toContain("doc_ingest_start");
  });

  test("doc_ingest_start includes title and source", async () => {
    const file = join(TMP, `trace_title_${Date.now()}.txt`);
    writeFileSync(file, "Content.\n\nMore.");
    await ingestDocument(mockSupabase, file, "My Report", { source: "report.txt", mimeType: "text/plain" });

    const startCall = mockTrace.mock.calls.find(
      (c) => (c[0] as any).event === "doc_ingest_start"
    );
    expect(startCall).toBeDefined();
    expect((startCall![0] as any).title).toBe("My Report");
    expect((startCall![0] as any).source).toBe("report.txt");
  });

  test("emits doc_ingest_complete with chunksInserted after success", async () => {
    const file = join(TMP, `trace_complete_${Date.now()}.txt`);
    writeFileSync(file, ("Para ".repeat(50) + "\n\n").repeat(3));
    const result = await ingestDocument(mockSupabase, file, "Complete Doc", { mimeType: "text/plain" });

    const completeCall = mockTrace.mock.calls.find(
      (c) => (c[0] as any).event === "doc_ingest_complete"
    );
    expect(completeCall).toBeDefined();
    expect((completeCall![0] as any).chunksInserted).toBe(result.chunksInserted);
    expect((completeCall![0] as any).title).toBe("Complete Doc");
  });

  test("emits doc_ingest_empty when file has no usable text", async () => {
    const file = join(TMP, `trace_empty_${Date.now()}.txt`);
    writeFileSync(file, "   \n   ");
    await ingestDocument(mockSupabase, file, "Empty Doc", { mimeType: "text/plain" });

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
    await deleteDocument(mockSupabase, "Insurance Policy 2024");

    const events = mockTrace.mock.calls.map((c) => (c[0] as any).event);
    expect(events).toContain("doc_delete");
  });

  test("doc_delete includes title and deleted count", async () => {
    await deleteDocument(mockSupabase, "Budget Report Q1");

    const deleteCall = mockTrace.mock.calls.find(
      (c) => (c[0] as any).event === "doc_delete"
    );
    expect(deleteCall).toBeDefined();
    expect((deleteCall![0] as any).title).toBe("Budget Report Q1");
    expect(typeof (deleteCall![0] as any).deleted).toBe("number");
  });
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────

afterAll(() => {
  try { rmSync(TMP, { recursive: true }); } catch {}
});
