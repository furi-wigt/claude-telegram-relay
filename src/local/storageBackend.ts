/**
 * Storage backend — local SQLite + Qdrant.
 *
 * All memory operations route to the local backend (SQLite for structured
 * data, Qdrant for vector search).
 */
import {
  getDb,
  insertMemory as sqliteInsertMemory,
  getActiveMemories,
  getMemoryById,
  updateMemoryStatus as sqliteUpdateStatus,
  incrementAccessCount,
  insertMessage as sqliteInsertMessage,
  insertDocument as sqliteInsertDocument,
  insertSummary as sqliteInsertSummary,
  getSummaries as sqliteGetSummaries,
} from "./db";
import { localEmbed, localEmbedBatch } from "./embed";
import { upsert, upsertBatch, deletePoints, initCollections, search as qdrantSearch } from "./vectorStore";
import { searchMemory, searchMessages, searchDocuments, searchSummaries, type HybridSearchResult } from "./searchService";
import type { MemoryRow } from "./db";
import { enqueue as enqueueTopicGeneration } from "../memory/topicQueue.ts";

// ── Initialization ────────────────────────────────────────────────────────────

let _initialized = false;

export async function initLocalStorage(): Promise<void> {
  if (_initialized) return;
  getDb(); // triggers schema init
  await initCollections();
  _initialized = true;
  console.log("[storage] Local backend initialized (SQLite + Qdrant)");
}

// ── Memory Insert ─────────────────────────────────────────────────────────────

export async function insertMemoryRecord(
  record: {
    type: string;
    content: string;
    chat_id?: number | null;
    thread_id?: number | null;
    category?: string;
    deadline?: string | null;
    extracted_from_exchange?: boolean;
    confidence?: number;
    importance?: number;
    stability?: number;
  }
): Promise<{ id: string | null; error: any }> {
  let localId: string | null = null;

  try {
    localId = sqliteInsertMemory({
      chat_id: record.chat_id?.toString() ?? null,
      thread_id: record.thread_id?.toString() ?? null,
      type: record.type,
      content: record.content,
      status: "active",
      source: record.extracted_from_exchange ? "llm" : "user",
      importance: record.importance ?? 0.7,
      stability: record.stability ?? 0.7,
    });

    // Embed and upsert to Qdrant
    const vector = await localEmbed(record.content);
    await upsert("memory", localId, vector, {
      type: record.type,
      status: "active",
      content: record.content,
      category: record.category ?? null,
      chat_id: record.chat_id?.toString() ?? null,
    });
  } catch (err) {
    console.error("[storage] Local memory insert failed:", err);
  }

  return { id: localId, error: null };
}

// ── Memory Delete ─────────────────────────────────────────────────────────────

export async function deleteMemoryRecord(
  id: string
): Promise<void> {
  try {
    sqliteUpdateStatus(id, "deleted");
    await deletePoints("memory", [id]);
  } catch (err) {
    console.error("[storage] Local memory delete failed:", err);
  }
}

// ── Memory Update (goal completion) ───────────────────────────────────────────

export async function updateMemoryRecord(
  id: string,
  updates: Record<string, unknown>
): Promise<void> {
  try {
    // Build dynamic SQLite UPDATE for all provided fields
    const db = getDb();
    const allowedCols = ["type", "content", "category", "status", "importance", "stability",
      "deadline", "completed_at", "chat_id", "thread_id"];
    const setClauses: string[] = ["updated_at = datetime('now')"];
    const values: unknown[] = [];

    for (const [key, val] of Object.entries(updates)) {
      if (allowedCols.includes(key)) {
        setClauses.push(`${key} = ?`);
        values.push(val);
      }
    }

    // Derive status from type when not explicitly set
    if (updates.type && !updates.status) {
      const status = updates.type === "completed_goal" ? "completed" : "active";
      setClauses.push("status = ?");
      values.push(status);
    }

    if (values.length > 0) {
      values.push(id);
      db.prepare(`UPDATE memory SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
    }

    // Update Qdrant payload
    const existing = db.prepare("SELECT content FROM memory WHERE id = ?").get(id) as { content: string } | null;
    const contentForEmbed = String(updates.content ?? existing?.content ?? "");
    const vec = await localEmbed(contentForEmbed);
    await upsert("memory", id, vec, {
      ...updates,
      status: updates.type === "completed_goal" ? "completed" : "active",
    });
  } catch (err) {
    console.error("[storage] Local memory update failed:", err);
  }
}

// ── Semantic Search ───────────────────────────────────────────────────────────

export interface SemanticSearchResult {
  id: string;
  content: string;
  type?: string;
  similarity: number;
}

/**
 * Semantic search over memory — uses Qdrant vector search.
 */
export async function semanticSearchMemory(
  query: string,
  opts?: { matchCount?: number; threshold?: number; type?: string }
): Promise<SemanticSearchResult[]> {
  const results = await searchMemory(query, {
    limit: opts?.matchCount ?? 5,
    threshold: opts?.threshold ?? 0.5,
    type: opts?.type,
    status: "active",
  });
  return results.map((r) => ({
    id: r.id,
    content: r.record.content,
    type: r.record.type,
    similarity: r.score,
  }));
}

/**
 * Semantic search over messages — uses Qdrant vector search.
 */
export async function semanticSearchMessages(
  query: string,
  opts?: { matchCount?: number; chatId?: string; role?: string; threshold?: number }
): Promise<Array<{ id: string; role: string; content: string; similarity: number }>> {
  const results = await searchMessages(query, {
    limit: opts?.matchCount ?? 5,
    chatId: opts?.chatId,
    role: opts?.role,
    threshold: opts?.threshold,
  });
  return results.map((r) => ({
    id: r.id,
    role: (r.record as any).role ?? "unknown",
    content: (r.record as any).content ?? "",
    similarity: r.score,
  }));
}

// ── Memory Read (non-semantic, for context) ───────────────────────────────────

export async function getMemoryFacts(
  opts?: { limit?: number; chatId?: number }
): Promise<Array<{ id: string; content: string; importance: number; stability: number; category?: string }>> {
  const rows = getActiveMemories({ type: "fact", limit: opts?.limit ?? 25 });
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    importance: r.importance,
    stability: r.stability,
  }));
}

export async function getMemoryGoals(
  opts?: { limit?: number }
): Promise<Array<{ id: string; content: string; deadline?: string; priority?: number }>> {
  const rows = getActiveMemories({ type: "goal", limit: opts?.limit ?? 20 });
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
  }));
}

// ── Touch Access Count ────────────────────────────────────────────────────────

export function touchMemoryAccess(
  ids: string[]
): void {
  if (ids.length === 0) return;

  for (const id of ids) {
    try { incrementAccessCount(id); } catch {}
  }
}

// ── Fetch existing memories for text dedup ────────────────────────────────────

export async function getExistingMemories(
  type: string,
  opts?: { limit?: number; chatId?: number; category?: string }
): Promise<Array<{ id: string; content: string }>> {
  const rows = getActiveMemories({
    type,
    limit: opts?.limit ?? 200,
  });
  return rows.map((r) => ({ id: r.id, content: r.content }));
}

// ── Find goal by content (for [DONE:] tag) ────────────────────────────────────

export async function findGoalByContent(
  searchText: string
): Promise<{ id: string } | null> {
  const db = getDb();
  const row = db
    .query("SELECT id FROM memory WHERE type = 'goal' AND status = 'active' AND content LIKE ? LIMIT 1")
    .get(`%${searchText}%`) as { id: string } | null;
  return row;
}

// ── Delete all memories for a chat ────────────────────────────────────────────

export async function deleteAllMemoriesForChat(
  chatId: number
): Promise<void> {
  const db = getDb();
  const rows = db
    .query("SELECT id FROM memory WHERE chat_id = ?")
    .all(chatId.toString()) as { id: string }[];
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    db.run(`UPDATE memory SET status = 'deleted' WHERE chat_id = ?`, [chatId.toString()]);
    await deletePoints("memory", ids);
  }
}

// ── Fetch memory by index (for /forget N) ─────────────────────────────────────

export async function getMemoryByIndex(
  index: number
): Promise<{ id: string; type: string; content: string } | null> {
  const db = getDb();
  const rows = db
    .query(
      "SELECT id, type, content FROM memory WHERE status = 'active' AND type != 'completed_goal' ORDER BY created_at ASC LIMIT ? OFFSET ?"
    )
    .all(1, index) as Array<{ id: string; type: string; content: string }>;
  return rows[0] ?? null;
}

// ── ILIKE search (for /forget topic) ──────────────────────────────────────────

export async function searchMemoryBySubstring(
  topic: string,
  limit = 5
): Promise<Array<{ id: string; type: string; content: string }>> {
  const db = getDb();
  return db
    .query(
      "SELECT id, type, content FROM memory WHERE status = 'active' AND content LIKE ? LIMIT ?"
    )
    .all(`%${topic}%`, limit) as Array<{ id: string; type: string; content: string }>;
}

// ── Get all memory for /memory display ────────────────────────────────────────

export async function getAllMemoryForDisplay(): Promise<{
  goals: any[];
  completedGoals: any[];
  facts: any[];
  dates: any[];
}> {
  const db = getDb();
  const isJunk = (content: string) =>
    !content?.trim() ||
    content.trim().length < 4 ||
    /^[\[\]`\/|,\s\-\.]+$/.test(content.trim());

  const goals = (db.query("SELECT * FROM memory WHERE type = 'goal' AND status = 'active' ORDER BY created_at DESC").all() as any[])
    .filter((r) => !isJunk(r.content));
  const completedGoals = (db.query("SELECT * FROM memory WHERE type = 'completed_goal' ORDER BY created_at DESC").all() as any[])
    .filter((r) => !isJunk(r.content));
  const allFacts = (db.query("SELECT * FROM memory WHERE type = 'fact' AND status = 'active' ORDER BY created_at DESC").all() as any[])
    .filter((r) => !isJunk(r.content));

  // Note: SQLite schema doesn't have category column yet — treat all as non-date facts
  return {
    goals,
    completedGoals,
    facts: allFacts,
    dates: [],
  };
}

// ── Message Insert ───────────────────────────────────────────────────────────

export async function insertMessageRecord(
  record: {
    role: string;
    content: string;
    chat_id?: number | null;
    thread_id?: number | null;
    agent_id?: string | null;
    channel?: string;
    metadata?: Record<string, unknown>;
    thread_name?: string | null;
  }
): Promise<void> {
  try {
    const id = sqliteInsertMessage({
      chat_id: record.chat_id?.toString() ?? null,
      thread_id: record.thread_id?.toString() ?? null,
      role: record.role,
      content: record.content,
      metadata: record.metadata ? JSON.stringify(record.metadata) : null,
      topic: null,
      thread_name: record.thread_name ?? null,
      agent_id: record.agent_id ?? null,
    });

    // Embed and upsert to Qdrant
    const vector = await localEmbed(record.content);
    await upsert("messages", id, vector, {
      role: record.role,
      chat_id: record.chat_id?.toString() ?? null,
      thread_id: record.thread_id?.toString() ?? null,
    });

    // Enqueue async topic generation (fire-and-forget)
    if (record.content.length >= 50) {
      enqueueTopicGeneration(id, record.content);
    }
  } catch (err) {
    console.error("[storage] Local message insert failed:", err);
  }
}

// ── Document Insert ──────────────────────────────────────────────────────────

export async function insertDocumentRecords(
  rows: Array<{
    title: string;
    source: string;
    chunk_index: number;
    content: string;
    chunk_heading?: string;
    metadata?: Record<string, unknown>;
  }>
): Promise<void> {
  try {
    // Batch embed all chunks in a single Ollama call
    const vectors = await localEmbedBatch(rows.map((r) => r.content));
    const points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const contentHash = (row.metadata as any)?.content_hash ?? null;
      const id = sqliteInsertDocument({
        chat_id: null,
        name: row.title,
        content: row.content,
        chunk_index: row.chunk_index,
        content_hash: contentHash,
        metadata: row.metadata ? JSON.stringify(row.metadata) : null,
      });

      points.push({
        id,
        vector: vectors[i],
        payload: {
          name: row.title,
          chunk_index: row.chunk_index,
          chunk_heading: row.chunk_heading ?? null,
          source: row.source,
        },
      });
    }

    // Single batch upsert to Qdrant
    await upsertBatch("documents", points);
  } catch (err) {
    console.warn("[storage] Local document insert failed:", err);
  }
}

export async function deleteDocumentRecords(
  title: string,
  source?: string
): Promise<{ deleted: number }> {
  let localDeleted = 0;

  try {
    const db = getDb();
    let sql = "SELECT id FROM documents WHERE name = ?";
    const params: any[] = [title];
    if (source) {
      sql += " AND metadata LIKE ?";
      params.push(`%"source":"${source}"%`);
    }
    const rows = db.query(sql).all(...params) as { id: string }[];
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      db.run(`DELETE FROM documents WHERE id IN (${placeholders})`, ids);
      await deletePoints("documents", ids);
      localDeleted = ids.length;
    }
  } catch (err) {
    console.error("[storage] Local document delete failed:", err);
  }

  return { deleted: localDeleted };
}

// ── Document Query Helpers ────────────────────────────────────────────────────

/**
 * Check if a document with the given content hash already exists.
 * Returns the existing title if found, null otherwise.
 */
export async function checkContentHashExists(
  contentHash: string
): Promise<{ title: string } | null> {
  const db = getDb();
  const row = db.query("SELECT name as title FROM documents WHERE content_hash = ? LIMIT 1").get(contentHash) as { title: string } | null;
  return row ?? null;
}

/**
 * Count documents with an exact title match.
 */
export async function countDocumentsByTitle(
  title: string
): Promise<number> {
  const db = getDb();
  const row = db.query("SELECT COUNT(*) as count FROM documents WHERE name = ?").get(title) as { count: number };
  return row.count;
}

/**
 * Case-insensitive fuzzy match for document titles.
 * Used as a fallback when exact delete doesn't match.
 */
export async function fuzzyMatchDocumentTitle(
  pattern: string
): Promise<string | null> {
  const db = getDb();
  const row = db.query("SELECT name FROM documents WHERE name LIKE ? LIMIT 1").get(`%${pattern}%`) as { name: string } | null;
  return row?.name ?? null;
}

/**
 * Check whether a document with the given title (case-insensitive) already exists.
 */
export async function checkDocumentTitleCollision(
  title: string
): Promise<{ exists: boolean; existingTitle?: string }> {
  const db = getDb();
  const row = db.query("SELECT name FROM documents WHERE name LIKE ? LIMIT 1").get(title) as { name: string } | null;
  if (!row) return { exists: false };
  return { exists: true, existingTitle: row.name };
}

/**
 * Find the first unused variant of `baseTitle` in the documents table.
 * Returns `baseTitle` if unused, otherwise `baseTitle (2)`, `baseTitle (3)`, etc.
 */
export async function resolveUniqueTitleBackend(
  baseTitle: string
): Promise<string> {
  let candidate = baseTitle;
  let version = 2;
  while (true) {
    const count = await countDocumentsByTitle(candidate);
    if (!count) return candidate;
    candidate = `${baseTitle} (${version++})`;
  }
}

// ── Summary Insert ───────────────────────────────────────────────────────────

export async function insertSummaryRecord(
  record: {
    chat_id: number;
    thread_id?: number | null;
    summary: string;
    message_count: number;
    from_message_id?: string;
    to_message_id?: string;
    from_timestamp?: string;
    to_timestamp?: string;
  }
): Promise<void> {
  try {
    const id = sqliteInsertSummary({
      chat_id: record.chat_id.toString(),
      thread_id: record.thread_id?.toString() ?? null,
      summary: record.summary,
      message_range: JSON.stringify({
        from: record.from_message_id,
        to: record.to_message_id,
        count: record.message_count,
        fromTs: record.from_timestamp,
        toTs: record.to_timestamp,
      }),
    });

    const vector = await localEmbed(record.summary);
    await upsert("summaries", id, vector, {
      chat_id: record.chat_id.toString(),
      thread_id: record.thread_id?.toString() ?? null,
    });
  } catch (err) {
    console.error("[storage] Local summary insert failed:", err);
  }
}

// ── Document Search (local) ──────────────────────────────────────────────────

export async function semanticSearchDocuments(
  query: string,
  opts?: { matchCount?: number; threshold?: number; filterTitle?: string }
): Promise<Array<{
  id: string;
  title: string;
  source: string;
  chunk_index: number;
  chunk_heading?: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}>> {
  const results = await searchDocuments(query, {
    limit: opts?.matchCount ?? 10,
    threshold: opts?.threshold ?? 0.5,
    name: opts?.filterTitle,
  });
  return results.map((r) => ({
    id: r.id,
    title: (r.record as any).name ?? "",
    source: (r.record as any).source ?? "unknown",
    chunk_index: (r.record as any).chunk_index ?? 0,
    chunk_heading: (r.record as any).chunk_heading,
    content: (r.record as any).content ?? "",
    metadata: (r.record as any).metadata ? JSON.parse((r.record as any).metadata) : {},
    similarity: r.score,
  }));
}

// ── Short-term memory reads (messages + summaries) ───────────────────────────

export async function getRecentMessagesLocal(
  chatId: number,
  limit: number,
  threadId?: number | null,
  since?: string | null
): Promise<Array<{ id: string; role: string; content: string; created_at: string; metadata?: any }>> {
  const db = getDb();
  let sql = "SELECT id, role, content, created_at, metadata FROM messages WHERE chat_id = ?";
  const params: any[] = [chatId.toString()];
  if (threadId != null) {
    sql += " AND thread_id = ?";
    params.push(threadId.toString());
  } else {
    sql += " AND thread_id IS NULL";
  }
  if (since) {
    sql += " AND created_at >= ?";
    // Normalize ISO format (2026-03-15T14:36:42.109Z) to SQLite format (2026-03-15 14:36:42)
    params.push(since.replace("T", " ").replace(/\.\d+Z$/, "").replace("Z", ""));
  }
  sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?";
  params.push(limit);
  const rows = db.query(sql).all(...params) as any[];
  return rows.reverse().map((r) => ({
    ...r,
    metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
  }));
}

export function getConversationSummariesLocal(
  chatId: number,
  threadId?: number | null
): Array<{ id: string; summary: string; message_count: number; from_timestamp: string | null; to_timestamp: string | null; created_at: string }> {
  const db = getDb();
  let sql = "SELECT id, summary, message_range, created_at FROM conversation_summaries WHERE chat_id = ?";
  const params: any[] = [chatId.toString()];
  if (threadId != null) {
    sql += " AND thread_id = ?";
    params.push(threadId.toString());
  } else {
    sql += " AND thread_id IS NULL";
  }
  sql += " ORDER BY created_at ASC";
  const rows = db.query(sql).all(...params) as any[];
  return rows.map((r: any) => {
    const range = r.message_range ? JSON.parse(r.message_range) : {};
    return {
      id: r.id,
      summary: r.summary,
      message_count: range.count ?? 0,
      from_timestamp: range.fromTs ?? null,
      to_timestamp: range.toTs ?? null,
      created_at: r.created_at,
    };
  });
}

export async function getMessageCountLocal(
  chatId: number,
  threadId?: number | null
): Promise<number> {
  const db = getDb();
  let sql = "SELECT COUNT(*) as count FROM messages WHERE chat_id = ?";
  const params: any[] = [chatId.toString()];
  if (threadId != null) {
    sql += " AND thread_id = ?";
    params.push(threadId.toString());
  } else {
    sql += " AND thread_id IS NULL";
  }
  const row = db.query(sql).get(...params) as { count: number };
  return row.count;
}

// ── Document list/query for local ────────────────────────────────────────────

export async function listDocumentsLocal(): Promise<Array<{
  title: string;
  source: string;
  chunks: number;
  created_at: string;
}>> {
  const db = getDb();
  const rows = db.query(`
    SELECT name as title, COUNT(*) as chunks, MAX(created_at) as created_at
    FROM documents
    GROUP BY name
    ORDER BY created_at DESC
  `).all() as any[];
  return rows.map((r: any) => ({
    title: r.title,
    source: "local",
    chunks: r.chunks,
    created_at: r.created_at,
  }));
}

// ── Count active memories ─────────────────────────────────────────────────────

export async function getActiveMemoryCount(): Promise<number> {
  const db = getDb();
  const row = db.query("SELECT COUNT(*) as count FROM memory WHERE status = 'active'").get() as { count: number };
  return row.count;
}

// ── Has documents check ───────────────────────────────────────────────────────

let _hasDocuments: boolean | null = null;
let _hasDocsCacheExpiry = 0;

export async function hasDocuments(): Promise<boolean> {
  if (_hasDocuments !== null && Date.now() < _hasDocsCacheExpiry) return _hasDocuments;

  const db = getDb();
  const row = db.query("SELECT COUNT(*) as count FROM documents LIMIT 1").get() as { count: number };
  _hasDocuments = row.count > 0;

  _hasDocsCacheExpiry = Date.now() + 600_000; // 10 min cache
  return _hasDocuments;
}

export function invalidateDocumentsCache(): void {
  _hasDocuments = null;
  _hasDocsCacheExpiry = 0;
}
