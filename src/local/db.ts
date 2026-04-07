/**
 * SQLite wrapper using bun:sqlite.
 * WAL mode, prepared statements, CRUD for memory/messages/documents/conversation_summaries.
 */
import { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
import { initOrchestrationSchema } from "../orchestration/schema.ts";

function getDbPath(): string {
  if (process.env.LOCAL_DB_PATH) return process.env.LOCAL_DB_PATH;
  const userDir = process.env.RELAY_USER_DIR || process.env.RELAY_DIR || join(homedir(), ".claude-relay");
  return join(userDir, "data", "local.sqlite");
}

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  const dbPath = getDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  _db = new Database(dbPath, { create: true });
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA synchronous = NORMAL");
  _db.exec("PRAGMA busy_timeout = 5000");
  initSchema(_db);
  return _db;
}

function initSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      chat_id TEXT,
      thread_id TEXT,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      source TEXT,
      category TEXT,
      deadline TEXT,
      completed_at TEXT,
      priority INTEGER DEFAULT 0,
      extracted_from_exchange INTEGER DEFAULT 0,
      confidence REAL DEFAULT 1.0,
      metadata TEXT DEFAULT '{}',
      importance REAL DEFAULT 0.5,
      stability REAL DEFAULT 0.5,
      access_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      chat_id TEXT,
      thread_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      channel TEXT DEFAULT 'telegram',
      metadata TEXT,
      agent_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      chat_id TEXT,
      name TEXT NOT NULL,
      source TEXT,
      content TEXT NOT NULL,
      chunk_index INTEGER DEFAULT 0,
      chunk_heading TEXT,
      content_hash TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      chat_id TEXT,
      thread_id TEXT,
      summary TEXT NOT NULL,
      message_range TEXT,
      message_count INTEGER,
      from_message_id TEXT,
      to_message_id TEXT,
      from_timestamp TEXT,
      to_timestamp TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memory_status ON memory(status);
    CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
    CREATE INDEX IF NOT EXISTS idx_memory_chat ON memory(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_documents_name ON documents(name);
    CREATE INDEX IF NOT EXISTS idx_summaries_chat ON conversation_summaries(chat_id);
  `);

  // ── Migrations for existing DBs ──────────────────────────────────────────
  // memory
  addColumnIfMissing(db, "memory", "thread_id", "TEXT");
  addColumnIfMissing(db, "memory", "metadata", "TEXT DEFAULT '{}'");
  addColumnIfMissing(db, "memory", "last_used_at", "TEXT");

  // memory — learning system (Phase 1)
  addColumnIfMissing(db, "memory", "evidence", "TEXT DEFAULT '{}'");
  addColumnIfMissing(db, "memory", "hit_count", "INTEGER DEFAULT 0");

  // Index for weekly retro queries (type='learning' filtered by confidence + date)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_learning
      ON memory(type, confidence, created_at)
      WHERE type = 'learning';
  `);

  // messages
  addColumnIfMissing(db, "messages", "metadata", "TEXT");
  addColumnIfMissing(db, "messages", "channel", "TEXT DEFAULT 'telegram'");
  addColumnIfMissing(db, "messages", "agent_id", "TEXT");
  addColumnIfMissing(db, "messages", "topic", "TEXT");
  addColumnIfMissing(db, "messages", "thread_name", "TEXT");

  // documents
  addColumnIfMissing(db, "documents", "content_hash", "TEXT");
  addColumnIfMissing(db, "documents", "source", "TEXT");
  addColumnIfMissing(db, "documents", "chunk_heading", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash)");

  // FTS5 virtual table for BM25 lexical search over documents
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      name, content, chunk_heading,
      content='documents', content_rowid='rowid'
    );
  `);

  // Triggers to keep FTS5 in sync with documents table
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, name, content, chunk_heading)
        VALUES (NEW.rowid, NEW.name, NEW.content, NEW.chunk_heading);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, name, content, chunk_heading)
        VALUES ('delete', OLD.rowid, OLD.name, OLD.content, OLD.chunk_heading);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, name, content, chunk_heading)
        VALUES ('delete', OLD.rowid, OLD.name, OLD.content, OLD.chunk_heading);
      INSERT INTO documents_fts(rowid, name, content, chunk_heading)
        VALUES (NEW.rowid, NEW.name, NEW.content, NEW.chunk_heading);
    END;
  `);

  // Backfill FTS5 from existing documents (idempotent — skips if already populated)
  try {
    const ftsCount = db.query("SELECT COUNT(*) as cnt FROM documents_fts").get() as { cnt: number };
    const docCount = db.query("SELECT COUNT(*) as cnt FROM documents").get() as { cnt: number };
    if (ftsCount.cnt === 0 && docCount.cnt > 0) {
      db.exec("INSERT INTO documents_fts(rowid, name, content, chunk_heading) SELECT rowid, name, content, chunk_heading FROM documents");
      console.log(`[db] Backfilled FTS5 index with ${docCount.cnt} document rows`);
    }
  } catch (e) {
    // FTS5 backfill is best-effort — don't block startup
    console.warn("[db] FTS5 backfill skipped:", (e as Error).message);
  }

  // conversation_summaries
  addColumnIfMissing(db, "conversation_summaries", "message_count", "INTEGER");
  addColumnIfMissing(db, "conversation_summaries", "from_message_id", "TEXT");
  addColumnIfMissing(db, "conversation_summaries", "to_message_id", "TEXT");
  addColumnIfMissing(db, "conversation_summaries", "from_timestamp", "TEXT");
  addColumnIfMissing(db, "conversation_summaries", "to_timestamp", "TEXT");

  // Orchestration tables (dispatches, dispatch_tasks)
  initOrchestrationSchema(db);
}

function addColumnIfMissing(db: Database, table: string, column: string, typeDef: string): void {
  try {
    const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef}`);
    }
  } catch {}
}

// ── Memory CRUD ───────────────────────────────────────────────────────────────

export interface MemoryRow {
  id: string;
  chat_id: string | null;
  thread_id: string | null;
  type: string;
  content: string;
  status: string;
  source: string | null;
  importance: number;
  stability: number;
  access_count: number;
  created_at: string;
  updated_at: string;
}

export function insertMemory(
  row: Omit<MemoryRow, "id" | "created_at" | "updated_at" | "access_count">
): string {
  const db = getDb();
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO memory (id, chat_id, thread_id, type, content, status, source, importance, stability)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, row.chat_id, row.thread_id ?? null, row.type, row.content, row.status, row.source, row.importance, row.stability]
  );
  return id;
}

export function getMemoryById(id: string): MemoryRow | null {
  return getDb().query("SELECT * FROM memory WHERE id = ?").get(id) as MemoryRow | null;
}

export function getActiveMemories(opts?: {
  type?: string;
  chatId?: string;
  limit?: number;
}): MemoryRow[] {
  let sql = "SELECT * FROM memory WHERE status = 'active'";
  const params: any[] = [];
  if (opts?.type) {
    sql += " AND type = ?";
    params.push(opts.type);
  }
  if (opts?.chatId) {
    sql += " AND (chat_id = ? OR chat_id IS NULL)";
    params.push(opts.chatId);
  }
  sql += " ORDER BY importance DESC, created_at DESC";
  if (opts?.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }
  return getDb().query(sql).all(...params) as MemoryRow[];
}

export function updateMemoryStatus(id: string, status: string): void {
  getDb().run(
    "UPDATE memory SET status = ?, updated_at = datetime('now') WHERE id = ?",
    [status, id]
  );
}

export function incrementAccessCount(id: string): void {
  getDb().run(
    "UPDATE memory SET access_count = access_count + 1, updated_at = datetime('now') WHERE id = ?",
    [id]
  );
}

// ── Messages CRUD ─────────────────────────────────────────────────────────────

export interface MessageRow {
  id: string;
  chat_id: string | null;
  thread_id: string | null;
  role: string;
  content: string;
  metadata: string | null;
  topic: string | null;
  thread_name?: string | null;
  agent_id?: string | null;
  created_at: string;
}

export function insertMessage(
  row: Omit<MessageRow, "id" | "created_at">
): string {
  const db = getDb();
  const id = crypto.randomUUID();
  db.run(
    "INSERT INTO messages (id, chat_id, thread_id, role, content, metadata, topic, thread_name, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, row.chat_id, row.thread_id, row.role, row.content, row.metadata ?? null, row.topic ?? null, row.thread_name ?? null, row.agent_id ?? null]
  );
  return id;
}

// ── Documents CRUD ────────────────────────────────────────────────────────────

export interface DocumentRow {
  id: string;
  chat_id: string | null;
  name: string;
  content: string;
  chunk_index: number;
  content_hash: string | null;
  metadata: string | null;
  created_at: string;
}

export function insertDocument(
  row: Omit<DocumentRow, "id" | "created_at">
): string {
  const db = getDb();
  const id = crypto.randomUUID();
  db.run(
    "INSERT INTO documents (id, chat_id, name, content, chunk_index, content_hash, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, row.chat_id, row.name, row.content, row.chunk_index, row.content_hash ?? null, row.metadata]
  );
  return id;
}

// ── Conversation Summaries CRUD ───────────────────────────────────────────────

export interface SummaryRow {
  id: string;
  chat_id: string | null;
  thread_id: string | null;
  summary: string;
  message_range: string | null;
  created_at: string;
}

export function insertSummary(
  row: Omit<SummaryRow, "id" | "created_at">
): string {
  const db = getDb();
  const id = crypto.randomUUID();
  db.run(
    "INSERT INTO conversation_summaries (id, chat_id, thread_id, summary, message_range) VALUES (?, ?, ?, ?, ?)",
    [id, row.chat_id, row.thread_id, row.summary, row.message_range]
  );
  return id;
}

export function getSummaries(chatId: string, limit = 10): SummaryRow[] {
  return getDb()
    .query(
      "SELECT * FROM conversation_summaries WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(chatId, limit) as SummaryRow[];
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
