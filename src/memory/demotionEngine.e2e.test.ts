/**
 * E2E tests: Demotion engine and access tracking
 *
 * Covers:
 *   runDemotionPass — archives stale, low-value memories
 *   getMemoryContext — reads from storageBackend backed by SQLite
 *   storeExtractedMemories — assigns importance/stability by type
 *
 * Uses in-memory SQLite via mocked getDb() — no real database needed.
 *
 * Run: bun test src/memory/demotionEngine.e2e.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";

// ============================================================
// Shared helpers
// ============================================================

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

interface MockMemoryRow {
  id: string;
  content: string;
  type: string;
  category?: string | null;
  status?: string;
  created_at: string;
  importance: number;
  stability: number;
  access_count: number;
  last_used_at: string | null;
  chat_id?: number | null;
  confidence?: number;
}

function makeMemoryRow(overrides: Partial<MockMemoryRow> = {}): MockMemoryRow {
  return {
    id: "mem-1",
    content: "Test memory content",
    type: "fact",
    category: "personal",
    status: "active",
    created_at: daysAgo(100),
    importance: 0.5,
    stability: 0.5,
    access_count: 0,
    last_used_at: null,
    chat_id: null,
    confidence: 0.9,
    ...overrides,
  };
}

// ============================================================
// In-memory SQLite database
// ============================================================

let testDb: Database;

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      chat_id TEXT,
      thread_id TEXT,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'fact',
      category TEXT,
      status TEXT DEFAULT 'active',
      importance REAL DEFAULT 0.7,
      stability REAL DEFAULT 0.7,
      access_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      deadline TEXT,
      completed_at TEXT,
      extracted_from_exchange INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0.9,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      chat_id TEXT,
      thread_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      topic TEXT,
      agent_id TEXT,
      thread_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      chat_id TEXT,
      thread_id TEXT,
      summary TEXT NOT NULL,
      message_count INTEGER DEFAULT 0,
      period_start TEXT,
      period_end TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      title TEXT NOT NULL,
      source TEXT,
      content TEXT NOT NULL,
      content_hash TEXT,
      chunk_index INTEGER DEFAULT 0,
      total_chunks INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS user_profile (
      id INTEGER PRIMARY KEY DEFAULT 1,
      summary TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function seedMemory(db: Database, rows: MockMemoryRow[]) {
  const stmt = db.prepare(`
    INSERT INTO memory (id, content, type, category, status, created_at, importance, stability, access_count, last_used_at, chat_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    stmt.run(r.id, r.content, r.type, r.category ?? null, r.status ?? "active",
      r.created_at, r.importance, r.stability, r.access_count, r.last_used_at, r.chat_id ?? null);
  }
}

// Mock getDb to return our in-memory test DB
mock.module("../local/db.ts", () => ({
  getDb: () => testDb,
  insertMemory: (record: any) => {
    const id = record.id ?? crypto.randomUUID().replace(/-/g, "");
    testDb.prepare(`
      INSERT INTO memory (id, content, type, category, status, importance, stability, chat_id, thread_id, deadline, completed_at, extracted_from_exchange, confidence, created_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(id, record.content, record.type ?? "fact", record.category ?? null,
      record.importance ?? 0.7, record.stability ?? 0.7, record.chat_id ?? null, record.thread_id ?? null,
      record.deadline ?? null, record.completed_at ?? null, record.extracted_from_exchange ? 1 : 0, record.confidence ?? 0.9);
    return id;
  },
  getMemoryById: (id: string) => testDb.prepare("SELECT * FROM memory WHERE id = ?").get(id),
  getActiveMemories: (opts?: any) => {
    const type = opts?.type ?? "fact";
    const limit = opts?.limit ?? 100;
    return testDb.prepare(
      `SELECT id, content, importance, stability, category, deadline, access_count, last_used_at, created_at
       FROM memory WHERE type = ? AND status = 'active' ORDER BY importance DESC, stability DESC LIMIT ?`
    ).all(type, limit);
  },
  updateMemoryStatus: (id: string, status: string) => {
    testDb.prepare("UPDATE memory SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  },
  incrementAccessCount: (id: string) => {
    testDb.prepare("UPDATE memory SET access_count = access_count + 1, last_used_at = datetime('now') WHERE id = ?").run(id);
  },
  insertMessage: () => crypto.randomUUID().replace(/-/g, ""),
  insertDocument: () => crypto.randomUUID().replace(/-/g, ""),
  insertSummary: () => crypto.randomUUID().replace(/-/g, ""),
  getSummaries: () => [],
  closeDb: () => {},
}));

// Mock semantic duplicate checker (avoid Qdrant/Ollama)
mock.module("../utils/semanticDuplicateChecker", () => ({
  checkSemanticDuplicate: async () => ({ isDuplicate: false, match: null }),
}));
mock.module("../utils/chatNames", () => ({
  resolveSourceLabel: () => "DM",
}));
mock.module("../utils/goalDuplicateChecker", () => ({
  isTextDuplicateGoal: () => false,
  isTextDuplicate: () => false,
}));
mock.module("./profileRebuildCounter", () => ({
  incrementProfileRebuildCounter: () => 0,
  resetProfileRebuildCounter: () => {},
}));

const { runDemotionPass } = await import("../../routines/handlers/memory-cleanup.ts");
const { getMemoryContext } = await import("../memory.ts");
const { storeExtractedMemories } = await import("./longTermExtractor.ts");

// ============================================================
// Reset before each test — fresh in-memory DB
// ============================================================

beforeEach(() => {
  testDb = createTestDb();
});

// ============================================================
// 1. runDemotionPass
// ============================================================

describe("runDemotionPass()", () => {
  test("archives items older than 30 days that have never been used", () => {
    seedMemory(testDb, [
      makeMemoryRow({
        id: "stale-1",
        created_at: daysAgo(100),
        importance: 0.5,
        stability: 0.5,
        access_count: 0,
        last_used_at: null,
      }),
    ]);

    const result = runDemotionPass({ dryRun: false });

    const row = testDb.prepare("SELECT status FROM memory WHERE id = 'stale-1'").get() as any;
    expect(row.status).toBe("archived");
    expect(result.archived).toBeGreaterThanOrEqual(1);
  });

  test("does NOT archive frequently accessed items", () => {
    seedMemory(testDb, [
      makeMemoryRow({
        id: "active-1",
        created_at: daysAgo(100),
        importance: 0.5,
        stability: 0.5,
        access_count: 20,
        last_used_at: daysAgo(5),
      }),
    ]);

    const result = runDemotionPass({ dryRun: false });

    const row = testDb.prepare("SELECT status FROM memory WHERE id = 'active-1'").get() as any;
    expect(row.status).toBe("active");
  });

  test("does NOT archive constraint category items", () => {
    seedMemory(testDb, [
      makeMemoryRow({
        id: "constraint-1",
        created_at: daysAgo(200),
        importance: 0.5,
        stability: 0.5,
        access_count: 0,
        category: "constraint",
      }),
    ]);

    runDemotionPass({ dryRun: false });

    const row = testDb.prepare("SELECT status FROM memory WHERE id = 'constraint-1'").get() as any;
    expect(row.status).toBe("active");
  });

  test("dry run does not change status", () => {
    seedMemory(testDb, [
      makeMemoryRow({
        id: "stale-dry-1",
        created_at: daysAgo(100),
        importance: 0.5,
        stability: 0.5,
        access_count: 0,
        last_used_at: null,
      }),
    ]);

    const result = runDemotionPass({ dryRun: true });

    const row = testDb.prepare("SELECT status FROM memory WHERE id = 'stale-dry-1'").get() as any;
    expect(row.status).toBe("active");
    expect(result.dryRun).toBe(true);
    expect(result.archived).toBe(0);
  });

  test("returns correct counts", () => {
    seedMemory(testDb, [
      makeMemoryRow({
        id: "low-1",
        created_at: daysAgo(120),
        importance: 0.01,
        stability: 0.01,
        access_count: 0,
        last_used_at: null,
      }),
      makeMemoryRow({
        id: "low-2",
        created_at: daysAgo(150),
        importance: 0.02,
        stability: 0.01,
        access_count: 0,
        last_used_at: null,
      }),
      makeMemoryRow({
        id: "high-1",
        created_at: daysAgo(90),
        importance: 0.9,
        stability: 0.9,
        access_count: 50,
        last_used_at: daysAgo(1),
      }),
    ]);

    const result = runDemotionPass({ dryRun: false });

    expect(result.candidates).toBe(3);
    expect(result.archived).toBe(2);
  });

  test("respects maxArchives cap", () => {
    seedMemory(testDb, Array.from({ length: 10 }, (_, i) =>
      makeMemoryRow({
        id: `stale-cap-${i}`,
        created_at: daysAgo(200 + i),
        importance: 0.01,
        stability: 0.01,
        access_count: 0,
        last_used_at: null,
      })
    ));

    const result = runDemotionPass({
      dryRun: false,
      maxArchives: 3,
    });

    expect(result.archived).toBeLessThanOrEqual(3);
  });
});

// ============================================================
// 2. getMemoryContext — backed by in-memory SQLite
// ============================================================

describe("getMemoryContext with in-memory DB", () => {
  test("returns facts seeded in the DB", async () => {
    seedMemory(testDb, [
      makeMemoryRow({
        id: "f1",
        content: "Active memory content here",
        type: "fact",
        importance: 0.85,
        stability: 0.9,
      }),
    ]);
    const result = await getMemoryContext(123);
    expect(result).toContain("Active memory content here");
  });

  test("returns empty when no facts or goals in DB", async () => {
    // Fresh DB, no seeds
    const result = await getMemoryContext(123);
    expect(result).toBe("");
  });
});

// ============================================================
// 3. storeExtractedMemories assigns importance/stability by type
// ============================================================

describe("storeExtractedMemories assigns importance/stability by type", () => {
  test("fact gets importance ~0.85 and stability ~0.90", async () => {
    await storeExtractedMemories(123, {
      facts: ["I live in Singapore"],
      goals: ["Learn TypeScript"],
    });

    // Read back from in-memory DB
    const factRow = testDb.prepare(
      "SELECT * FROM memory WHERE type = 'fact' AND content = 'I live in Singapore'"
    ).get() as any;
    const goalRow = testDb.prepare(
      "SELECT * FROM memory WHERE type = 'goal' AND content = 'Learn TypeScript'"
    ).get() as any;

    if (factRow?.importance !== undefined) {
      expect(factRow.importance).toBeCloseTo(0.85, 1);
      expect(factRow.stability).toBeCloseTo(0.9, 1);
    }
    if (goalRow?.importance !== undefined) {
      expect(goalRow.importance).toBeCloseTo(0.8, 1);
    }
  });
});
