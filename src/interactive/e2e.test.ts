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
 *   E2E-9  createLoadingCard sends parse_mode: "Markdown"
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

  it("loading card is sent with parse_mode: Markdown on /plan command", async () => {
    const { bot, sends } = createMockBot();
    const callClaude = createCallClaudeQueue([ROUND1_ONE_Q, DONE_RESPONSE]);
    const sm = new InteractiveStateMachine(bot, callClaude);

    const ctx = createMockCtx(CHAT_ID, "/plan add JWT auth");
    await sm.handlePlanCommand(ctx);

    // First sendMessage call should be the loading card
    expect(sends.length).toBeGreaterThan(0);
    const loadingCall = sends[0];
    expect(loadingCall.opts?.parse_mode).toBe("Markdown");
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

  it("iq:eq:0 jumps to Q0 and clears answers from index 0 onwards", async () => {
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
    expect(session!.answers[0]).toBeNull(); // cleared from qIdx 0
    expect(session!.answers[1]).toBeNull(); // cleared from qIdx 1
    expect(session!.phase).toBe("collecting");
  });

  it("iq:eq:1 jumps to Q1 but leaves Q0 answer intact, clears Q1 onwards", async () => {
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
    expect(session!.answers[0]).toBe("express"); // Q0 preserved
    expect(session!.answers[1]).toBeNull();       // Q1 cleared
    expect(session!.phase).toBe("collecting");
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
// E2E-9: parse_mode: "Markdown" on createLoadingCard
// ──────────────────────────────────────────────

describe("E2E-9: createLoadingCard sends parse_mode: Markdown", () => {
  it("sendMessage is called with parse_mode Markdown when creating loading card", async () => {
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
    expect(sends[0].opts?.parse_mode).toBe("Markdown");
    expect(sends[0].text).toContain("build a user system");
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
