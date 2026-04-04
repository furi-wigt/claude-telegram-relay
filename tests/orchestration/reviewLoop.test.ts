/**
 * P4 Review & Critique Loop Tests
 *
 * Tests for:
 * - P4.1: Review trigger — buildReviewRequest, recordReviewVerdict
 * - P4.2: Revision loop — handleRevisionNeeded, recordRevisedArtifact
 * - P4.3: Security review gate — checkSecurityReviewNeeded
 * - P4.4: Conflict resolution — raiseConflict, buildConflictCase, resolveConflict
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initBlackboardSchema } from "../../src/orchestration/blackboardSchema";
import { createSession, writeRecord, getRecord, getRecordsBySpace, updateRecordStatus } from "../../src/orchestration/blackboard";
import {
  buildReviewRequest,
  recordReviewVerdict,
  handleRevisionNeeded,
  recordRevisedArtifact,
  checkSecurityReviewNeeded,
  raiseConflict,
  buildConflictCase,
  buildConflictKeyboard,
  resolveConflict,
  buildEscalationKeyboard,
  formatConflictSummary,
  formatEscalationMessage,
  MAX_REVISION_ITERATIONS,
  REVIEWER_AGENT,
  SECURITY_AGENT,
} from "../../src/orchestration/reviewLoop";
import type { BbReviewContent, BbConflictContent, BbRecord } from "../../src/orchestration/types";

let db: Database;
let sessionId: string;

function freshDb(): Database {
  const d = new Database(":memory:");
  initBlackboardSchema(d);
  return d;
}

function createArtifact(
  producer: string,
  summary: string,
  fullResponse?: string,
  round = 1,
): BbRecord {
  return writeRecord(db, {
    sessionId,
    space: "artifacts",
    recordType: "artifact",
    producer,
    content: {
      summary,
      fullResponse: fullResponse ?? `Full response for: ${summary}`,
    },
    round,
  });
}

beforeEach(() => {
  db = freshDb();
  const session = createSession(db, { dispatchId: "d-test", workflow: "default" });
  sessionId = session.id;
});

// ── P4.1: Review trigger + reviewer invocation ─────────────────────────────────

describe("P4.1 — buildReviewRequest", () => {
  it("builds review request for unreviewed artifact", () => {
    const artifact = createArtifact("strategy-comms", "Meeting deck draft");
    const req = buildReviewRequest(db, sessionId, artifact.id, 1);

    expect(req).not.toBeNull();
    expect(req!.artifactRecordId).toBe(artifact.id);
    expect(req!.reviewerAgent).toBe(REVIEWER_AGENT);
    expect(req!.prompt).toContain("strategy-comms");
    expect(req!.prompt).toContain("Meeting deck draft");
  });

  it("returns null for already-reviewed artifact", () => {
    const artifact = createArtifact("engineering", "Code patch");
    // Write a review
    recordReviewVerdict(db, {
      sessionId,
      targetRecordId: artifact.id,
      reviewerAgent: REVIEWER_AGENT,
      verdict: "approved",
      feedback: "Looks good",
      iteration: 1,
      round: 1,
    });

    const req = buildReviewRequest(db, sessionId, artifact.id, 2);
    expect(req).toBeNull();
  });

  it("returns null for non-existent artifact", () => {
    const req = buildReviewRequest(db, sessionId, "nonexistent-id", 1);
    expect(req).toBeNull();
  });

  it("returns null for archived artifact", () => {
    const artifact = createArtifact("engineering", "Old patch");
    updateRecordStatus(db, artifact.id, "archived");
    const req = buildReviewRequest(db, sessionId, artifact.id, 1);
    expect(req).toBeNull();
  });
});

describe("P4.1 — recordReviewVerdict", () => {
  it("creates review record with approved verdict", () => {
    const artifact = createArtifact("engineering", "API endpoint");
    const review = recordReviewVerdict(db, {
      sessionId,
      targetRecordId: artifact.id,
      reviewerAgent: REVIEWER_AGENT,
      verdict: "approved",
      feedback: "Clean implementation",
      iteration: 1,
      round: 1,
    });

    expect(review.space).toBe("reviews");
    expect(review.producer).toBe(REVIEWER_AGENT);
    const content = JSON.parse(review.content) as BbReviewContent;
    expect(content.verdict).toBe("approved");
    expect(content.targetRecordId).toBe(artifact.id);

    // Artifact should be marked done
    const updated = getRecord(db, artifact.id)!;
    expect(updated.status).toBe("done");
  });

  it("creates review record with revision_needed — artifact stays pending", () => {
    const artifact = createArtifact("strategy-comms", "Draft deck");
    recordReviewVerdict(db, {
      sessionId,
      targetRecordId: artifact.id,
      reviewerAgent: REVIEWER_AGENT,
      verdict: "revision_needed",
      feedback: "Missing executive summary",
      iteration: 1,
      round: 1,
    });

    const updated = getRecord(db, artifact.id)!;
    expect(updated.status).toBe("pending");
  });
});

// ── P4.2: Revision loop ────────────────────────────────────────────────────────

describe("P4.2 — handleRevisionNeeded", () => {
  it("returns revise action when under max iterations", () => {
    const artifact = createArtifact("engineering", "v1 code patch");
    const result = handleRevisionNeeded(db, sessionId, artifact.id, "Fix the error handling", 1, 2);

    expect(result.action).toBe("revise");
    if (result.action === "revise") {
      expect(result.request.originalAgent).toBe("engineering");
      expect(result.request.iteration).toBe(2);
      expect(result.request.prompt).toContain("revision");
      expect(result.request.prompt).toContain("Fix the error handling");
    }
  });

  it("returns escalate action at max iterations", () => {
    const artifact = createArtifact("engineering", "v3 still bad");
    const result = handleRevisionNeeded(db, sessionId, artifact.id, "Still wrong", MAX_REVISION_ITERATIONS, 3);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") {
      expect(result.request.iteration).toBe(MAX_REVISION_ITERATIONS);
      expect(result.request.lastFeedback).toBe("Still wrong");
    }
  });

  it("returns escalate for nonexistent artifact", () => {
    const result = handleRevisionNeeded(db, sessionId, "ghost-id", "feedback", 1, 1);
    expect(result.action).toBe("escalate");
  });
});

describe("P4.2 — recordRevisedArtifact", () => {
  it("creates new artifact superseding the old one", () => {
    const v1 = createArtifact("engineering", "v1 endpoint");
    const v2 = recordRevisedArtifact(db, {
      sessionId,
      previousArtifactId: v1.id,
      producer: "engineering",
      summary: "v2 endpoint — fixed error handling",
      fullResponse: "Full v2 response",
      round: 2,
    });

    // v1 superseded
    const old = getRecord(db, v1.id)!;
    expect(old.status).toBe("superseded");

    // v2 links back
    expect(v2.supersedes).toBe(v1.id);
    expect(v2.status).toBe("pending");
    const content = JSON.parse(v2.content);
    expect(content.summary).toContain("v2");
  });

  it("two-iteration cycle: v1 → review → v2 → approved", () => {
    const v1 = createArtifact("engineering", "v1");

    // Review v1 — revision needed
    recordReviewVerdict(db, {
      sessionId,
      targetRecordId: v1.id,
      reviewerAgent: REVIEWER_AGENT,
      verdict: "revision_needed",
      feedback: "Missing tests",
      iteration: 1,
      round: 1,
    });

    // Produce v2
    const v2 = recordRevisedArtifact(db, {
      sessionId,
      previousArtifactId: v1.id,
      producer: "engineering",
      summary: "v2 — with tests",
      fullResponse: "Full v2",
      round: 2,
    });

    // Review v2 — approved
    recordReviewVerdict(db, {
      sessionId,
      targetRecordId: v2.id,
      reviewerAgent: REVIEWER_AGENT,
      verdict: "approved",
      feedback: "Tests added, looks good",
      iteration: 2,
      round: 2,
    });

    expect(getRecord(db, v1.id)!.status).toBe("superseded");
    expect(getRecord(db, v2.id)!.status).toBe("done");
  });

  it("three-rejection escalation", () => {
    let currentArtifact = createArtifact("engineering", "v1");

    for (let i = 1; i <= MAX_REVISION_ITERATIONS; i++) {
      recordReviewVerdict(db, {
        sessionId,
        targetRecordId: currentArtifact.id,
        reviewerAgent: REVIEWER_AGENT,
        verdict: "revision_needed",
        feedback: `Issue #${i}`,
        iteration: i,
        round: i,
      });

      const result = handleRevisionNeeded(db, sessionId, currentArtifact.id, `Issue #${i}`, i, i);
      if (result.action === "escalate") {
        expect(i).toBe(MAX_REVISION_ITERATIONS);
        break;
      }

      currentArtifact = recordRevisedArtifact(db, {
        sessionId,
        previousArtifactId: currentArtifact.id,
        producer: "engineering",
        summary: `v${i + 1}`,
        fullResponse: `Full v${i + 1}`,
        round: i + 1,
      });
    }
  });
});

// ── P4.3: Security review gate ─────────────────────────────────────────────────

describe("P4.3 — checkSecurityReviewNeeded", () => {
  it("triggers security review for cloud-architect artifacts", () => {
    const artifact = createArtifact("cloud-architect", "CDK stack for VPC");
    const req = checkSecurityReviewNeeded(db, sessionId, artifact.id, 1);

    expect(req).not.toBeNull();
    expect(req!.reviewerAgent).toBe(SECURITY_AGENT);
    expect(req!.prompt).toContain("IM8 compliance");
  });

  it("triggers security review for engineering artifacts", () => {
    const artifact = createArtifact("engineering", "API endpoint code");
    const req = checkSecurityReviewNeeded(db, sessionId, artifact.id, 1);

    expect(req).not.toBeNull();
    expect(req!.reviewerAgent).toBe(SECURITY_AGENT);
  });

  it("does NOT trigger for strategy-comms docs artifact", () => {
    const artifact = createArtifact("strategy-comms", "Meeting agenda and talking points");
    const req = checkSecurityReviewNeeded(db, sessionId, artifact.id, 1);

    expect(req).toBeNull();
  });

  it("does NOT trigger for operations-hub general artifact", () => {
    const artifact = createArtifact("operations-hub", "Task prioritization list for the week");
    const req = checkSecurityReviewNeeded(db, sessionId, artifact.id, 1);

    expect(req).toBeNull();
  });

  it("triggers for artifact with security keyword in content", () => {
    const artifact = createArtifact(
      "strategy-comms",
      "Infrastructure migration plan",
      "Full plan for infrastructure migration to new VPC",
    );
    const req = checkSecurityReviewNeeded(db, sessionId, artifact.id, 1);

    expect(req).not.toBeNull();
  });

  it("does NOT trigger if already has security review", () => {
    const artifact = createArtifact("cloud-architect", "CDK stack");
    // Add a security review
    recordReviewVerdict(db, {
      sessionId,
      targetRecordId: artifact.id,
      reviewerAgent: SECURITY_AGENT,
      verdict: "approved",
      feedback: "Compliant",
      iteration: 1,
      round: 1,
    });

    const req = checkSecurityReviewNeeded(db, sessionId, artifact.id, 2);
    expect(req).toBeNull();
  });
});

// ── P4.4: Conflict resolution ──────────────────────────────────────────────────

describe("P4.4 — raiseConflict", () => {
  it("creates conflict record on the board", () => {
    const a1 = createArtifact("cloud-architect", "Use ECS");
    const a2 = createArtifact("engineering", "Use Lambda");

    const conflict = raiseConflict(db, {
      sessionId,
      agents: ["cloud-architect", "engineering"],
      relatedRecordIds: [a1.id, a2.id],
      round: 1,
    });

    expect(conflict.space).toBe("conflicts");
    const content = JSON.parse(conflict.content) as BbConflictContent;
    expect(content.agents).toEqual(["cloud-architect", "engineering"]);
    expect(content.relatedRecords).toHaveLength(2);
    expect(content.resolutionPolicy).toBe("evidence_then_arbitration");
  });
});

describe("P4.4 — buildConflictCase", () => {
  it("gathers evidence from conflicting agents", () => {
    // Add some evidence from both agents
    writeRecord(db, {
      sessionId,
      space: "evidence",
      recordType: "finding",
      producer: "cloud-architect",
      content: { summary: "ECS provides better cost control" },
      round: 1,
    });
    writeRecord(db, {
      sessionId,
      space: "evidence",
      recordType: "finding",
      producer: "engineering",
      content: { summary: "Lambda reduces operational overhead" },
      round: 1,
    });

    const a1 = createArtifact("cloud-architect", "ECS recommendation");
    const a2 = createArtifact("engineering", "Lambda recommendation");

    const conflict = raiseConflict(db, {
      sessionId,
      agents: ["cloud-architect", "engineering"],
      relatedRecordIds: [a1.id, a2.id],
      round: 1,
    });

    const conflictCase = buildConflictCase(db, sessionId, conflict.id);
    expect(conflictCase).not.toBeNull();
    expect(conflictCase!.agents).toEqual(["cloud-architect", "engineering"]);
    // 2 evidence + 2 artifacts
    expect(conflictCase!.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it("returns null for nonexistent conflict", () => {
    expect(buildConflictCase(db, sessionId, "ghost")).toBeNull();
  });
});

describe("P4.4 — resolveConflict", () => {
  it("resolves conflict by picking a winner", () => {
    const a1 = createArtifact("cloud-architect", "ECS");
    const a2 = createArtifact("engineering", "Lambda");

    const conflict = raiseConflict(db, {
      sessionId,
      agents: ["cloud-architect", "engineering"],
      relatedRecordIds: [a1.id, a2.id],
      round: 1,
    });

    resolveConflict(db, conflict.id, "keep_a", "cloud-architect");

    const resolved = getRecord(db, conflict.id)!;
    expect(resolved.status).toBe("done");
    const content = JSON.parse(resolved.content) as BbConflictContent;
    expect(content.resolution).toContain("cloud-architect");

    // Loser's artifact superseded
    expect(getRecord(db, a2.id)!.status).toBe("superseded");
    // Winner's artifact unchanged
    expect(getRecord(db, a1.id)!.status).toBe("pending");
  });

  it("resolves with neither — escalation", () => {
    const a1 = createArtifact("cloud-architect", "Option A");
    const a2 = createArtifact("engineering", "Option B");

    const conflict = raiseConflict(db, {
      sessionId,
      agents: ["cloud-architect", "engineering"],
      relatedRecordIds: [a1.id, a2.id],
      round: 1,
    });

    resolveConflict(db, conflict.id, "neither");

    const resolved = getRecord(db, conflict.id)!;
    expect(resolved.status).toBe("done");
    const content = JSON.parse(resolved.content) as BbConflictContent;
    expect(content.resolution).toContain("Escalated");

    // Both artifacts remain pending (neither accepted)
    expect(getRecord(db, a1.id)!.status).toBe("pending");
    expect(getRecord(db, a2.id)!.status).toBe("pending");
  });
});

describe("P4.4 — UI formatting", () => {
  it("buildConflictKeyboard has 3 buttons in 2 rows", () => {
    const kb = buildConflictKeyboard("c-1", "cloud-architect", "engineering");
    const rows = (kb as any).inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(2); // Keep A, Keep B
    expect(rows[1]).toHaveLength(1); // Neither
    expect(rows[0][0].text).toContain("cloud-architect");
    expect(rows[0][1].text).toContain("engineering");
    expect(rows[1][0].text).toContain("Neither");
  });

  it("buildEscalationKeyboard has 3 buttons", () => {
    const kb = buildEscalationKeyboard("art-1");
    const rows = (kb as any).inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
    const totalButtons = rows.reduce((sum, row) => sum + row.length, 0);
    expect(totalButtons).toBe(3);
  });

  it("formatConflictSummary includes agent names and evidence count", () => {
    const summary = formatConflictSummary({
      sessionId,
      conflictRecordId: "c-1",
      agents: ["cloud-architect", "engineering"],
      relatedRecords: ["r1", "r2"],
      evidence: [{
        id: "e1",
        session_id: sessionId,
        space: "evidence",
        record_type: "finding",
        producer: "cloud-architect",
        owner: null,
        status: "pending",
        confidence: null,
        content: JSON.stringify({ summary: "ECS is cheaper" }),
        parent_id: null,
        supersedes: null,
        round: 1,
        created_at: new Date().toISOString(),
        updated_at: null,
      }],
    });

    expect(summary).toContain("CONFLICT DETECTED");
    expect(summary).toContain("cloud-architect vs engineering");
    expect(summary).toContain("Evidence: 1 items");
  });

  it("formatEscalationMessage shows iteration count", () => {
    const msg = formatEscalationMessage("art-123", "Still broken", 3);
    expect(msg).toContain("ESCALATION");
    expect(msg).toContain("3/3");
    expect(msg).toContain("Still broken");
  });
});
