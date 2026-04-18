// src/jobs/jobTopicRegistry.ts
//
// Registry mapping CC forum topicId → job metadata.
// Hot path: in-memory Map (O(1)).
// Cold path (post-restart): SQLite fallback reconstructed from jobs.metadata.
//
// initFromDb() must be called once at startup (jobs/index.ts).

import type { Database } from "bun:sqlite";

export interface JobTopicEntry {
  jobId: string;
  prompt: string;
  agentId: string;
}

const registry = new Map<number, JobTopicEntry>();
let _db: Database | null = null;

/** Call once at startup to enable SQLite fallback. */
export function initFromDb(db: Database): void {
  _db = db;
  // Rebuild hot map from all non-terminal jobs that have a jobTopicId
  try {
    const rows = db.query(
      `SELECT id, metadata FROM jobs
       WHERE status NOT IN ('done','failed','cancelled')
         AND metadata LIKE '%jobTopicId%'`
    ).all() as Array<{ id: string; metadata: string | null }>;

    let loaded = 0;
    for (const row of rows) {
      const meta = safeParseJson(row.metadata);
      const topicId = meta?.jobTopicId;
      if (typeof topicId !== "number") continue;
      const prompt = (meta?.prompt as string | undefined) ?? "";
      const agentId = (meta?.agentId as string | undefined) ?? "operations-hub";
      registry.set(topicId, { jobId: row.id, prompt, agentId });
      loaded++;
    }
    if (loaded > 0) {
      console.log(`[jobTopicRegistry] rebuilt ${loaded} entries from DB`);
    }
  } catch (err) {
    console.warn("[jobTopicRegistry] initFromDb failed (non-fatal):", err instanceof Error ? err.message : err);
  }
}

export function registerJobTopic(topicId: number, entry: JobTopicEntry): void {
  registry.set(topicId, entry);
}

/**
 * Get topic entry. Checks in-memory map first (O(1)).
 * On miss, falls back to SQLite if DB was initialised (handles post-restart lookup).
 */
export function getJobTopic(topicId: number): JobTopicEntry | undefined {
  const hot = registry.get(topicId);
  if (hot) return hot;

  if (!_db) return undefined;

  // SQLite fallback: find non-terminal job with this topicId in metadata
  try {
    const row = _db.query(
      `SELECT id, metadata FROM jobs
       WHERE status NOT IN ('done','failed','cancelled')
         AND metadata LIKE ?
       LIMIT 1`
    ).get(`%"jobTopicId":${topicId}%`) as { id: string; metadata: string | null } | null;

    if (!row) return undefined;

    const meta = safeParseJson(row.metadata);
    if (!meta) return undefined;

    const entry: JobTopicEntry = {
      jobId: row.id,
      prompt: (meta.prompt as string | undefined) ?? "",
      agentId: (meta.agentId as string | undefined) ?? "operations-hub",
    };
    // Warm the hot cache
    registry.set(topicId, entry);
    return entry;
  } catch {
    return undefined;
  }
}

export function isJobTopic(topicId: number): boolean {
  return getJobTopic(topicId) !== undefined;
}

/** Exposed for testing only */
export function _clearRegistry(): void {
  registry.clear();
  _db = null;
}

function safeParseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
