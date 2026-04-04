/**
 * Blackboard CRUD
 *
 * Pure DB layer for bb_sessions and bb_records. No orchestration logic.
 * All functions accept a Database argument to support both production (getDb())
 * and test (:memory:) databases.
 */

import type { Database } from "bun:sqlite";
import type { BbSession, BbRecord, BbSpace, BbRecordType, BbRecordStatus, BbSessionStatus } from "./types.ts";

// ── Sessions ──────────────────────────────────────────────────────────────────

export interface CreateSessionOpts {
  dispatchId?: string | null;
  workflow?: string;
  maxRounds?: number;
  budgetTokens?: number | null;
  metadata?: Record<string, unknown>;
}

export function createSession(db: Database, opts: CreateSessionOpts = {}): BbSession {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO bb_sessions (id, dispatch_id, status, workflow, max_rounds, budget_tokens, metadata)
     VALUES (?, ?, 'active', ?, ?, ?, ?)`,
    [
      id,
      opts.dispatchId ?? null,
      opts.workflow ?? "default",
      opts.maxRounds ?? 10,
      opts.budgetTokens ?? null,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
    ]
  );
  return getSession(db, id)!;
}

export function getSession(db: Database, sessionId: string): BbSession | null {
  return db.query("SELECT * FROM bb_sessions WHERE id = ?").get(sessionId) as BbSession | null;
}

export function updateSessionStatus(db: Database, sessionId: string, status: BbSessionStatus): void {
  const completedCol = status === "done" || status === "failed" || status === "cancelled"
    ? ", completed_at = datetime('now')"
    : "";
  db.run(`UPDATE bb_sessions SET status = ?${completedCol} WHERE id = ?`, [status, sessionId]);
}

export function incrementRound(db: Database, sessionId: string): void {
  db.run("UPDATE bb_sessions SET current_round = current_round + 1 WHERE id = ?", [sessionId]);
}

// ── Records ───────────────────────────────────────────────────────────────────

export interface WriteRecordOpts {
  sessionId: string;
  space: BbSpace;
  recordType: BbRecordType;
  producer?: string | null;
  owner?: string | null;
  confidence?: number | null;
  content: Record<string, unknown>;
  parentId?: string | null;
  supersedes?: string | null;
  round?: number | null;
}

export function writeRecord(db: Database, opts: WriteRecordOpts): BbRecord {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO bb_records (id, session_id, space, record_type, producer, owner, status, confidence, content, parent_id, supersedes, round)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [
      id,
      opts.sessionId,
      opts.space,
      opts.recordType,
      opts.producer ?? null,
      opts.owner ?? null,
      opts.confidence ?? null,
      JSON.stringify(opts.content),
      opts.parentId ?? null,
      opts.supersedes ?? null,
      opts.round ?? null,
    ]
  );
  return db.query("SELECT * FROM bb_records WHERE id = ?").get(id) as BbRecord;
}

export function getRecords(db: Database, sessionId: string): BbRecord[] {
  return db.query("SELECT * FROM bb_records WHERE session_id = ? ORDER BY created_at").all(sessionId) as BbRecord[];
}

export function getRecordsBySpace(db: Database, sessionId: string, space: BbSpace): BbRecord[] {
  return db
    .query("SELECT * FROM bb_records WHERE session_id = ? AND space = ? ORDER BY created_at")
    .all(sessionId, space) as BbRecord[];
}

export function updateRecordStatus(db: Database, recordId: string, status: BbRecordStatus): void {
  db.run("UPDATE bb_records SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, recordId]);
}

/**
 * Archive all completed records for a session (status 'done' → 'archived').
 * Returns the number of records archived.
 */
export function archiveCompletedRecords(db: Database, sessionId: string): number {
  const result = db.run(
    "UPDATE bb_records SET status = 'archived', updated_at = datetime('now') WHERE session_id = ? AND status = 'done'",
    [sessionId]
  );
  return result.changes;
}

/**
 * Get a single record by ID.
 */
export function getRecord(db: Database, recordId: string): BbRecord | null {
  return db.query("SELECT * FROM bb_records WHERE id = ?").get(recordId) as BbRecord | null;
}
