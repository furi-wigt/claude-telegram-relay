/**
 * Review & Critique Loop (Phase 4)
 *
 * Handles the full review lifecycle:
 *   1. Reviewer invocation — code-quality-coach reviews artifacts
 *   2. Revision loop — original agent gets feedback, max 3 iterations
 *   3. Security review gate — infra/code artifacts → security-compliance
 *   4. Conflict resolution — evidence-first, then human escalation
 *
 * Pure logic module — no Telegram/Bot dependency. Returns actions for the caller to execute.
 */

import type { Database } from "bun:sqlite";
import { InlineKeyboard } from "grammy";
import type {
  BbRecord,
  BbReviewContent,
  BbArtifactContent,
  BbConflictContent,
  AgentTrigger,
} from "./types.ts";
import {
  writeRecord,
  getRecord,
  getRecordsBySpace,
  updateRecordStatus,
} from "./blackboard.ts";
import { ORCH_CB_PREFIX } from "./interruptProtocol.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_REVISION_ITERATIONS = 3;
const REVIEWER_AGENT = "code-quality-coach";
const SECURITY_AGENT = "security-compliance";

/** Artifact types that require security review */
const SECURITY_REVIEW_TYPES = new Set([
  "infrastructure",
  "code",
  "cloud",
  "deployment",
  "network",
  "iam",
  "security",
]);

// ── P4.1: Review trigger + reviewer invocation ─────────────────────────────────

export interface ReviewRequest {
  sessionId: string;
  artifactRecordId: string;
  reviewerAgent: string;
  prompt: string;
  round: number;
}

/**
 * Build a review request for an unreviewed artifact.
 * Returns null if the artifact already has a review or doesn't exist.
 */
export function buildReviewRequest(
  db: Database,
  sessionId: string,
  artifactRecordId: string,
  round: number,
): ReviewRequest | null {
  const artifact = getRecord(db, artifactRecordId);
  if (!artifact || artifact.space !== "artifacts" || artifact.status === "archived") {
    return null;
  }

  // Check if already reviewed
  const reviews = getRecordsBySpace(db, sessionId, "reviews");
  const hasReview = reviews.some((r) => {
    const content = JSON.parse(r.content) as BbReviewContent;
    return content.targetRecordId === artifactRecordId;
  });
  if (hasReview) return null;

  const artifactContent = JSON.parse(artifact.content) as BbArtifactContent;
  const prompt = buildReviewPrompt(artifact, artifactContent);

  return {
    sessionId,
    artifactRecordId,
    reviewerAgent: REVIEWER_AGENT,
    prompt,
    round,
  };
}

/** Build a review prompt from an artifact record */
function buildReviewPrompt(artifact: BbRecord, content: BbArtifactContent): string {
  const body = content.fullResponse ?? content.summary;
  return [
    `Review this artifact from ${artifact.producer ?? "unknown agent"}.`,
    ``,
    `Artifact summary: ${content.summary}`,
    ``,
    body.length > 2000 ? body.slice(0, 2000) + "\n...(truncated)" : body,
    ``,
    `Evaluate for:`,
    `1. Correctness — does it accurately address the task?`,
    `2. Completeness — are all requirements covered?`,
    `3. Quality — is it well-structured and clear?`,
    ``,
    `Respond with your verdict: APPROVED, REVISION_NEEDED, or REJECTED.`,
    `Include specific feedback for any issues found.`,
  ].join("\n");
}

/**
 * Record a review verdict on the blackboard.
 * Returns the created review record.
 */
export function recordReviewVerdict(
  db: Database,
  opts: {
    sessionId: string;
    targetRecordId: string;
    reviewerAgent: string;
    verdict: "approved" | "revision_needed" | "rejected";
    feedback: string;
    iteration: number;
    round: number;
  },
): BbRecord {
  const reviewContent: BbReviewContent = {
    verdict: opts.verdict,
    targetRecordId: opts.targetRecordId,
    feedback: opts.feedback,
    iteration: opts.iteration,
  };

  const record = writeRecord(db, {
    sessionId: opts.sessionId,
    space: "reviews",
    recordType: "review",
    producer: opts.reviewerAgent,
    content: reviewContent as unknown as Record<string, unknown>,
    parentId: opts.targetRecordId,
    round: opts.round,
  });

  // Update artifact status based on verdict
  if (opts.verdict === "approved") {
    updateRecordStatus(db, opts.targetRecordId, "done");
  }
  // revision_needed and rejected leave artifact as pending for re-processing

  return record;
}

// ── P4.2: Revision loop ────────────────────────────────────────────────────────

export interface RevisionRequest {
  sessionId: string;
  artifactRecordId: string;
  originalAgent: string;
  feedback: string;
  iteration: number;
  round: number;
  prompt: string;
}

export interface EscalationRequest {
  sessionId: string;
  artifactRecordId: string;
  lastFeedback: string;
  iteration: number;
}

export type RevisionResult =
  | { action: "revise"; request: RevisionRequest }
  | { action: "escalate"; request: EscalationRequest };

/**
 * Determine the next action after a review verdict of revision_needed or rejected.
 *
 * - If iteration < MAX_REVISION_ITERATIONS → revise (re-activate original agent)
 * - If iteration >= MAX_REVISION_ITERATIONS → escalate to human
 */
export function handleRevisionNeeded(
  db: Database,
  sessionId: string,
  artifactRecordId: string,
  feedback: string,
  iteration: number,
  round: number,
): RevisionResult {
  if (iteration >= MAX_REVISION_ITERATIONS) {
    return {
      action: "escalate",
      request: {
        sessionId,
        artifactRecordId,
        lastFeedback: feedback,
        iteration,
      },
    };
  }

  const artifact = getRecord(db, artifactRecordId);
  if (!artifact) {
    return {
      action: "escalate",
      request: { sessionId, artifactRecordId, lastFeedback: feedback, iteration },
    };
  }

  const artifactContent = JSON.parse(artifact.content) as BbArtifactContent;
  const prompt = buildRevisionPrompt(artifactContent, feedback, iteration);

  return {
    action: "revise",
    request: {
      sessionId,
      artifactRecordId,
      originalAgent: artifact.producer ?? "operations-hub",
      feedback,
      iteration: iteration + 1,
      round,
      prompt,
    },
  };
}

/** Build a revision prompt with previous feedback */
function buildRevisionPrompt(
  content: BbArtifactContent,
  feedback: string,
  iteration: number,
): string {
  return [
    `Your previous artifact (iteration ${iteration}) received feedback and needs revision.`,
    ``,
    `Previous output summary: ${content.summary}`,
    ``,
    `Reviewer feedback:`,
    feedback,
    ``,
    `Please address all feedback points and produce an improved version.`,
    `This is revision ${iteration + 1} of ${MAX_REVISION_ITERATIONS}.`,
  ].join("\n");
}

/**
 * Record a revised artifact on the blackboard (supersedes the previous version).
 */
export function recordRevisedArtifact(
  db: Database,
  opts: {
    sessionId: string;
    previousArtifactId: string;
    producer: string;
    summary: string;
    fullResponse: string;
    round: number;
  },
): BbRecord {
  // Mark previous as superseded
  updateRecordStatus(db, opts.previousArtifactId, "superseded");

  return writeRecord(db, {
    sessionId: opts.sessionId,
    space: "artifacts",
    recordType: "artifact",
    producer: opts.producer,
    content: {
      summary: opts.summary,
      fullResponse: opts.fullResponse,
    } as unknown as Record<string, unknown>,
    supersedes: opts.previousArtifactId,
    round: opts.round,
  });
}

// ── P4.3: Security review gate ─────────────────────────────────────────────────

/**
 * Determine whether an artifact needs security review based on its content/producer.
 *
 * Returns a ReviewRequest for security-compliance if needed, null otherwise.
 */
export function checkSecurityReviewNeeded(
  db: Database,
  sessionId: string,
  artifactRecordId: string,
  round: number,
): ReviewRequest | null {
  const artifact = getRecord(db, artifactRecordId);
  if (!artifact || artifact.status === "archived") return null;

  const artifactContent = JSON.parse(artifact.content) as BbArtifactContent;
  const needsSecurity = isSecurityRelevant(artifact, artifactContent);
  if (!needsSecurity) return null;

  // Check if already has a security review
  const reviews = getRecordsBySpace(db, sessionId, "reviews");
  const hasSecurityReview = reviews.some((r) => {
    const content = JSON.parse(r.content) as BbReviewContent;
    return content.targetRecordId === artifactRecordId && r.producer === SECURITY_AGENT;
  });
  if (hasSecurityReview) return null;

  const prompt = buildSecurityReviewPrompt(artifact, artifactContent);

  return {
    sessionId,
    artifactRecordId,
    reviewerAgent: SECURITY_AGENT,
    prompt,
    round,
  };
}

/** Check if an artifact is security-relevant based on producer or content signals */
function isSecurityRelevant(artifact: BbRecord, content: BbArtifactContent): boolean {
  // Producer-based: cloud-architect and engineering produce infra/code artifacts
  const securityProducers = new Set(["cloud-architect", "engineering"]);
  if (artifact.producer && securityProducers.has(artifact.producer)) return true;

  // Content-based: check summary for security-relevant keywords
  const summary = (content.summary ?? "").toLowerCase();
  const fullText = (content.fullResponse ?? "").toLowerCase();
  const text = summary + " " + fullText.slice(0, 500);

  for (const keyword of SECURITY_REVIEW_TYPES) {
    if (text.includes(keyword)) return true;
  }

  return false;
}

/** Build a security review prompt */
function buildSecurityReviewPrompt(artifact: BbRecord, content: BbArtifactContent): string {
  const body = content.fullResponse ?? content.summary;
  return [
    `Security review requested for artifact from ${artifact.producer ?? "unknown"}.`,
    ``,
    `Artifact: ${content.summary}`,
    ``,
    body.length > 2000 ? body.slice(0, 2000) + "\n...(truncated)" : body,
    ``,
    `Evaluate for:`,
    `1. IM8 compliance — any violations?`,
    `2. PDPA considerations — personal data handling?`,
    `3. Infrastructure security — misconfigurations, exposed secrets, overly permissive IAM?`,
    `4. Code security — injection, XSS, SSRF, insecure defaults?`,
    ``,
    `Respond with: APPROVED, REVISION_NEEDED, or REJECTED with specific findings.`,
  ].join("\n");
}

// ── P4.4: Conflict resolution ──────────────────────────────────────────────────

export interface ConflictCase {
  sessionId: string;
  conflictRecordId: string;
  agents: string[];
  relatedRecords: string[];
  evidence: BbRecord[];
}

/**
 * Raise a conflict when two agents produce contradictory recommendations.
 * Returns the conflict record ID.
 */
export function raiseConflict(
  db: Database,
  opts: {
    sessionId: string;
    agents: string[];
    relatedRecordIds: string[];
    round: number;
  },
): BbRecord {
  const conflictContent: BbConflictContent = {
    type: "recommendation_conflict",
    agents: opts.agents,
    relatedRecords: opts.relatedRecordIds,
    resolutionPolicy: "evidence_then_arbitration",
  };

  return writeRecord(db, {
    sessionId: opts.sessionId,
    space: "conflicts",
    recordType: "conflict",
    producer: "control-plane",
    content: conflictContent as unknown as Record<string, unknown>,
    round: opts.round,
  });
}

/**
 * Build a conflict case for human resolution.
 * Gathers evidence records related to the conflicting agents.
 */
export function buildConflictCase(
  db: Database,
  sessionId: string,
  conflictRecordId: string,
): ConflictCase | null {
  const conflict = getRecord(db, conflictRecordId);
  if (!conflict || conflict.space !== "conflicts") return null;

  const conflictContent = JSON.parse(conflict.content) as BbConflictContent;

  // Gather evidence from the conflicting agents
  const evidence = getRecordsBySpace(db, sessionId, "evidence").filter(
    (r) => r.producer && conflictContent.agents.includes(r.producer),
  );

  // Also include the related artifact/decision records
  const relatedRecords = conflictContent.relatedRecords
    .map((id) => getRecord(db, id))
    .filter((r): r is BbRecord => r !== null);

  return {
    sessionId,
    conflictRecordId,
    agents: conflictContent.agents,
    relatedRecords: conflictContent.relatedRecords,
    evidence: [...evidence, ...relatedRecords],
  };
}

/**
 * Build the conflict resolution keyboard for CC.
 * Buttons: [Keep A] [Keep B] [Neither]
 */
export function buildConflictKeyboard(
  conflictRecordId: string,
  agentA: string,
  agentB: string,
): InlineKeyboard {
  return new InlineKeyboard()
    .text(`\u2705 Keep ${agentA}`, `${ORCH_CB_PREFIX}conflict_keep:${conflictRecordId}:${agentA}`)
    .text(`\u2705 Keep ${agentB}`, `${ORCH_CB_PREFIX}conflict_keep:${conflictRecordId}:${agentB}`)
    .row()
    .text("\u274C Neither — escalate", `${ORCH_CB_PREFIX}conflict_neither:${conflictRecordId}`);
}

/**
 * Resolve a conflict by picking a winner or escalating.
 */
export function resolveConflict(
  db: Database,
  conflictRecordId: string,
  resolution: "keep_a" | "keep_b" | "neither",
  winnerAgent?: string,
): void {
  const conflict = getRecord(db, conflictRecordId);
  if (!conflict) return;

  const content = JSON.parse(conflict.content) as BbConflictContent;
  content.resolution =
    resolution === "neither"
      ? "Escalated — neither recommendation accepted"
      : `Resolved: ${winnerAgent}'s recommendation accepted`;

  db.run(
    "UPDATE bb_records SET content = ?, status = 'done', updated_at = datetime('now') WHERE id = ?",
    [JSON.stringify(content), conflictRecordId],
  );

  // If a winner was picked, mark the loser's related artifacts as superseded
  if (resolution !== "neither" && winnerAgent) {
    const loserAgent = content.agents.find((a) => a !== winnerAgent);
    if (loserAgent) {
      const artifacts = getRecordsBySpace(db, conflict.session_id, "artifacts");
      for (const art of artifacts) {
        if (art.producer === loserAgent && content.relatedRecords.includes(art.id) && art.status === "pending") {
          updateRecordStatus(db, art.id, "superseded");
        }
      }
    }
  }
}

/**
 * Build the escalation keyboard for when max revisions are reached.
 * Buttons: [Accept Anyway] [Override] [Cancel Task]
 */
export function buildEscalationKeyboard(artifactRecordId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("\u2705 Accept Anyway", `${ORCH_CB_PREFIX}escalate_accept:${artifactRecordId}`)
    .text("\u270F\uFE0F Override", `${ORCH_CB_PREFIX}escalate_override:${artifactRecordId}`)
    .row()
    .text("\u274C Cancel Task", `${ORCH_CB_PREFIX}escalate_cancel:${artifactRecordId}`);
}

/**
 * Format a conflict case for display in CC.
 */
export function formatConflictSummary(conflictCase: ConflictCase): string {
  const lines = [
    `\u26A0\uFE0F CONFLICT DETECTED`,
    ``,
    `Agents: ${conflictCase.agents.join(" vs ")}`,
    `Related records: ${conflictCase.relatedRecords.length}`,
    `Evidence: ${conflictCase.evidence.length} items`,
    ``,
  ];

  for (const ev of conflictCase.evidence.slice(0, 5)) {
    const content = JSON.parse(ev.content);
    const summary = content.summary ?? content.message ?? "(no summary)";
    lines.push(`  \u2022 [${ev.producer}] ${String(summary).slice(0, 100)}`);
  }

  if (conflictCase.evidence.length > 5) {
    lines.push(`  ... and ${conflictCase.evidence.length - 5} more`);
  }

  return lines.join("\n");
}

/**
 * Format an escalation message for when max revision iterations are reached.
 */
export function formatEscalationMessage(
  artifactRecordId: string,
  lastFeedback: string,
  iteration: number,
): string {
  return [
    `\u{1F6A8} ESCALATION — Max revisions reached (${iteration}/${MAX_REVISION_ITERATIONS})`,
    ``,
    `Artifact: ${artifactRecordId.slice(0, 8)}...`,
    ``,
    `Last reviewer feedback:`,
    lastFeedback.length > 300 ? lastFeedback.slice(0, 297) + "..." : lastFeedback,
    ``,
    `Choose an action:`,
  ].join("\n");
}

// ── Exports for control plane integration ──────────────────────────────────────

export { MAX_REVISION_ITERATIONS, REVIEWER_AGENT, SECURITY_AGENT, SECURITY_REVIEW_TYPES };
