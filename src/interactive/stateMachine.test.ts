/**
 * Tests for InteractiveStateMachine multi-round Q&A flow.
 *
 * Tests use the public API (handleCallback, handleFreeText, handlePlanCommand)
 * with mocked bot and callClaude, plus direct sessionStore access for setup/verification.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { InteractiveStateMachine } from "./stateMachine.ts";
import type { InteractiveSession, Question } from "./types.ts";
import {
  setSession,
  getSession,
  clearSession,
} from "./sessionStore.ts";
import fs from "node:fs/promises";
import path from "node:path";

// ──────────────────────────────────────────────
// Shared fixtures
// ──────────────────────────────────────────────

const CHAT_ID = 12345;

function makeQuestion(id: string, question: string, options: { label: string; value: string }[]): Question {
  return { id, question, options, allowFreeText: false };
}

const Q_FRAMEWORK = makeQuestion("q1", "What framework?", [
  { label: "Express", value: "express" },
  { label: "Fastify", value: "fastify" },
]);

const Q_TOKEN_STORAGE = makeQuestion("q2", "Token storage?", [
  { label: "Cookie", value: "cookie" },
  { label: "localStorage", value: "ls" },
]);

const Q_DB = makeQuestion("q3", "Database?", [
  { label: "PostgreSQL", value: "pg" },
  { label: "MySQL", value: "mysql" },
]);

function makeSession(overrides: Partial<InteractiveSession> = {}): InteractiveSession {
  return {
    sessionId: "test-session-001",
    chatId: CHAT_ID,
    phase: "collecting",
    task: "add JWT authentication",
    goal: "jwt-auth",
    description: "implement-jwt-auth-system",
    questions: [Q_FRAMEWORK],
    answers: [null],
    currentIndex: 0,
    cardMessageId: 42,
    createdAt: Date.now(),
    completedQA: [],
    currentBatchStart: 0,
    round: 1,
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// Mock factories
// ──────────────────────────────────────────────

function createMockBot() {
  const messages: string[] = [];
  const edits: string[] = [];
  const bot = {
    api: {
      sendMessage: async (_chatId: number, text: string, _opts?: any) => {
        messages.push(text);
        return { message_id: 99 };
      },
      editMessageText: async (_chatId: number, _msgId: number, text: string, _opts?: any) => {
        edits.push(text);
      },
    },
  } as any;
  return { bot, messages, edits };
}

function createMockCtx(chatId: number = CHAT_ID) {
  return {
    chat: { id: chatId },
    answerCallbackQuery: async () => {},
    reply: async () => {},
    message: { text: "" },
  } as any;
}

/** Build a callClaude mock that returns responses from a queue. */
function createCallClaudeQueue(responses: string[]) {
  let callIndex = 0;
  return async (_prompt: string): Promise<string> => {
    if (callIndex >= responses.length) {
      throw new Error(`callClaude called more times (${callIndex + 1}) than expected (${responses.length})`);
    }
    return responses[callIndex++];
  };
}

// ──────────────────────────────────────────────
// Standard Claude response payloads
// ──────────────────────────────────────────────

const ROUND1_RESPONSE = JSON.stringify({
  goal: "jwt-auth",
  description: "impl-jwt",
  questions: [
    { id: "q1", question: "What framework?", options: [{ label: "Express", value: "express" }, { label: "Fastify", value: "fastify" }], allowFreeText: false },
  ],
  done: false,
});

const ROUND2_RESPONSE = JSON.stringify({
  done: false,
  questions: [
    { id: "q2", question: "Token storage?", options: [{ label: "Cookie", value: "cookie" }, { label: "localStorage", value: "ls" }], allowFreeText: false },
  ],
});

const DONE_RESPONSE = JSON.stringify({
  done: true,
  questions: [],
});

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe("InteractiveStateMachine multi-round", () => {
  beforeEach(() => {
    clearSession(CHAT_ID);
  });

  describe("TC-MULTI-1: onBatchComplete triggered after last Q in batch", () => {
    it("populates completedQA after answering the only question in the batch", async () => {
      const { bot } = createMockBot();
      const callClaude = createCallClaudeQueue([DONE_RESPONSE]);
      const sm = new InteractiveStateMachine(bot, callClaude);

      // Set up a session with 1 question
      const session = makeSession({
        questions: [Q_FRAMEWORK],
        answers: [null],
        currentIndex: 0,
        round: 1,
        completedQA: [],
        currentBatchStart: 0,
      });
      setSession(CHAT_ID, session);

      const ctx = createMockCtx();

      // Answer Q1 (option 0 = "express") — this is the last question in the batch
      await sm.handleCallback(ctx, "iq:a:0:0");

      // After onBatchComplete, since callClaude returns done:true, session should
      // be in "confirming" phase with completedQA populated
      const updated = getSession(CHAT_ID);
      expect(updated).toBeDefined();
      expect(updated!.completedQA.length).toBe(1);
      expect(updated!.completedQA[0].question).toBe("What framework?");
      expect(updated!.completedQA[0].answer).toBe("express");
      expect(updated!.phase).toBe("confirming");
    });
  });

  describe("TC-MULTI-2: completedQA accumulates across rounds", () => {
    it("has entries from both rounds after completing 2 rounds", async () => {
      const { bot } = createMockBot();
      // Call 1: after round 1 batch complete, return round 2 questions
      // Call 2: after round 2 batch complete, return done
      const callClaude = createCallClaudeQueue([ROUND2_RESPONSE, DONE_RESPONSE]);
      const sm = new InteractiveStateMachine(bot, callClaude);

      // Set up round 1 with 1 question
      const session = makeSession({
        questions: [Q_FRAMEWORK],
        answers: [null],
        currentIndex: 0,
        round: 1,
        completedQA: [],
        currentBatchStart: 0,
      });
      setSession(CHAT_ID, session);

      const ctx = createMockCtx();

      // Answer round 1 Q1 → triggers onBatchComplete → callClaude returns round 2 questions
      await sm.handleCallback(ctx, "iq:a:0:0");

      // Session should now have the round 2 question appended
      let current = getSession(CHAT_ID);
      expect(current).toBeDefined();
      expect(current!.round).toBe(2);
      expect(current!.questions.length).toBe(2); // original Q + new Q
      expect(current!.currentIndex).toBe(1); // pointing to the new question
      expect(current!.completedQA.length).toBe(1); // round 1 QA recorded

      // Answer round 2 Q (index 1, option 0 = "cookie") → onBatchComplete → done
      await sm.handleCallback(ctx, "iq:a:1:0");

      current = getSession(CHAT_ID);
      expect(current).toBeDefined();
      expect(current!.completedQA.length).toBe(2);
      expect(current!.completedQA[0].question).toBe("What framework?");
      expect(current!.completedQA[0].answer).toBe("express");
      expect(current!.completedQA[1].question).toBe("Token storage?");
      expect(current!.completedQA[1].answer).toBe("cookie");
      expect(current!.phase).toBe("confirming");
    });
  });

  describe("TC-MULTI-3: done:true leads to advanceToSummary", () => {
    it("sets phase to confirming when callClaude returns done:true", async () => {
      const { bot } = createMockBot();
      const callClaude = createCallClaudeQueue([DONE_RESPONSE]);
      const sm = new InteractiveStateMachine(bot, callClaude);

      const session = makeSession({
        questions: [Q_FRAMEWORK],
        answers: [null],
        currentIndex: 0,
        round: 1,
      });
      setSession(CHAT_ID, session);

      const ctx = createMockCtx();
      await sm.handleCallback(ctx, "iq:a:0:0");

      const updated = getSession(CHAT_ID);
      expect(updated).toBeDefined();
      expect(updated!.phase).toBe("confirming");
    });
  });

  describe("TC-MULTI-4: Round cap at 5 forces done", () => {
    it("skips callClaude and goes to summary when round would exceed 5", async () => {
      const { bot } = createMockBot();
      // This callClaude should NOT be called — the round cap short-circuits
      let claudeCalled = false;
      const callClaude = async (_prompt: string): Promise<string> => {
        claudeCalled = true;
        return DONE_RESPONSE;
      };
      const sm = new InteractiveStateMachine(bot, callClaude);

      // Session at round 4 — answering last Q triggers onBatchComplete
      // which calls generateNextBatch(task, qa, 5) → round >= 5 → done immediately
      const session = makeSession({
        questions: [Q_FRAMEWORK, Q_TOKEN_STORAGE],
        answers: ["express", null],
        currentIndex: 1,
        round: 4,
        completedQA: [{ question: "What framework?", answer: "express" }],
        currentBatchStart: 1,
      });
      setSession(CHAT_ID, session);

      const ctx = createMockCtx();
      await sm.handleCallback(ctx, "iq:a:1:0"); // answer Q2

      const updated = getSession(CHAT_ID);
      expect(updated).toBeDefined();
      expect(updated!.phase).toBe("confirming");
      // callClaude should not have been called for batch generation
      expect(claudeCalled).toBe(false);
    });
  });

  describe("TC-MULTI-5: Plan markdown includes ALL completedQA", () => {
    it("writes a plan file containing Q&A from both rounds", async () => {
      const { bot } = createMockBot();
      const callClaude = createCallClaudeQueue([DONE_RESPONSE]);
      const sm = new InteractiveStateMachine(bot, callClaude);

      // Session with 1 question left but completedQA already has round 1 data
      const session = makeSession({
        questions: [Q_FRAMEWORK, Q_TOKEN_STORAGE],
        answers: ["express", null],
        currentIndex: 1,
        round: 2,
        completedQA: [{ question: "What framework?", answer: "express" }],
        currentBatchStart: 1,
        goal: "jwt-auth",
        description: "implement-jwt-auth-system",
      });
      setSession(CHAT_ID, session);

      const ctx = createMockCtx();
      // Answer the last question → onBatchComplete → done → savePlan
      await sm.handleCallback(ctx, "iq:a:1:0");

      // Read the saved plan file
      const planPath = path.join(".claude/todos", "jwt-auth", "implement-jwt-auth-system.md");
      try {
        const content = await fs.readFile(planPath, "utf-8");

        // Verify both rounds' Q&A are in the file
        expect(content).toContain("What framework?");
        expect(content).toContain("express");
        expect(content).toContain("Token storage?");
        expect(content).toContain("cookie");
        expect(content).toContain("Rounds:");
      } finally {
        // Clean up the written file
        try {
          await fs.rm(path.join(".claude/todos", "jwt-auth"), { recursive: true });
        } catch {
          // ignore cleanup errors
        }
      }
    });
  });

  describe("TC-MULTI-6: Back navigation works within batch", () => {
    it("moves currentIndex back and clears the current answer", async () => {
      const { bot } = createMockBot();
      const callClaude = async () => DONE_RESPONSE;
      const sm = new InteractiveStateMachine(bot, callClaude);

      // Set up 2 questions in a batch, Q1 already answered, on Q2
      const session = makeSession({
        questions: [Q_FRAMEWORK, Q_TOKEN_STORAGE],
        answers: ["express", null],
        currentIndex: 1,
        round: 1,
        currentBatchStart: 0,
      });
      setSession(CHAT_ID, session);

      const ctx = createMockCtx();
      await sm.handleCallback(ctx, "iq:back");

      const updated = getSession(CHAT_ID);
      expect(updated).toBeDefined();
      expect(updated!.currentIndex).toBe(0);
      // The answer at position 1 should be null (cleared)
      expect(updated!.answers[1]).toBeNull();
    });
  });

  describe("handleFreeText triggers onBatchComplete on last question", () => {
    it("calls onBatchComplete when free-text answers the last question", async () => {
      const { bot } = createMockBot();
      const callClaude = createCallClaudeQueue([DONE_RESPONSE]);
      const sm = new InteractiveStateMachine(bot, callClaude);

      const freeTextQ = { ...Q_FRAMEWORK, allowFreeText: true };
      const session = makeSession({
        questions: [freeTextQ],
        answers: [null],
        currentIndex: 0,
        round: 1,
      });
      setSession(CHAT_ID, session);

      const ctx = createMockCtx();
      const consumed = await sm.handleFreeText(ctx, "NestJS");

      expect(consumed).toBe(true);
      const updated = getSession(CHAT_ID);
      expect(updated).toBeDefined();
      expect(updated!.phase).toBe("confirming");
      expect(updated!.completedQA.length).toBe(1);
      expect(updated!.completedQA[0].answer).toBe("NestJS");
    });
  });

  describe("confirm uses completedQA for context", () => {
    it("sends a prompt containing all completedQA entries to callClaude", async () => {
      const { bot, messages } = createMockBot();
      let capturedPrompt = "";
      const callClaude = async (prompt: string): Promise<string> => {
        capturedPrompt = prompt;
        return "Implementation complete.";
      };
      const sm = new InteractiveStateMachine(bot, callClaude);

      const session = makeSession({
        phase: "confirming",
        questions: [Q_FRAMEWORK, Q_TOKEN_STORAGE],
        answers: ["express", "cookie"],
        completedQA: [
          { question: "What framework?", answer: "express" },
          { question: "Token storage?", answer: "cookie" },
        ],
        round: 2,
      });
      setSession(CHAT_ID, session);

      const ctx = createMockCtx();
      await sm.handleCallback(ctx, "iq:confirm");

      // The prompt sent to Claude should contain completedQA content
      expect(capturedPrompt).toContain("What framework?");
      expect(capturedPrompt).toContain("express");
      expect(capturedPrompt).toContain("Token storage?");
      expect(capturedPrompt).toContain("cookie");

      // Response should have been sent to the user
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.some((m) => m.includes("Implementation complete"))).toBe(true);
    });
  });

  describe("expired session returns early", () => {
    it("does nothing when session has expired", async () => {
      const { bot } = createMockBot();
      const callClaude = async () => DONE_RESPONSE;
      const sm = new InteractiveStateMachine(bot, callClaude);

      // Set a session that has already expired
      const session = makeSession({
        createdAt: Date.now() - 31 * 60 * 1000, // 31 minutes ago
      });
      setSession(CHAT_ID, session);

      const ctx = createMockCtx();
      // This should not throw and should not modify anything
      await sm.handleCallback(ctx, "iq:a:0:0");

      // getSession should return undefined (expired)
      expect(getSession(CHAT_ID)).toBeUndefined();
    });
  });
});
