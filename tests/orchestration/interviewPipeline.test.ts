/**
 * P3 Interview Pipeline Tests
 *
 * Tests for:
 * - P3.1: InteractiveSession mode field
 * - P3.2: Interview trigger logic (shouldInterview decision)
 * - P3.3: Interview → Board decomposition
 * - P3.4: Governance keyboard and plan formatting
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { initBlackboardSchema } from "../../src/orchestration/blackboardSchema";
import {
  decomposeFromInterview,
  formatDispatchPlan,
  buildGovernanceKeyboard,
  type InterviewContext,
} from "../../src/orchestration/interviewPipeline";
import type { ClassificationResult } from "../../src/orchestration/types";
import type { InteractiveSession, SessionMode } from "../../src/interactive/types";

// ── P3.1: Session mode field ────────────────────────────────────────────────

describe("P3.1 — InteractiveSession mode", () => {
  it("plan mode session has mode='plan'", () => {
    const session: Partial<InteractiveSession> = {
      sessionId: "test-1",
      mode: "plan",
      phase: "loading",
      task: "add user auth",
    };
    expect(session.mode).toBe("plan");
  });

  it("orchestrate mode session has mode='orchestrate' with classification", () => {
    const session: Partial<InteractiveSession> = {
      sessionId: "test-2",
      mode: "orchestrate",
      phase: "loading",
      task: "prep for CityWatch meeting",
      classification: {
        intent: "meeting-prep",
        primaryAgent: "operations-hub",
        topicHint: null,
        isCompound: true,
        confidence: 0.7,
        reasoning: "Multi-step meeting prep",
      },
      threadId: 123,
    };
    expect(session.mode).toBe("orchestrate");
    expect(session.classification?.isCompound).toBe(true);
    expect(session.threadId).toBe(123);
  });

  it("mode field accepts only 'plan' or 'orchestrate'", () => {
    const validModes: SessionMode[] = ["plan", "orchestrate"];
    expect(validModes).toContain("plan");
    expect(validModes).toContain("orchestrate");
    expect(validModes).toHaveLength(2);
  });
});

// ── P3.2: Interview trigger logic ──────────────────────────────────────────

describe("P3.2 — shouldInterview decision", () => {
  // Replicate the decision logic from commandCenter.ts
  const INTERVIEW_CONFIDENCE_THRESHOLD = 0.8;
  const DEFAULT_AGENT_ID = "operations-hub";

  function shouldInterview(classification: ClassificationResult): boolean {
    return (
      classification.isCompound ||
      (classification.confidence < INTERVIEW_CONFIDENCE_THRESHOLD &&
        classification.primaryAgent !== DEFAULT_AGENT_ID)
    );
  }

  it("triggers interview for compound tasks", () => {
    expect(shouldInterview({
      intent: "meeting-prep",
      primaryAgent: "strategy-comms",
      topicHint: null,
      isCompound: true,
      confidence: 0.95,
      reasoning: "Compound task",
    })).toBe(true);
  });

  it("triggers interview for low confidence on non-default agent", () => {
    expect(shouldInterview({
      intent: "security-review",
      primaryAgent: "security-compliance",
      topicHint: null,
      isCompound: false,
      confidence: 0.65,
      reasoning: "Low confidence",
    })).toBe(true);
  });

  it("skips interview for high confidence simple task", () => {
    expect(shouldInterview({
      intent: "security-review",
      primaryAgent: "security-compliance",
      topicHint: null,
      isCompound: false,
      confidence: 0.9,
      reasoning: "Clear match",
    })).toBe(false);
  });

  it("skips interview for low confidence on default agent (ops-hub)", () => {
    expect(shouldInterview({
      intent: "general",
      primaryAgent: "operations-hub",
      topicHint: null,
      isCompound: false,
      confidence: 0.5,
      reasoning: "No match, default",
    })).toBe(false);
  });

  it("skips interview for exactly threshold confidence", () => {
    expect(shouldInterview({
      intent: "cloud-review",
      primaryAgent: "cloud-architect",
      topicHint: null,
      isCompound: false,
      confidence: 0.8, // exactly at threshold
      reasoning: "Borderline",
    })).toBe(false);
  });

  it("triggers interview for compound even when default agent", () => {
    expect(shouldInterview({
      intent: "general",
      primaryAgent: "operations-hub",
      topicHint: null,
      isCompound: true,
      confidence: 0.9,
      reasoning: "Compound general task",
    })).toBe(true);
  });
});

// ── P3.3: Interview → Board decomposition ──────────────────────────────────

describe("P3.3 — decomposeFromInterview", () => {
  const simpleCtx: InterviewContext = {
    task: "review EDEN security posture",
    completedQA: [
      { question: "Which compliance framework?", answer: "IM8 v4" },
      { question: "Scope?", answer: "Full infrastructure" },
    ],
    classification: {
      intent: "security-review",
      primaryAgent: "security-compliance",
      topicHint: null,
      isCompound: false,
      confidence: 0.7,
      reasoning: "Security review",
    },
  };

  const compoundCtx: InterviewContext = {
    task: "prep for CityWatch meeting tomorrow — need deck, security review, and cost estimate",
    completedQA: [
      { question: "Meeting audience?", answer: "CTO and CISO" },
      { question: "Key deliverables?", answer: "Deck + security report + cost analysis" },
    ],
    classification: {
      intent: "meeting-prep",
      primaryAgent: "strategy-comms",
      topicHint: null,
      isCompound: true,
      confidence: 0.75,
      reasoning: "Multi-deliverable meeting prep",
    },
  };

  it("simple task produces single task record", async () => {
    const plan = await decomposeFromInterview(simpleCtx);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].seq).toBe(1);
    expect(plan.tasks[0].agentId).toBe("security-compliance");
    expect(plan.tasks[0].taskDescription).toContain("review EDEN security posture");
    expect(plan.tasks[0].taskDescription).toContain("IM8 v4");
  });

  it("simple task produces evidence records from QA", async () => {
    const plan = await decomposeFromInterview(simpleCtx);
    expect(plan.evidence).toHaveLength(2);
    expect(plan.evidence[0].summary).toContain("IM8 v4");
    expect(plan.evidence[0].source).toBe("user-interview");
    expect(plan.evidence[0].supportsTasks).toContain(1);
  });

  it("compound task falls back to heuristic when MLX unavailable", async () => {
    // MLX is not running in test — isMlxAvailable() has 3s timeout.
    // Set env to a definitely-unreachable address to speed up the fallback.
    const origUrl = process.env.MLX_URL;
    process.env.MLX_URL = "http://127.0.0.1:1"; // port 1 — connection refused instantly
    try {
      const plan = await decomposeFromInterview(compoundCtx);
      // Heuristic wraps into single task when MLX unavailable
      expect(plan.tasks.length).toBeGreaterThanOrEqual(1);
      expect(plan.tasks[0].agentId).toBe("strategy-comms");
      expect(plan.evidence.length).toBeGreaterThanOrEqual(2);
    } finally {
      if (origUrl !== undefined) process.env.MLX_URL = origUrl;
      else delete process.env.MLX_URL;
    }
  });

  it("task description includes interview context", async () => {
    const plan = await decomposeFromInterview(simpleCtx);
    const desc = plan.tasks[0].taskDescription;
    expect(desc).toContain("Context from interview");
    expect(desc).toContain("IM8 v4");
    expect(desc).toContain("Full infrastructure");
  });
});

// ── P3.4: Governance keyboard and plan display ─────────────────────────────

describe("P3.4 — governance keyboard", () => {
  it("builds keyboard with correct buttons", () => {
    const kb = buildGovernanceKeyboard("d-1", 5);
    // InlineKeyboard stores rows in .inline_keyboard
    const rows = (kb as any).inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
    expect(rows.length).toBe(3); // 3 rows

    // Row 1: Approve + Edit
    expect(rows[0]).toHaveLength(2);
    expect(rows[0][0].text).toContain("Approve");
    expect(rows[0][0].text).toContain("5s");
    expect(rows[0][1].text).toContain("Edit");

    // Row 2: Cancel + Skip Review
    expect(rows[1]).toHaveLength(2);
    expect(rows[1][0].text).toContain("Cancel");
    expect(rows[1][1].text).toContain("Skip Review");

    // Row 3: Force Security
    expect(rows[2]).toHaveLength(1);
    expect(rows[2][0].text).toContain("Force Security");
  });

  it("callback data contains dispatchId", () => {
    const kb = buildGovernanceKeyboard("my-dispatch-id", 3);
    const rows = (kb as any).inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
    // All callback_data should reference the dispatch ID
    for (const row of rows) {
      for (const btn of row) {
        expect(btn.callback_data).toContain("my-dispatch-id");
      }
    }
  });
});

describe("P3.4 — formatDispatchPlan", () => {
  it("formats single-task plan", () => {
    const plan = {
      tasks: [{
        seq: 1,
        agentId: "security-compliance",
        topicHint: null,
        taskDescription: "Review EDEN security",
      }],
      evidence: [{ summary: "IM8 v4", source: "interview", supportsTasks: [1] }],
    };
    const text = formatDispatchPlan(
      plan,
      "review EDEN security",
      {
        intent: "security-review",
        primaryAgent: "security-compliance",
        topicHint: null,
        isCompound: false,
        confidence: 0.7,
        reasoning: "test",
      },
    );
    expect(text).toContain("DISPATCH PLAN");
    expect(text).toContain("security-review");
    expect(text).toContain("70%");
    expect(text).toContain("Evidence: 1 items");
  });

  it("formats multi-task plan with dependencies", () => {
    const plan = {
      tasks: [
        { seq: 1, agentId: "strategy-comms", topicHint: null, taskDescription: "Create meeting deck" },
        { seq: 2, agentId: "security-compliance", topicHint: null, taskDescription: "Security review", dependsOn: [1] },
        { seq: 3, agentId: "cloud-architect", topicHint: null, taskDescription: "Cost estimate", dependsOn: [1] },
      ],
      evidence: [],
    };
    const text = formatDispatchPlan(
      plan,
      "prep for meeting",
      {
        intent: "meeting-prep",
        primaryAgent: "strategy-comms",
        topicHint: null,
        isCompound: true,
        confidence: 0.75,
        reasoning: "test",
      },
    );
    expect(text).toContain("Compound: Yes");
    expect(text).toContain("(after #1)");
  });

  it("truncates long task descriptions", () => {
    const longTask = "A".repeat(200);
    const plan = {
      tasks: [{ seq: 1, agentId: "operations-hub", topicHint: null, taskDescription: longTask }],
      evidence: [],
    };
    const text = formatDispatchPlan(plan, longTask, {
      intent: "general",
      primaryAgent: "operations-hub",
      topicHint: null,
      isCompound: false,
      confidence: 0.9,
      reasoning: "test",
    });
    // Task line and task description should be truncated
    expect(text).toContain("...");
  });
});
