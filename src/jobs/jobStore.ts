// src/jobs/jobStore.ts
import type { Database } from "bun:sqlite";
import type {
  Job,
  JobCheckpoint,
  JobStatus,
  JobType,
  JobPriority,
  InterventionType,
  AutoResolvePolicy,
} from "./types.ts";

interface InsertJobInput {
  source: string;
  type: string;
  priority?: string;
  executor: string;
  title: string;
  payload?: Record<string, unknown>;
  dedup_key?: string;
  timeout_ms?: number;
  auto_resolve_policy?: string;
  auto_resolve_timeout_ms?: number;
  metadata?: Record<string, unknown>;
}

interface SetInterventionInput {
  type: InterventionType;
  prompt: string;
  due_at?: string;
  auto_resolve_policy?: AutoResolvePolicy;
  auto_resolve_timeout_ms?: number;
}

interface ListJobsFilter {
  status?: JobStatus;
  type?: JobType;
  priority?: JobPriority;
  limit?: number;
}

const TERMINAL_STATUSES: JobStatus[] = ["done", "failed", "cancelled"];

function parseJsonField(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function rowToJob(row: Record<string, unknown>): Job {
  return {
    ...row,
    payload: parseJsonField(row.payload as string) ?? {},
    metadata: parseJsonField(row.metadata as string),
  } as Job;
}

function rowToCheckpoint(row: Record<string, unknown>): JobCheckpoint {
  return {
    ...row,
    state: parseJsonField(row.state as string) ?? {},
  } as JobCheckpoint;
}

export class JobStore {
  constructor(private db: Database) {}

  insertJob(input: InsertJobInput): Job {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO jobs (id, source, type, priority, executor, title, payload, dedup_key, timeout_ms, auto_resolve_policy, auto_resolve_timeout_ms, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.source,
        input.type,
        input.priority ?? "normal",
        input.executor,
        input.title,
        JSON.stringify(input.payload ?? {}),
        input.dedup_key ?? null,
        input.timeout_ms ?? null,
        input.auto_resolve_policy ?? null,
        input.auto_resolve_timeout_ms ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ]
    );
    return this.getJob(id)!;
  }

  getJob(id: string): Job | null {
    const row = this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? rowToJob(row) : null;
  }

  updateStatus(id: string, status: JobStatus): void {
    const sets: string[] = ["status = ?"];
    const params: unknown[] = [status];

    if (status === "running") {
      sets.push("started_at = datetime('now')");
    }
    if (TERMINAL_STATUSES.includes(status)) {
      sets.push("completed_at = datetime('now')");
    }

    this.db.run(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  }

  setIntervention(id: string, input: SetInterventionInput): void {
    this.db.run(
      `UPDATE jobs SET
        status = 'awaiting-intervention',
        intervention_type = ?,
        intervention_prompt = ?,
        intervention_due_at = ?,
        auto_resolve_policy = COALESCE(?, auto_resolve_policy),
        auto_resolve_timeout_ms = COALESCE(?, auto_resolve_timeout_ms)
      WHERE id = ?`,
      [
        input.type,
        input.prompt,
        input.due_at ?? null,
        input.auto_resolve_policy ?? null,
        input.auto_resolve_timeout_ms ?? null,
        id,
      ]
    );
  }

  clearIntervention(id: string, resumeStatus: JobStatus): void {
    this.db.run(
      `UPDATE jobs SET
        status = ?,
        intervention_type = NULL,
        intervention_prompt = NULL,
        intervention_due_at = NULL
      WHERE id = ?`,
      [resumeStatus, id]
    );
  }

  listJobs(filter?: ListJobsFilter): Job[] {
    let sql = "SELECT * FROM jobs WHERE 1=1";
    const params: unknown[] = [];

    if (filter?.status) {
      sql += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.type) {
      sql += " AND type = ?";
      params.push(filter.type);
    }
    if (filter?.priority) {
      sql += " AND priority = ?";
      params.push(filter.priority);
    }

    sql += " ORDER BY created_at DESC";

    if (filter?.limit) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }

    const rows = this.db.query(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToJob);
  }

  countRunningByType(type: JobType): number {
    const row = this.db
      .query("SELECT COUNT(*) as count FROM jobs WHERE type = ? AND status = 'running'")
      .get(type) as { count: number };
    return row.count;
  }

  getAwaitingIntervention(): Job[] {
    const rows = this.db
      .query("SELECT * FROM jobs WHERE status = 'awaiting-intervention' ORDER BY created_at ASC")
      .all() as Record<string, unknown>[];
    return rows.map(rowToJob);
  }

  getTimedOutJobs(): Job[] {
    const rows = this.db
      .query(
        `SELECT * FROM jobs
         WHERE status = 'running'
           AND timeout_ms IS NOT NULL
           AND started_at IS NOT NULL
           AND (julianday('now') - julianday(started_at)) * 86400000 > timeout_ms`
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToJob);
  }

  getPendingByPriority(): Job[] {
    const rows = this.db
      .query(
        `SELECT * FROM jobs WHERE status = 'pending'
         ORDER BY
           CASE priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 WHEN 'background' THEN 2 END,
           created_at ASC`
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToJob);
  }

  incrementRetry(id: string): void {
    this.db.run("UPDATE jobs SET retry_count = retry_count + 1 WHERE id = ?", [id]);
  }

  setError(id: string, error: string): void {
    this.db.run("UPDATE jobs SET error = ? WHERE id = ?", [error, id]);
  }

  insertCheckpoint(jobId: string, round: number, state: Record<string, unknown>): string {
    const id = crypto.randomUUID();
    this.db.run(
      "INSERT INTO job_checkpoints (id, job_id, round, state) VALUES (?, ?, ?, ?)",
      [id, jobId, round, JSON.stringify(state)]
    );
    return id;
  }

  getLatestCheckpoint(jobId: string): JobCheckpoint | null {
    const row = this.db
      .query("SELECT * FROM job_checkpoints WHERE job_id = ? ORDER BY round DESC LIMIT 1")
      .get(jobId) as Record<string, unknown> | null;
    return row ? rowToCheckpoint(row) : null;
  }

  /** For auto-resolve: find awaiting-intervention jobs past their timeout */
  getExpiredInterventions(): Job[] {
    const rows = this.db
      .query(
        `SELECT * FROM jobs
         WHERE status = 'awaiting-intervention'
           AND auto_resolve_policy IS NOT NULL
           AND auto_resolve_policy != 'none'
           AND auto_resolve_timeout_ms IS NOT NULL
           AND intervention_due_at IS NOT NULL
           AND (julianday('now') - julianday(intervention_due_at)) * 86400000 > auto_resolve_timeout_ms`
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToJob);
  }
}
