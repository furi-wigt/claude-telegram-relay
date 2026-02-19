/**
 * Tests for QuestionDashboard card formatters.
 * Verifies the visual output without needing a live Telegram connection.
 */

import { describe, it, expect } from "bun:test";
import { QuestionDashboard } from "./questionDashboard.ts";
import type { InteractiveSession } from "./types.ts";

// Minimal bot stub — only the API calls we test are stubbed
const stubBot = {
  api: {
    sendMessage: async () => ({ message_id: 42 }),
    editMessageText: async () => {},
  },
} as unknown as Parameters<typeof QuestionDashboard>[0] extends never
  ? never
  // @ts-ignore — minimal stub
  : import("grammy").Bot;

const dashboard = new QuestionDashboard(stubBot as any);

const baseSession: InteractiveSession = {
  sessionId: "abc-def-123",
  chatId: 999,
  phase: "collecting",
  task: "add JWT authentication",
  goal: "jwt-auth",
  description: "implement-jwt-auth-system",
  questions: [
    {
      id: "q1",
      question: "What framework are you using?",
      options: [
        { label: "Express", value: "express" },
        { label: "Fastify", value: "fastify" },
        { label: "Hono", value: "hono" },
      ],
      allowFreeText: true,
    },
    {
      id: "q2",
      question: "Where should tokens be stored?",
      options: [
        { label: "HttpOnly cookie", value: "cookie" },
        { label: "localStorage", value: "localstorage" },
      ],
      allowFreeText: false,
    },
  ],
  answers: [null, null],
  currentIndex: 0,
  cardMessageId: 42,
  createdAt: Date.now(),
  completedQA: [],
  currentBatchStart: 0,
  round: 1,
};

describe("QuestionDashboard.formatLoading", () => {
  it("contains the task name", () => {
    const text = dashboard.formatLoading("add JWT authentication");
    expect(text).toContain("add JWT authentication");
    expect(text).toContain("Generating questions");
  });
});

describe("QuestionDashboard.formatQuestion", () => {
  it("shows Q1 of 2 with progress bar", () => {
    const text = dashboard.formatQuestion(baseSession);
    expect(text).toContain("Q1 of 2");
    expect(text).toContain("What framework are you using?");
    expect(text).toContain("Type a custom answer"); // allowFreeText = true
  });

  it("shows previous answer when on Q2", () => {
    const session: InteractiveSession = {
      ...baseSession,
      currentIndex: 1,
      answers: ["express", null],
    };
    const text = dashboard.formatQuestion(session);
    expect(text).toContain("Q2 of 2");
    expect(text).toContain("express");          // previous answer shown
    expect(text).not.toContain("Type a custom"); // Q2 allowFreeText=false
  });
});

describe("QuestionDashboard.formatSummary", () => {
  it("shows all answers and plan path", () => {
    const session: InteractiveSession = {
      ...baseSession,
      phase: "confirming",
      answers: ["express", "cookie"],
    };
    const text = dashboard.formatSummary(session, ".claude/todos/jwt-auth/implement-jwt-auth.md");
    expect(text).toContain("Plan Ready");
    expect(text).toContain("express");
    expect(text).toContain("cookie");
    expect(text).toContain(".claude/todos/jwt-auth/implement-jwt-auth.md");
    // shortId is MarkdownV2-escaped: hyphens become \-
    expect(text).toContain("abc\\-def\\-123");
  });
});

describe("QuestionDashboard.buildQuestionKeyboard", () => {
  it("has correct callback data for each option", () => {
    const kb = dashboard.buildQuestionKeyboard(baseSession);
    const flat = kb.inline_keyboard.flat();
    const datas = flat.map((btn) => btn.callback_data);

    // Option indices match
    expect(datas).toContain("iq:a:0:0"); // Q0, option 0
    expect(datas).toContain("iq:a:0:1"); // Q0, option 1
    expect(datas).toContain("iq:a:0:2"); // Q0, option 2
    expect(datas).toContain("iq:cancel");

    // No Back on first question
    expect(datas).not.toContain("iq:back");
  });

  it("has Back button on Q2", () => {
    const session = { ...baseSession, currentIndex: 1 };
    const kb = dashboard.buildQuestionKeyboard(session);
    const flat = kb.inline_keyboard.flat();
    const datas = flat.map((btn) => btn.callback_data);
    expect(datas).toContain("iq:back");
  });

  it("callback_data values are all ≤ 64 bytes", () => {
    const kb = dashboard.buildQuestionKeyboard(baseSession);
    for (const row of kb.inline_keyboard) {
      for (const btn of row) {
        const len = Buffer.byteLength(btn.callback_data ?? "", "utf8");
        expect(len).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe("QuestionDashboard.buildSummaryKeyboard", () => {
  it("has Confirm and Edit buttons", () => {
    const kb = dashboard.buildSummaryKeyboard();
    const flat = kb.inline_keyboard.flat();
    const datas = flat.map((btn) => btn.callback_data);
    expect(datas).toContain("iq:confirm");
    expect(datas).toContain("iq:edit");
  });
});
