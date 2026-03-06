/**
 * Document Processor
 *
 * Reusable module for chunking, extracting, ingesting, deleting,
 * and listing documents in Supabase. Embeddings are auto-generated
 * by the `embed` Edge Function webhook on INSERT.
 *
 * Emits structured trace events for all operations when OBSERVABILITY_ENABLED=1.
 */

import { readFileSync } from "fs";
import { basename } from "path";
import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { analyzeImage } from "../vision/visionClient.ts";
import { trace } from "../utils/tracer.ts";

export interface DocSummary {
  title: string;
  sources: string[];
  chunks: number;
  latestAt?: string;
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

export interface IngestResult {
  chunksInserted: number;
  title: string;
  duplicate?: boolean;
  conflict?: "title";
}

/**
 * Ingest raw text into Supabase `documents` table.
 * Used for pasted text, /remember large content, and post-response save offers.
 *
 * Guards:
 *  1. Content hash dedup — same text already stored → returns { duplicate: true }
 *  2. Title conflict — same name, different content → returns { conflict: "title" }
 *     (caller shows 3-option inline keyboard)
 *
 * Embeddings are generated automatically via the `embed` Edge Function webhook on INSERT.
 *
 * Emits: doc_ingest_text_start, doc_ingest_text_complete, doc_ingest_text_empty,
 *        doc_ingest_text_duplicate, doc_ingest_text_title_conflict.
 */
export async function ingestText(
  supabase: SupabaseClient,
  text: string,
  title: string,
  opts: { source?: string; chunkSize?: number; overlap?: number } = {}
): Promise<IngestResult> {
  const { source = "telegram-paste", chunkSize = 1800, overlap = 200 } = opts;

  trace({ event: "doc_ingest_text_start", title, source, textLength: text.length });

  if (!text.trim()) {
    trace({ event: "doc_ingest_text_empty", title });
    return { chunksInserted: 0, title };
  }

  // Guards run in parallel: content hash dedup + title conflict check
  // Hash covers first 2000 chars — sufficient for dedup of typical pasted content
  const contentHash = createHash("sha256").update(text.slice(0, 2000)).digest("hex");
  const [{ data: hashMatch }, { count: titleCount }] = await Promise.all([
    supabase
      .from("documents")
      .select("title")
      .eq("metadata->>content_hash", contentHash)
      .limit(1),
    supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("title", title),
  ]);

  // Guard 1: Content hash dedup — exact same text already stored
  if (hashMatch?.length) {
    trace({ event: "doc_ingest_text_duplicate", title, existingTitle: hashMatch[0].title });
    return { chunksInserted: 0, title: hashMatch[0].title, duplicate: true };
  }

  // Guard 2: Title conflict — same name, different content
  if (titleCount && titleCount > 0) {
    trace({ event: "doc_ingest_text_title_conflict", title });
    return { chunksInserted: 0, title, conflict: "title" };
  }

  // No conflicts — chunk and insert
  const chunks = chunkText(text, chunkSize, overlap);
  if (!chunks.length) {
    trace({ event: "doc_ingest_text_empty", title });
    return { chunksInserted: 0, title };
  }

  const rows = chunks.map((content, chunk_index) => ({
    title,
    source,
    chunk_index,
    content,
    metadata: {
      total_chunks: chunks.length,
      original_length: text.length,
      content_hash: contentHash,
      pasted_at: new Date().toISOString(),
    },
  }));

  const { error } = await supabase.from("documents").insert(rows);
  if (error) {
    throw new Error(`Failed to insert text chunks: ${error.message}`);
  }

  trace({ event: "doc_ingest_text_complete", title, source, chunksInserted: chunks.length });

  return { chunksInserted: chunks.length, title };
}

// ─── resolveUniqueTitle ───────────────────────────────────────────────────────

/**
 * Find the first unused variant of `baseTitle` in the documents table.
 * Returns `baseTitle` if unused, otherwise `baseTitle (2)`, `baseTitle (3)`, etc.
 */
export async function resolveUniqueTitle(
  supabase: SupabaseClient,
  baseTitle: string
): Promise<string> {
  let candidate = baseTitle;
  let version = 2;
  while (true) {
    const { count } = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("title", candidate);
    if (!count) return candidate;
    candidate = `${baseTitle} (${version++})`;
  }
}

// ─── extractTextFromFile ──────────────────────────────────────────────────────

/**
 * Extract text from a file based on its MIME type.
 *  - image/*          → Claude vision analysis via analyzeImage
 *  - application/pdf  → pdf-parse (graceful fallback to "" if unavailable)
 *  - everything else  → UTF-8 read
 */
export async function extractTextFromFile(
  filePath: string,
  mimeType?: string
): Promise<string> {
  const mime = mimeType ?? "";

  if (mime.startsWith("image/")) {
    const buffer = readFileSync(filePath);
    return analyzeImage(buffer);
  }

  if (mime === "application/pdf") {
    try {
      // @ts-ignore — pdf-parse is an optional dependency; graceful fallback below
      const { default: pdfParse } = await import("pdf-parse");
      const buffer = readFileSync(filePath);
      const data = await pdfParse(buffer);
      return data.text;
    } catch {
      trace({ event: "doc_pdf_fallback", filePath });
      return "";
    }
  }

  // text/plain, text/markdown, or any unrecognised type → UTF-8
  return readFileSync(filePath, "utf-8");
}

// ─── ingestDocument ───────────────────────────────────────────────────────────

/**
 * Ingest a single file into Supabase `documents` table.
 * Chunks the extracted text and inserts one row per chunk.
 * Embeddings are generated automatically via the `embed` Edge Function webhook.
 *
 * Returns { chunksInserted, title }.
 * Returns chunksInserted=0 when the file yields no usable text.
 *
 * Emits: doc_ingest_start, doc_ingest_complete, doc_ingest_empty.
 */
export async function ingestDocument(
  supabase: SupabaseClient,
  filePath: string,
  title: string,
  opts: { source?: string; mimeType?: string } = {}
): Promise<{ chunksInserted: number; title: string }> {
  const source = opts.source ?? basename(filePath);

  trace({ event: "doc_ingest_start", title, source, mimeType: opts.mimeType ?? null });

  const text = await extractTextFromFile(filePath, opts.mimeType);

  if (!text.trim()) {
    trace({ event: "doc_ingest_empty", title, source });
    return { chunksInserted: 0, title };
  }

  const chunks = chunkText(text);
  if (!chunks.length) {
    trace({ event: "doc_ingest_empty", title, source });
    return { chunksInserted: 0, title };
  }

  // Remove any existing chunks for this title+source before re-ingesting
  await supabase
    .from("documents")
    .delete()
    .eq("title", title)
    .eq("source", source);

  const totalChars = chunks.reduce((sum, c) => sum + c.length, 0);
  const rows = chunks.map((content, chunk_index) => ({
    title,
    source,
    chunk_index,
    content,
    metadata: { chars: content.length },
  }));

  const { error } = await supabase.from("documents").insert(rows);
  if (error) {
    throw new Error(`Failed to insert document chunks: ${error.message}`);
  }

  trace({ event: "doc_ingest_complete", title, source, chunksInserted: chunks.length, totalChars });

  return { chunksInserted: chunks.length, title };
}

// ─── deleteDocument ───────────────────────────────────────────────────────────

/**
 * Delete all chunks for a document title.
 * Returns { deleted: number }.
 *
 * Emits: doc_delete.
 */
export async function deleteDocument(
  supabase: SupabaseClient,
  title: string
): Promise<{ deleted: number }> {
  const { count, error } = await supabase
    .from("documents")
    .delete({ count: "exact" })
    .eq("title", title);

  if (error) {
    throw new Error(`Failed to delete document "${title}": ${error.message}`);
  }

  const deleted = count ?? 0;
  trace({ event: "doc_delete", title, deleted });

  return { deleted };
}

// ─── listDocuments ────────────────────────────────────────────────────────────

/**
 * List all ingested documents, grouped by title.
 * Returns an array of DocSummary sorted by most-recently ingested first.
 */
export async function listDocuments(
  supabase: SupabaseClient
): Promise<DocSummary[]> {
  const { data, error } = await supabase
    .from("documents")
    .select("title, source, chunk_index, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to list documents: ${error.message}`);
  }

  if (!data?.length) {
    return [];
  }

  const byTitle = new Map<
    string,
    { sources: Set<string>; chunks: number; latestAt: string }
  >();

  for (const row of data) {
    if (!byTitle.has(row.title)) {
      byTitle.set(row.title, {
        sources: new Set(),
        chunks: 0,
        latestAt: row.created_at,
      });
    }
    const entry = byTitle.get(row.title)!;
    entry.sources.add(row.source);
    entry.chunks++;
  }

  return Array.from(byTitle.entries()).map(([title, info]) => ({
    title,
    sources: [...info.sources],
    chunks: info.chunks,
    latestAt: info.latestAt,
  }));
}
