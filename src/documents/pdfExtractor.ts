/**
 * PDF text extractor with fast unpdf primary path and Claude CLI fallback.
 *
 * Primary: unpdf (pdfjs-dist wrapper) — instant text extraction for digital PDFs.
 * Fallback: Claude CLI — for scanned/image PDFs where unpdf yields sparse text.
 *
 * Extracted text is cached in SQLite (`pdf_extractions` table) keyed by
 * content hash — re-ingesting the same PDF skips extraction entirely.
 */

import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { extractText } from "unpdf";
import { claudeText } from "../claude-process";
import { trace } from "../utils/tracer";

export interface PageText {
  pageNum: number;
  text: string;
}

export interface PdfExtraction {
  pages: PageText[];
  fullText: string;
  contentHash: string;
  extractionMethod: "unpdf" | "claude-cli" | "cache";
}

/** Minimum average chars per page to consider unpdf extraction successful. */
const MIN_CHARS_PER_PAGE = 50;

const PDF_EXTRACT_PROMPT = (filePath: string) =>
  `Read the file at exactly this path: ${filePath}\n\n` +
  `This is a PDF document. Extract ALL text content from it.\n\n` +
  `IMPORTANT: Mark page boundaries with [PAGE 1], [PAGE 2], etc. at the start of each page's content.\n` +
  `If you cannot determine exact page boundaries, use [PAGE 1] for the entire content.\n\n` +
  `Return ONLY the extracted text with page markers. No analysis, no commentary.`;

/**
 * Hash the first 8KB of a PDF for cache lookup.
 * 8KB captures the PDF header + first page structure — sufficient for dedup.
 */
export function hashPdfContent(buffer: Buffer): string {
  const slice = buffer.subarray(0, 8192);
  return createHash("sha256").update(slice).digest("hex");
}

/** Serialize PageText[] into the [PAGE N] format used for caching and downstream chunking. */
function pagesToFullText(pages: PageText[]): string {
  return pages.map((p) => `[PAGE ${p.pageNum}]\n${p.text}`).join("\n\n");
}

/**
 * Parse Claude CLI output into page-segmented text.
 * Splits on `[PAGE N]` markers. If no markers found, treats entire text as page 1.
 */
export function parsePageMarkers(rawText: string): PageText[] {
  const pagePattern = /\[PAGE\s+(\d+)\]/gi;
  const parts = rawText.split(pagePattern);

  // No markers found — entire text is page 1
  if (parts.length <= 1) {
    const text = rawText.trim();
    return text ? [{ pageNum: 1, text }] : [];
  }

  // parts alternates: [preamble, pageNum, text, pageNum, text, ...]
  const pages: PageText[] = [];

  // Any text before the first marker is preamble (rare) — include as page 0
  const preamble = parts[0].trim();
  if (preamble) {
    pages.push({ pageNum: 0, text: preamble });
  }

  for (let i = 1; i < parts.length; i += 2) {
    const pageNum = parseInt(parts[i], 10);
    const text = (parts[i + 1] ?? "").trim();
    if (text) {
      pages.push({ pageNum, text });
    }
  }

  return pages;
}

// ── Cache layer ─────────────────────────────────────────────────────────────

function getCacheDb() {
  // Lazy import to avoid circular dependency and allow tests to mock
  const { getDb } = require("../local/db");
  return getDb();
}

let _cacheTableReady = false;

function ensureCacheTable(): void {
  if (_cacheTableReady) return;
  const db = getCacheDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS pdf_extractions (
      content_hash TEXT PRIMARY KEY,
      full_text TEXT NOT NULL,
      page_count INTEGER NOT NULL,
      extracted_at TEXT DEFAULT (datetime('now'))
    )
  `);
  _cacheTableReady = true;
}

function getCachedExtraction(contentHash: string): string | null {
  try {
    ensureCacheTable();
    const row = getCacheDb()
      .query("SELECT full_text FROM pdf_extractions WHERE content_hash = ?")
      .get(contentHash) as { full_text: string } | null;
    return row?.full_text ?? null;
  } catch {
    return null;
  }
}

function cacheExtraction(contentHash: string, fullText: string, pageCount: number): void {
  try {
    ensureCacheTable();
    getCacheDb().run(
      `INSERT OR REPLACE INTO pdf_extractions (content_hash, full_text, page_count) VALUES (?, ?, ?)`,
      [contentHash, fullText, pageCount]
    );
  } catch (err) {
    console.warn("[pdfExtractor] cache write failed:", err instanceof Error ? err.message : err);
  }
}

// ── Fast extraction via unpdf ───────────────────────────────────────────────

/**
 * Extract text using unpdf (pdfjs-dist). Returns null if the PDF appears
 * to be scanned/image-based (sparse text output).
 */
async function extractWithUnpdf(
  buffer: Buffer,
  onProgress?: (msg: string) => void,
): Promise<PageText[] | null> {
  onProgress?.("📄 Extracting text (fast mode)…");
  // unpdf/pdfjs-dist rejects Buffer — must pass a plain Uint8Array
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const result = await extractText(data, { mergePages: false });

  // TODO: remove cast once unpdf fixes its types for mergePages: false
  const pageTexts = result.text as unknown as string[];
  const pages: PageText[] = [];
  if (Array.isArray(pageTexts)) {
    for (let i = 0; i < pageTexts.length; i++) {
      const text = pageTexts[i]?.trim();
      if (text) {
        pages.push({ pageNum: i + 1, text });
      }
    }
  }

  // Check if extraction yielded meaningful text
  if (pages.length === 0) return null;
  const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
  const avgCharsPerPage = totalChars / (result.totalPages || 1);
  if (avgCharsPerPage < MIN_CHARS_PER_PAGE) return null;

  return pages;
}

// ── Claude CLI fallback ─────────────────────────────────────────────────────

async function extractWithClaudeCli(
  filePath: string,
  timeoutMs: number,
  model: string,
  onProgress?: (msg: string) => void,
): Promise<PageText[]> {
  onProgress?.("📄 Scanned PDF detected — reading with Claude…");
  const rawText = await claudeText(PDF_EXTRACT_PROMPT(filePath), {
    model,
    timeoutMs,
    dangerouslySkipPermissions: true,
    cwd: undefined,
  });
  return parsePageMarkers(rawText);
}

// ── Main extractor ──────────────────────────────────────────────────────────

/**
 * Extract text from a PDF.
 *
 * Strategy:
 *  1. Check SQLite cache (by content hash)
 *  2. Try unpdf (fast, <1s for digital PDFs)
 *  3. Fall back to Claude CLI (for scanned/image PDFs)
 */
export async function extractPdf(
  filePath: string,
  opts?: {
    timeoutMs?: number;
    model?: string;
    onProgress?: (msg: string) => void;
  },
): Promise<PdfExtraction> {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const model = opts?.model ?? "claude-sonnet-4-6";

  const buffer = Buffer.from(await readFile(filePath));
  const contentHash = hashPdfContent(buffer);

  // 1. Cache hit
  const cached = getCachedExtraction(contentHash);
  if (cached) {
    trace({ event: "pdf_extract_cache_hit", filePath, contentHash });
    opts?.onProgress?.("📄 Using cached extraction");
    const pages = parsePageMarkers(cached);
    return { pages, fullText: cached, contentHash, extractionMethod: "cache" };
  }

  const start = Date.now();

  // 2. Try unpdf (fast path)
  try {
    const pages = await extractWithUnpdf(buffer, opts?.onProgress);
    if (pages) {
      const fullText = pagesToFullText(pages);
      const elapsed = Date.now() - start;
      trace({ event: "pdf_extract_complete", filePath, method: "unpdf", pageCount: pages.length, chars: fullText.length, elapsedMs: elapsed });
      opts?.onProgress?.(`📄 Extracted ${pages.length} page(s), ${fullText.length.toLocaleString()} chars (${elapsed}ms)`);
      cacheExtraction(contentHash, fullText, pages.length);
      return { pages, fullText, contentHash, extractionMethod: "unpdf" };
    }
  } catch (err) {
    console.error("[pdfExtractor] unpdf failed, falling back to Claude CLI:", err instanceof Error ? err.message : String(err));
    trace({ event: "pdf_extract_unpdf_error", filePath, error: err instanceof Error ? err.message : String(err) });
  }

  // 3. Fallback to Claude CLI (scanned/image PDFs)
  trace({ event: "pdf_extract_start", filePath, contentHash, model, method: "claude-cli" });
  try {
    const pages = await extractWithClaudeCli(filePath, timeoutMs, model, opts?.onProgress);
    const fullText = pagesToFullText(pages);
    const elapsed = Date.now() - start;
    trace({ event: "pdf_extract_complete", filePath, method: "claude-cli", pageCount: pages.length, chars: fullText.length, elapsedMs: elapsed });
    opts?.onProgress?.(`📄 Extracted ${pages.length} page(s), ${fullText.length.toLocaleString()} chars`);
    cacheExtraction(contentHash, fullText, pages.length);
    return { pages, fullText, contentHash, extractionMethod: "claude-cli" };
  } catch (err) {
    trace({ event: "pdf_extract_error", filePath, error: err instanceof Error ? err.message : String(err) });
    throw new Error(
      `PDF extraction failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
