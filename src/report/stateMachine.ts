/**
 * Report QA State Machine
 *
 * Orchestrates the full QA session lifecycle:
 *   start → loading → active → collecting → submitting → active → ... → ending → done
 *                                   ↕
 *                                paused
 *
 * Entry points:
 *   handleStart(ctx, slug, project)  — /report qa <slug>
 *   handleResume(ctx)                — /report qa resume
 *   handleCallback(ctx, data)        — rpq:* inline keyboard callbacks
 *   handleFreeText(ctx, text)        — intercept text messages in QA mode
 *   handleVoice(ctx, transcription)  — intercept voice transcriptions in QA mode
 */

import type { Bot, Context } from "grammy";
import { randomUUID } from "crypto";
import {
  setReportQASession,
  getReportQASession,
  updateReportQASession,
  clearReportQASession,
  hasActiveReportQA,
  saveCheckpoint,
  loadCheckpoint,
} from "./sessionStore.ts";
import {
  initTranscript,
  appendExchange,
  countExchanges,
  removeLastExchange,
  readTranscript,
} from "./transcriptWriter.ts";
import {
  readManifest,
  getActiveProject,
  getTranscriptPath,
  getFindingsPath,
  getCheckpointPath,
  getManifestPath,
  registerResearchInManifest,
} from "./manifestReader.ts";
import { generateQuestion, generateFindings } from "./questionEngine.ts";
import { writeFindings } from "./transcriptWriter.ts";
import { ReportQADashboard } from "./dashboard.ts";
import { RPQ_PREFIX, RPQ_ACTIONS } from "./types.ts";
import type { ReportQASession, ReportManifest } from "./types.ts";

export class ReportQAStateMachine {
  private dashboard: ReportQADashboard;

  constructor(private bot: Bot) {
    this.dashboard = new ReportQADashboard(bot);
  }

  // ── Entry: Start QA ────────────────────────────────────────────────────────

  async handleStart(ctx: Context, slug: string, project?: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const threadId = ctx.message?.message_thread_id ?? null;

    // Resolve project
    const resolvedProject = project ?? getActiveProject();
    if (!resolvedProject) {
      await ctx.reply(
        "No active project. Set one with `report project use <name>` on your Mac, " +
        "or specify: /report qa <slug> <project>"
      );
      return;
    }

    // Read manifest
    const manifest = readManifest(resolvedProject, slug);
    if (!manifest) {
      await ctx.reply(
        `No manifest found for "${slug}" in project "${resolvedProject}".\n` +
        `Create it first: \`report new ${slug}\` on your Mac.`
      );
      return;
    }

    // Check for existing active session
    const existing = getReportQASession(chatId);
    if (existing && existing.phase !== "paused" && existing.phase !== "done") {
      await ctx.reply(
        `QA session already active for "${existing.slug}". ` +
        `Tap [Pause] or [End] first, or /report qa resume.`
      );
      return;
    }

    // Check for disk checkpoint (resume from previous session)
    const checkpointPath = getCheckpointPath(resolvedProject, slug);
    const checkpoint = loadCheckpoint(checkpointPath);
    if (checkpoint && checkpoint.exchanges.length > 0) {
      await this.resumeFromCheckpoint(chatId, threadId, checkpoint, manifest);
      return;
    }

    // Create new session
    const transcriptPath = getTranscriptPath(resolvedProject, slug);
    const findingsPath = getFindingsPath(resolvedProject, slug);

    const session: ReportQASession = {
      sessionId: randomUUID(),
      chatId,
      threadId,
      phase: "loading",
      slug,
      project: resolvedProject,
      archetype: manifest.archetype ?? null,
      audience: manifest.audience ?? null,
      sections: manifest.sections ?? [],
      exchanges: [],
      currentQuestion: null,
      answerBuffer: [],
      cardMessageId: null,
      transcriptPath,
      findingsPath,
      checkpointPath,
      manifestPath: getManifestPath(resolvedProject, slug),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      pausedAt: null,
    };

    // Initialize transcript file
    initTranscript(transcriptPath, {
      slug,
      project: resolvedProject,
      archetype: manifest.archetype ?? null,
      audience: manifest.audience ?? null,
    });

    // Count existing exchanges (resume from transcript)
    const existingCount = countExchanges(transcriptPath);
    if (existingCount > 0) {
      // Transcript exists from prior session — mark existing exchanges
      session.exchanges = Array.from({ length: existingCount }, (_, i) => ({
        question: `(exchange ${i + 1} from prior session)`,
        answer: "(from prior session)",
        timestamp: new Date().toISOString(),
      }));
    }

    setReportQASession(chatId, session);

    // Send loading card
    const cardMsgId = await this.dashboard.createLoadingCard(chatId, slug, threadId);
    updateReportQASession(chatId, { cardMessageId: cardMsgId });

    // Generate first question
    await this.advanceToNextQuestion(chatId, manifest);
  }

  // ── Entry: Resume ──────────────────────────────────────────────────────────

  async handleResume(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const threadId = ctx.message?.message_thread_id ?? null;

    // Check in-memory paused session
    const session = getReportQASession(chatId);
    if (session && session.phase === "paused") {
      const manifest = readManifest(session.project, session.slug);
      if (!manifest) {
        await ctx.reply(`Manifest for "${session.slug}" no longer exists.`);
        clearReportQASession(chatId);
        return;
      }

      // Send new card (old one has no buttons)
      const cardMsgId = await this.dashboard.createLoadingCard(chatId, session.slug, threadId);
      updateReportQASession(chatId, {
        phase: "active",
        cardMessageId: cardMsgId,
        threadId,
        pausedAt: null,
      });

      const updated = getReportQASession(chatId)!;
      if (updated.currentQuestion) {
        await this.dashboard.showQuestion(updated);
      } else {
        await this.advanceToNextQuestion(chatId, manifest);
      }
      return;
    }

    // Check disk for any paused session across projects
    await ctx.reply("No paused QA session found. Start one with /report qa <slug>");
  }

  // ── Entry: Callback ────────────────────────────────────────────────────────

  async handleCallback(ctx: Context, data: string): Promise<void> {
    await ctx.answerCallbackQuery().catch(() => {});

    const parts = data.replace(RPQ_PREFIX, "").split(":");
    const action = parts[0];
    const chatId = parseInt(parts[1] ?? "0", 10);

    const session = getReportQASession(chatId);
    if (!session) {
      console.warn(`[report-qa] No session for chatId=${chatId} on callback ${action}`);
      return;
    }

    const manifest = readManifest(session.project, session.slug);

    switch (action) {
      case RPQ_ACTIONS.SUBMIT:
        await this.handleSubmit(chatId, manifest);
        break;
      case RPQ_ACTIONS.SKIP:
        await this.handleSkip(chatId, manifest);
        break;
      case RPQ_ACTIONS.UNDO:
        await this.handleUndo(chatId, manifest);
        break;
      case RPQ_ACTIONS.PAUSE:
        await this.handlePause(chatId);
        break;
      case RPQ_ACTIONS.END:
        await this.handleEnd(chatId);
        break;
      case RPQ_ACTIONS.PREVIEW:
        await this.handlePreview(chatId);
        break;
      default:
        console.warn(`[report-qa] Unknown callback action: ${action}`);
    }
  }

  // ── Entry: Free Text ───────────────────────────────────────────────────────

  /**
   * Intercept text messages when QA session is active.
   * Returns true if message was consumed (caller should not process further).
   */
  handleFreeText(ctx: Context, text: string): boolean {
    const chatId = ctx.chat?.id;
    if (!chatId) return false;
    if (!hasActiveReportQA(chatId)) return false;

    // Buffer the message
    const session = getReportQASession(chatId);
    if (!session) return false;

    session.answerBuffer.push(text);
    updateReportQASession(chatId, {
      answerBuffer: session.answerBuffer,
      phase: "collecting",
    });

    return true;
  }

  /**
   * Intercept voice transcriptions when QA session is active.
   * Returns true if consumed.
   */
  handleVoice(chatId: number, transcription: string): boolean {
    if (!hasActiveReportQA(chatId)) return false;

    const session = getReportQASession(chatId);
    if (!session) return false;

    session.answerBuffer.push(`[Voice] ${transcription}`);
    updateReportQASession(chatId, {
      answerBuffer: session.answerBuffer,
      phase: "collecting",
    });

    return true;
  }

  // ── Action Handlers ────────────────────────────────────────────────────────

  private async handleSubmit(chatId: number, manifest: ReportManifest | null): Promise<void> {
    const session = getReportQASession(chatId);
    if (!session || !session.currentQuestion) return;

    if (session.answerBuffer.length === 0) {
      // No answer provided — notify via card update
      return;
    }

    // Flush buffer into single answer
    const answer = session.answerBuffer.join("\n\n");
    const exchangeNum = session.exchanges.length + 1;
    const timestamp = new Date().toISOString();

    // Write to transcript file (checkpoint)
    appendExchange(session.transcriptPath, exchangeNum, session.currentQuestion, answer, timestamp);

    // Update session
    const exchange = { question: session.currentQuestion, answer, timestamp };
    session.exchanges.push(exchange);

    updateReportQASession(chatId, {
      exchanges: session.exchanges,
      answerBuffer: [],
      phase: "submitting",
      currentQuestion: null,
    });

    saveCheckpoint(getReportQASession(chatId)!);

    // Generate next question
    if (manifest) {
      await this.advanceToNextQuestion(chatId, manifest);
    }
  }

  private async handleSkip(chatId: number, manifest: ReportManifest | null): Promise<void> {
    const session = getReportQASession(chatId);
    if (!session) return;

    // Clear buffer and advance
    updateReportQASession(chatId, {
      answerBuffer: [],
      currentQuestion: null,
      phase: "submitting",
    });

    if (manifest) {
      await this.advanceToNextQuestion(chatId, manifest);
    }
  }

  private async handleUndo(chatId: number, manifest: ReportManifest | null): Promise<void> {
    const session = getReportQASession(chatId);
    if (!session || session.exchanges.length === 0) return;

    // Remove last exchange from transcript file
    removeLastExchange(session.transcriptPath);

    // Remove from session
    const removed = session.exchanges.pop()!;
    updateReportQASession(chatId, {
      exchanges: session.exchanges,
      currentQuestion: removed.question,
      answerBuffer: [],
      phase: "active",
    });

    saveCheckpoint(getReportQASession(chatId)!);

    // Re-show the undone question
    const updated = getReportQASession(chatId)!;
    await this.dashboard.showQuestion(updated);
  }

  private async handlePause(chatId: number): Promise<void> {
    const session = getReportQASession(chatId);
    if (!session) return;

    updateReportQASession(chatId, {
      phase: "paused",
      pausedAt: new Date().toISOString(),
    });

    saveCheckpoint(getReportQASession(chatId)!);
    await this.dashboard.showPaused(getReportQASession(chatId)!);

    // Don't clear from memory — keep for quick resume within TTL
  }

  private async handleEnd(chatId: number): Promise<void> {
    const session = getReportQASession(chatId);
    if (!session) return;

    // If buffer has unsaved content, submit it first
    if (session.answerBuffer.length > 0 && session.currentQuestion) {
      const answer = session.answerBuffer.join("\n\n");
      const exchangeNum = session.exchanges.length + 1;
      appendExchange(session.transcriptPath, exchangeNum, session.currentQuestion, answer);
      session.exchanges.push({
        question: session.currentQuestion,
        answer,
        timestamp: new Date().toISOString(),
      });
    }

    if (session.exchanges.length === 0) {
      updateReportQASession(chatId, { phase: "done" });
      await this.dashboard.sendMessage(
        chatId,
        "No exchanges recorded. QA session ended without saving.",
        session.threadId
      );
      clearReportQASession(chatId);
      return;
    }

    updateReportQASession(chatId, { phase: "ending" });
    const updated = getReportQASession(chatId)!;
    await this.dashboard.showEnding(updated);

    // Generate findings
    try {
      const findings = await generateFindings(updated);
      writeFindings(updated.findingsPath, updated.slug, findings);

      // Register in manifest
      registerResearchInManifest(
        updated.project,
        updated.slug,
        updated.transcriptPath,
        updated.findingsPath
      );

      updateReportQASession(chatId, { phase: "done" });
      await this.dashboard.showDone(getReportQASession(chatId)!);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[report-qa] Findings generation failed:", msg);
      await this.dashboard.sendMessage(
        chatId,
        `Findings generation failed: ${msg}\nTranscript is saved — you can regenerate later.`,
        updated.threadId
      );
      updateReportQASession(chatId, { phase: "done" });
    }

    saveCheckpoint(getReportQASession(chatId)!);
    clearReportQASession(chatId);
  }

  private async handlePreview(chatId: number): Promise<void> {
    const session = getReportQASession(chatId);
    if (!session) return;
    await this.dashboard.showPreview(session);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private async advanceToNextQuestion(chatId: number, manifest: ReportManifest): Promise<void> {
    const session = getReportQASession(chatId);
    if (!session) return;

    await this.dashboard.showGenerating(session);

    try {
      const question = await generateQuestion(session, manifest);
      updateReportQASession(chatId, {
        currentQuestion: question,
        phase: "active",
        answerBuffer: [],
      });

      const updated = getReportQASession(chatId)!;
      await this.dashboard.showQuestion(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[report-qa] Question generation failed:", msg);

      // Pause session on failure — don't lose state
      updateReportQASession(chatId, { phase: "paused", pausedAt: new Date().toISOString() });
      saveCheckpoint(getReportQASession(chatId)!);

      await this.dashboard.sendMessage(
        chatId,
        `Question generation failed: ${msg}\nSession paused. /report qa resume to retry.`,
        session.threadId
      );
    }
  }

  private async resumeFromCheckpoint(
    chatId: number,
    threadId: number | null,
    checkpoint: ReportQASession,
    manifest: ReportManifest
  ): Promise<void> {
    // Restore session to memory
    checkpoint.chatId = chatId;
    checkpoint.threadId = threadId;
    checkpoint.lastActivityAt = Date.now();
    checkpoint.phase = "loading";
    checkpoint.pausedAt = null;

    setReportQASession(chatId, checkpoint);

    const cardMsgId = await this.dashboard.createLoadingCard(chatId, checkpoint.slug, threadId);
    updateReportQASession(chatId, { cardMessageId: cardMsgId });

    await this.dashboard.sendMessage(
      chatId,
      `Resuming QA for ${checkpoint.slug} (${checkpoint.exchanges.length} exchanges done).`,
      threadId
    );

    if (checkpoint.currentQuestion) {
      updateReportQASession(chatId, { phase: "active" });
      await this.dashboard.showQuestion(getReportQASession(chatId)!);
    } else {
      await this.advanceToNextQuestion(chatId, manifest);
    }
  }
}
