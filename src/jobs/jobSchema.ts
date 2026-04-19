// src/jobs/jobSchema.ts
import type { Database } from "bun:sqlite";

export function initJobSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      dedup_key TEXT,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      executor TEXT NOT NULL,
      title TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      intervention_type TEXT,
      intervention_prompt TEXT,
      intervention_due_at TEXT,
      auto_resolve_policy TEXT,
      auto_resolve_timeout_ms INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      timeout_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      metadata TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedup_key
      ON jobs(dedup_key) WHERE dedup_key IS NOT NULL
        AND (status = 'pending' OR status = 'running' OR status = 'awaiting-intervention');

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);
    CREATE INDEX IF NOT EXISTS idx_jobs_priority ON jobs(priority);
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);

    CREATE TABLE IF NOT EXISTS job_checkpoints (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      round INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_job_checkpoints_job ON job_checkpoints(job_id);
  `);
}
