/**
 * Response Aggregator
 *
 * Reads completed board records and produces a structured summary
 * for the Command Center. Does NOT call an LLM — the CC handler
 * can optionally pass the summary to Haiku for natural-language polish.
 */

import type { Database } from "bun:sqlite";
import type { BbRecord, BbTaskContent, BbArtifactContent } from "./types.ts";

export interface AggregatedResult {
  sessionId: string;
  taskCount: number;
  completedCount: number;
  failedCount: number;
  artifacts: Array<{ producer: string; summary: string; artifactPath?: string }>;
  /** Pre-formatted summary text for CC */
  summaryText: string;
}

export function aggregateResults(db: Database, sessionId: string): AggregatedResult {
  const taskRecords = db
    .query("SELECT * FROM bb_records WHERE session_id = ? AND space = 'tasks' ORDER BY created_at")
    .all(sessionId) as BbRecord[];

  const artifactRecords = db
    .query("SELECT * FROM bb_records WHERE session_id = ? AND space = 'artifacts' ORDER BY created_at")
    .all(sessionId) as BbRecord[];

  const completedCount = taskRecords.filter((t) => t.status === "done").length;
  const failedCount = taskRecords.filter((t) => t.status === "failed").length;

  const artifacts = artifactRecords.map((a) => {
    const content = JSON.parse(a.content) as BbArtifactContent;
    return {
      producer: a.producer ?? "unknown",
      summary: content.summary ?? "",
      artifactPath: content.artifactPath,
    };
  });

  // Build summary text
  const lines: string[] = [];
  lines.push(`📋 DISPATCH COMPLETE (${completedCount}/${taskRecords.length} tasks done)`);
  if (failedCount > 0) lines.push(`❌ ${failedCount} task(s) failed`);

  for (const task of taskRecords) {
    const content = JSON.parse(task.content) as BbTaskContent;
    const icon = task.status === "done" ? "✅" : task.status === "failed" ? "❌" : "⏳";
    lines.push(`${icon} ${content.agentId}: ${content.taskDescription?.slice(0, 80)}`);
  }

  if (artifacts.length > 0) {
    lines.push("");
    lines.push("Key findings:");
    for (const a of artifacts) {
      lines.push(`• ${a.producer}: ${a.summary.slice(0, 120)}`);
    }
  }

  return {
    sessionId,
    taskCount: taskRecords.length,
    completedCount,
    failedCount,
    artifacts,
    summaryText: lines.join("\n"),
  };
}
