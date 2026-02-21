/**
 * Central orchestrator for all coding sessions.
 * Manages lifecycle, persistence, and coordination between
 * SessionRunner, PermissionManager, ReminderManager, and DashboardManager.
 */

import { randomUUID } from "crypto";
import { readFile, writeFile, mkdir, appendFile, stat, readdir } from "fs/promises";
import { join, basename, dirname } from "path";
import { spawn } from "bun";
import { homedir } from "os";
import type { Bot, Context } from "grammy";
import type { CodingSession, SessionStatus } from "./types.ts";
import type { DiscoveredSession } from "./projectScanner.ts";
import { SessionRunner } from "./sessionRunner.ts";
import { InputBridge } from "./inputBridge.ts";
import { PermissionManager } from "./permissionManager.ts";
import { ReminderManager } from "./reminderManager.ts";
import { ProjectScanner } from "./projectScanner.ts";
import { AGENTS } from "../agents/config.ts";

const RELAY_DIR = process.env.RELAY_DIR || join(homedir(), ".claude-relay");
const CODING_LOG_DIR = process.env.CODING_LOG_DIR || join(RELAY_DIR, "coding-logs");
const SESSIONS_FILE = join(RELAY_DIR, "coding-sessions.json");
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const PROJECT_ROOT = join(dirname(dirname(import.meta.path)));
const ROUTINES_DIR = join(PROJECT_ROOT, "routines");

// dashboardManager will be created in Phase 3 -- use lazy import
let dashboardManagerInstance: {
  createDashboard(session: CodingSession): Promise<number>;
  updateDashboard(session: CodingSession): Promise<void>;
  removeDashboard(session: CodingSession): Promise<void>;
} | null = null;

async function getDashboardManager(bot: Bot): Promise<typeof dashboardManagerInstance> {
  if (!dashboardManagerInstance) {
    try {
      const m = await import("./dashboardManager.ts");
      dashboardManagerInstance = new m.DashboardManager(bot);
    } catch {
      // Not yet available -- Phase 3
    }
  }
  return dashboardManagerInstance;
}

export class CodingSessionManager {
  private sessions: Map<string, CodingSession> = new Map();
  private runners: Map<string, SessionRunner> = new Map();
  private inputBridges: Map<string, InputBridge> = new Map();
  private heartbeatTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private routineSnapshots: Map<string, Set<string>> = new Map();
  private permissionManager = new PermissionManager();
  private reminderManager = new ReminderManager();
  private projectScanner = new ProjectScanner();
  /** Resolvers waiting for claudeSessionId to be set on a given relay session. */
  private claudeSessionIdResolvers: Map<string, Array<(id: string) => void>> = new Map();

  constructor(private bot: Bot) {}

  /** Load persisted sessions from disk on startup. */
  async init(): Promise<void> {
    await mkdir(CODING_LOG_DIR, { recursive: true });

    try {
      const raw = await readFile(SESSIONS_FILE, "utf-8");
      const data = JSON.parse(raw);
      const sessions: CodingSession[] = data.sessions || [];

      for (const s of sessions) {
        // Mark any previously "running" or "starting" sessions as "paused"
        // since we lost the process reference on restart
        if (s.status === "running" || s.status === "starting") {
          s.status = "paused";
        }
        // Clear non-serializable timer IDs
        delete s.questionReminderTimerId;
        this.sessions.set(s.id, s);
      }
    } catch {
      // No sessions file yet
    }
  }

  /** Start a new coding session. */
  async startSession(
    chatId: number,
    ctx: Context,
    options: {
      directory: string;
      task: string;
      useAgentTeam?: boolean;
    }
  ): Promise<CodingSession> {
    const { directory, task, useAgentTeam } = options;

    // Validate directory exists
    try {
      const dirStat = await stat(directory);
      if (!dirStat.isDirectory()) {
        throw new Error(`Not a directory: ${directory}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Directory does not exist: ${directory}\n\nCreate it first with: mkdir -p ${directory}`);
      }
      throw err;
    }

    // Check directory permission
    const permitted = await this.permissionManager.isPermitted(directory);
    if (!permitted) {
      const msgId = await this.permissionManager.requestPermission(ctx, directory);
      // Create session in pending_permission state
      const session = this.createSession({
        chatId,
        directory,
        task,
        useAgentTeam: useAgentTeam || false,
        status: "pending_permission",
      });
      return session;
    }

    // Permission granted -- create and launch
    const session = this.createSession({
      chatId,
      directory,
      task,
      useAgentTeam: useAgentTeam || false,
      status: "starting",
    });

    await this.launchSession(session);
    return session;
  }

  /** Launch a session that has permission. */
  async launchSession(session: CodingSession): Promise<void> {
    session.status = "starting";
    session.lastActivityAt = new Date().toISOString();
    this.persistSessions();

    // Snapshot existing routine files for post-session detection
    const snapshot = await this.scanRoutineFiles();
    this.routineSnapshots.set(session.id, snapshot);

    // Create dashboard if available
    const dm = await getDashboardManager(this.bot);
    if (dm) {
      try {
        session.pinnedMessageId = await dm.createDashboard(session);
        this.persistSessions();
      } catch {
        // Dashboard creation failed -- continue without it
      }
    }

    const runner = new SessionRunner(CLAUDE_PATH);
    this.runners.set(session.id, runner);

    // Run in background -- don't await
    runner
      .run({
        task: session.task,
        directory: session.directory,
        resume: session.claudeSessionId,
        useAgentTeam: session.useAgentTeam,
        callbacks: {
          onStart: (pid, inputBridge) => {
            session.pid = pid;
            session.status = "running";
            session.lastActivityAt = new Date().toISOString();
            this.inputBridges.set(session.id, inputBridge);
            this.persistSessions();
            this.refreshDashboard(session.id);
          },

          onSessionId: (claudeSessionId) => {
            session.claudeSessionId = claudeSessionId;
            this.persistSessions();
            // Notify any waiters (e.g. the start confirmation message)
            const resolvers = this.claudeSessionIdResolvers.get(session.id) || [];
            this.claudeSessionIdResolvers.delete(session.id);
            for (const resolve of resolvers) {
              resolve(claudeSessionId);
            }
          },

          onProgress: (event) => {
            session.lastActivityAt = new Date().toISOString();
            session.filesChanged = event.filesChanged;
            this.logEvent(session.id, event);
            this.persistSessions();
            this.refreshDashboard(session.id);

            // Route detailed events to coding topic if configured for this chat
            if (this.getCodingTopicId(session.chatId) && (event.type === "tool_use" || event.type === "worker_message")) {
              this.sendProgressToTopic(session, event.summary as string || String(event.type)).catch(() => {});
            }
          },

          onQuestion: async (q) => {
            session.status = "waiting_for_input";
            session.lastActivityAt = new Date().toISOString();

            // Send question to Telegram
            const questionMsg = await this.sendQuestionMessage(session, q);

            session.pendingQuestion = {
              questionMessageId: questionMsg,
              questionText: q.questionText,
              options: q.options,
              toolUseId: q.toolUseId,
              askedAt: new Date().toISOString(),
            };

            this.persistSessions();
            this.refreshDashboard(session.id);

            // Schedule 15-minute reminder
            this.reminderManager.scheduleReminder(session, this.bot);
          },

          onPlanApproval: async (p) => {
            session.status = "waiting_for_plan";
            session.lastActivityAt = new Date().toISOString();

            // Send plan to Telegram
            const planMsgIds = await this.sendPlanMessage(session, p);

            session.pendingPlanApproval = {
              planMessageIds: planMsgIds,
              planText: p.planText,
              requestId: p.requestId,
              askedAt: new Date().toISOString(),
            };

            this.persistSessions();
            this.refreshDashboard(session.id);

            // Schedule reminder
            this.reminderManager.scheduleReminder(session, this.bot);
          },

          onComplete: async (r) => {
            session.status = "completed";
            session.summary = r.summary;
            session.claudeSessionId = r.claudeSessionId;
            session.filesChanged = r.filesChanged;
            session.completedAt = new Date().toISOString();
            session.lastActivityAt = new Date().toISOString();
            session.pid = undefined;

            this.runners.delete(session.id);
            this.inputBridges.delete(session.id);
            this.clearHeartbeat(session.id);
            this.reminderManager.cancelReminder(session.id);
            this.persistSessions();
            this.refreshDashboard(session.id);

            // Send completion notification
            await this.sendCompletionMessage(session);

            // Detect new routine files created during the session
            await this.notifyNewRoutineFiles(session);
          },

          onError: async (error) => {
            session.status = "failed";
            session.errorMessage = error.message;
            session.lastActivityAt = new Date().toISOString();
            session.pid = undefined;

            this.runners.delete(session.id);
            this.inputBridges.delete(session.id);
            this.clearHeartbeat(session.id);
            this.reminderManager.cancelReminder(session.id);
            this.persistSessions();
            this.refreshDashboard(session.id);

            // Notify user
            try {
              await this.bot.api.sendMessage(
                session.chatId,
                `\u274C Coding Failed \u2014 ${session.projectName}\n\n${error.message}`
              );
            } catch {
              // Send failed
            }
          },
        },
      })
      .catch(async (err) => {
        console.error(`Session runner error for ${session.id}:`, err);
        session.status = "failed";
        session.errorMessage = err instanceof Error ? err.message : String(err);
        this.clearHeartbeat(session.id);
        this.persistSessions();
        try {
          await this.bot.api.sendMessage(
            session.chatId,
            `\u274C Coding Failed \u2014 ${session.projectName}\n\n${session.errorMessage}`
          );
        } catch {
          // Send failed
        }
      });

    // Start periodic heartbeat
    const HEARTBEAT_INTERVAL_MS = parseInt(process.env.PROGRESS_HEARTBEAT_INTERVAL_MS || "300000", 10);
    const heartbeatTimer = setInterval(async () => {
      const current = this.sessions.get(session.id);
      if (!current || current.status !== "running") {
        this.clearHeartbeat(session.id);
        return;
      }

      const elapsed = this.formatElapsed(current.startedAt);
      const fileCount = current.filesChanged.length;
      const text = `\u2699\uFE0F ${current.projectName} \u2014 still working (${elapsed})\n\u{1F4DD} ${fileCount} file(s) changed`;

      await this.sendProgressHeartbeat(current, text);
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimers.set(session.id, heartbeatTimer);
  }

  /** Attach a desktop-discovered session for monitoring. */
  async attachDesktopSession(chatId: number, discovered: DiscoveredSession): Promise<CodingSession> {
    const session = this.createSession({
      chatId,
      directory: discovered.directory,
      task: discovered.lastAssistantMessage || "(desktop session)",
      useAgentTeam: false,
      status: "paused",
      source: "desktop",
      claudeSessionId: discovered.claudeSessionId,
    });
    return session;
  }

  /** Get a human-readable status text for a session. */
  getStatusText(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) return "Session not found.";

    const icon = this.statusIcon(session.status);
    const elapsed = this.formatElapsed(session.startedAt);
    const fileCount = session.filesChanged.length;

    let text = `\u{1F4C1} ${session.projectName} \u2014 Status\n`;
    text += "\u2501".repeat(20) + "\n\n";
    text += `${icon} ${this.statusLabel(session.status)}`;
    if (session.status === "running" || session.status === "starting") {
      text += ` for ${elapsed}`;
    }
    text += "\n";
    text += `\u{1F4CB} Task: ${session.task}\n`;
    const displayId = session.claudeSessionId
      ? session.claudeSessionId.slice(0, 8)
      : session.id.slice(0, 8);
    text += `\u{1F194} Session: ${displayId}\n`;

    if (fileCount > 0) {
      text += `\n\u{1F4DD} Files changed (${fileCount}):\n`;
      for (const f of session.filesChanged.slice(0, 10)) {
        text += `\u2022 ${f}\n`;
      }
      if (fileCount > 10) {
        text += `  ... and ${fileCount - 10} more\n`;
      }
    }

    if (session.summary) {
      text += `\n\u{1F4AC} Summary: ${session.summary.slice(0, 300)}`;
    }

    if (session.status === "waiting_for_input" && session.pendingQuestion) {
      text += `\n\n\u2753 Waiting for answer:\n"${session.pendingQuestion.questionText}"`;
    }

    if (session.errorMessage) {
      text += `\n\n\u274C Error: ${session.errorMessage}`;
    }

    const lastActivity = this.formatElapsed(session.lastActivityAt);
    text += `\n\nLast activity: ${lastActivity} ago`;

    return text;
  }

  /** Get recent log lines from a session's log file. */
  async getLogs(sessionId: string, lines = 20): Promise<string> {
    const logPath = join(CODING_LOG_DIR, `${sessionId}.ndjson`);
    try {
      const content = await readFile(logPath, "utf-8");
      const allLines = content.trim().split("\n").filter(Boolean);
      const recent = allLines.slice(-lines);

      const formatted = recent
        .map((line) => {
          try {
            const event = JSON.parse(line);
            const time = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : "";
            return `[${time}] ${event.summary || event.type || "event"}`;
          } catch {
            return line.slice(0, 120);
          }
        })
        .join("\n");

      const session = this.sessions.get(sessionId);
      const name = session?.projectName || sessionId.slice(0, 8);
      return `\u{1F4C4} Recent output \u2014 ${name}\n${"━".repeat(20)}\n\n${formatted}`;
    } catch {
      return "No logs available yet.";
    }
  }

  /** Get git diff --stat for a session's directory. */
  async getDiff(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) return "Session not found.";

    try {
      const proc = spawn(["git", "diff", "--stat"], {
        cwd: session.directory,
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      if (!output.trim()) {
        return `\u{1F4CA} Git diff \u2014 ${session.projectName}\n${"━".repeat(20)}\n\nNo uncommitted changes.`;
      }

      return `\u{1F4CA} Git diff \u2014 ${session.projectName}\n${"━".repeat(20)}\n\n${output.trim()}`;
    } catch {
      return "Could not get git diff.";
    }
  }

  /** List all sessions for a specific chat. */
  listForChat(chatId: number): CodingSession[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.chatId === chatId)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }

  /** List all sessions including desktop-discovered ones. */
  async listAll(chatId: number): Promise<CodingSession[]> {
    return this.listForChat(chatId);
  }

  /** Kill a running session. */
  async killSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const runner = this.runners.get(sessionId);
    if (runner) {
      runner.kill();
      this.runners.delete(sessionId);
    }

    this.inputBridges.delete(sessionId);
    this.clearHeartbeat(sessionId);
    this.reminderManager.cancelReminder(sessionId);

    session.status = "killed";
    session.lastActivityAt = new Date().toISOString();
    session.pid = undefined;
    this.persistSessions();
    this.refreshDashboard(sessionId);
  }

  /** Refresh the pinned dashboard message for a session. */
  async refreshDashboard(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const dm = await getDashboardManager(this.bot);
    if (dm) {
      try {
        await dm.updateDashboard(session);
      } catch {
        // Dashboard update failed -- non-fatal
      }
    }
  }

  /** Answer a pending question in a session. */
  async answerQuestion(sessionId: string, answer: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    if (session.status !== "waiting_for_input" || !session.pendingQuestion) {
      throw new Error("Session is not waiting for input");
    }

    const bridge = this.inputBridges.get(sessionId);
    if (!bridge || !bridge.isAlive()) {
      throw new Error("Session process is not running");
    }

    // Send the answer to Claude's stdin
    bridge.sendToolResult(session.pendingQuestion.toolUseId, answer);

    // Edit the question message to show the answer
    try {
      await this.bot.api.editMessageText(
        session.chatId,
        session.pendingQuestion.questionMessageId,
        `\u2705 Answered \u2014 ${session.projectName}\nQ: ${session.pendingQuestion.questionText}\nA: "${answer}" (${new Date().toLocaleTimeString()})`
      );
    } catch {
      // Edit failed -- non-fatal
    }

    // Clear pending state
    session.pendingQuestion = undefined;
    session.status = "running";
    session.lastActivityAt = new Date().toISOString();

    this.reminderManager.cancelReminder(sessionId);
    this.persistSessions();
    this.refreshDashboard(sessionId);
  }

  /** Approve or reject a pending plan in a session. */
  async approvePlan(sessionId: string, approved: boolean, modifications?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    if (session.status !== "waiting_for_plan" || !session.pendingPlanApproval) {
      throw new Error("Session is not waiting for plan approval");
    }

    const bridge = this.inputBridges.get(sessionId);
    if (!bridge || !bridge.isAlive()) {
      throw new Error("Session process is not running");
    }

    if (!approved && !modifications) {
      // Cancel -- kill the session
      await this.killSession(sessionId);
      return;
    }

    bridge.sendPlanApproval(session.pendingPlanApproval.requestId, approved, modifications);

    // Edit the plan message to show result
    const lastMsgId = session.pendingPlanApproval.planMessageIds.slice(-1)[0];
    if (lastMsgId) {
      try {
        const statusText = approved ? "\u2705 Plan Approved" : `\u270F\uFE0F Plan Modified: ${modifications?.slice(0, 100)}`;
        await this.bot.api.editMessageText(
          session.chatId,
          lastMsgId,
          `${statusText}\n\n(${new Date().toLocaleTimeString()})`
        );
      } catch {
        // Edit failed
      }
    }

    if (approved) {
      session.pendingPlanApproval = undefined;
      session.status = "running";
    }
    // If modifications sent, Claude will revise and send a new plan_approval_request

    session.lastActivityAt = new Date().toISOString();
    this.reminderManager.cancelReminder(sessionId);
    this.persistSessions();
    this.refreshDashboard(sessionId);
  }

  /** Answer the most recently waiting session for a chat (/code answer fallback). */
  async answerCurrentWaiting(chatId: number, answer: string): Promise<void> {
    const waitingSessions = this.listForChat(chatId).filter(
      (s) => s.status === "waiting_for_input" && s.pendingQuestion
    );

    if (waitingSessions.length === 0) {
      throw new Error("No sessions are currently waiting for input");
    }

    // Answer the most recent one
    await this.answerQuestion(waitingSessions[0].id, answer);
  }

  /** Pause all running sessions (graceful shutdown -- don't kill processes). */
  async pauseAllRunning(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.status === "running" || session.status === "starting") {
        this.clearHeartbeat(session.id);
        session.status = "paused";
        session.lastActivityAt = new Date().toISOString();
      }
    }
    this.reminderManager.cancelAll();
    await this.persistSessions();
  }

  /** Scan for desktop sessions and add any not already tracked. */
  async syncDesktopSessions(chatId: number): Promise<void> {
    const discovered = await this.projectScanner.getRecentSessions(60);
    const trackedIds = new Set(
      Array.from(this.sessions.values())
        .filter((s) => s.claudeSessionId)
        .map((s) => s.claudeSessionId)
    );

    for (const d of discovered) {
      if (!trackedIds.has(d.claudeSessionId)) {
        await this.attachDesktopSession(chatId, d);
      }
    }
  }

  /** Get a session by ID. */
  getSession(sessionId: string): CodingSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Get the most recent active session for a chat. */
  getMostRecentActive(chatId: number): CodingSession | undefined {
    const active = this.listForChat(chatId).filter(
      (s) => s.status === "running" || s.status === "starting" || s.status === "waiting_for_input" || s.status === "waiting_for_plan"
    );
    return active[0]; // Already sorted by startedAt descending
  }

  /** Get the PermissionManager instance (for callback handlers). */
  getPermissionManager(): PermissionManager {
    return this.permissionManager;
  }

  /** Get the ReminderManager instance. */
  getReminderManager(): ReminderManager {
    return this.reminderManager;
  }

  /**
   * Returns a promise that resolves with the Claude Code session ID
   * once the NDJSON system init event is received for the given relay session.
   * Times out after `timeoutMs` milliseconds and resolves with undefined.
   */
  waitForClaudeSessionId(sessionId: string, timeoutMs = 5000): Promise<string | undefined> {
    const session = this.sessions.get(sessionId);
    // Already available (e.g. resumed session) -- resolve immediately
    if (session?.claudeSessionId) {
      return Promise.resolve(session.claudeSessionId);
    }

    return new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        // Timed out -- remove resolver and resolve with undefined
        const resolvers = this.claudeSessionIdResolvers.get(sessionId);
        if (resolvers) {
          const idx = resolvers.indexOf(resolve as (id: string) => void);
          if (idx !== -1) resolvers.splice(idx, 1);
        }
        resolve(undefined);
      }, timeoutMs);

      const wrappedResolve = (id: string) => {
        clearTimeout(timer);
        resolve(id);
      };

      const existing = this.claudeSessionIdResolvers.get(sessionId) || [];
      existing.push(wrappedResolve);
      this.claudeSessionIdResolvers.set(sessionId, existing);
    });
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private createSession(opts: {
    chatId: number;
    directory: string;
    task: string;
    useAgentTeam: boolean;
    status: SessionStatus;
    source?: "bot" | "desktop";
    claudeSessionId?: string;
  }): CodingSession {
    const now = new Date().toISOString();
    const session: CodingSession = {
      id: randomUUID(),
      chatId: opts.chatId,
      directory: opts.directory,
      projectName: basename(opts.directory),
      task: opts.task,
      status: opts.status,
      useAgentTeam: opts.useAgentTeam,
      startedAt: now,
      lastActivityAt: now,
      filesChanged: [],
      source: opts.source || "bot",
      claudeSessionId: opts.claudeSessionId,
    };
    this.sessions.set(session.id, session);
    this.persistSessions();
    return session;
  }

  private async persistSessions(): Promise<void> {
    try {
      await mkdir(RELAY_DIR, { recursive: true });
      const serializable = Array.from(this.sessions.values()).map((s) => {
        // Exclude non-serializable fields
        const { questionReminderTimerId, ...rest } = s;
        return rest;
      });
      await writeFile(SESSIONS_FILE, JSON.stringify({ sessions: serializable }, null, 2));
    } catch (err) {
      console.error("Failed to persist sessions:", err);
    }
  }

  private async logEvent(sessionId: string, event: Record<string, unknown>): Promise<void> {
    const logPath = join(CODING_LOG_DIR, `${sessionId}.ndjson`);

    // Check log file size before appending
    try {
      const fileStat = await stat(logPath);
      if (fileStat.size > LOG_MAX_BYTES) {
        // Truncate by rewriting with the last half of the file
        const content = await readFile(logPath, "utf-8");
        const lines = content.split("\n");
        const halfLines = lines.slice(Math.floor(lines.length / 2));
        await writeFile(logPath, halfLines.join("\n"));
      }
    } catch {
      // File doesn't exist yet
    }

    const logEntry = JSON.stringify({ ...event, timestamp: new Date().toISOString() });
    try {
      await appendFile(logPath, logEntry + "\n");
    } catch {
      // Log write failed
    }
  }

  private async sendQuestionMessage(
    session: CodingSession,
    q: { toolUseId: string; questionText: string; options?: string[] }
  ): Promise<number> {
    const keyboard: { text: string; callback_data: string }[][] = [];

    // Add option buttons if available
    if (q.options && q.options.length > 0) {
      const optionRow = q.options.map((opt) => ({
        text: opt,
        callback_data: `code_answer:option:${session.id}:${q.toolUseId}:${Buffer.from(opt).toString("base64")}`,
      }));
      keyboard.push(optionRow);
    }

    // Always add custom + claude-decides row
    keyboard.push([
      {
        text: "\u270D\uFE0F Custom answer",
        callback_data: `code_answer:custom:${session.id}:${q.toolUseId}`,
      },
      {
        text: "\u{1F916} Claude decides",
        callback_data: `code_answer:skip:${session.id}:${q.toolUseId}`,
      },
    ]);

    const text = `\u2753 Claude needs your input \u2014 ${session.projectName}\n\n${q.questionText}\n\n\u21A9\uFE0F Or reply to this message with a custom answer`;

    const result = await this.bot.api.sendMessage(session.chatId, text, {
      reply_markup: { inline_keyboard: keyboard },
    });

    return result.message_id;
  }

  private async sendPlanMessage(
    session: CodingSession,
    p: { requestId: string; planText: string }
  ): Promise<number[]> {
    const MAX_LENGTH = 4000;
    const messageIds: number[] = [];

    // Split plan text if needed
    const header = `\u{1F4CB} Plan for approval \u2014 ${session.projectName}\n\n`;
    const fullText = header + p.planText;

    const chunks: string[] = [];
    let remaining = fullText;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_LENGTH) {
        chunks.push(remaining);
        break;
      }
      let splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
      if (splitIndex === -1) splitIndex = MAX_LENGTH;
      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).trim();
    }

    // Send all chunks
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;

      const msgOpts: { reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } } = {};
      if (isLast) {
        msgOpts.reply_markup = {
          inline_keyboard: [
            [
              { text: "\u2705 Approve", callback_data: `code_plan:approve:${session.id}:${p.requestId}` },
              { text: "\u270F\uFE0F Modify", callback_data: `code_plan:modify:${session.id}:${p.requestId}` },
            ],
            [
              { text: "\u274C Cancel", callback_data: `code_plan:cancel:${session.id}:${p.requestId}` },
              { text: "\u{1F916} Trust Claude", callback_data: `code_plan:trust:${session.id}:${p.requestId}` },
            ],
          ],
        };
      }

      const result = await this.bot.api.sendMessage(session.chatId, chunks[i], msgOpts);
      messageIds.push(result.message_id);
    }

    return messageIds;
  }

  private async sendCompletionMessage(session: CodingSession): Promise<void> {
    const elapsed = this.formatElapsed(session.startedAt);
    const fileCount = session.filesChanged.length;
    const summaryText = session.summary
      ? `\n\nSummary:\n${session.summary.slice(0, 500)}`
      : "";

    const text =
      `\u2705 Coding Complete \u2014 ${session.projectName}\n\n` +
      `Task: ${session.task}\n` +
      `Duration: ${elapsed}\n` +
      `Files changed: ${fileCount}` +
      summaryText;

    const keyboard = [
      [
        { text: "\u{1F4CA} View Diff", callback_data: `code_dash:diff:${session.id}` },
        { text: "\u{1F4C4} Full Logs", callback_data: `code_dash:logs:${session.id}` },
      ],
    ];

    try {
      await this.bot.api.sendMessage(session.chatId, text, {
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch {
      // Send failed
    }
  }

  private statusIcon(status: SessionStatus): string {
    const icons: Record<SessionStatus, string> = {
      pending_permission: "\u{1F510}",
      starting: "\u23F3",
      running: "\u2699\uFE0F",
      waiting_for_input: "\u2753",
      waiting_for_plan: "\u{1F4CB}",
      paused: "\u23F8",
      completed: "\u2705",
      failed: "\u274C",
      killed: "\u26D4",
    };
    return icons[status] || "\u2754";
  }

  private statusLabel(status: SessionStatus): string {
    const labels: Record<SessionStatus, string> = {
      pending_permission: "Awaiting permission",
      starting: "Starting...",
      running: "Running",
      waiting_for_input: "Waiting for your input",
      waiting_for_plan: "Plan approval needed",
      paused: "Paused",
      completed: "Completed",
      failed: "Failed",
      killed: "Stopped",
    };
    return labels[status] || status;
  }

  private formatElapsed(isoDate: string): string {
    const ms = Date.now() - new Date(isoDate).getTime();
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  private clearHeartbeat(sessionId: string): void {
    const timer = this.heartbeatTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(sessionId);
    }
  }

  /**
   * Resolve the coding topic thread_id for a given chatId.
   *
   * Lookup order:
   *   1. codingTopicId field in agents.json — per-group topic (matched by chatId)
   *   2. CODING_TOPIC_ID env var           — global fallback for single-chat setups
   *
   * Returns undefined when no topic is configured for this chat.
   */
  private getCodingTopicId(chatId: number): number | undefined {
    for (const agent of Object.values(AGENTS)) {
      if (agent.chatId && agent.chatId === chatId) {
        return agent.codingTopicId;
      }
    }

    // Global fallback for single-chat setups
    return process.env.CODING_TOPIC_ID ? parseInt(process.env.CODING_TOPIC_ID, 10) : undefined;
  }

  private async sendProgressHeartbeat(session: CodingSession, text: string): Promise<void> {
    const topicId = this.getCodingTopicId(session.chatId);

    try {
      await this.bot.api.sendMessage(session.chatId, text, {
        message_thread_id: topicId,
        reply_markup: {
          inline_keyboard: [[
            { text: "\u{1F4CA} Status", callback_data: `code_dash:status:${session.id}` },
            { text: "\u{1F4C4} Logs", callback_data: `code_dash:logs:${session.id}` },
          ]],
        },
      });
    } catch {
      // Non-fatal -- don't crash session on notification failure
    }
    // IMPORTANT: Do NOT call saveMessage() or any memory function here
  }

  private async sendProgressToTopic(session: CodingSession, summary: string): Promise<void> {
    const topicId = this.getCodingTopicId(session.chatId);
    if (!topicId) return;
    try {
      await this.bot.api.sendMessage(session.chatId, `[${session.projectName}] ${summary}`, {
        message_thread_id: topicId,
      });
    } catch {
      // Non-fatal
    }
  }

  /** Scan routines/ for .ts files (non-recursive, excluding user/ subdirectory). */
  private async scanRoutineFiles(): Promise<Set<string>> {
    try {
      const entries = await readdir(ROUTINES_DIR, { withFileTypes: true });
      const tsFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith(".ts"))
        .map((e) => e.name);
      return new Set(tsFiles);
    } catch {
      return new Set();
    }
  }

  /** Compare current routine files against the pre-session snapshot and notify about new ones. */
  private async notifyNewRoutineFiles(session: CodingSession): Promise<void> {
    const snapshot = this.routineSnapshots.get(session.id);
    this.routineSnapshots.delete(session.id);
    if (!snapshot) return;

    const current = await this.scanRoutineFiles();
    const newFiles: string[] = [];
    for (const file of current) {
      if (!snapshot.has(file)) {
        newFiles.push(file);
      }
    }

    for (const file of newFiles) {
      try {
        await this.bot.api.sendMessage(
          session.chatId,
          `New routine file detected: ${file}\nRun /routines list to register it with PM2.`
        );
      } catch {
        // Send failed
      }
    }
  }
}
