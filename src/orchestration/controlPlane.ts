/**
 * Control Plane
 *
 * selectNextAgents(db, sessionId) → AgentTrigger[]
 *
 * Pure function: reads board state, returns trigger list.
 * Evaluated after every agent completion. O(n) over active records.
 *
 * Rule priority: ESCALATE > CONFLICT > REVIEW > INIT > EXECUTE > FINALIZE
 */

import type { Database } from "bun:sqlite";
import type { BbRecord, BbSession, BbTaskContent, BbArtifactContent, AgentTrigger } from "./types.ts";

const MAX_TASK_RETRIES = 3;
const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Inspect the blackboard and determine which agents should fire next.
 * Rules evaluated in priority order: ESCALATE > CONFLICT > REVIEW > INIT > EXECUTE > FINALIZE.
 */
export function selectNextAgents(db: Database, sessionId: string): AgentTrigger[] {
  const session = db.query("SELECT * FROM bb_sessions WHERE id = ?").get(sessionId) as BbSession | null;
  if (!session) return [];

  const records = db
    .query("SELECT * FROM bb_records WHERE session_id = ? ORDER BY created_at")
    .all(sessionId) as BbRecord[];

  const inputRecords = records.filter((r) => r.space === "input");
  const taskRecords = records.filter((r) => r.space === "tasks");
  const artifactRecords = records.filter((r) => r.space === "artifacts");
  const reviewRecords = records.filter((r) => r.space === "reviews");
  const conflictRecords = records.filter((r) => r.space === "conflicts");

  // ── ESCALATE: round budget exceeded ──────────────────────────────────────
  if (session.current_round >= session.max_rounds && taskRecords.some((t) => t.status === "pending" || t.status === "active")) {
    return [{
      rule: "ESCALATE",
      agentId: "command-center",
      reason: `Round limit reached (${session.current_round}/${session.max_rounds}) with incomplete tasks`,
    }];
  }

  // ESCALATE: tasks that failed too many times
  for (const task of taskRecords) {
    const content = JSON.parse(task.content) as BbTaskContent;
    if (task.status === "failed" && (content.retryCount ?? 0) >= MAX_TASK_RETRIES) {
      return [{
        rule: "ESCALATE",
        agentId: "command-center",
        taskRecordId: task.id,
        reason: `Task failed ${MAX_TASK_RETRIES}× — "${content.taskDescription?.slice(0, 60)}"`,
      }];
    }
  }

  // ESCALATE: low confidence artifact without review
  for (const artifact of artifactRecords) {
    if (artifact.status !== "pending") continue;
    if (artifact.confidence !== null && artifact.confidence < LOW_CONFIDENCE_THRESHOLD) {
      const hasReview = reviewRecords.some((r) => {
        const content = JSON.parse(r.content);
        return content.targetRecordId === artifact.id;
      });
      if (!hasReview) {
        return [{
          rule: "ESCALATE",
          agentId: "command-center",
          taskRecordId: artifact.id,
          reason: `Low confidence artifact (${artifact.confidence}) needs review — "${artifact.producer}"`,
        }];
      }
    }
  }

  // ── CONFLICT: open conflicts need resolution ──────────────────────────────
  const openConflicts = conflictRecords.filter((c) => c.status === "pending");
  if (openConflicts.length > 0) {
    return [{
      rule: "CONFLICT",
      agentId: "command-center",
      taskRecordId: openConflicts[0].id,
      reason: `Open conflict: ${openConflicts.length} unresolved`,
    }];
  }

  // ── REVIEW: artifacts without reviews need code-quality-coach ──────────
  const pendingArtifacts = artifactRecords.filter((a) => a.status === "pending");
  const reviewedArtifactIds = new Set(
    reviewRecords.map((r) => {
      const content = JSON.parse(r.content);
      return content.targetRecordId as string;
    })
  );

  for (const artifact of pendingArtifacts) {
    if (!reviewedArtifactIds.has(artifact.id)) {
      // Check if the producing agent's artifacts require review
      // For now, all pending artifacts in the review pipeline get reviewed
      return [{
        rule: "REVIEW",
        agentId: "code-quality-coach",
        taskRecordId: artifact.id,
        reason: `Artifact from ${artifact.producer} needs review`,
      }];
    }
  }

  // ── INIT: input exists but no tasks → decompose ─────────────────────────
  if (inputRecords.length > 0 && taskRecords.length === 0) {
    return [{
      rule: "INIT",
      agentId: "command-center",
      reason: "Input received, no task graph — decompose into tasks",
    }];
  }

  // ── EXECUTE: pending tasks with satisfied deps ──────────────────────────
  const triggers: AgentTrigger[] = [];
  const doneSeqs = new Set<number>();
  for (const task of taskRecords) {
    if (task.status === "done") {
      const content = JSON.parse(task.content) as BbTaskContent;
      doneSeqs.add(content.seq);
    }
  }

  for (const task of taskRecords) {
    if (task.status !== "pending") continue;
    const content = JSON.parse(task.content) as BbTaskContent;
    const depsReady = content.dependsOn.length === 0 || content.dependsOn.every((d) => doneSeqs.has(d));
    if (depsReady) {
      triggers.push({
        rule: "EXECUTE",
        agentId: content.agentId,
        taskRecordId: task.id,
        reason: `Task ready: "${content.taskDescription?.slice(0, 60)}"`,
      });
    }
  }

  if (triggers.length > 0) return triggers;

  // ── FINALIZE: all tasks done, no open reviews ───────────────────────────
  const allTasksDone = taskRecords.length > 0 && taskRecords.every((t) => t.status === "done");
  const openReviews = reviewRecords.some((r) => r.status === "pending" || r.status === "active");

  if (allTasksDone && !openReviews) {
    return [{
      rule: "FINALIZE",
      agentId: "command-center",
      reason: "All tasks complete, no open reviews — ready for aggregation",
    }];
  }

  return [];
}
