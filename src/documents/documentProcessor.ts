/**
 * Document Processor
 *
 * Reusable module for chunking, extracting, ingesting, deleting,
 * and listing documents in local SQLite + Qdrant. Embeddings are
 * generated synchronously via Ollama BGE-M3 during insert.
 *
 * Emits structured trace events for all operations when OBSERVABILITY_ENABLED=1.
 */

import { readFileSync } from "fs";
import { basename } from "path";
import { createHash } from "crypto";
import { invalidateDocumentsCache } from "../rag/hasDocuments.ts";
import { analyzeImage } from "../vision/visionClient.ts";
import { trace } from "../utils/tracer.ts";
import {
  insertDocumentRecords,
  deleteDocumentRecords,
  checkContentHashExists,
  countDocumentsByTitle,
  fuzzyMatchDocumentTitle,
  checkDocumentTitleCollision,
  resolveUniqueTitleBackend,
  listDocumentsLocal,
} from "../local/storageBackend";

export interface DocSummary {
  title: string;
  sources: string[];
  chunks: number;
  latestAt?: string;
}

// ─── hasMarkdownHeadings ──────────────────────────────────────────────────────

/**
 * Returns true if the text contains one or more markdown headings (# through ###).
 * Used to decide whether to apply heading-aware chunking.
 */
export function hasMarkdownHeadings(text: string): boolean {
  return /^#{1,3}\s+.+/m.test(text);
}

// ─── chunkByHeadings ──────────────────────────────────────────────────────────

export interface HeadingChunk {
  /** The raw markdown heading line, e.g. "## LM-8: Security Log Retention" */
  heading: string;
  /** Contextual prefix + section body — this is what gets embedded */
  content: string;
}

/**
 * Split a heading-rich document into one chunk per section.
 * Each chunk is prefixed with `[Doc: {docTitle}] [{heading}]` so the
 * embedding carries document + section context, not just the body text.
 *
 * Headings `#` through `###` are treated as split points.
 * Any preamble before the first heading becomes chunk 0 (prefixed with doc title only).
 * Sections shorter than 30 chars are dropped.
 */
export function chunkByHeadings(text: string, docTitle: string): HeadingChunk[] {
  const lines = text.split("\n");
  const sections: { heading: string; bodyLines: string[] }[] = [];
  let currentHeading = "";
  let currentBody: string[] = [];

  const flush = () => {
    const body = currentBody.join("\n").trim();
    if (body || currentHeading) {
      sections.push({ heading: currentHeading, bodyLines: currentBody });
    }
  };

  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.+)/);
    if (match) {
      flush();
      currentHeading = line.trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  flush();

  const titleLabel = docTitle.length > 60 ? docTitle.slice(0, 57) + "…" : docTitle;

  return sections
    .map(({ heading, bodyLines }) => {
      const body = bodyLines.join("\n").trim();
      // Truncate long headings in the prefix to prevent embedding dilution (A2.3)
      const headingLabel = heading.length > 80 ? heading.slice(0, 77) + "…" : heading;
      const prefix = headingLabel
        ? `[Doc: ${titleLabel}] [${headingLabel}]\n\n`
        : `[Doc: ${titleLabel}]\n\n`;
      const content = prefix + (body || heading);
      return { heading, content };
    })
    .filter(({ content }) => content.length > 100);
}

// ─── chunkText ────────────────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks.
 * Tries to break on paragraph boundaries (double newline) first,
 * then falls back to hard split at chunkSize.
 */
export function chunkText(
  text: string,
  chunkSize = 1800,
  overlap = 200
): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 2 > chunkSize) {
      if (current) {
        chunks.push(current.trim());
        // Keep last `overlap` chars as context for next chunk
        current =
          current.length > overlap
            ? current.slice(-overlap) + "\n\n" + trimmed
            : trimmed;
      } else {
        // Single paragraph exceeds chunk size — hard split
        for (let i = 0; i < trimmed.length; i += chunkSize - overlap) {
          chunks.push(trimmed.slice(i, i + chunkSize));
        }
        // Carry overlap from last hard-split chunk into next paragraph
        const lastHardChunk = chunks[chunks.length - 1];
        current = lastHardChunk ? lastHardChunk.slice(-overlap) : "";
      }
    } else {
      current = current ? current + "\n\n" + trimmed : trimmed;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.filter((c) => c.trim().length > 0);
}

// ─── ingestText ───────────────────────────────────────────────────────────────

export type ChunkingStrategy = "heading-aware" | "paragraph" | "page-boundary" | "hybrid";

// ─── PageText type (canonical definition in pdfExtractor) ─────────────────────

export type { PageText } from "./pdfExtractor";

// ─── chunkByPages ─────────────────────────────────────────────────────────────

/**
 * Split a page-segmented document into chunks, one per page.
 * Oversized pages (> maxPageChars) are split at paragraph boundaries.
 * Each chunk is prefixed with `[Doc: {title}] [Page {N}]`.
 */
export function chunkByPages(
  pages: PageText[],
  docTitle: string,
  maxPageChars = 3000,
): HeadingChunk[] {
  const titleLabel = docTitle.length > 60 ? docTitle.slice(0, 57) + "…" : docTitle;
  const chunks: HeadingChunk[] = [];

  for (const page of pages) {
    const text = page.text.trim();
    if (!text || text.length < 50) continue;

    if (text.length <= maxPageChars) {
      chunks.push({
        heading: `Page ${page.pageNum}`,
        content: `[Doc: ${titleLabel}] [Page ${page.pageNum}]\n\n${text}`,
      });
    } else {
      // Oversized page — split at paragraph boundaries
      const subChunks = chunkText(text, 1800, 200);
      for (let i = 0; i < subChunks.length; i++) {
        chunks.push({
          heading: `Page ${page.pageNum} (${i + 1}/${subChunks.length})`,
          content: `[Doc: ${titleLabel}] [Page ${page.pageNum}, part ${i + 1}]\n\n${subChunks[i]}`,
        });
      }
    }
  }

  return chunks;
}

// ─── chunkByPagesWithHeadings (hybrid) ───────────────────────────────────────

/**
 * Hybrid strategy: heading-aware chunking within page boundaries.
 * Best for structured PDFs (reports, policies) that have both
 * page markers and markdown headings.
 *
 * For pages with headings: split by heading within the page.
 * For pages without headings: treat entire page as one chunk.
 */
export function chunkByPagesWithHeadings(
  pages: PageText[],
  docTitle: string,
): HeadingChunk[] {
  const titleLabel = docTitle.length > 60 ? docTitle.slice(0, 57) + "…" : docTitle;
  const chunks: HeadingChunk[] = [];

  for (const page of pages) {
    const text = page.text.trim();
    if (!text || text.length < 50) continue;

    if (hasMarkdownHeadings(text)) {
      // Page has headings — split by heading within the page
      const headingChunks = chunkByHeadings(text, docTitle);
      for (const hc of headingChunks) {
        // Replace the doc-only prefix with doc+page prefix
        const headingLabel = hc.heading.length > 80 ? hc.heading.slice(0, 77) + "…" : hc.heading;
        const prefix = headingLabel
          ? `[Doc: ${titleLabel}] [Page ${page.pageNum}] [${headingLabel}]\n\n`
          : `[Doc: ${titleLabel}] [Page ${page.pageNum}]\n\n`;
        // Extract body from the heading chunk (strip old prefix)
        const bodyMatch = hc.content.match(/\]\n\n([\s\S]*)/);
        const body = bodyMatch ? bodyMatch[1] : hc.content;
        chunks.push({
          heading: hc.heading ? `Page ${page.pageNum} — ${hc.heading}` : `Page ${page.pageNum}`,
          content: prefix + body,
        });
      }
    } else {
      // No headings — treat page as single chunk (split if oversized)
      const pageChunks = chunkByPages([page], docTitle);
      chunks.push(...pageChunks);
    }
  }

  return chunks;
}

// ─── detectChunkingStrategy ──────────────────────────────────────────────────

/**
 * Auto-select the best chunking strategy based on content structure.
 *
 * Priority: hybrid (pages+headings) > page-boundary > heading-aware > paragraph
 */
export function detectChunkingStrategy(
  text: string,
  pages?: PageText[],
): ChunkingStrategy {
  const hasPages = pages && pages.length > 1;
  const hasHeadings = hasMarkdownHeadings(text);

  if (hasPages && hasHeadings) return "hybrid";
  if (hasPages) return "page-boundary";
  if (hasHeadings) return "heading-aware";
  return "paragraph";
}

export interface IngestResult {
  chunksInserted: number;
  title: string;
  duplicate?: boolean;
  conflict?: "title";
}

/**
 * Ingest raw text into local `documents` table (SQLite + Qdrant).
 * Used for pasted text, /remember large content, and post-response save offers.
 *
 * Guards:
 *  1. Content hash dedup — same text already stored → returns { duplicate: true }
 *  2. Title conflict — same name, different content → returns { conflict: "title" }
 *     (caller shows 3-option inline keyboard)
 *
 * Embeddings are generated synchronously via Ollama BGE-M3 during insert.
 *
 * Emits: doc_ingest_text_start, doc_ingest_text_complete, doc_ingest_text_empty,
 *        doc_ingest_text_duplicate, doc_ingest_text_title_conflict.
 */
export async function ingestText(
  text: string,
  title: string,
  opts: {
    source?: string;
    chunkSize?: number;
    overlap?: number;
    pages?: PageText[];
    onProgress?: (msg: string) => void;
    /** Optional pre-computed content hash (e.g. binary hash for PDFs). When provided,
     *  used instead of the text-derived hash for more reliable dedup. */
    contentHash?: string;
  } = {}
): Promise<IngestResult> {
  const { source = "telegram-paste", chunkSize = 1800, overlap = 200, pages } = opts;

  trace({ event: "doc_ingest_text_start", title, source, textLength: text.length });

  if (!text.trim()) {
    trace({ event: "doc_ingest_text_empty", title });
    return { chunksInserted: 0, title };
  }

  // Guards: content hash dedup + title conflict check
  // Use caller-supplied hash (e.g. PDF binary hash) when available — more reliable than text slice.
  const contentHash = opts.contentHash ?? createHash("sha256").update(text.slice(0, 2000)).digest("hex");

  const [hashMatch, titleCount] = await Promise.all([
    checkContentHashExists(contentHash),
    countDocumentsByTitle(title),
  ]);

  // Guard 1: Content hash dedup — exact same text already stored
  if (hashMatch) {
    trace({ event: "doc_ingest_text_duplicate", title, existingTitle: hashMatch.title });
    return { chunksInserted: 0, title: hashMatch.title, duplicate: true };
  }

  // Guard 2: Title conflict — same name, different content
  if (titleCount && titleCount > 0) {
    trace({ event: "doc_ingest_text_title_conflict", title });
    return { chunksInserted: 0, title, conflict: "title" };
  }

  // No conflicts — detect strategy, chunk, and insert
  const strategy = detectChunkingStrategy(text, pages);
  opts.onProgress?.(`📊 Chunking with ${strategy} strategy…`);

  let structuredChunks: HeadingChunk[];

  switch (strategy) {
    case "hybrid":
      structuredChunks = chunkByPagesWithHeadings(pages!, title);
      break;
    case "page-boundary":
      structuredChunks = chunkByPages(pages!, title);
      break;
    case "heading-aware":
      structuredChunks = chunkByHeadings(text, title);
      break;
    case "paragraph":
    default: {
      const flatChunks = chunkText(text, chunkSize, overlap);
      structuredChunks = flatChunks.map((content, i) => ({
        heading: "",
        content: `[Doc: ${title}]\n\n${content}`,
      }));
      break;
    }
  }

  if (!structuredChunks.length) {
    trace({ event: "doc_ingest_text_empty", title });
    return { chunksInserted: 0, title };
  }

  const rows = structuredChunks.map(({ heading, content }, chunk_index) => ({
    title,
    source,
    chunk_index,
    chunk_heading: heading || undefined,
    content,
    metadata: {
      total_chunks: structuredChunks.length,
      original_length: text.length,
      content_hash: contentHash,
      pasted_at: new Date().toISOString(),
      chunking_strategy: strategy,
      ...(pages ? { page_count: pages.length } : {}),
    } as Record<string, unknown>,
  }));

  await insertDocumentRecords(rows);

  trace({ event: "doc_ingest_text_complete", title, source, chunksInserted: rows.length });

  invalidateDocumentsCache();
  return { chunksInserted: rows.length, title };
}

// ─── resolveUniqueTitle ───────────────────────────────────────────────────────

/**
 * Find the first unused variant of `baseTitle` in the documents table.
 * Delegates to storageBackend for mode-aware lookup.
 */
export async function resolveUniqueTitle(
  baseTitle: string
): Promise<string> {
  return resolveUniqueTitleBackend(baseTitle);
}

// ─── extractTextFromFile ──────────────────────────────────────────────────────

/**
 * Extract text from a file based on its MIME type.
 *  - image/*          → Claude vision analysis via analyzeImage
 *  - application/pdf  → Claude CLI with page markers (via pdfExtractor)
 *  - everything else  → UTF-8 read
 */
export async function extractTextFromFile(
  filePath: string,
  mimeType?: string,
  opts?: { onProgress?: (msg: string) => void },
): Promise<{ text: string; pages?: PageText[]; contentHash?: string }> {
  const mime = mimeType ?? "";

  if (mime.startsWith("image/")) {
    const buffer = readFileSync(filePath);
    const text = await analyzeImage(buffer);
    return { text };
  }

  if (mime === "application/pdf") {
    const { extractPdf } = await import("./pdfExtractor");
    const result = await extractPdf(filePath, { onProgress: opts?.onProgress });
    return { text: result.fullText, pages: result.pages, contentHash: result.contentHash };
  }

  // text/plain, text/markdown, or any unrecognised type → UTF-8
  const text = readFileSync(filePath, "utf-8");
  return { text };
}

// ─── ingestDocument ───────────────────────────────────────────────────────────

/**
 * Ingest a single file into the documents table.
 * Extracts text (PDF via Claude CLI, images via vision, text via readFile),
 * then delegates to ingestText() for unified chunking, dedup, and storage.
 *
 * Returns { chunksInserted, title }.
 * Returns chunksInserted=0 when the file yields no usable text.
 *
 * Emits: doc_ingest_start, doc_ingest_complete, doc_ingest_empty.
 */
export async function ingestDocument(
  filePath: string,
  title: string,
  opts: { source?: string; mimeType?: string; onProgress?: (msg: string) => void } = {}
): Promise<IngestResult> {
  const source = opts.source ?? basename(filePath);

  trace({ event: "doc_ingest_start", title, source, mimeType: opts.mimeType ?? null });

  opts.onProgress?.(`📄 Extracting text from ${source}…`);
  const extracted = await extractTextFromFile(filePath, opts.mimeType, {
    onProgress: opts.onProgress,
  });

  if (!extracted.text.trim()) {
    trace({ event: "doc_ingest_empty", title, source });
    return { chunksInserted: 0, title };
  }

  // Delegate to ingestText for unified chunking pipeline.
  // Note: do NOT pre-delete here — ingestText performs content-hash dedup first.
  // Deletion on overwrite is handled by handleDocOverwrite() after user confirmation.
  return ingestText(extracted.text, title, {
    source,
    pages: extracted.pages,
    onProgress: opts.onProgress,
    contentHash: extracted.contentHash,
  });
}

// ─── deleteDocument ───────────────────────────────────────────────────────────

/**
 * Delete all chunks for a document title.
 * Returns { deleted: number }.
 *
 * Emits: doc_delete.
 */
export async function deleteDocument(
  title: string
): Promise<{ deleted: number; matchedTitle?: string }> {
  // Try exact match first
  const { deleted } = await deleteDocumentRecords(title);

  if (deleted > 0) {
    trace({ event: "doc_delete", title, deleted });
    return { deleted };
  }

  // Fallback: case-insensitive partial match
  const matchedTitle = await fuzzyMatchDocumentTitle(title);
  if (!matchedTitle) return { deleted: 0 };

  const result = await deleteDocumentRecords(matchedTitle);
  trace({ event: "doc_delete", title: matchedTitle, deleted: result.deleted });
  return { deleted: result.deleted, matchedTitle };
}

// ─── checkTitleCollision ──────────────────────────────────────────────────────

/**
 * Check whether a document with the given title (case-insensitive) already exists.
 * Delegates to storageBackend for mode-aware lookup.
 */
export async function checkTitleCollision(
  title: string
): Promise<{ exists: boolean; existingTitle?: string }> {
  return checkDocumentTitleCollision(title);
}

// ─── listDocuments ────────────────────────────────────────────────────────────

/**
 * List all ingested documents, grouped by title.
 * Returns an array of DocSummary sorted by most-recently ingested first.
 */
export async function listDocuments(): Promise<DocSummary[]> {
  const docs = await listDocumentsLocal();
  return docs.map((d) => ({
    title: d.title,
    sources: [d.source],
    chunks: d.chunks,
    latestAt: d.created_at,
  }));
}
