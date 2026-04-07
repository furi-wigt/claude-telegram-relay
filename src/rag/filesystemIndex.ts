/**
 * Filesystem Indexer
 *
 * Indexes markdown files from a thread's CWD (e.g. Obsidian vault)
 * into the existing document pipeline (SQLite + Qdrant).
 *
 * Features:
 *  - Glob scan for **\/*.md files
 *  - Content-addressable storage: SHA-256 hash of file content → skip unchanged
 *  - Incremental re-index: only re-ingest files that changed since last index
 *  - Source tracking: `source: "filesystem:{cwdPath}"` to distinguish from uploads
 *
 * Usage:
 *  - /kb index    — index/reindex current CWD's markdown files
 *  - /kb status   — show indexed file count, last index time, stale files
 *  - /kb search   — explicit search with re-ranking enabled
 */

import { readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { basename, relative, join } from "path";
import { Glob } from "bun";
import { ingestText, deleteDocument } from "../documents/documentProcessor";
import { getDb } from "../local/db";

export interface IndexedFile {
  /** Relative path from CWD */
  relativePath: string;
  /** File modification time */
  mtime: string;
  /** SHA-256 of file content */
  contentHash: string;
  /** Number of chunks created */
  chunks: number;
}

export interface IndexResult {
  /** Total files found matching the pattern */
  filesFound: number;
  /** Files that were indexed (new or changed) */
  filesIndexed: number;
  /** Files skipped (unchanged content hash) */
  filesSkipped: number;
  /** Files that failed to index */
  filesFailed: number;
  /** Details per indexed file */
  indexed: IndexedFile[];
}

export interface IndexStatus {
  /** CWD path being tracked */
  cwdPath: string;
  /** Number of files currently indexed from this CWD */
  indexedFiles: number;
  /** Number of markdown files found in CWD */
  totalFiles: number;
  /** Files in CWD that are not yet indexed or have changed */
  staleFiles: string[];
  /** Last index time (if any indexed files exist) */
  lastIndexed?: string;
}

/**
 * Scan a directory for markdown files matching a glob pattern.
 * Returns absolute paths sorted alphabetically.
 */
export function scanMarkdownFiles(
  cwdPath: string,
  pattern: string = "**/*.md",
): string[] {
  const glob = new Glob(pattern);
  const files: string[] = [];
  for (const match of glob.scanSync({ cwd: cwdPath, absolute: true })) {
    // Skip hidden dirs, node_modules, .git
    const rel = relative(cwdPath, match);
    if (rel.startsWith(".") || rel.includes("node_modules") || rel.includes(".git/")) continue;
    files.push(match);
  }
  return files.sort();
}

/**
 * Compute SHA-256 hash of file content.
 */
function hashFile(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Get the filesystem source label for a CWD path.
 */
function fsSource(cwdPath: string): string {
  return `filesystem:${cwdPath}`;
}

/**
 * Check if a file's content hash already exists in the documents table
 * for a specific CWD source. Returns true if unchanged.
 */
function isFileUnchanged(contentHash: string, source: string): boolean {
  const db = getDb();
  const row = db.query(
    "SELECT id FROM documents WHERE content_hash = ? AND source = ? LIMIT 1"
  ).get(contentHash, source) as { id: string } | null;
  return row !== null;
}

/**
 * Get all indexed files for a CWD source.
 */
function getIndexedFilesForSource(source: string): Array<{ name: string; created_at: string; content_hash: string }> {
  const db = getDb();
  return db.query(
    "SELECT DISTINCT name, MAX(created_at) as created_at, content_hash FROM documents WHERE source = ? GROUP BY name"
  ).all(source) as Array<{ name: string; created_at: string; content_hash: string }>;
}

/**
 * Index markdown files from a CWD directory into the document pipeline.
 *
 * Performs incremental indexing:
 *  - Computes SHA-256 of each file
 *  - Skips files whose content hash already exists for this source
 *  - Deletes old chunks and re-ingests files that changed
 *
 * @param cwdPath  Absolute path to the CWD directory
 * @param onProgress  Optional callback for status updates
 */
export async function indexCwdDocuments(
  cwdPath: string,
  onProgress?: (msg: string) => void,
): Promise<IndexResult> {
  const source = fsSource(cwdPath);
  const files = scanMarkdownFiles(cwdPath);
  const result: IndexResult = {
    filesFound: files.length,
    filesIndexed: 0,
    filesSkipped: 0,
    filesFailed: 0,
    indexed: [],
  };

  if (files.length === 0) {
    onProgress?.("No markdown files found in CWD.");
    return result;
  }

  onProgress?.(`Found ${files.length} markdown files. Indexing...`);

  for (const filePath of files) {
    const relPath = relative(cwdPath, filePath);
    const contentHash = hashFile(filePath);

    // Skip if content hasn't changed
    if (isFileUnchanged(contentHash, source)) {
      result.filesSkipped++;
      continue;
    }

    try {
      // Delete old version if exists (title = relative path)
      const title = relPath;
      await deleteDocument(title);

      // Read and ingest
      const text = readFileSync(filePath, "utf-8");
      if (!text.trim()) {
        result.filesSkipped++;
        continue;
      }

      const stat = statSync(filePath);
      const ingestResult = await ingestText(text, title, {
        source,
        contentHash,
      });

      if (ingestResult.chunksInserted > 0) {
        result.filesIndexed++;
        result.indexed.push({
          relativePath: relPath,
          mtime: stat.mtime.toISOString(),
          contentHash,
          chunks: ingestResult.chunksInserted,
        });
        onProgress?.(`  ✓ ${relPath} (${ingestResult.chunksInserted} chunks)`);
      } else if (ingestResult.duplicate) {
        result.filesSkipped++;
      } else {
        result.filesSkipped++;
      }
    } catch (err) {
      result.filesFailed++;
      console.warn(`[fsIndex] Failed to index ${relPath}:`, (err as Error).message);
      onProgress?.(`  ✗ ${relPath}: ${(err as Error).message}`);
    }
  }

  return result;
}

/**
 * Get the current indexing status for a CWD directory.
 */
export function getIndexStatus(cwdPath: string): IndexStatus {
  const source = fsSource(cwdPath);
  const files = scanMarkdownFiles(cwdPath);
  const indexed = getIndexedFilesForSource(source);

  // Find stale files (in CWD but not indexed, or content changed)
  const indexedNames = new Set(indexed.map((f) => f.name));
  const staleFiles: string[] = [];

  for (const filePath of files) {
    const relPath = relative(cwdPath, filePath);
    if (!indexedNames.has(relPath)) {
      staleFiles.push(relPath);
    } else {
      // Check if content changed
      const contentHash = hashFile(filePath);
      if (!isFileUnchanged(contentHash, source)) {
        staleFiles.push(relPath);
      }
    }
  }

  return {
    cwdPath,
    indexedFiles: indexed.length,
    totalFiles: files.length,
    staleFiles,
    lastIndexed: indexed.length > 0
      ? indexed.reduce((latest, f) => f.created_at > latest ? f.created_at : latest, "")
      : undefined,
  };
}
