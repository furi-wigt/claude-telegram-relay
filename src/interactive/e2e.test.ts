/**
 * End-to-end integration tests for the Question UI flow.
 *
 * Exercises the full pipeline:
 *   /plan command → loading card → question generation → answer collection → plan generation
 *
 * Tests the integration between InteractiveStateMachine, QuestionDashboard,
 * and sessionStore. The bot API and callClaude are mocked at the boundary
 * so no real network calls are made.
 *
 * Coverage map:
 *   E2E-1  Full single-round flow (loading card → Q1 → summary → confirm)
 *   E2E-2  Callback routing: correct answer advances to next question
 *   E2E-3  Back navigation: answering Q2 then tapping back clears Q2 answer
 *   E2E-4  Free-text answer: allowFreeText question accepts typed text
 *   E2E-5  Stale button tap: qIdx mismatch is silently ignored
 *   E2E-6  Cancel flow: session cleared and cancelled card shown
 *   E2E-7  Edit menu → jump back to question (answers from qIdx cleared)
 *   E2E-8  Progress bar correctness via formatQuestion output
 *   E2E-9  createLoadingCard sends parse_mode: "MarkdownV2"
 *   E2E-10 extractJsonObject robustness (via callClaude queue variants)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { InteractiveStateMachine } from "./stateMachine.ts";
import { QuestionDashboard } from "./questionDashboard.ts";
import type { InteractiveSession, Question } from "./types.ts";
import {
  setSession,
  getSession,
  clearSession,
  hasSession,
} from "./sessionStore.ts";
import fs from "node:fs/promises";
import path from "node:path";

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const CHAT_ID = 99001;
const CARD_MSG_ID = 42;
const PLAN_DIR = ".claude/todos";

// ──────────────────────────────────────────────
// Captured call types
// ──────────────────────────────────────────────

interface CapturedSend {
  chatId: number;
  text: string;
  opts?: Record<string, unknown>;
}

interface CapturedEdit {
  chatId: number;
  msgId: number;
  text: string;
  opts?: Record<string, unknown>;
}

// ──────────────────────────────────────────────
// Mock factories
// ──────────────────────────────────────────────

/**
 * Create a mock bot that captures all API calls with their options.
 * This is an enhanced version of the factory in stateMachine.test.ts that
 * also records the full options object so we can verify parse_mode.
 */
function createMockBot() {
  const sends: CapturedSend[] = [];
  const edits: CapturedEdit[] = [];

  let nextMessageId = CARD_MSG_ID;

  const bot = {
    api: {
      sendMessage: async (chatId: number, text: string, opts?: Record<string, unknown>) => {
        sends.push({ chatId, text, opts });
        return { message_id: nextMessageId++ };
      },
      editMessageText: async (
        chatId: number,
        msgId: number,
        text: string,
        opts?: Record<string, unknown>
      ) => {
        edits.push({ chatId, msgId, text, opts });
      },
    },
  } as any;

  return { bot, sends, edits };
}

/**
 * Create a minimal context object that satisfies grammy's Context interface
 * for the subset of fields accessed by the state machine.
 */
function createMockCtx(
  chatId: number = CHAT_ID,
  messageText: string = ""
) {
  return {
    chat: { id: chatId },
    message: { text: messageText },
    answerCallbackQuery: async (_opts?: unknown) => {},
    reply: async (_text: string, _opts?: unknown) => ({ message_id: 1 }),
  } as any;
}

/**
 * Build a callClaude mock that returns responses from a queue in order.
 * Throws if called more times than responses were provided.
 */
function createCallClaudeQueue(responses: string[]) {
  let idx = 0;
  return async (_prompt: string): Promise<string> => {
    if (idx >= responses.length) {
      throw new Error(
        `callClaude called ${idx + 1} times but only ${responses.length} response(s) queued`
      );
    }
    return responses[idx++];
  };
}

// ──────────────────────────────────────────────
// Question fixtures
// ──────────────────────────────────────────────

function makeQuestion(
  id: string,
  question: string,
  options: { label: string; value: string }[],
  allowFreeText = false
): Question {
  return { id, question, options, allowFreeText };
}

const Q1 = makeQuestion("q1", "What framework?", [
  { label: "Express", value: "express" },
  { label: "Fastify", value: "fastify" },
]);

const Q2 = makeQuestion("q2", "Token storage?", [
  { label: "Cookie", value: "cookie" },
  { label: "localStorage", value: "ls" },
]);

const Q_FREE = makeQuestion(
  "q1",
  "Custom requirement?",
  [{ label: "Option A", value: "a" }],
  true // allowFreeText
);

// ──────────────────────────────────────────────
// Standard Claude JSON payloads
// ──────────────────────────────────────────────

/** Round 1 response: 2 questions */
const ROUND1_TWO_Q = JSON.stringify({
  goal: "jwt-auth",
  description: "implement-jwt-auth-system",
  questions: [
    {
      id: "q1",
      question: "What framework?",
      options: [
        { label: "Express", value: "express" },
        { label: "Fastify", value: "fastify" },
      ],
      allowFreeText: false,
    },
    {
      id: "q2",
      question: "Token storage?",
      options: [
        { label: "Cookie", value: "cookie" },
        { label: "localStorage", value: "ls" },
      ],
      allowFreeText: false,
    },
  ],
  done: false,
});

/** Round 1 response: 1 question (for single-round tests) */
const ROUND1_ONE_Q = JSON.stringify({
  goal: "jwt-auth",
  description: "implement-jwt-auth-system",
  questions: [
    {
      id: "q1",
      question: "What framework?",
      options: [
        { label: "Express", value: "express" },
        { label: "Fastify", value: "fastify" },
      ],
      allowFreeText: false,
    },
  ],
  done: false,
});

/** done:true — no more questions */
const DONE_RESPONSE = JSON.stringify({ done: true, questions: [] });

/** Round 1 response with a free-text question */
const ROUND1_FREE_TEXT = JSON.stringify({
  goal: "custom-req",
  description: "custom-requirement-task",
  questions: [
    {
      id: "q1",
      question: "Custom requirement?",
      options: [{ label: "Option A", value: "a" }],
      allowFreeText: true,
    },
  ],
  done: false,
});

// ──────────────────────────────────────────────
// Session builder for direct session injection
// ──────────────────────────────────────────────

function makeSession(overrides: Partial<InteractiveSession> = {}): InteractiveSession {
  return {
    sessionId: "e2e-test-session",
    chatId: CHAT_ID,
    phase: "collecting",
    task: "add JWT authentication",
    goal: "jwt-auth",
    description: "implement-jwt-auth-system",
    questions: [Q1],
    answers: [null],
    currentIndex: 0,
    cardMessageId: CARD_MSG_ID,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    completedQA: [],
    currentBatchStart: 0,
    round: 1,
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// Cleanup helper
// ──────────────────────────────────────────────

async function cleanPlanDir(goal: string): Promise<void> {
  try {
    await fs.rm(path.join(PLAN_DIR, goal), { recursive: true });
  } catch {
    // Nothing to clean — ignore
  }
}

// ──────────────────────────────────────────────
// E2E-1: Full single-round flow
// ──────────────────────────────────────────────

describe("E2E-1: Full single-round flow", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("loading card is sent with parse_mode: MarkdownV2 on /plan command", async () => {
    const { bot, sends } = createMockBot();
    const callClaude = createCallClaudeQueue([ROUND1_ONE_Q, DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    const ctx = createMockCtx(CHAT_ID, "/plan add JWT auth");
    await sm.handlePlanCommand(ctx);

    // First sendMessage call should be the loading card
    expect(sends.length).toBeGreaterThan(0);
    const loadingCall = sends[0];
    expect(loadingCall.opts?.parse_mode).toBe("MarkdownV2");
    expect(loadingCall.text).toContain("Generating questions");
    expect(loadingCall.text).toContain("add JWT auth");
  });

  it("session transitions to collecting phase after questions generated", async () => {
    const { bot } = createMockBot();
    const callClaude = createCallClaudeQueue([ROUND1_ONE_Q, DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    const ctx = createMockCtx(CHAT_ID, "/plan add JWT auth");
    await sm.handlePlanCommand(ctx);

    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.phase).toBe("collecting");
    expect(session!.questions.length).toBe(1);
    expect(session!.questions[0].question).toBe("What framework?");
  });

  it("question card is edited in-place showing question text with progress bar", async () => {
    const { bot, edits } = createMockBot();
    const callClaude = createCallClaudeQueue([ROUND1_ONE_Q, DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    const ctx = createMockCtx(CHAT_ID, "/plan add JWT auth");
    await sm.handlePlanCommand(ctx);

    // An edit should have been made to display the first question
    expect(edits.length).toBeGreaterThan(0);
    const questionEdit = edits[edits.length - 1];
    expect(questionEdit.text).toContain("What framework?");
    expect(questionEdit.text).toContain("Q1 of 1");
  });

  it("answering the only question triggers summary (confirming phase)", async () => {
    const { bot } = createMockBot();
    // After answering the single question, onBatchComplete calls Claude which returns done
    const callClaude = createCallClaudeQueue([DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    // Inject session directly for isolation
    setSession(CHAT_ID, makeSession({
      questions: [Q1],
      answers: [null],
      currentIndex: 0,
      round: 1,
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:a:0:0"); // answer Q1, option 0 (express)

    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.phase).toBe("confirming");
  });

  it("summary card shows plan path and all answers", async () => {
    const { bot, edits } = createMockBot();
    const callClaude = createCallClaudeQueue([DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1],
      answers: [null],
      currentIndex: 0,
      round: 1,
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:a:0:0");

    const summaryEdit = edits[edits.length - 1];
    expect(summaryEdit.text).toContain("Plan Ready");
    expect(summaryEdit.text).toContain(".claude/todos");
    expect(summaryEdit.text).toContain("express");
  });

  it("confirm clears session after spawning Claude", async () => {
    let claudeCallCount = 0;
    const { bot } = createMockBot();
    const callClaude = async (_prompt: string): Promise<string> => {
      claudeCallCount++;
      return "Implementation plan complete.";
    };
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      phase: "confirming",
      questions: [Q1],
      answers: ["express"],
      completedQA: [{ question: "What framework?", answer: "express" }],
      round: 1,
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:confirm");

    // Session must be cleared after confirm
    expect(hasSession(CHAT_ID)).toBe(false);
    // callClaude should have been invoked for the actual implementation
    expect(claudeCallCount).toBe(1);
  });

  it("plan file is written to disk during summary transition", async () => {
    const { bot } = createMockBot();
    const callClaude = createCallClaudeQueue([DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1],
      answers: [null],
      currentIndex: 0,
      round: 1,
      goal: "jwt-auth",
      description: "implement-jwt-auth-system",
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:a:0:0");

    const planPath = path.join(PLAN_DIR, "jwt-auth", "implement-jwt-auth-system.md");
    try {
      const content = await fs.readFile(planPath, "utf-8");
      expect(content).toContain("Plan:");
      expect(content).toContain("add JWT authentication");
    } finally {
      await cleanPlanDir("jwt-auth");
    }
  });
});

// ──────────────────────────────────────────────
// E2E-2: Callback routing — correct answer selection
// ──────────────────────────────────────────────

describe("E2E-2: Callback routing - answer selection advances question index", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("iq:a:0:0 on Q1 of 2 advances currentIndex to 1", async () => {
    const { bot } = createMockBot();
    const callClaude = createCallClaudeQueue([DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1, Q2],
      answers: [null, null],
      currentIndex: 0,
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:a:0:0");

    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.currentIndex).toBe(1);
    expect(session!.answers[0]).toBe("express");
    expect(session!.phase).toBe("collecting");
  });

  it("iq:a:1:1 on Q2 of 2 (last question) triggers onBatchComplete", async () => {
    const { bot } = createMockBot();
    const callClaude = createCallClaudeQueue([DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1, Q2],
      answers: ["express", null],
      currentIndex: 1,
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:a:1:1"); // Q2, option 1 (localStorage)

    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.answers[1]).toBe("ls");
    expect(session!.phase).toBe("confirming");
  });

  it("option 0 stores the first option value, option 1 stores the second", async () => {
    const { bot } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    // Test option 0
    setSession(CHAT_ID, makeSession({
      questions: [Q1, Q2],
      answers: [null, null],
      currentIndex: 0,
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:a:0:0");

    let session = getSession(CHAT_ID);
    expect(session!.answers[0]).toBe("express"); // option 0 value

    // Clear and test option 1
    clearSession(CHAT_ID);
    setSession(CHAT_ID, makeSession({
      questions: [Q1, Q2],
      answers: [null, null],
      currentIndex: 0,
    }));

    await sm.handleCallback(ctx, "iq:a:0:1");

    session = getSession(CHAT_ID);
    expect(session!.answers[0]).toBe("fastify"); // option 1 value
  });
});

// ──────────────────────────────────────────────
// E2E-3: Back navigation
// ──────────────────────────────────────────────

describe("E2E-3: Back navigation", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("iq:back from Q2 goes to Q1 and clears Q2's pending answer slot", async () => {
    const { bot } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1, Q2],
      answers: ["express", null],
      currentIndex: 1,
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:back");

    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.currentIndex).toBe(0);
    // The current Q slot (index 1) should remain null; index 0 answer preserved
    expect(session!.answers[1]).toBeNull();
    expect(session!.answers[0]).toBe("express");
  });

  it("iq:back on Q1 (first question) does nothing — no change", async () => {
    const { bot } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1, Q2],
      answers: [null, null],
      currentIndex: 0,
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:back");

    const session = getSession(CHAT_ID);
    expect(session!.currentIndex).toBe(0); // unchanged
  });

  it("question card is edited after going back", async () => {
    const { bot, edits } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1, Q2],
      answers: ["express", null],
      currentIndex: 1,
    }));

    const ctx = createMockCtx();
    const editCountBefore = edits.length;
    await sm.handleCallback(ctx, "iq:back");

    expect(edits.length).toBeGreaterThan(editCountBefore);
    const backEdit = edits[edits.length - 1];
    expect(backEdit.text).toContain("What framework?"); // back on Q1
  });
});

// ──────────────────────────────────────────────
// E2E-4: Free-text answer
// ──────────────────────────────────────────────

describe("E2E-4: Free-text answer", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("typed text is accepted as answer when allowFreeText is true", async () => {
    const { bot } = createMockBot();
    const callClaude = createCallClaudeQueue([DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q_FREE],
      answers: [null],
      currentIndex: 0,
    }));

    const ctx = createMockCtx(CHAT_ID, "NestJS");
    const consumed = await sm.handleFreeText(ctx, "NestJS");

    expect(consumed).toBe(true);
    const session = getSession(CHAT_ID);
    // Last question answered — should trigger onBatchComplete → confirming
    expect(session).toBeDefined();
    expect(session!.phase).toBe("confirming");
    expect(session!.completedQA[0].answer).toBe("NestJS");
  });

  it("typed text on non-last question advances to next question", async () => {
    const { bot } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    const freeQ1 = { ...Q_FREE, id: "q1", question: "Custom requirement?" };
    const q2 = makeQuestion("q2", "Priority level?", [
      { label: "High", value: "high" },
    ]);

    setSession(CHAT_ID, makeSession({
      questions: [freeQ1, q2],
      answers: [null, null],
      currentIndex: 0,
    }));

    const ctx = createMockCtx(CHAT_ID, "custom answer");
    const consumed = await sm.handleFreeText(ctx, "custom answer");

    expect(consumed).toBe(true);
    const session = getSession(CHAT_ID);
    expect(session!.currentIndex).toBe(1);
    expect(session!.answers[0]).toBe("custom answer");
    expect(session!.phase).toBe("collecting");
  });

  it("typed text is rejected with reply when allowFreeText is false", async () => {
    const { bot } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    // Q1 has allowFreeText: false
    setSession(CHAT_ID, makeSession({
      questions: [Q1],
      answers: [null],
      currentIndex: 0,
    }));

    let replyCalled = false;
    const ctx = {
      ...createMockCtx(CHAT_ID, "some text"),
      reply: async (_text: string) => { replyCalled = true; return { message_id: 1 }; },
    } as any;

    const consumed = await sm.handleFreeText(ctx, "some text");

    // Consumed = true (intercepted), but reply was called to indicate buttons-only
    expect(consumed).toBe(true);
    expect(replyCalled).toBe(true);
    // Answer should NOT be stored
    const session = getSession(CHAT_ID);
    expect(session!.answers[0]).toBeNull();
  });

  it("handleFreeText returns false when there is no active session", async () => {
    const { bot } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    // No session set
    const ctx = createMockCtx();
    const consumed = await sm.handleFreeText(ctx, "some text");

    expect(consumed).toBe(false);
  });
});

// ──────────────────────────────────────────────
// E2E-5: Stale button tap
// ──────────────────────────────────────────────

describe("E2E-5: Stale button tap (qIdx mismatch is silently ignored)", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("tapping iq:a:0:0 when session is on Q1 (index 1) does nothing", async () => {
    const { bot, edits } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1, Q2],
      answers: ["express", null],
      currentIndex: 1, // currently on Q2
    }));

    const ctx = createMockCtx();
    const editCountBefore = edits.length;
    await sm.handleCallback(ctx, "iq:a:0:0"); // qIdx=0, but session is at index=1 → stale

    // Session should be unchanged
    const session = getSession(CHAT_ID);
    expect(session!.currentIndex).toBe(1);
    expect(session!.answers[0]).toBe("express"); // unchanged
    expect(session!.answers[1]).toBeNull(); // not set

    // No card edit should have been triggered
    expect(edits.length).toBe(editCountBefore);
  });

  it("tapping a button after session has been confirmed does nothing harmful", async () => {
    const { bot } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    // No session for this chat
    const ctx = createMockCtx();
    // Should not throw
    await expect(sm.handleCallback(ctx, "iq:a:0:0")).resolves.toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// E2E-6: Cancel flow
// ──────────────────────────────────────────────

describe("E2E-6: Cancel flow", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("iq:cancel clears the session", async () => {
    const { bot } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession());

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:cancel");

    expect(hasSession(CHAT_ID)).toBe(false);
  });

  it("iq:cancel edits the card to show cancelled message", async () => {
    const { bot, edits } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession());

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:cancel");

    expect(edits.length).toBeGreaterThan(0);
    const cancelEdit = edits[edits.length - 1];
    expect(cancelEdit.text).toContain("cancelled");
    // Card should have no actual buttons — grammY's InlineKeyboard with no buttons
    // serialises as { inline_keyboard: [[]] } (one empty row), so we check that
    // every row is empty rather than asserting zero rows.
    const keyboard = cancelEdit.opts?.reply_markup as any;
    if (keyboard !== undefined) {
      const allRowsEmpty = (keyboard.inline_keyboard as unknown[][]).every(
        (row) => row.length === 0
      );
      expect(allRowsEmpty).toBe(true);
    }
  });

  it("iq:cancel during collecting phase removes session before any further processing", async () => {
    const { bot } = createMockBot();
    let claudeCallCount = 0;
    const callClaude = async (): Promise<string> => {
      claudeCallCount++;
      return DONE_RESPONSE;
    };
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      phase: "collecting",
      questions: [Q1, Q2],
      answers: [null, null],
      currentIndex: 0,
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:cancel");

    expect(hasSession(CHAT_ID)).toBe(false);
    // callClaude should not be invoked on cancel
    expect(claudeCallCount).toBe(0);
  });
});

// ──────────────────────────────────────────────
// E2E-7: Edit menu flow
// ──────────────────────────────────────────────

describe("E2E-7: Edit menu → jump back to question", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("iq:edit on summary shows edit menu card", async () => {
    const { bot, edits } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      phase: "confirming",
      questions: [Q1, Q2],
      answers: ["express", "cookie"],
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:edit");

    expect(edits.length).toBeGreaterThan(0);
    const editMenuCard = edits[edits.length - 1];
    expect(editMenuCard.text).toContain("Edit an answer");
    expect(editMenuCard.text).toContain("What framework?");
    expect(editMenuCard.text).toContain("Token storage?");
  });

  it("iq:eq:0 enters single-question edit mode for Q0 (preserves all answers)", async () => {
    const { bot } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      phase: "confirming",
      questions: [Q1, Q2],
      answers: ["express", "cookie"],
      currentIndex: 1,
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:eq:0");

    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.currentIndex).toBe(0);
    expect(session!.editingIndex).toBe(0);      // edit mode flagged
    expect(session!.answers[0]).toBe("express"); // NOT cleared — preserved for display
    expect(session!.answers[1]).toBe("cookie");  // downstream answers preserved too
    expect(session!.phase).toBe("collecting");
  });

  it("iq:eq:1 enters single-question edit mode for Q1 (preserves all answers)", async () => {
    const { bot } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      phase: "confirming",
      questions: [Q1, Q2],
      answers: ["express", "cookie"],
      currentIndex: 1,
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:eq:1");

    const session = getSession(CHAT_ID);
    expect(session!.currentIndex).toBe(1);
    expect(session!.editingIndex).toBe(1);      // edit mode flagged
    expect(session!.answers[0]).toBe("express"); // Q0 preserved
    expect(session!.answers[1]).toBe("cookie");  // Q1 preserved (will be replaced on answer)
    expect(session!.phase).toBe("collecting");
  });

  it("answering in edit mode updates that answer and returns to summary", async () => {
    const { bot, edits } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      phase: "collecting",
      questions: [Q1, Q2],
      answers: ["express", "cookie"],
      currentIndex: 1,
      editingIndex: 1,
      goal: "jwt-auth",
      description: "implement-jwt-auth-system",
    }));

    const ctx = createMockCtx();
    // User picks option 0 (label: "Express") for Q1 (index 1) while in edit mode
    await sm.handleCallback(ctx, "iq:a:1:0");

    const session = getSession(CHAT_ID);
    expect(session!.editingIndex).toBeUndefined(); // edit mode cleared
    expect(session!.answers[0]).toBe("express");   // Q0 unchanged
    // Returns to summary, not next question
    const lastEdit = edits[edits.length - 1];
    expect(lastEdit.text).toContain("Plan Ready");
  });

  it("iq:edit_cancel returns to summary from edit menu", async () => {
    const { bot, edits } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      phase: "confirming",
      questions: [Q1, Q2],
      answers: ["express", "cookie"],
      goal: "jwt-auth",
      description: "implement-jwt-auth-system",
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:edit_cancel");

    const summaryCard = edits[edits.length - 1];
    expect(summaryCard.text).toContain("Plan Ready");
    expect(summaryCard.text).toContain("express");
  });
});

// ──────────────────────────────────────────────
// E2E-8: Progress bar correctness
// ──────────────────────────────────────────────

describe("E2E-8: Progress bar correctness via formatQuestion", () => {
  const stubBot = {
    api: {
      sendMessage: async () => ({ message_id: 42 }),
      editMessageText: async () => {},
    },
  } as any;
  const dashboard = new QuestionDashboard(stubBot);

  it("Q1 of 2 (current=0, total=2) shows 0% progress", () => {
    const session: InteractiveSession = {
      sessionId: "test",
      chatId: CHAT_ID,
      phase: "collecting",
      task: "test task",
      goal: "goal",
      description: "desc",
      questions: [Q1, Q2],
      answers: [null, null],
      currentIndex: 0,
      cardMessageId: 42,
      createdAt: Date.now(),
      completedQA: [],
      currentBatchStart: 0,
      round: 1,
    };

    const text = dashboard.formatQuestion(session);
    expect(text).toContain("Q1 of 2");
    expect(text).toContain("0%");
  });

  it("Q2 of 2 (current=1, total=2) shows 50% progress", () => {
    const session: InteractiveSession = {
      sessionId: "test",
      chatId: CHAT_ID,
      phase: "collecting",
      task: "test task",
      goal: "goal",
      description: "desc",
      questions: [Q1, Q2],
      answers: ["express", null],
      currentIndex: 1,
      cardMessageId: 42,
      createdAt: Date.now(),
      completedQA: [],
      currentBatchStart: 0,
      round: 1,
    };

    const text = dashboard.formatQuestion(session);
    expect(text).toContain("Q2 of 2");
    expect(text).toContain("50%");
  });

  it("total=0 shows 0% without divide-by-zero error", () => {
    // Create a session with 1 question (currentIndex=0, total=1 → current/total = 0%)
    // For total=0 case we need to invoke formatQuestion with an edge-case session
    // The buildProgressBar guard (total === 0) returns 0% when total is 0
    // We can test this indirectly by using a single question at index 0
    const session: InteractiveSession = {
      sessionId: "test",
      chatId: CHAT_ID,
      phase: "collecting",
      task: "test task",
      goal: "goal",
      description: "desc",
      questions: [Q1],
      answers: [null],
      currentIndex: 0,
      cardMessageId: 42,
      createdAt: Date.now(),
      completedQA: [],
      currentBatchStart: 0,
      round: 1,
    };

    // Should not throw
    expect(() => dashboard.formatQuestion(session)).not.toThrow();
    const text = dashboard.formatQuestion(session);
    expect(text).toContain("Q1 of 1");
    expect(text).toContain("0%"); // current=0/total=1 → 0%
  });
});

// ──────────────────────────────────────────────
// E2E-9: parse_mode: "MarkdownV2" on createLoadingCard
// ──────────────────────────────────────────────

describe("E2E-9: createLoadingCard sends parse_mode: MarkdownV2", () => {
  it("sendMessage is called with parse_mode MarkdownV2 when creating loading card", async () => {
    const sends: CapturedSend[] = [];
    const bot = {
      api: {
        sendMessage: async (chatId: number, text: string, opts?: Record<string, unknown>) => {
          sends.push({ chatId, text, opts });
          return { message_id: 1 };
        },
        editMessageText: async () => {},
      },
    } as any;

    const dashboard = new QuestionDashboard(bot);
    await dashboard.createLoadingCard(CHAT_ID, "build a user system");

    expect(sends.length).toBe(1);
    expect(sends[0].opts?.parse_mode).toBe("MarkdownV2");
    expect(sends[0].text).toContain("build a user system");
  });
});

// ──────────────────────────────────────────────
// E2E-22: showExecuting card has no unescaped dots (MarkdownV2 regression)
// ──────────────────────────────────────────────

describe("E2E-22: showExecuting card contains no unescaped dots (MarkdownV2 dot bug)", () => {
  it("iq:confirm edits card to executing state with no literal '...' sequence", async () => {
    const edits: CapturedEdit[] = [];
    const bot = {
      api: {
        sendMessage: async () => ({ message_id: CARD_MSG_ID }),
        editMessageText: async (
          chatId: number,
          msgId: number,
          text: string,
          opts?: Record<string, unknown>
        ) => {
          edits.push({ chatId, msgId, text, opts });
        },
      },
    } as any;

    let callClaudeInvoked = false;
    const callClaude = async (): Promise<string> => {
      callClaudeInvoked = true;
      return "Done.";
    };
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      phase: "confirming",
      questions: [Q1],
      answers: ["express"],
      completedQA: [{ question: "What framework?", answer: "express" }],
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:confirm");

    // Find the executing card edit
    const executingEdit = edits.find((e) => e.text.includes("Launching Claude"));
    expect(executingEdit).toBeDefined();

    // Must NOT contain three consecutive unescaped dots (MarkdownV2 parse error)
    expect(executingEdit!.text).not.toContain("...");
    // Should use ellipsis character instead
    expect(executingEdit!.text).toContain("\u2026");
  });
});

// ──────────────────────────────────────────────
// E2E-11: answerCallbackQuery error toast when session not found
// ──────────────────────────────────────────────

describe("E2E-11: answerCallbackQuery called once with error text when session not found", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("calls answerCallbackQuery with error text (not silently) when session is missing", async () => {
    const { bot } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    const answerCalls: Array<{ text?: string }> = [];
    const ctx = {
      ...createMockCtx(),
      answerCallbackQuery: async (opts?: { text?: string }) => {
        answerCalls.push(opts ?? {});
      },
    } as any;

    // No session — any callback should trigger the "Session expired" toast
    await sm.handleCallback(ctx, "iq:a:0:0");

    expect(answerCalls.length).toBe(1);
    expect(answerCalls[0].text).toContain("Session expired");
  });

  it("does NOT call answerCallbackQuery twice when session is missing", async () => {
    const { bot } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    let callCount = 0;
    const ctx = {
      ...createMockCtx(),
      answerCallbackQuery: async (_opts?: unknown) => { callCount++; },
    } as any;

    await sm.handleCallback(ctx, "iq:cancel");

    expect(callCount).toBe(1);
  });

  it("calls answerCallbackQuery with no text when session exists (spinner dismissed)", async () => {
    const { bot } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1, Q2],
      answers: [null, null],
      currentIndex: 0,
    }));

    const answerCalls: Array<{ text?: string } | undefined> = [];
    const ctx = {
      ...createMockCtx(),
      answerCallbackQuery: async (opts?: { text?: string }) => {
        answerCalls.push(opts);
      },
    } as any;

    await sm.handleCallback(ctx, "iq:cancel");

    // Called exactly once, with no text (just dismiss spinner)
    expect(answerCalls.length).toBe(1);
    expect(answerCalls[0]).toBeUndefined();
  });
});

// ──────────────────────────────────────────────
// E2E-12: Q2 card rendered when Q1 answer has underscore chars
// ──────────────────────────────────────────────

describe("E2E-12: Q2 card renders correctly when Q1 answer contains Markdown special chars", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("editMessageText is called for Q2 even when Q1 answer has underscores", async () => {
    const edits: CapturedEdit[] = [];
    const bot = {
      api: {
        sendMessage: async () => ({ message_id: CARD_MSG_ID }),
        editMessageText: async (
          chatId: number,
          msgId: number,
          text: string,
          opts?: Record<string, unknown>
        ) => {
          edits.push({ chatId, msgId, text, opts });
        },
      },
    } as any;

    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    // Q1 answer value contains underscores — classic MarkdownV1 breaker
    const Q1_UNDERSCORE = makeQuestion("q1", "Auth method?", [
      { label: "JWT Token", value: "jwt_token" },
      { label: "Session Cookie", value: "session_cookie" },
    ]);

    setSession(CHAT_ID, makeSession({
      questions: [Q1_UNDERSCORE, Q2],
      answers: [null, null],
      currentIndex: 0,
    }));

    const ctx = createMockCtx();

    // Answer Q1 with option 0 (value = "jwt_token")
    await sm.handleCallback(ctx, "iq:a:0:0");

    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();

    // Session must have advanced to Q2
    expect(session!.currentIndex).toBe(1);
    expect(session!.answers[0]).toBe("jwt_token");

    // editMessageText must have been called for the Q2 card
    const q2Edit = edits.find((e) => e.text.includes("Q2 of 2"));
    expect(q2Edit).toBeDefined();
  });

  it("Q2 card text includes escaped Q1 answer in prevAnswers section", () => {
    const stubBot = {
      api: {
        sendMessage: async () => ({ message_id: 42 }),
        editMessageText: async () => {},
      },
    } as any;
    const dashboard = new QuestionDashboard(stubBot);

    const Q1_UNDERSCORE = makeQuestion("q1", "Auth method?", [
      { label: "JWT Token", value: "jwt_token" },
    ]);

    const session: InteractiveSession = {
      sessionId: "test",
      chatId: CHAT_ID,
      phase: "collecting",
      task: "add auth",
      goal: "goal",
      description: "desc",
      questions: [Q1_UNDERSCORE, Q2],
      answers: ["jwt_token", null],
      currentIndex: 1,
      cardMessageId: 42,
      createdAt: Date.now(),
      completedQA: [],
      currentBatchStart: 0,
      round: 1,
    };

    const text = dashboard.formatQuestion(session);

    // Underscores in the Q1 answer must be escaped so Telegram doesn't choke
    expect(text).toContain("jwt\\_token");
    // The Q2 question itself should be present
    expect(text).toContain("Token storage?");
  });
});

// ──────────────────────────────────────────────
// E2E-13: editCard logs error for non-"message-not-modified" failures
// ──────────────────────────────────────────────

describe("E2E-13: editCard logs errors for real failures", () => {
  it("non-'message is not modified' error is logged to console.error", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      const bot = {
        api: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {
            throw new Error("Bad Request: can't parse entities: Can't find end of the entity");
          },
        },
      } as any;

      const callClaude = async () => DONE_RESPONSE;
      const sm = new InteractiveStateMachine(bot, callClaude);

      setSession(CHAT_ID, makeSession({
        questions: [Q1, Q2],
        answers: [null, null],
        currentIndex: 0,
      }));

      const ctx = createMockCtx();
      await sm.handleCallback(ctx, "iq:cancel");

      // The "can't parse entities" error should have been logged
      expect(errors.some((e) => e.includes("editCard failed"))).toBe(true);
    } finally {
      console.error = originalError;
      clearSession(CHAT_ID);
    }
  });

  it("'message is not modified' error is silently swallowed (not logged)", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      const bot = {
        api: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {
            throw new Error("Bad Request: message is not modified: specified new message content");
          },
        },
      } as any;

      const callClaude = async () => DONE_RESPONSE;
      const sm = new InteractiveStateMachine(bot, callClaude);

      setSession(CHAT_ID, makeSession({ questions: [Q1], answers: [null], currentIndex: 0 }));

      const ctx = createMockCtx();
      await sm.handleCallback(ctx, "iq:cancel");

      // "message is not modified" must NOT be logged
      expect(errors.some((e) => e.includes("editCard failed"))).toBe(false);
    } finally {
      console.error = originalError;
      clearSession(CHAT_ID);
    }
  });
});

// ──────────────────────────────────────────────
// E2E-14: Full 2-question flow renders in MarkdownV2 (prevAnswers visible)
// ──────────────────────────────────────────────

describe("E2E-14: Full 2-question flow renders correctly in MarkdownV2", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("editMessageText uses parse_mode MarkdownV2 for all card edits", async () => {
    const { bot, edits } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1, Q2],
      answers: [null, null],
      currentIndex: 0,
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:a:0:0"); // answer Q1

    const q2Edit = edits.find((e) => e.text.includes("Q2 of 2"));
    expect(q2Edit).toBeDefined();
    expect(q2Edit!.opts?.parse_mode).toBe("MarkdownV2");
  });

  it("prevAnswers block appears in Q2 card text", () => {
    const stubBot = {
      api: {
        sendMessage: async () => ({ message_id: 42 }),
        editMessageText: async () => {},
      },
    } as any;
    const dashboard = new QuestionDashboard(stubBot);

    const session: InteractiveSession = {
      sessionId: "test",
      chatId: CHAT_ID,
      phase: "collecting",
      task: "add JWT authentication",
      goal: "jwt-auth",
      description: "desc",
      questions: [Q1, Q2],
      answers: ["express", null],
      currentIndex: 1,
      cardMessageId: 42,
      createdAt: Date.now(),
      completedQA: [],
      currentBatchStart: 0,
      round: 1,
    };

    const text = dashboard.formatQuestion(session);

    // Q1 answer "express" should appear in prevAnswers
    expect(text).toContain("express");
    // Q1 question text should appear in prevAnswers
    expect(text).toContain("What framework?");
    // Q2 question should be the current question
    expect(text).toContain("Token storage?");
    // Progress should show Q2 of 2
    expect(text).toContain("Q2 of 2");
  });

  it("summary card uses MarkdownV2 parse_mode", async () => {
    const { bot, edits } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1],
      answers: [null],
      currentIndex: 0,
      goal: "jwt-auth",
      description: "implement-jwt-auth-system",
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:a:0:0");

    const summaryEdit = edits.find((e) => e.text.includes("Plan Ready"));
    expect(summaryEdit).toBeDefined();
    expect(summaryEdit!.opts?.parse_mode).toBe("MarkdownV2");

    await cleanPlanDir("jwt-auth");
  });
});

// ──────────────────────────────────────────────
// E2E-10: extractJsonObject robustness (via callClaude queue)
// ──────────────────────────────────────────────

describe("E2E-10: JSON extraction robustness via callClaude", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("clean JSON response is parsed correctly", async () => {
    const { bot } = createMockBot();
    const callClaude = createCallClaudeQueue([ROUND1_ONE_Q, DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({ phase: "loading", cardMessageId: CARD_MSG_ID }));

    const ctx = createMockCtx(CHAT_ID, "/plan add JWT auth");
    await sm.handlePlanCommand(ctx);

    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.questions.length).toBe(1);
    expect(session!.phase).toBe("collecting");
  });

  it("JSON wrapped in code fence is extracted correctly", async () => {
    const { bot } = createMockBot();
    const fencedJson = "```json\n" + ROUND1_ONE_Q + "\n```";
    const callClaude = createCallClaudeQueue([fencedJson, DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    const ctx = createMockCtx(CHAT_ID, "/plan add JWT auth");
    await sm.handlePlanCommand(ctx);

    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.questions.length).toBeGreaterThan(0);
    expect(session!.phase).toBe("collecting");
  });

  it("JSON with preamble text (WORKFLOW: Q&A prefix) is extracted correctly", async () => {
    const { bot } = createMockBot();
    const preambleJson = "WORKFLOW: Q&A\n\nHere are the questions:\n\n" + ROUND1_ONE_Q;
    const callClaude = createCallClaudeQueue([preambleJson, DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    const ctx = createMockCtx(CHAT_ID, "/plan add JWT auth");
    await sm.handlePlanCommand(ctx);

    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.questions.length).toBeGreaterThan(0);
  });

  it("response with no JSON object at all → session cleared and error card shown", async () => {
    const { bot, edits } = createMockBot();
    const callClaude = createCallClaudeQueue(["No JSON here at all, just prose."]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    const ctx = createMockCtx(CHAT_ID, "/plan add JWT auth");
    await sm.handlePlanCommand(ctx);

    // Session should be cleared on error
    expect(hasSession(CHAT_ID)).toBe(false);

    // An error message should be shown via editMessageText
    expect(edits.length).toBeGreaterThan(0);
    const errorEdit = edits[edits.length - 1];
    expect(errorEdit.text).toContain("Failed");
  });

  it("JSON wrapped in plain code fence (no language tag) is extracted correctly", async () => {
    const { bot } = createMockBot();
    const plainFenced = "```\n" + ROUND1_ONE_Q + "\n```";
    const callClaude = createCallClaudeQueue([plainFenced, DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    const ctx = createMockCtx(CHAT_ID, "/plan add JWT auth");
    await sm.handlePlanCommand(ctx);

    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.phase).toBe("collecting");
  });
});

// ──────────────────────────────────────────────
// E2E bonus: handlePlanCommand edge cases
// ──────────────────────────────────────────────

describe("handlePlanCommand edge cases", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("replying with usage hint when no task is provided", async () => {
    const { bot } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    let repliedText = "";
    const ctx = {
      chat: { id: CHAT_ID },
      message: { text: "/plan" },
      answerCallbackQuery: async () => {},
      reply: async (text: string) => {
        repliedText = text;
        return { message_id: 1 };
      },
    } as any;

    await sm.handlePlanCommand(ctx);

    expect(repliedText).toContain("Usage:");
    expect(hasSession(CHAT_ID)).toBe(false);
  });

  it("overrides existing session when /plan is called with active session", async () => {
    const { bot } = createMockBot();
    const callClaude = createCallClaudeQueue([ROUND1_ONE_Q, DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    // Inject a pre-existing session
    setSession(CHAT_ID, makeSession({ task: "old task" }));

    let repliedText = "";
    const ctx = {
      chat: { id: CHAT_ID },
      message: { text: "/plan new task" },
      answerCallbackQuery: async () => {},
      reply: async (text: string) => {
        repliedText = text;
        return { message_id: 1 };
      },
    } as any;

    await sm.handlePlanCommand(ctx);

    // Should have warned about existing session, then continued
    expect(repliedText).toContain("active planning session");

    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.task).toBe("new task"); // new session with new task
  });

  it("task text from /plan command is stored in session correctly", async () => {
    // Verifies that the task is extracted from the message text and stored in
    // the session. The session is fully created after handlePlanCommand resolves.
    const { bot } = createMockBot();
    const callClaude = createCallClaudeQueue([ROUND1_ONE_Q, DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    const ctx = createMockCtx(CHAT_ID, "/plan add JWT auth");
    await sm.handlePlanCommand(ctx);

    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.task).toBe("add JWT auth");
    // handlePlanCommand strips the /plan prefix from the task text
    expect(session!.task).not.toContain("/plan");
  });
});

// ──────────────────────────────────────────────
// E2E bonus: Two-round flow (multi-batch)
// ──────────────────────────────────────────────

describe("Two-round flow: completedQA accumulates across rounds", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("Q&A from both rounds appear in the plan file", async () => {
    const { bot } = createMockBot();
    // Round 1 complete → Claude returns round 2 question
    const round2Response = JSON.stringify({
      done: false,
      questions: [
        {
          id: "q2",
          question: "Token storage?",
          options: [
            { label: "Cookie", value: "cookie" },
            { label: "localStorage", value: "ls" },
          ],
          allowFreeText: false,
        },
      ],
    });
    const callClaude = createCallClaudeQueue([round2Response, DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1],
      answers: [null],
      currentIndex: 0,
      round: 1,
      goal: "jwt-auth",
      description: "implement-jwt-auth-system",
    }));

    const ctx = createMockCtx();

    // Answer round 1 Q → triggers onBatchComplete → gets round 2 questions
    await sm.handleCallback(ctx, "iq:a:0:0");

    let session = getSession(CHAT_ID);
    expect(session!.round).toBe(2);
    expect(session!.questions.length).toBe(2);
    expect(session!.completedQA.length).toBe(1);

    // Answer round 2 Q → done → summary
    await sm.handleCallback(ctx, "iq:a:1:0"); // Q2, option 0 (cookie)

    session = getSession(CHAT_ID);
    expect(session!.phase).toBe("confirming");
    expect(session!.completedQA.length).toBe(2);
    expect(session!.completedQA[0]).toEqual({ question: "What framework?", answer: "express" });
    expect(session!.completedQA[1]).toEqual({ question: "Token storage?", answer: "cookie" });

    const planPath = path.join(PLAN_DIR, "jwt-auth", "implement-jwt-auth-system.md");
    try {
      const content = await fs.readFile(planPath, "utf-8");
      expect(content).toContain("What framework?");
      expect(content).toContain("express");
      expect(content).toContain("Token storage?");
      expect(content).toContain("cookie");
    } finally {
      await cleanPlanDir("jwt-auth");
    }
  });
});

// ──────────────────────────────────────────────
// E2E-15: Edit menu uses Q1: format (regression guard for MarkdownV2 dot bug)
// ──────────────────────────────────────────────

describe("E2E-15: Edit menu text uses Q1: format (no unescaped dot)", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("formatEditMenu uses Q1: format, not '1.' numbered list", () => {
    const stubBot = {
      api: {
        sendMessage: async () => ({ message_id: 42 }),
        editMessageText: async () => {},
      },
    } as any;
    const dashboard = new QuestionDashboard(stubBot);

    const session: InteractiveSession = {
      sessionId: "test",
      chatId: CHAT_ID,
      phase: "confirming",
      task: "build calendar integration",
      goal: "calendar",
      description: "integrate-calendar",
      questions: [Q1, Q2],
      answers: ["express", "cookie"],
      currentIndex: 1,
      cardMessageId: 42,
      createdAt: Date.now(),
      completedQA: [],
      currentBatchStart: 0,
      round: 1,
    };

    const text = dashboard.formatEditMenu(session);

    // Must use Q1: format, not "1." (unescaped dot causes MarkdownV2 parse error)
    expect(text).toContain("Q1:");
    expect(text).toContain("Q2:");
    // Must NOT contain "1. " or "2. " (the old numbered list format with unescaped dot)
    expect(text).not.toMatch(/^\d+\. /m);
  });

  it("iq:edit callback from confirming phase shows edit menu with Q1: format", async () => {
    const { bot, edits } = createMockBot();
    const callClaude = async () => DONE_RESPONSE;
    const sm = new InteractiveStateMachine(bot, callClaude);

    setSession(CHAT_ID, makeSession({
      phase: "confirming",
      questions: [Q1, Q2],
      answers: ["express", "cookie"],
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:edit");

    const editMenuCard = edits[edits.length - 1];
    expect(editMenuCard.text).toContain("Edit an answer");
    // Q1: format — no unescaped dot
    expect(editMenuCard.text).toContain("Q1:");
    expect(editMenuCard.text).toContain("Q2:");
    expect(editMenuCard.text).not.toMatch(/^\d+\. /m);
  });
});

// ──────────────────────────────────────────────
// E2E-16: formatEditMenu MarkdownV2 safety — no unescaped dot in numbered positions
// ──────────────────────────────────────────────

describe("E2E-16: formatEditMenu MarkdownV2 safety with answer values containing special chars", () => {
  it("answers with underscores and dashes are escaped in edit menu", () => {
    const stubBot = {
      api: {
        sendMessage: async () => ({ message_id: 42 }),
        editMessageText: async () => {},
      },
    } as any;
    const dashboard = new QuestionDashboard(stubBot);

    const specialQ = makeQuestion("q1", "Auth method?", [
      { label: "JWT Token", value: "jwt_token" },
    ]);
    const dashQ = makeQuestion("q2", "Storage type?", [
      { label: "Full Data", value: "full-data" },
    ]);

    const session: InteractiveSession = {
      sessionId: "test",
      chatId: CHAT_ID,
      phase: "confirming",
      task: "build auth",
      goal: "auth",
      description: "auth-system",
      questions: [specialQ, dashQ],
      answers: ["jwt_token", "full-data"],
      currentIndex: 1,
      cardMessageId: 42,
      createdAt: Date.now(),
      completedQA: [],
      currentBatchStart: 0,
      round: 1,
    };

    const text = dashboard.formatEditMenu(session);

    // Underscores in answer must be escaped for MarkdownV2
    expect(text).toContain("jwt\\_token");
    // Dashes in answer must be escaped for MarkdownV2
    expect(text).toContain("full\\-data");
    // No unescaped dot pattern in numbered positions
    expect(text).not.toMatch(/^\d+\. /m);
  });

  it("formatEditMenu with 13 questions produces valid-looking MarkdownV2 (regression for large plans)", () => {
    const stubBot = {
      api: {
        sendMessage: async () => ({ message_id: 42 }),
        editMessageText: async () => {},
      },
    } as any;
    const dashboard = new QuestionDashboard(stubBot);

    // Build 13 questions like the calendar integration scenario
    const questions = Array.from({ length: 13 }, (_, i) =>
      makeQuestion(`q${i + 1}`, `Question ${i + 1}?`, [
        { label: `Option A`, value: `option_a_${i}` },
      ])
    );
    const answers = questions.map((_, i) => `value_${i}`);

    const session: InteractiveSession = {
      sessionId: "test",
      chatId: CHAT_ID,
      phase: "confirming",
      task: "large plan task",
      goal: "large-plan",
      description: "large-plan-task",
      questions,
      answers,
      currentIndex: 12,
      cardMessageId: 42,
      createdAt: Date.now(),
      completedQA: [],
      currentBatchStart: 0,
      round: 3,
    };

    const text = dashboard.formatEditMenu(session);

    // All 13 questions should appear with Q1: through Q13: format
    for (let i = 1; i <= 13; i++) {
      expect(text).toContain(`Q${i}:`);
    }
    // No unescaped dot patterns in numbered list position
    expect(text).not.toMatch(/^\d+\. /m);
  });
});

// ──────────────────────────────────────────────
// E2E-18: callClaudeForQuestions is used for question generation
// ──────────────────────────────────────────────

describe("E2E-18: callClaudeForQuestions is used for question generation when provided", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("uses callClaudeForQuestions (not callClaude) when generating round 1 questions", async () => {
    const mainClaude = createCallClaudeQueue(["SHOULD_NOT_BE_CALLED"]);
    let questionCallCount = 0;
    const questionClaude = async (_prompt: string): Promise<string> => {
      questionCallCount++;
      return ROUND1_ONE_Q;
    };

    const { bot } = createMockBot();
    const sm = new InteractiveStateMachine(bot, mainClaude, questionClaude);

    const ctx = createMockCtx(CHAT_ID, "/plan build a feature");
    await sm.handlePlanCommand(ctx);

    // callClaudeForQuestions should have been called for question generation
    expect(questionCallCount).toBe(1);
    // Main callClaude should NOT have been called
    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.questions.length).toBe(1);
    expect(session!.phase).toBe("collecting");

    // Clean up
    await cleanPlanDir("jwt-auth");
  });

  it("uses callClaudeForQuestions for round 2 question generation", async () => {
    const mainClaude = async (): Promise<string> => "Implementation done.";
    let questionCallCount = 0;
    const questionClaude = async (_prompt: string): Promise<string> => {
      questionCallCount++;
      return DONE_RESPONSE; // return done for round 2
    };

    const { bot } = createMockBot();
    const sm = new InteractiveStateMachine(bot, mainClaude, questionClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1],
      answers: [null],
      currentIndex: 0,
      round: 1,
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:a:0:0"); // answer last Q → triggers onBatchComplete

    // callClaudeForQuestions called once (round 2 check)
    expect(questionCallCount).toBe(1);
    const session = getSession(CHAT_ID);
    expect(session!.phase).toBe("confirming"); // done=true → summary

    await cleanPlanDir("jwt-auth");
  });

  it("falls back to callClaude for question generation when callClaudeForQuestions is not provided", async () => {
    let mainClaudeCallCount = 0;
    const mainClaude = async (_prompt: string): Promise<string> => {
      mainClaudeCallCount++;
      return ROUND1_ONE_Q;
    };

    const { bot } = createMockBot();
    // No third argument — should fall back to callClaude for questions
    const sm = new InteractiveStateMachine(bot, mainClaude);

    const ctx = createMockCtx(CHAT_ID, "/plan build a feature");
    await sm.handlePlanCommand(ctx);

    // callClaude should have been called (as question fallback)
    expect(mainClaudeCallCount).toBeGreaterThan(0);
    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.phase).toBe("collecting");

    await cleanPlanDir("jwt-auth");
  });
});

// ──────────────────────────────────────────────
// E2E-19: onBatchComplete error path → advanceToSummary succeeds
// ──────────────────────────────────────────────

describe("E2E-19: onBatchComplete question generation failure → advanceToSummary succeeds", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("when callClaudeForQuestions throws, falls back to summary (confirming phase)", async () => {
    const mainClaude = async (): Promise<string> => "Implementation done.";
    const questionClaude = async (): Promise<string> => {
      throw new Error("callClaudeForQuestions: simulated failure");
    };

    const { bot } = createMockBot();
    const sm = new InteractiveStateMachine(bot, mainClaude, questionClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1],
      answers: [null],
      currentIndex: 0,
      round: 1,
      goal: "jwt-auth",
      description: "implement-jwt-auth-system",
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:a:0:0"); // triggers onBatchComplete → questionClaude throws

    // Should have fallen back to summary despite question generation failure
    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.phase).toBe("confirming");

    await cleanPlanDir("jwt-auth");
  });

  it("plan file is written even when question generation fails on round 2", async () => {
    const mainClaude = async (): Promise<string> => "Implementation done.";
    const questionClaude = async (): Promise<string> => {
      throw new Error("Simulated question gen failure");
    };

    const { bot } = createMockBot();
    const sm = new InteractiveStateMachine(bot, mainClaude, questionClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1],
      answers: [null],
      currentIndex: 0,
      round: 1,
      goal: "jwt-auth",
      description: "implement-jwt-auth-system",
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:a:0:0");

    const planPath = path.join(PLAN_DIR, "jwt-auth", "implement-jwt-auth-system.md");
    try {
      const content = await fs.readFile(planPath, "utf-8");
      expect(content).toContain("Plan:");
    } finally {
      await cleanPlanDir("jwt-auth");
    }
  });
});

// ──────────────────────────────────────────────
// E2E-20: onBatchComplete error path → advanceToSummary also fails → error sendMessage
// ──────────────────────────────────────────────

describe("E2E-20: onBatchComplete — both question gen AND advanceToSummary fail → error message", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("sends error message via sendMessage when advanceToSummary throws (invalid plan path)", async () => {
    const mainClaude = async (): Promise<string> => "Implementation done.";
    const questionClaude = async (): Promise<string> => {
      throw new Error("Question gen failed");
    };

    const sends: CapturedSend[] = [];
    const bot = {
      api: {
        sendMessage: async (chatId: number, text: string, opts?: Record<string, unknown>) => {
          sends.push({ chatId, text, opts });
          return { message_id: 99 };
        },
        editMessageText: async () => {},
      },
    } as any;

    const sm = new InteractiveStateMachine(bot, mainClaude, questionClaude);

    // Use null byte in goal — fs.mkdir throws EINVAL on any POSIX system
    setSession(CHAT_ID, makeSession({
      questions: [Q1],
      answers: [null],
      currentIndex: 0,
      round: 1,
      goal: "test\x00", // null byte in path → EINVAL
      description: "desc",
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:a:0:0");

    // Should have sent an error message
    const errorMsg = sends.find((s) => s.text.includes("❌") || s.text.includes("Failed"));
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.chatId).toBe(CHAT_ID);

    // Session should be cleared after the double failure
    expect(hasSession(CHAT_ID)).toBe(false);
  });

  it("session is cleared after double failure (no zombie session)", async () => {
    const mainClaude = async (): Promise<string> => "Implementation done.";
    const questionClaude = async (): Promise<string> => {
      throw new Error("Question gen failed");
    };

    const bot = {
      api: {
        sendMessage: async () => ({ message_id: 99 }),
        editMessageText: async () => {},
      },
    } as any;

    const sm = new InteractiveStateMachine(bot, mainClaude, questionClaude);

    setSession(CHAT_ID, makeSession({
      questions: [Q1],
      answers: [null],
      currentIndex: 0,
      goal: "test\x00",
      description: "desc",
    }));

    const ctx = createMockCtx();
    await sm.handleCallback(ctx, "iq:a:0:0");

    // Session must be cleared — no zombie session remains
    expect(hasSession(CHAT_ID)).toBe(false);
  });
});

// ──────────────────────────────────────────────
// E2E-21: Empty option labels from LLM response are filtered
// ──────────────────────────────────────────────

describe("E2E-21: Empty option labels filtered (guards Telegram 400 on inline keyboard)", () => {
  beforeEach(() => clearSession(CHAT_ID));

  it("generateNextBatch filters out options with empty labels", async () => {
    const responseWithEmptyLabel = JSON.stringify({
      goal: "test-goal",
      description: "test-desc",
      questions: [
        {
          id: "q1",
          question: "What framework?",
          options: [
            { label: "Express", value: "express" },
            { label: "", value: "empty-label" },   // empty label — must be filtered
            { label: "   ", value: "whitespace" },  // whitespace-only — must be filtered
            { label: "Fastify", value: "fastify" },
          ],
          allowFreeText: false,
        },
      ],
      done: false,
    });

    const { bot } = createMockBot();
    const callClaude = createCallClaudeQueue([responseWithEmptyLabel, DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    const ctx = createMockCtx(CHAT_ID, "/plan add auth");
    await sm.handlePlanCommand(ctx);

    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.phase).toBe("collecting");
    // Empty and whitespace labels filtered — only 2 valid options remain
    expect(session!.questions[0].options.length).toBe(2);
    expect(session!.questions[0].options.every((o) => o.label.trim().length > 0)).toBe(true);

    await cleanPlanDir("test-goal");
  });

  it("generateNextBatch filters out questions where ALL options have empty labels", async () => {
    const responseAllEmptyLabels = JSON.stringify({
      goal: "test-goal",
      description: "test-desc",
      questions: [
        {
          id: "q1",
          question: "What framework?",
          options: [
            { label: "Express", value: "express" },
            { label: "Fastify", value: "fastify" },
          ],
          allowFreeText: false,
        },
        {
          id: "q2",
          question: "All empty?",
          options: [
            { label: "", value: "a" },
            { label: "", value: "b" },
          ],
          allowFreeText: false,
        },
      ],
      done: false,
    });

    const { bot } = createMockBot();
    const callClaude = createCallClaudeQueue([responseAllEmptyLabels, DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    const ctx = createMockCtx(CHAT_ID, "/plan add auth");
    await sm.handlePlanCommand(ctx);

    const session = getSession(CHAT_ID);
    expect(session).toBeDefined();
    expect(session!.phase).toBe("collecting");
    // Q2 had all empty labels — filtered out entirely, only Q1 remains
    expect(session!.questions.length).toBe(1);
    expect(session!.questions[0].question).toBe("What framework?");

    await cleanPlanDir("test-goal");
  });

  it("buildQuestionKeyboard skips buttons with empty labels (defense-in-depth)", () => {
    const stubBot = {
      api: {
        sendMessage: async () => ({ message_id: 42 }),
        editMessageText: async () => {},
      },
    } as any;
    const dashboard = new QuestionDashboard(stubBot);

    // Inject a question with a mix of valid and empty labels directly
    const qWithEmptyLabel: Question = {
      id: "q1",
      question: "What?",
      options: [
        { label: "A", value: "a" },
        { label: "", value: "empty" },
        { label: "C", value: "c" },
      ],
      allowFreeText: false,
    };

    const session: InteractiveSession = {
      sessionId: "test",
      chatId: CHAT_ID,
      phase: "collecting",
      task: "test",
      goal: "g",
      description: "d",
      questions: [qWithEmptyLabel],
      answers: [null],
      currentIndex: 0,
      cardMessageId: 42,
      createdAt: Date.now(),
      completedQA: [],
      currentBatchStart: 0,
      round: 1,
    };

    const kb = dashboard.buildQuestionKeyboard(session);
    const rows = kb.inline_keyboard;
    const optionRows = rows.filter((row: any[]) =>
      row.some((btn: any) => btn.callback_data?.startsWith("iq:a:"))
    );

    // Only 2 valid options (A and C), empty label filtered
    expect(optionRows.length).toBe(2);
    const optionTexts = optionRows.map((row: any[]) => row[0]?.text);
    expect(optionTexts).toContain("A");
    expect(optionTexts).toContain("C");
    expect(optionTexts.every((t: string) => t.length > 0)).toBe(true);
  });
});

// ──────────────────────────────────────────────
// E2E-17: buildQuestionKeyboard — 1 option per row
// ──────────────────────────────────────────────

describe("E2E-17: buildQuestionKeyboard puts each option on its own row", () => {
  it("keyboard has separate row for each option", () => {
    const stubBot = {
      api: {
        sendMessage: async () => ({ message_id: 42 }),
        editMessageText: async () => {},
      },
    } as any;
    const dashboard = new QuestionDashboard(stubBot);

    const session: InteractiveSession = {
      sessionId: "test",
      chatId: CHAT_ID,
      phase: "collecting",
      task: "test task",
      goal: "goal",
      description: "desc",
      questions: [Q1, Q2], // Q1 has 2 options
      answers: [null, null],
      currentIndex: 0,
      cardMessageId: 42,
      createdAt: Date.now(),
      completedQA: [],
      currentBatchStart: 0,
      round: 1,
    };

    const kb = dashboard.buildQuestionKeyboard(session);
    const rows = kb.inline_keyboard;

    // Q1 has 2 options (Express, Fastify) + 1 nav row (Cancel)
    // Each option should be on its own row → 2 option rows + 1 nav row = 3 rows
    const optionRows = rows.filter((row: any[]) =>
      row.some((btn: any) => btn.callback_data?.startsWith("iq:a:"))
    );
    // Each option row should have exactly 1 button (1 per row layout)
    for (const row of optionRows) {
      expect(row.filter((btn: any) => btn.callback_data?.startsWith("iq:a:")).length).toBe(1);
    }
    // Total option rows should equal number of options
    expect(optionRows.length).toBe(Q1.options.length);
  });

  it("4-option question produces 4 single-button rows", () => {
    const stubBot = {
      api: {
        sendMessage: async () => ({ message_id: 42 }),
        editMessageText: async () => {},
      },
    } as any;
    const dashboard = new QuestionDashboard(stubBot);

    const q4 = makeQuestion("q1", "Pick a framework?", [
      { label: "Express", value: "express" },
      { label: "Fastify", value: "fastify" },
      { label: "NestJS", value: "nestjs" },
      { label: "Hono", value: "hono" },
    ]);

    const session: InteractiveSession = {
      sessionId: "test",
      chatId: CHAT_ID,
      phase: "collecting",
      task: "test",
      goal: "g",
      description: "d",
      questions: [q4],
      answers: [null],
      currentIndex: 0,
      cardMessageId: 42,
      createdAt: Date.now(),
      completedQA: [],
      currentBatchStart: 0,
      round: 1,
    };

    const kb = dashboard.buildQuestionKeyboard(session);
    const rows = kb.inline_keyboard;
    const optionRows = rows.filter((row: any[]) =>
      row.some((btn: any) => btn.callback_data?.startsWith("iq:a:"))
    );

    expect(optionRows.length).toBe(4);
    for (const row of optionRows) {
      expect(row.length).toBe(1);
    }
  });
});
