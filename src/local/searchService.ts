/**
 * Unified search service: embed query → Qdrant search → join with SQLite for full records.
 */
import { localEmbed } from "./embed";
import { search as qdrantSearch, type CollectionName, type SearchResult } from "./vectorStore";
import { getDb, type MemoryRow, type DocumentRow } from "./db";

export interface HybridSearchResult<T = Record<string, unknown>> {
  id: string;
  score: number;
  record: T;
}

/**
 * Semantic search over any collection.
 * 1. Embed the query with BGE-M3
 * 2. Search Qdrant for top matches
 * 3. Join with SQLite to return full records
 */
export async function hybridSearch<T = Record<string, unknown>>(
  collection: CollectionName,
  query: string,
  opts?: {
    limit?: number;
    threshold?: number;
    filter?: Record<string, unknown>;
  }
): Promise<HybridSearchResult<T>[]> {
  let vector: number[];
  try {
    vector = await localEmbed(query);
  } catch (err) {
    console.error("[search] Embedding failed, returning empty results:", (err as Error).message);
    return [];
  }
  const hits = await qdrantSearch(collection, vector, opts);

  if (hits.length === 0) return [];

  const tableName = collectionToTable(collection);
  const db = getDb();
  const ids = hits.map((h) => h.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query(`SELECT * FROM ${tableName} WHERE id IN (${placeholders})`)
    .all(...ids) as T[];

  // Build lookup map
  const rowMap = new Map<string, T>();
  for (const row of rows) {
    rowMap.set((row as any).id, row);
  }

  // Return in score order, with full records
  return hits
    .filter((h) => rowMap.has(h.id))
    .map((h) => ({
      id: h.id,
      score: h.score,
      record: rowMap.get(h.id)!,
    }));
}

/**
 * Search memory specifically — convenience wrapper with typed return.
 */
export async function searchMemory(
  query: string,
  opts?: { limit?: number; threshold?: number; type?: string; status?: string }
): Promise<HybridSearchResult<MemoryRow>[]> {
  const filter = buildFilter(opts);
  return hybridSearch<MemoryRow>("memory", query, {
    limit: opts?.limit ?? 10,
    threshold: opts?.threshold,
    filter: filter || undefined,
  });
}

/**
 * Search documents — convenience wrapper with typed return.
 */
export async function searchDocuments(
  query: string,
  opts?: { limit?: number; threshold?: number; name?: string }
): Promise<HybridSearchResult<DocumentRow>[]> {
  const filter = opts?.name
    ? { must: [{ key: "name", match: { value: opts.name } }] }
    : undefined;
  return hybridSearch<DocumentRow>("documents", query, {
    limit: opts?.limit ?? 10,
    threshold: opts?.threshold,
    filter,
  });
}

/**
 * Search messages — convenience wrapper.
 */
export async function searchMessages(
  query: string,
  opts?: { limit?: number; threshold?: number; chatId?: string; role?: string }
): Promise<HybridSearchResult<Record<string, unknown>>[]> {
  const must: Array<{ key: string; match: { value: string } }> = [];
  if (opts?.chatId) must.push({ key: "chat_id", match: { value: opts.chatId } });
  if (opts?.role) must.push({ key: "role", match: { value: opts.role } });
  const filter = must.length > 0 ? { must } : undefined;
  return hybridSearch("messages", query, {
    limit: opts?.limit ?? 10,
    threshold: opts?.threshold,
    filter,
  });
}

/**
 * Search conversation summaries.
 */
export async function searchSummaries(
  query: string,
  opts?: { limit?: number; threshold?: number; chatId?: string }
): Promise<HybridSearchResult<Record<string, unknown>>[]> {
  const filter = opts?.chatId
    ? { must: [{ key: "chat_id", match: { value: opts.chatId } }] }
    : undefined;
  return hybridSearch("summaries", query, {
    limit: opts?.limit ?? 10,
    threshold: opts?.threshold,
    filter,
  });
}

/**
 * Keyword fallback search — SQLite LIKE on document content.
 * Catches exact control IDs (LM-4, AS-1) and quoted terms that embeddings miss.
 * Used only by explicit /doc query, never by auto-injection.
 */
export function keywordSearchDocuments(
  keywords: string[],
  opts?: { limit?: number; name?: string }
): HybridSearchResult<DocumentRow>[] {
  if (keywords.length === 0) return [];
  const db = getDb();
  const limit = opts?.limit ?? 5;
  // Control IDs (e.g. "LM-4") use colon-anchored patterns ("%LM-4:%") so "LM-4" doesn't match "LM-40".
  const controlIdRe = /^[A-Z]{2,}-\d+$/;
  const conditions = keywords.map(() => `content LIKE ?`).join(" OR ");
  const params: (string | number)[] = keywords.map((k) =>
    controlIdRe.test(k) ? `%${k}:%` : `%${k}%`
  );
  let sql = `SELECT * FROM documents WHERE (${conditions})`;
  if (opts?.name) {
    sql += ` AND name = ?`;
    params.push(opts.name);
  }
  sql += ` ORDER BY chunk_index LIMIT ?`;
  params.push(limit);
  const rows = db.query(sql).all(...params) as DocumentRow[];
  return rows.map((r) => ({
    id: r.id,
    score: 1.0, // keyword match = max relevance
    record: r,
  }));
}

/**
 * Extract searchable keywords from a query string.
 * Detects IM8-style control IDs (e.g. LM-4, AS-1, PM-3) and quoted phrases.
 */
export function extractDocKeywords(query: string): string[] {
  const keywords: string[] = [];
  // Control IDs: 2+ uppercase letters, dash, 1+ digits
  const controlIds = query.match(/[A-Z]{2,}-\d+/g);
  if (controlIds) keywords.push(...controlIds);
  // Quoted phrases
  const quoted = query.match(/"([^"]+)"/g);
  if (quoted) keywords.push(...quoted.map((q) => q.replace(/"/g, "")));
  return [...new Set(keywords)];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectionToTable(collection: CollectionName): string {
  if (collection === "summaries") return "conversation_summaries";
  return collection;
}

function buildFilter(opts?: {
  type?: string;
  status?: string;
}): Record<string, unknown> | null {
  const must: Array<Record<string, unknown>> = [];
  if (opts?.type) must.push({ key: "type", match: { value: opts.type } });
  if (opts?.status) must.push({ key: "status", match: { value: opts.status } });
  return must.length > 0 ? { must } : null;
}
