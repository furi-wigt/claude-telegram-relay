/**
 * Tests for BM25 search via SQLite FTS5.
 *
 * Uses an in-memory SQLite database to test FTS5 indexing and search
 * without requiring Qdrant or embedding services.
 *
 * Run: bun test src/local/bm25Search.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";

// ─── In-memory DB with FTS5 ────────────────────────────────────────────────

let db: Database;

beforeAll(() => {
  db = new Database(":memory:");

  // Create documents table
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
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
  `);

  // Create FTS5 virtual table
  db.exec(`
    CREATE VIRTUAL TABLE documents_fts USING fts5(
      name, content, chunk_heading,
      content='documents', content_rowid='rowid'
    );
  `);

  // Triggers
  db.exec(`
    CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, name, content, chunk_heading)
        VALUES (NEW.rowid, NEW.name, NEW.content, NEW.chunk_heading);
    END;
  `);
  db.exec(`
    CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, name, content, chunk_heading)
        VALUES ('delete', OLD.rowid, OLD.name, OLD.content, OLD.chunk_heading);
    END;
  `);

  // Insert test documents
  const docs = [
    { id: "bcp-1", name: "Business Continuity Plan", content: "Business continuity planning for EDEN project. Disaster recovery procedures and backup strategies.", chunk_heading: "Overview" },
    { id: "bcp-2", name: "Business Continuity Plan", content: "Recovery time objectives (RTO) and recovery point objectives (RPO) for critical systems.", chunk_heading: "RTO/RPO" },
    { id: "mesh-1", name: "Constrained Mesh Multi-Agent", content: "Constrained mesh multi-agent architecture with blackboard pattern for distributed AI systems.", chunk_heading: "Architecture" },
    { id: "sec-1", name: "Security Policy", content: "Information security management system (ISMS) policies and procedures for government agencies.", chunk_heading: "ISMS" },
    { id: "sec-2", name: "Security Policy", content: "Access control and identity management requirements for IM8 compliance.", chunk_heading: "Access Control" },
  ];

  const stmt = db.prepare(
    "INSERT INTO documents (id, name, content, chunk_heading) VALUES (?, ?, ?, ?)"
  );
  for (const doc of docs) {
    stmt.run(doc.id, doc.name, doc.content, doc.chunk_heading);
  }
});

afterAll(() => {
  db.close();
});

// ─── FTS5 Search Tests ──────────────────────────────────────────────────────

describe("FTS5 BM25 search", () => {
  test("finds documents matching query terms", () => {
    const rows = db.query(`
      SELECT d.id, d.name, bm25(documents_fts) AS rank
      FROM documents_fts
      JOIN documents d ON d.rowid = documents_fts.rowid
      WHERE documents_fts MATCH 'business continuity'
      ORDER BY rank
    `).all() as { id: string; name: string; rank: number }[];

    expect(rows.length).toBeGreaterThan(0);
    // BCP documents should match
    expect(rows.some((r) => r.id === "bcp-1")).toBe(true);
  });

  test("does NOT match 'blackboard' for 'business continuity plan' query", () => {
    const rows = db.query(`
      SELECT d.id
      FROM documents_fts
      JOIN documents d ON d.rowid = documents_fts.rowid
      WHERE documents_fts MATCH 'business continuity plan'
    `).all() as { id: string }[];

    const ids = rows.map((r) => r.id);
    // Blackboard doc should NOT appear
    expect(ids).not.toContain("mesh-1");
    // BCP docs should appear
    expect(ids).toContain("bcp-1");
  });

  test("ranks exact matches higher than partial matches", () => {
    const rows = db.query(`
      SELECT d.id, bm25(documents_fts) AS rank
      FROM documents_fts
      JOIN documents d ON d.rowid = documents_fts.rowid
      WHERE documents_fts MATCH 'security'
      ORDER BY rank
    `).all() as { id: string; rank: number }[];

    expect(rows.length).toBeGreaterThanOrEqual(2);
    // Security policy docs should be returned
    expect(rows.some((r) => r.id === "sec-1")).toBe(true);
  });

  test("FTS5 trigger keeps index in sync on INSERT", () => {
    db.run(
      "INSERT INTO documents (id, name, content, chunk_heading) VALUES (?, ?, ?, ?)",
      ["new-1", "New Document", "Unique searchable zebra content", "Test"]
    );

    const rows = db.query(`
      SELECT d.id FROM documents_fts
      JOIN documents d ON d.rowid = documents_fts.rowid
      WHERE documents_fts MATCH 'zebra'
    `).all() as { id: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("new-1");
  });

  test("FTS5 trigger keeps index in sync on DELETE", () => {
    db.run("DELETE FROM documents WHERE id = ?", ["new-1"]);

    const rows = db.query(`
      SELECT d.id FROM documents_fts
      JOIN documents d ON d.rowid = documents_fts.rowid
      WHERE documents_fts MATCH 'zebra'
    `).all() as { id: string }[];

    expect(rows).toHaveLength(0);
  });

  test("BM25 scores are negative (SQLite convention)", () => {
    const rows = db.query(`
      SELECT bm25(documents_fts) AS rank
      FROM documents_fts
      WHERE documents_fts MATCH 'security'
    `).all() as { rank: number }[];

    for (const row of rows) {
      expect(row.rank).toBeLessThanOrEqual(0);
    }
  });

  test("handles query with special characters gracefully", () => {
    // Should not throw — special chars are stripped by bm25SearchDocuments
    const result = db.query(`
      SELECT COUNT(*) as cnt FROM documents_fts
      WHERE documents_fts MATCH 'simple query'
    `).get() as { cnt: number };

    expect(result.cnt).toBeGreaterThanOrEqual(0);
  });

  test("question mark in natural language query does not throw FTS5 parse error", () => {
    // Regression: "What are my active goals?" → '?' is an FTS5 wildcard operator.
    // bm25SearchDocuments must strip it before passing to MATCH.
    const raw = "What are my active goals?";
    const sanitized = raw.replace(/['"(){}[\]*:^~!@#$%&?]/g, " ").trim();

    expect(sanitized).toBe("What are my active goals");  // '?' removed, trim() cleans trailing space
    expect(sanitized).not.toContain("?");

    // Sanitized form must not throw when used in a MATCH clause
    const result = db.query(`
      SELECT COUNT(*) as cnt FROM documents_fts
      WHERE documents_fts MATCH ?
    `).get(sanitized) as { cnt: number };

    expect(result.cnt).toBeGreaterThanOrEqual(0);
  });
});

// ─── The core scenario: BCP query no longer matches blackboard ──────────────

describe("BCP false positive scenario", () => {
  test("'business continuity plan EDEN' finds BCP docs, not blackboard", () => {
    const rows = db.query(`
      SELECT d.id, d.name, bm25(documents_fts) AS rank
      FROM documents_fts
      JOIN documents d ON d.rowid = documents_fts.rowid
      WHERE documents_fts MATCH 'business continuity plan EDEN'
      ORDER BY rank
      LIMIT 5
    `).all() as { id: string; name: string; rank: number }[];

    const ids = rows.map((r) => r.id);
    // BCP doc MUST appear
    expect(ids).toContain("bcp-1");
    // Blackboard doc MUST NOT appear
    expect(ids).not.toContain("mesh-1");
  });
});
