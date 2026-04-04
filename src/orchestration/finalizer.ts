/**
 * Finalizer & Governance (Phase 5)
 *
 * Handles the end-of-dispatch lifecycle:
 *   P5.1 — Synthesis: aggregate all artifacts/reviews into a final summary record
 *   P5.2 — Board compaction: archive completed records, clean stale/expired
 *   P5.3 — Governance UI: keyboards for final approval, skip, override
 *   P5.4 — CC progress dashboard: throttled updates during dispatch
 *
 * Pure logic module — no Telegram/Bot dependency. Returns data for the caller to render.
 */

import type { Database } from "bun:sqlite";
import { InlineKeyboard } from "grammy";
import type {
  BbRecord,
  BbSession,
  BbTaskContent,
  BbArtifactContent,
  BbReviewContent,
  BbConflictContent,
} from "./types.ts";
import {
  getSession,
  getRecords,
  getRecordsBySpace,
  updateSessionStatus,
  writeRecord,
  archiveCompletedRecords,
} from "./blackboard.ts";
import { ORCH_CB_PREFIX } from "./interruptProtocol.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

/** Stale record threshold — records older than this (hours) are eligible for cleanup */
const STALE_HOURS = 72;

/** Max artifact body chars included in synthesis */
const MAX_ARTIFACT_BODY = 500;

/** Progress update throttle — minimum ms between updates to CC */
const PROGRESS_THROTTLE_MS = 3_000;

// ── P5.1: Finalizer — Synthesis ──────────────────────────────────────────────

export interface SynthesisResult {
  sessionId: string;
  finalRecordId: string;
  summary: string;
  taskCount: number;
  completedCount: number;
  failedCount: number;
  artifactSummaries: Array<{ producer: string; summary: string; verdict?: string }>;
  reviewSummaries: Array<{ reviewer: string; verdict: string; target: string }>;
  conflictResolutions: string[];
}

/**
 * Produce a final synthesis record from all board state.
 *
 * Reads tasks, artifacts (non-superseded), reviews, and conflict resolutions.
 * Writes a single "output" record to the "final" space.
 * Transitions session status to "finalizing".
 *
 * O(n) over all records in the session — single pass with space-partitioned arrays.
 */
export function finalizeSynthesis(db: Database, sessionId: string): SynthesisResult | null {
  const session = getSession(db, sessionId);
  if (!session || session.status === "done" || session.status === "cancelled") return null;

  // Transition to finalizing
  updateSessionStatus(db, sessionId, "finalizing");

  const records = getRecords(db, sessionId);

  // Partition by space — single pass O(n)
  const tasks: BbRecord[] = [];
  const artifacts: BbRecord[] = [];
  const reviews: BbRecord[] = [];
  const conflicts: BbRecord[] = [];

  for (const r of records) {
    switch (r.space) {
      case "tasks": tasks.push(r); break;
      case "artifacts": artifacts.push(r); break;
      case "reviews": reviews.push(r); break;
      case "conflicts": conflicts.push(r); break;
    }
  }

  const completedCount = tasks.filter((t) => t.status === "done").length;
  const failedCount = tasks.filter((t) => t.status === "failed").length;

  // Only include non-superseded artifacts
  const activeArtifacts = artifacts.filter((a) => a.status !== "superseded" && a.status !== "archived");

  const artifactSummaries = activeArtifacts.map((a) => {
    const content = JSON.parse(a.content) as BbArtifactContent;
    // Find the latest review verdict for this artifact
    const review = reviews.find((r) => {
      const rc = JSON.parse(r.content) as BbReviewContent;
      return rc.targetRecordId === a.id;
    });
    const verdict = review ? (JSON.parse(review.content) as BbReviewContent).verdict : undefined;

    return {
      producer: a.producer ?? "unknown",
      summary: content.summary ?? "",
      verdict,
    };
  });

  const reviewSummaries = reviews.map((r) => {
    const content = JSON.parse(r.content) as BbReviewContent;
    return {
      reviewer: r.producer ?? "unknown",
      verdict: content.verdict,
      target: content.targetRecordId.slice(0, 8),
    };
  });

  const conflictResolutions = conflicts
    .filter((c) => c.status === "done")
    .map((c) => {
      const content = JSON.parse(c.content) as BbConflictContent;
      return content.resolution ?? `${content.agents.join(" vs ")} — unresolved`;
    });

  // Build summary text
  const summary = formatSynthesis({
    tasks,
    activeArtifacts,
    artifactSummaries,
    reviewSummaries,
    conflictResolutions,
    completedCount,
    failedCount,
  });

  // Write final output record
  const finalRecord = writeRecord(db, {
    sessionId,
    space: "final",
    recordType: "output",
    producer: "finalizer",
    confidence: completedCount === tasks.length ? 1.0 : completedCount / Math.max(tasks.length, 1),
    content: {
      summary,
      taskCount: tasks.length,
      completedCount,
      failedCount,
      artifactSummaries,
      reviewSummaries,
      conflictResolutions,
    },
  });

  return {
    sessionId,
    finalRecordId: finalRecord.id,
    summary,
    taskCount: tasks.length,
    completedCount,
    failedCount,
    artifactSummaries,
    reviewSummaries,
    conflictResolutions,
  };
}

/** Format the synthesis into a human-readable summary for CC */
function formatSynthesis(data: {
  tasks: BbRecord[];
  activeArtifacts: BbRecord[];
  artifactSummaries: SynthesisResult["artifactSummaries"];
  reviewSummaries: SynthesisResult["reviewSummaries"];
  conflictResolutions: string[];
  completedCount: number;
  failedCount: number;
}): string {
  const lines: string[] = [];

  // Header
  const total = data.tasks.length;
  const icon = data.failedCount === 0 ? "\u2705" : "\u26A0\uFE0F";
  lines.push(`${icon} SYNTHESIS — ${data.completedCount}/${total} tasks complete`);
  if (data.failedCount > 0) lines.push(`\u274C ${data.failedCount} task(s) failed`);
  lines.push("");

  // Task breakdown
  lines.push("Tasks:");
  for (const task of data.tasks) {
    const content = JSON.parse(task.content) as BbTaskContent;
    const statusIcon = task.status === "done" ? "\u2705" : task.status === "failed" ? "\u274C" : "\u23F3";
    lines.push(`  ${statusIcon} ${content.agentId}: ${(content.taskDescription ?? "").slice(0, 80)}`);
  }

  // Artifacts
  if (data.artifactSummaries.length > 0) {
    lines.push("");
    lines.push("Artifacts:");
    for (const a of data.artifactSummaries) {
      const vIcon = a.verdict === "approved" ? " \u2705" : a.verdict === "rejected" ? " \u274C" : "";
      lines.push(`  \u2022 ${a.producer}${vIcon}: ${a.summary.slice(0, 120)}`);
    }
  }

  // Reviews
  if (data.reviewSummaries.length > 0) {
    lines.push("");
    lines.push(`Reviews: ${data.reviewSummaries.length} total`);
    const approved = data.reviewSummaries.filter((r) => r.verdict === "approved").length;
    const revisions = data.reviewSummaries.filter((r) => r.verdict === "revision_needed").length;
    const rejected = data.reviewSummaries.filter((r) => r.verdict === "rejected").length;
    if (approved > 0) lines.push(`  \u2705 ${approved} approved`);
    if (revisions > 0) lines.push(`  \u{1F504} ${revisions} revision(s) requested`);
    if (rejected > 0) lines.push(`  \u274C ${rejected} rejected`);
  }

  // Conflicts
  if (data.conflictResolutions.length > 0) {
    lines.push("");
    lines.push("Conflict resolutions:");
    for (const cr of data.conflictResolutions) {
      lines.push(`  \u2022 ${cr.slice(0, 120)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Mark a session as done after synthesis is approved.
 * Optionally archives completed records.
 */
export function completeSession(
  db: Database,
  sessionId: string,
  archiveRecords: boolean = true,
): { archivedCount: number } {
  updateSessionStatus(db, sessionId, "done");
  const archivedCount = archiveRecords ? archiveCompletedRecords(db, sessionId) : 0;
  return { archivedCount };
}

// ── P5.2: Board Compaction + Cleanup ─────────────────────────────────────────

export interface CompactionResult {
  archivedCount: number;
  staleCleanedCount: number;
}

/**
 * Compact the board for a session:
 *   1. Archive all done records → "archived"
 *   2. Clean stale records (pending/active older than STALE_HOURS)
 *
 * O(1) SQL — no per-record iteration needed.
 */
export function compactBoard(db: Database, sessionId: string): CompactionResult {
  const archivedCount = archiveCompletedRecords(db, sessionId);

  // Clean stale: pending or active records older than threshold
  const staleResult = db.run(
    `UPDATE bb_records
     SET status = 'failed', updated_at = datetime('now')
     WHERE session_id = ?
       AND status IN ('pending', 'active')
       AND created_at < datetime('now', '-${STALE_HOURS} hours')`,
    [sessionId],
  );

  return { archivedCount, staleCleanedCount: staleResult.changes };
}

/**
 * Global cleanup — compact all non-active sessions.
 * Intended for scheduled cleanup (orphan-gc or memory-cleanup routine).
 *
 * Returns total records affected across all sessions.
 */
export function compactAllSessions(db: Database): { sessionsProcessed: number; totalArchived: number; totalStaleCleaned: number } {
  const sessions = db
    .query("SELECT id FROM bb_sessions WHERE status IN ('done', 'failed', 'cancelled')")
    .all() as Array<{ id: string }>;

  let totalArchived = 0;
  let totalStaleCleaned = 0;

  for (const s of sessions) {
    const result = compactBoard(db, s.id);
    totalArchived += result.archivedCount;
    totalStaleCleaned += result.staleCleanedCount;
  }

  return { sessionsProcessed: sessions.length, totalArchived, totalStaleCleaned };
}

// ── P5.3: Governance UI — Keyboards ──────────────────────────────────────────

/**
 * Build the final synthesis approval keyboard.
 * Buttons: [Approve & Archive] [Override] [Retry Failed]
 */
export function buildFinalKeyboard(sessionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("\u2705 Approve & Archive", `${ORCH_CB_PREFIX}final_approve:${sessionId}`)
    .text("\u270F\uFE0F Override", `${ORCH_CB_PREFIX}final_override:${sessionId}`)
    .row()
    .text("\u{1F504} Retry Failed", `${ORCH_CB_PREFIX}final_retry:${sessionId}`)
    .text("\u274C Discard", `${ORCH_CB_PREFIX}final_discard:${sessionId}`);
}

/**
 * Parse a finalizer callback action.
 * Callbacks: final_approve, final_override, final_retry, final_discard
 */
export type FinalAction = "final_approve" | "final_override" | "final_retry" | "final_discard";

export function parseFinalCallback(data: string): { action: FinalAction; sessionId: string } | null {
  if (!data.startsWith(ORCH_CB_PREFIX)) return null;
  const rest = data.slice(ORCH_CB_PREFIX.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx < 0) return null;

  const action = rest.slice(0, colonIdx);
  const sessionId = rest.slice(colonIdx + 1);

  const validActions: FinalAction[] = ["final_approve", "final_override", "final_retry", "final_discard"];
  if (!validActions.includes(action as FinalAction)) return null;

  return { action: action as FinalAction, sessionId };
}

/**
 * Handle a finalizer callback action.
 * Returns a description of what happened for CC display.
 */
export function handleFinalAction(
  db: Database,
  action: FinalAction,
  sessionId: string,
): { message: string; sessionCompleted: boolean } {
  switch (action) {
    case "final_approve": {
      const { archivedCount } = completeSession(db, sessionId, true);
      return {
        message: `\u2705 Session approved and archived (${archivedCount} records archived)`,
        sessionCompleted: true,
      };
    }
    case "final_override": {
      // Mark done without archiving — user wants to keep records visible
      completeSession(db, sessionId, false);
      return {
        message: "\u270F\uFE0F Session marked complete (records preserved for manual review)",
        sessionCompleted: true,
      };
    }
    case "final_retry": {
      // Reset failed tasks to pending for re-execution
      const resetCount = db.run(
        "UPDATE bb_records SET status = 'pending', updated_at = datetime('now') WHERE session_id = ? AND space = 'tasks' AND status = 'failed'",
        [sessionId],
      ).changes;
      // Return session to active
      updateSessionStatus(db, sessionId, "active");
      return {
        message: `\u{1F504} ${resetCount} failed task(s) reset — session re-activated`,
        sessionCompleted: false,
      };
    }
    case "final_discard": {
      updateSessionStatus(db, sessionId, "cancelled");
      return {
        message: "\u274C Session discarded — all results abandoned",
        sessionCompleted: true,
      };
    }
  }
}

// ── P5.4: CC Progress Dashboard ──────────────────────────────────────────────

/** Last update timestamps per session — prevents spamming CC */
const lastProgressUpdate = new Map<string, number>();

export interface ProgressSnapshot {
  sessionId: string;
  status: BbSession["status"];
  round: number;
  maxRounds: number;
  tasksPending: number;
  tasksActive: number;
  tasksDone: number;
  tasksFailed: number;
  artifactCount: number;
  reviewCount: number;
  openConflicts: number;
  /** Formatted text for CC message */
  text: string;
}

/**
 * Build a progress snapshot for the given session.
 * Returns null if throttled (last update was less than PROGRESS_THROTTLE_MS ago).
 *
 * O(n) over session records — single pass.
 */
export function buildProgressSnapshot(
  db: Database,
  sessionId: string,
  force: boolean = false,
): ProgressSnapshot | null {
  // Throttle check
  if (!force) {
    const lastUpdate = lastProgressUpdate.get(sessionId);
    if (lastUpdate && Date.now() - lastUpdate < PROGRESS_THROTTLE_MS) return null;
  }

  const session = getSession(db, sessionId);
  if (!session) return null;

  const records = getRecords(db, sessionId);

  // Single-pass counters
  let tasksPending = 0, tasksActive = 0, tasksDone = 0, tasksFailed = 0;
  let artifactCount = 0, reviewCount = 0, openConflicts = 0;

  for (const r of records) {
    switch (r.space) {
      case "tasks":
        if (r.status === "pending") tasksPending++;
        else if (r.status === "active") tasksActive++;
        else if (r.status === "done") tasksDone++;
        else if (r.status === "failed") tasksFailed++;
        break;
      case "artifacts":
        if (r.status !== "superseded" && r.status !== "archived") artifactCount++;
        break;
      case "reviews":
        reviewCount++;
        break;
      case "conflicts":
        if (r.status === "pending") openConflicts++;
        break;
    }
  }

  const totalTasks = tasksPending + tasksActive + tasksDone + tasksFailed;

  // Build progress bar
  const doneRatio = totalTasks > 0 ? tasksDone / totalTasks : 0;
  const barLen = 10;
  const filled = Math.round(doneRatio * barLen);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);

  const statusIcon = session.status === "active" ? "\u{1F504}"
    : session.status === "finalizing" ? "\u{1F4CB}"
    : session.status === "done" ? "\u2705"
    : "\u274C";

  const lines = [
    `${statusIcon} Progress — Round ${session.current_round}/${session.max_rounds}`,
    `[${bar}] ${tasksDone}/${totalTasks} tasks`,
  ];

  if (tasksActive > 0) lines.push(`\u{1F3C3} ${tasksActive} in progress`);
  if (tasksFailed > 0) lines.push(`\u274C ${tasksFailed} failed`);
  if (artifactCount > 0) lines.push(`\u{1F4C4} ${artifactCount} artifacts`);
  if (reviewCount > 0) lines.push(`\u{1F50D} ${reviewCount} reviews`);
  if (openConflicts > 0) lines.push(`\u26A0\uFE0F ${openConflicts} open conflict(s)`);

  lastProgressUpdate.set(sessionId, Date.now());

  return {
    sessionId,
    status: session.status,
    round: session.current_round,
    maxRounds: session.max_rounds,
    tasksPending,
    tasksActive,
    tasksDone,
    tasksFailed,
    artifactCount,
    reviewCount,
    openConflicts,
    text: lines.join("\n"),
  };
}

/**
 * Clear the progress throttle for a session (useful for testing).
 */
export function clearProgressThrottle(sessionId?: string): void {
  if (sessionId) {
    lastProgressUpdate.delete(sessionId);
  } else {
    lastProgressUpdate.clear();
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

export { STALE_HOURS, MAX_ARTIFACT_BODY, PROGRESS_THROTTLE_MS };
