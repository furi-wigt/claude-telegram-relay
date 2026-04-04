/**
 * Blackboard CRUD
 *
 * Pure DB layer for bb_sessions and bb_records. No orchestration logic.
 * All functions accept a Database argument to support both production (getDb())
 * and test (:memory:) databases.
 */

import type { Database } from "bun:sqlite";
import type { BbSession, BbRecord, BbSpace, BbRecordType, BbRecordStatus, BbSessionStatus } from "./types.ts";

// ── Gap 3: Status Transition Maps ────────────────────────────────────────────

/**
 * Valid status transitions for bb_records.
 * Allows forward-only progression + retry path (failed→pending).
 * Prevents: done→pending, archived→*, done→active (invalid backtracks).
 */
export const VALID_RECORD_TRANSITIONS: Record<BbRecordStatus, BbRecordStatus[]> = {
  pending:    ["active", "done", "failed", "superseded", "archived"],  // done: instant-complete; archived: cancelled before start
  active:     ["done", "failed"],
  done:       ["archived", "superseded"],
  failed:     ["pending", "archived"],  // pending = retry path (governance action)
  superseded: ["archived"],
  archived:   [],                       // terminal — no transitions out
};

/**
 * Valid status transitions for bb_sessions.
 * done→active: governance retry path (user resets failed tasks).
 * finalizing→active: retry from finalizing state.
 */
export const VALID_SESSION_TRANSITIONS: Record<BbSessionStatus, BbSessionStatus[]> = {
  active:     ["finalizing", "done", "failed", "cancelled"],
  finalizing: ["done", "failed", "active", "cancelled"],  // active = retry; cancelled = discard
  done:       ["active"],                     // active = governance retry
  failed:     ["active"],                     // re-activate on retry
  cancelled:  [],                             // terminal
};

export class InvalidTransitionError extends Error {
  constructor(public entity: "record" | "session", public from: string, public to: string) {
    super(`Invalid ${entity} transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

// ── Gap 1: Audit Log ─────────────────────────────────────────────────────────

export type AuditEventType =
  | "record_created"
  | "record_status_changed"
  | "session_status_changed"
  | "trigger_fired"
  | "orphan_reaped";

export interface AuditEntry {
  sessionId?: string | null;
  recordId?: string | null;
  eventType: AuditEventType;
  agent?: string | null;
  oldStatus?: string | null;
  newStatus?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Fire-and-forget audit write. Never throws — degrades gracefully. */
export function writeAuditEntry(db: Database, entry: AuditEntry): void {
  try {
    db.run(
      `INSERT INTO bb_audit_log (session_id, record_id, event_type, agent, old_status, new_status, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.sessionId ?? null,
        entry.recordId ?? null,
        entry.eventType,
        entry.agent ?? null,
        entry.oldStatus ?? null,
        entry.newStatus ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ]
    );
  } catch {
    // Audit failures must never block the operation being audited
  }
}

/** Read audit entries for a session (for debugging/testing). */
export function getAuditEntries(db: Database, sessionId: string): Array<{
  id: number;
  session_id: string | null;
  record_id: string | null;
  event_type: string;
  agent: string | null;
  old_status: string | null;
  new_status: string | null;
  metadata: string | null;
  created_at: string;
}> {
  return db
    .query("SELECT * FROM bb_audit_log WHERE session_id = ? ORDER BY id")
    .all(sessionId) as any[];
}

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
  // Gap 3: validate transition (idempotent self-transitions are allowed)
  const current = db.query("SELECT status FROM bb_sessions WHERE id = ?").get(sessionId) as { status: BbSessionStatus } | null;
  if (current && current.status !== status) {
    const allowed = VALID_SESSION_TRANSITIONS[current.status];
    if (allowed && !allowed.includes(status)) {
      throw new InvalidTransitionError("session", current.status, status);
    }
  }

  const completedCol = status === "done" || status === "failed" || status === "cancelled"
    ? ", completed_at = datetime('now')"
    : "";
  db.run(`UPDATE bb_sessions SET status = ?${completedCol} WHERE id = ?`, [status, sessionId]);

  // Gap 1: audit
  writeAuditEntry(db, {
    sessionId,
    eventType: "session_status_changed",
    oldStatus: current?.status ?? null,
    newStatus: status,
  });
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

  // Gap 1: audit
  writeAuditEntry(db, {
    sessionId: opts.sessionId,
    recordId: id,
    eventType: "record_created",
    agent: opts.producer ?? null,
    newStatus: "pending",
    metadata: { space: opts.space, recordType: opts.recordType },
  });

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
  // Gap 3: validate transition (idempotent self-transitions are allowed)
  const current = db.query("SELECT status, session_id, producer FROM bb_records WHERE id = ?").get(recordId) as { status: BbRecordStatus; session_id: string; producer: string | null } | null;
  if (current && current.status !== status) {
    const allowed = VALID_RECORD_TRANSITIONS[current.status];
    if (allowed && !allowed.includes(status)) {
      throw new InvalidTransitionError("record", current.status, status);
    }
  }

  db.run("UPDATE bb_records SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, recordId]);

  // Gap 1: audit
  writeAuditEntry(db, {
    sessionId: current?.session_id ?? null,
    recordId,
    eventType: "record_status_changed",
    agent: current?.producer ?? null,
    oldStatus: current?.status ?? null,
    newStatus: status,
  });
}

/**
 * Archive all completed records for a session (status 'done' → 'archived').
 * Bulk operation — bypasses per-record transition validation (done→archived is valid).
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

// ── Gap 8: Orphan Record Reaper ─────────────────────────────────────────────

/** Stale threshold for active records on active sessions (minutes) */
const ORPHAN_STALE_MINUTES = 10;

/**
 * Reap orphaned records: active records on active sessions with no update for > threshold.
 *
 * Targets records where:
 *   - session is still 'active'
 *   - record status is 'active'
 *   - updated_at (or created_at if never updated) is older than ORPHAN_STALE_MINUTES
 *
 * Returns the number of records reaped.
 */
export function reapOrphanRecords(db: Database, staleMinutes: number = ORPHAN_STALE_MINUTES): number {
  const result = db.run(
    `UPDATE bb_records SET status = 'failed', updated_at = datetime('now')
     WHERE status = 'active'
       AND session_id IN (SELECT id FROM bb_sessions WHERE status = 'active')
       AND COALESCE(updated_at, created_at) < datetime('now', '-${staleMinutes} minutes')`,
  );

  // Audit each reaped record
  if (result.changes > 0) {
    const reaped = db.query(
      `SELECT id, session_id FROM bb_records
       WHERE status = 'failed'
         AND updated_at = (SELECT MAX(updated_at) FROM bb_records WHERE status = 'failed')
       LIMIT ${result.changes}`
    ).all() as Array<{ id: string; session_id: string }>;

    for (const r of reaped) {
      writeAuditEntry(db, {
        sessionId: r.session_id,
        recordId: r.id,
        eventType: "orphan_reaped",
        oldStatus: "active",
        newStatus: "failed",
        metadata: { reason: "stale_timeout", thresholdMinutes: staleMinutes },
      });
    }
  }

  return result.changes;
}
