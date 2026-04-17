/**
 * Orchestration DB Schema
 *
 * Adds `dispatches` and `dispatch_tasks` tables to the existing SQLite database.
 * Called from db.ts initSchema() — safe to call multiple times (CREATE IF NOT EXISTS).
 */

import type { Database } from "bun:sqlite";

export function initOrchestrationSchema(db: Database): void {
  // Drop blackboard tables — removed in NLAH harness replacement (2026-04-18)
  db.exec(`
    DROP TABLE IF EXISTS bb_audit_log;
    DROP TABLE IF EXISTS bb_status_log;
    DROP TABLE IF EXISTS agent_messages;
    DROP TABLE IF EXISTS bb_records;
    DROP TABLE IF EXISTS agent_mesh;
    DROP TABLE IF EXISTS bb_sessions;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatches (
      id TEXT PRIMARY KEY,
      command_center_msg_id INTEGER,
      user_message TEXT NOT NULL,
      intent TEXT,
      confidence REAL,
      is_compound INTEGER DEFAULT 0,
      status TEXT DEFAULT 'planning',
      plan_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      duration_ms INTEGER,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS dispatch_tasks (
      id TEXT PRIMARY KEY,
      dispatch_id TEXT NOT NULL REFERENCES dispatches(id),
      seq INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      topic_hint TEXT,
      task_description TEXT,
      status TEXT DEFAULT 'pending',
      agent_message_id INTEGER,
      result_summary TEXT,
      result_artifact_path TEXT,
      started_at TEXT,
      completed_at TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_dispatches_status ON dispatches(status);
    CREATE INDEX IF NOT EXISTS idx_dispatches_created ON dispatches(created_at);
    CREATE INDEX IF NOT EXISTS idx_dispatch_tasks_dispatch ON dispatch_tasks(dispatch_id);
    CREATE INDEX IF NOT EXISTS idx_dispatch_tasks_status ON dispatch_tasks(status);
  `);
}
