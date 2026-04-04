/**
 * Blackboard DB Schema
 *
 * Adds bb_sessions, bb_records, and bb_mesh_links tables.
 * Called from schema.ts initOrchestrationSchema() — safe to call multiple times.
 */

import type { Database } from "bun:sqlite";

export function initBlackboardSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bb_sessions (
      id TEXT PRIMARY KEY,
      dispatch_id TEXT,
      status TEXT DEFAULT 'active',
      workflow TEXT DEFAULT 'default',
      max_rounds INTEGER DEFAULT 10,
      current_round INTEGER DEFAULT 0,
      budget_tokens INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS bb_records (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES bb_sessions(id),
      space TEXT NOT NULL,
      record_type TEXT NOT NULL,
      producer TEXT,
      owner TEXT,
      status TEXT DEFAULT 'pending',
      confidence REAL,
      content TEXT NOT NULL,
      parent_id TEXT,
      supersedes TEXT,
      round INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS bb_mesh_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      link_type TEXT DEFAULT 'bidirectional',
      UNIQUE(from_agent, to_agent)
    );

    CREATE INDEX IF NOT EXISTS idx_bb_sessions_status ON bb_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_bb_records_session ON bb_records(session_id);
    CREATE INDEX IF NOT EXISTS idx_bb_records_space ON bb_records(session_id, space);
    CREATE INDEX IF NOT EXISTS idx_bb_records_status ON bb_records(status);
  `);
}
