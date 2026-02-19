/**
 * Interactive Q&A State Machine
 *
 * Orchestrates the full /plan flow:
 *   1. /plan <task>    → show loading card → generate questions → Q1
 *   2. User taps/types → record answer → next Q
 *   3. All answered    → save plan → show summary card
 *   4. Confirm         → spawn Claude with full context
 *   5. Edit            → jump back to a question
 *   6. Cancel          → delete session, update card
 *
 * Entry points:
 *   handlePlanCommand(ctx, task)
 *   handleCallback(ctx, data)    → call from bot.on("callback_query:data")
 *   handleFreeText(ctx, text)    → call early in bot.on("message:text"), returns true if consumed
 */

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import type { Context, Bot } from "grammy";
import { QuestionDashboard } from "./questionDashboard.ts";
import {
  setSession,
  getSession,
  updateSession,
  clearSession,
  hasSession,
} from "./sessionStore.ts";
import type { InteractiveSession, Question, BatchResult } from "./types.ts";

type CallerCallClaude = (prompt: string) => Promise<string>;

const PLAN_DIR = ".claude/todos";

export class InteractiveStateMachine {
  private dashboard: QuestionDashboard;

  constructor(
    private bot: Bot,
    private callClaude: CallerCallClaude,
    /** Optional lighter callable for question generation (e.g. claudeText).
     * Falls back to callClaude when not provided. */
    private callClaudeForQuestions?: CallerCallClaude
  ) {
    this.dashboard = new QuestionDashboard(bot);
  }

  // ──────────────────────────────────────────────
  // /plan <task>
  // ──────────────────────────────────────────────

  async handlePlanCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const task = ctx.message?.text?.replace(/^\/plan\s*/i, "").trim() ?? "";
    if (!task) {
      await ctx.reply("Usage: /plan <task description>\nExample: /plan add user authentication");
      return;
    }

    // If an active session exists, ask to cancel first
    if (hasSession(chatId)) {
      await ctx.reply(
        "You already have an active planning session.\nTap \u2716 Cancel in the card above, or send /plan again to override."
      );
      clearSession(chatId); // override: clear old one
    }

    // Show loading card immediately
    const cardMessageId = await this.dashboard.createLoadingCard(chatId, task);

    const now = Date.now();
    const session: InteractiveSession = {
      sessionId: crypto.randomUUID(),
      chatId,
      phase: "loading",
      task,
      goal: "",
      description: "",
      questions: [],
      answers: [],
      currentIndex: 0,
      cardMessageId,
      createdAt: now,
      lastActivityAt: now,
      completedQA: [],
      currentBatchStart: 0,
      round: 1,
    };
    setSession(chatId, session);

    // Generate first batch of questions (Claude call)
    try {
      const result = await this.generateNextBatch(task, [], 1);
      const updated = updateSession(chatId, {
        phase: "collecting",
        goal: result.goal ?? "",
        description: result.description ?? "",
        questions: result.questions,
        answers: new Array(result.questions.length).fill(null),
        completedQA: [],
        currentBatchStart: 0,
        round: 1,
      });
      if (updated) await this.dashboard.showQuestion(updated);
    } catch (err) {
      console.error("[interactive] Failed to generate questions:", err);
      clearSession(chatId);
      try {
        await this.bot.api.editMessageText(
          chatId,
          cardMessageId,
          "\u274C Failed to generate questions. Please try /plan again."
        );
      } catch {
        /* ignore */
      }
    }
  }

  // ──────────────────────────────────────────────
  // Callback query handler (iq:* prefix)
  // ──────────────────────────────────────────────

  async handleCallback(ctx: Context, data: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const session = getSession(chatId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "Session expired. Use /plan to start again." }).catch(() => {});
      return;
    }

    // iq:a:{qIdx}:{oIdx}
    if (data.startsWith("iq:a:")) {
      const [, , qIdx, oIdx] = data.split(":");
      const qIdxNum = parseInt(qIdx);
      // Show instant toast when this is the last answer and will trigger a backend fetch.
      // This fires before any card edit, closing the "button looks broken" timing gap.
      const willFetch =
        qIdxNum === session.currentIndex &&
        qIdxNum + 1 >= session.questions.length &&
        session.editingIndex === undefined;
      await ctx
        .answerCallbackQuery(willFetch ? { text: "✓ Reviewing your answers…" } : {})
        .catch(() => {});
      await this.recordAnswer(session, qIdxNum, parseInt(oIdx));
      return;
    }

    await ctx.answerCallbackQuery().catch(() => {});

    if (data === "iq:back") {
      await this.goBack(session);
      return;
    }

    if (data === "iq:edit") {
      const updated = updateSession(chatId, {}) ?? session;
      await this.dashboard.showEditMenu(updated);
      return;
    }

    // iq:eq:{qIdx}
    if (data.startsWith("iq:eq:")) {
      const qIdx = parseInt(data.split(":")[2]);
      await this.editQuestion(session, qIdx);
      return;
    }

    if (data === "iq:edit_cancel") {
      // Back from edit menu to summary
      const planPath = buildPlanPath(session);
      await this.dashboard.showSummary(session, planPath);
      return;
    }

    if (data === "iq:confirm") {
      await this.confirm(session);
      return;
    }

    if (data === "iq:cancel") {
      await this.cancel(session);
      return;
    }
  }

  // ──────────────────────────────────────────────
  // Free-text message handler
  // ──────────────────────────────────────────────

  /** Returns true if the message was consumed by the interactive flow. */
  async handleFreeText(ctx: Context, text: string): Promise<boolean> {
    const chatId = ctx.chat?.id;
    if (!chatId) return false;

    const session = getSession(chatId);
    if (!session || session.phase !== "collecting") return false;

    const q = session.questions[session.currentIndex];
    if (!q) return false;

    if (!q.allowFreeText) {
      await ctx.reply("\u261D\uFE0F Please use the buttons to answer.");
      return true; // consumed — don't pass to Claude
    }

    // Record the typed answer
    const newAnswers = [...session.answers];
    newAnswers[session.currentIndex] = text;

    // Single-question edit mode: update only this answer then return to summary
    if (session.editingIndex !== undefined) {
      const updated = updateSession(chatId, { answers: newAnswers, editingIndex: undefined });
      if (updated) {
        const planPath = buildPlanPath(updated);
        await this.dashboard.showSummary(updated, planPath);
      }
      return true;
    }

    if (session.currentIndex + 1 < session.questions.length) {
      const updated = updateSession(chatId, {
        answers: newAnswers,
        currentIndex: session.currentIndex + 1,
      });
      if (updated) await this.dashboard.showQuestion(updated);
    } else {
      const updated = updateSession(chatId, { answers: newAnswers });
      if (updated) await this.onBatchComplete(updated);
    }

    return true;
  }

  // ──────────────────────────────────────────────
  // Internal actions
  // ──────────────────────────────────────────────

  private async recordAnswer(
    session: InteractiveSession,
    qIdx: number,
    oIdx: number
  ): Promise<void> {
    const { chatId, questions } = session;
    if (qIdx !== session.currentIndex) return; // stale button tap

    const option = questions[qIdx]?.options[oIdx];
    if (!option) return;

    const newAnswers = [...session.answers];
    newAnswers[qIdx] = option.value;

    // Single-question edit mode: update only this answer then return to summary
    if (session.editingIndex !== undefined) {
      const updated = updateSession(chatId, { answers: newAnswers, editingIndex: undefined });
      if (updated) {
        const planPath = buildPlanPath(updated);
        await this.dashboard.showSummary(updated, planPath);
      }
      return;
    }

    if (qIdx + 1 < questions.length) {
      const updated = updateSession(chatId, {
        answers: newAnswers,
        currentIndex: qIdx + 1,
      });
      if (updated) await this.dashboard.showQuestion(updated);
    } else {
      const updated = updateSession(chatId, { answers: newAnswers });
      if (updated) await this.onBatchComplete(updated);
    }
  }

  private async goBack(session: InteractiveSession): Promise<void> {
    const { chatId, currentIndex, answers } = session;
    if (currentIndex === 0) return;

    const newAnswers = [...answers];
    newAnswers[currentIndex] = null; // clear current (unanswered) Q

    const updated = updateSession(chatId, {
      currentIndex: currentIndex - 1,
      answers: newAnswers,
    });
    if (updated) await this.dashboard.showQuestion(updated);
  }

  /** Called when user picks a question from the edit menu. Preserves all other answers. */
  private async editQuestion(session: InteractiveSession, qIdx: number): Promise<void> {
    const { chatId, questions } = session;
    if (qIdx < 0 || qIdx >= questions.length) return;

    const updated = updateSession(chatId, {
      phase: "collecting",
      currentIndex: qIdx,
      editingIndex: qIdx,
    });
    if (updated) await this.dashboard.showQuestion(updated);
  }

  /** Called when user taps Back during normal Q&A (not edit mode). */
  private async jumpToQuestion(session: InteractiveSession, qIdx: number): Promise<void> {
    const { chatId, questions } = session;
    if (qIdx < 0 || qIdx >= questions.length) return;

    // Clear answers from qIdx onwards so user re-answers them in sequence
    const newAnswers = [...session.answers];
    for (let i = qIdx; i < newAnswers.length; i++) newAnswers[i] = null;

    const updated = updateSession(chatId, {
      phase: "collecting",
      currentIndex: qIdx,
      answers: newAnswers,
    });
    if (updated) await this.dashboard.showQuestion(updated);
  }

  private async onBatchComplete(session: InteractiveSession): Promise<void> {
    const { chatId, questions, answers, currentBatchStart, completedQA, round } = session;

    // Build Q&A pairs for the current batch
    const batchPairs: { question: string; answer: string }[] = [];
    for (let i = currentBatchStart; i < questions.length; i++) {
      batchPairs.push({
        question: questions[i].question,
        answer: answers[i] ?? "not specified",
      });
    }
    const newCompletedQA = [...completedQA, ...batchPairs];

    // Show loading state while generating next batch
    await this.dashboard.showRoundLoading(session);

    try {
      const result = await this.generateNextBatch(session.task, newCompletedQA, round + 1);

      if (result.done || result.questions.length === 0) {
        // No more questions — advance to summary
        const updated = updateSession(chatId, { completedQA: newCompletedQA });
        if (updated) await this.advanceToSummary(updated);
      } else {
        // Append new questions, advance round
        const newQuestions = [...questions, ...result.questions];
        const newAnswers = [...answers, ...new Array(result.questions.length).fill(null)];
        const updated = updateSession(chatId, {
          questions: newQuestions,
          answers: newAnswers,
          currentBatchStart: questions.length,
          currentIndex: questions.length,
          round: round + 1,
          completedQA: newCompletedQA,
        });
        if (updated) await this.dashboard.showQuestion(updated);
      }
    } catch (err) {
      console.error("[interactive] Failed to generate next batch:", err);
      // On error, try to advance to summary with what we have
      try {
        const updated = updateSession(chatId, { completedQA: newCompletedQA });
        if (updated) await this.advanceToSummary(updated);
      } catch (summaryErr) {
        console.error("[interactive] advanceToSummary also failed:", summaryErr);
        // Card is stuck at "Reviewing your answers…" — send a plain error message
        await this.bot.api
          .sendMessage(chatId, "❌ Failed to generate follow-up questions. Use /plan to start again.")
          .catch(() => {});
        clearSession(chatId);
      }
    }
  }

  private async advanceToSummary(session: InteractiveSession): Promise<void> {
    const { chatId } = session;
    const planPath = buildPlanPath(session);
    await savePlan(session, planPath);
    const updated = updateSession(chatId, { phase: "confirming" });
    if (updated) await this.dashboard.showSummary(updated, planPath);
  }

  private async confirm(session: InteractiveSession): Promise<void> {
    const { chatId, task, completedQA } = session;

    const updated = updateSession(chatId, { phase: "done" });
    if (updated) await this.dashboard.showExecuting(updated);
    clearSession(chatId);

    // Build rich context prompt from all rounds
    const qaContext = completedQA
      .map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`)
      .join("\n\n");

    const prompt =
      `You are an expert software engineer who practices strict Test-Driven Development (TDD).\n\n` +
      `Your approach:\n` +
      `1. Write failing tests FIRST (red) that precisely capture the requirements\n` +
      `2. Write the minimal implementation to make tests pass (green)\n` +
      `3. Refactor for clarity and simplicity without breaking tests\n\n` +
      `Principles you follow:\n` +
      `- Each function/module has a single, clear responsibility\n` +
      `- Tests are the living specification — they document intent, not just behaviour\n` +
      `- No stubs, placeholders, or TODOs — every function either works or doesn't exist\n` +
      `- Prefer simple, explicit code over clever abstractions\n` +
      `- Remove dead code immediately\n\n` +
      `# Task\n${task}\n\n` +
      `# Requirements (gathered from user)\n${qaContext}\n\n` +
      `Implement this task using TDD. Show tests first, then implementation.\n`;

    try {
      const response = await this.callClaude(prompt);
      // Send response in chunks if needed
      const CHUNK = 4000;
      for (let i = 0; i < response.length; i += CHUNK) {
        await this.bot.api.sendMessage(chatId, response.slice(i, i + CHUNK));
      }
    } catch (err) {
      console.error("[interactive] Claude call failed after confirm:", err);
      await this.bot.api.sendMessage(
        chatId,
        "\u274C Claude failed to start. Your plan is saved — use /plan to try again."
      );
    }
  }

  private async cancel(session: InteractiveSession): Promise<void> {
    await this.dashboard.showCancelled(session);
    clearSession(session.chatId);
  }

  // ──────────────────────────────────────────────
  // Question generation (multi-round)
  // ──────────────────────────────────────────────

  private async generateNextBatch(
    task: string,
    completedQA: { question: string; answer: string }[],
    round: number
  ): Promise<BatchResult> {
    // Cap at 3 rounds — force done
    if (round >= 5) {
      return { questions: [], done: true };
    }

    let prompt: string;

    if (completedQA.length === 0) {
      // Round 1 — generate initial questions
      prompt = `You are a requirements analyst. Given a task, generate 2-4 focused clarifying questions.

Task: ${task}

Respond with ONLY valid JSON:
{
  "goal": "short-slug",
  "description": "longer-description-slug",
  "questions": [
    {
      "id": "q1",
      "question": "Question text (max 80 chars)?",
      "options": [
        {"label": "Short label", "value": "stored-value"}
      ],
      "allowFreeText": false
    }
  ],
  "done": false
}

Rules:
- goal: 1-3 words kebab-case
- description: 3-6 words kebab-case
- 2-4 questions, 2-4 options each, options.label <= 25 chars
- allowFreeText: true only when custom input needed`;
    } else {
      // Round 2+ — follow-up based on gathered answers
      const qaBlock = completedQA
        .map((qa) => `Q: ${qa.question} → ${qa.answer}`)
        .join("\n");

      prompt = `You are a requirements analyst.

Task: ${task}

Answers gathered so far:
${qaBlock}

Do you need more clarifying questions to implement this task?
If yes: {"done":false,"questions":[...]} (2-4 new questions, no repeats, same question format)
If no:  {"done":true,"questions":[]}

Round ${round} of 5 maximum.

Respond with ONLY valid JSON. Each question needs: id, question, options (2-4 with label ≤ 25 chars and value), allowFreeText.`;
    }

    const callFn = this.callClaudeForQuestions ?? this.callClaude;
    const raw = await callFn(prompt);

    // Extract JSON robustly — handles preamble text, code fences, postamble
    const extracted = extractJsonObject(raw);
    if (!extracted) {
      throw new Error("No valid JSON object found in Claude response");
    }
    const parsed = JSON.parse(extracted);

    if (parsed.done) {
      return { questions: [], done: true };
    }

    if (!parsed.questions || !Array.isArray(parsed.questions)) {
      throw new Error("Invalid question response from Claude");
    }

    // Re-number question IDs to avoid collisions with previous rounds.
    // Also filter out options with empty labels — any LLM (including Ollama fallback)
    // can return empty strings, which cause Telegram 400 on inline keyboard build.
    const offset = completedQA.length;
    const questions: Question[] = parsed.questions.slice(0, 4)
      .map((q: any, i: number) => ({
        ...q,
        id: `q${offset + i + 1}`,
        options: (q.options ?? []).filter(
          (o: any) => typeof o.label === "string" && o.label.trim().length > 0,
        ),
      }))
      .filter((q: any) => q.options.length > 0) as Question[];

    return {
      goal: parsed.goal ? slugify(parsed.goal) : undefined,
      description: parsed.description ? slugify(parsed.description) : undefined,
      questions,
      done: false,
    };
  }
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/**
 * Extract the first complete JSON object from a string.
 * Handles code fences, preamble text, and postamble text.
 */
function extractJsonObject(text: string): string | null {
  // Strategy 1: direct parse (clean JSON)
  try {
    JSON.parse(text.trim());
    return text.trim();
  } catch {}

  // Strategy 2: strip code fences and parse
  const stripped = text
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
  try {
    JSON.parse(stripped);
    return stripped;
  } catch {}

  // Strategy 3: find first { ... } block
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = text.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }

  return null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

function buildPlanPath(session: InteractiveSession): string {
  return path.join(PLAN_DIR, session.goal, `${session.description}.md`);
}

async function savePlan(session: InteractiveSession, planPath: string): Promise<void> {
  const { task, completedQA, sessionId, round } = session;

  const qaLines = completedQA
    .map((qa) => `**Q: ${qa.question}**\nA: ${qa.answer}`)
    .join("\n\n");

  const markdown = `# Plan: ${task}

**Created:** ${new Date().toISOString()}
**Session:** ${sessionId}
**Rounds:** ${round}

## Task
${task}

## Requirements (Q&A)

${qaLines}

## Context for Implementation

${completedQA.map((qa) => `- ${qa.question}: ${qa.answer}`).join("\n")}
`;

  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, markdown, "utf-8");
}
