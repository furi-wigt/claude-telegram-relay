/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InlineKeyboard } from "grammy";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { readFileSync } from "fs";
import { join, dirname, basename, extname } from "path";
import { supabase } from "./utils/supabase.ts";
import {
  activeStreams,
  streamKey,
  parseCancelKey,
  handleCancelCallback,
  handleCancelCommand,
} from "./cancel.ts";
import { markdownToHtml } from "./utils/htmlFormat.ts";
import { transcribe } from "./transcribe.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";
import {
  getShortTermContext,
  formatShortTermContext,
  shouldSummarize,
  summarizeOldMessages,
} from "./memory/shortTermMemory.ts";
import {
  extractAndStore,
  rebuildProfileSummary,
  getUserProfile,
  hasMemoryItems,
} from "./memory/longTermExtractor.ts";
import {
  registerMemoryConfirmHandler,
  sendMemoryConfirmation,
} from "./memory/memoryConfirm.ts";
import { enqueueExtraction } from "./memory/extractionQueue.ts";
import { callOllama, checkOllamaAvailable } from "./fallback.ts";
import { getAgentForChat, autoDiscoverGroup, loadGroupMappings } from "./routing/groupRouter.ts";
// Router removed: always use Sonnet for simplicity and predictable latency
import { loadSession as loadGroupSession, updateSessionIdGuarded, initSessions, loadAllSessions, saveSession, isResumeReliable, didResumeFail, lockActiveCwd } from "./session/groupSessions.ts";
import { buildAgentPrompt } from "./agents/promptBuilder.ts";
import { GroupQueueManager } from "./queue/groupQueueManager.ts";
import { registerCommands, registerContextSwitchCallbackHandler } from "./commands/botCommands.ts";
import { registerTshoOtCommands, handleTshoOtCapture } from "./commands/tshoOtCommands.ts";
import { detectAndHandle, registerCallbackHandler } from "./routines/routineHandler.ts";
import { getTROQAState, appendQAAnswer } from "./tro/troQAState.ts";
import { registerDedupReviewCallbackHandler } from "./memory/dedupReviewCallbackHandler.ts";
import { CodingSessionManager } from "./coding/sessionManager.ts";
import { InputRouter } from "./coding/inputRouter.ts";
import { ReminderManager } from "./coding/reminderManager.ts";
import { registerCodingCommands } from "./coding/codingCommands.ts";
import { InteractiveStateMachine } from "./interactive/index.ts";
import { claudeText, claudeStream, enrichProgressText, type AskUserQuestionItem, type AskUserQuestionEvent } from "./claude-process.ts";
import { ProgressIndicator } from "./utils/progressIndicator.ts";
import { trace, generateTraceId } from "./utils/tracer.ts";
import { searchDocuments } from "./rag/documentSearch.ts";
import { ingestDocument } from "./documents/documentProcessor.ts";
import { analyzeImages, combineImageContexts } from "./vision/visionClient.ts";
import { analyzeDiagnosticImages } from "./documents/diagnosticAnalyzer.ts";
import { USER_NAME, USER_TIMEZONE } from "./config/userConfig.ts";
import { buildFooter, extractNextStep, type FooterData } from "./utils/footer.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// Load .env file explicitly (for launchd and other non-interactive contexts)
try {
  const envPath = join(PROJECT_ROOT, ".env");
  const envFile = readFileSync(envPath, "utf-8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (key && valueParts.length > 0) {
      const value = valueParts.join("=").trim();
      // Only set if not already in environment
      if (!process.env[key.trim()]) {
        process.env[key.trim()] = value;
      }
    }
  }
} catch (err) {
  // .env file might not exist or be readable - continue anyway
}

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
// CLAUDE_TIMEOUT removed — replaced by activity-based idle timeout in claude-process.ts.
// Configure via: CLAUDE_IDLE_TIMEOUT_MS (default 300000) and CLAUDE_SOFT_CEILING_MS (default 1800000).

// Queue Configuration
const QUEUE_MAX_DEPTH = parseInt(process.env.QUEUE_MAX_DEPTH || "50", 10);
const QUEUE_IDLE_TIMEOUT = parseInt(process.env.QUEUE_IDLE_TIMEOUT_MS || "86400000", 10);
const QUEUE_STATS_INTERVAL = parseInt(process.env.QUEUE_STATS_LOG_INTERVAL_MS || "300000", 10);
const QUEUE_SHUTDOWN_GRACE = parseInt(process.env.QUEUE_SHUTDOWN_GRACE_MS || "30000", 10);

// Agentic Coding
const CODING_AUTO_SCAN_INTERVAL = parseInt(process.env.CODING_AUTO_SCAN_INTERVAL || "300000", 10);

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session management is now per-group — see src/session/groupSessions.ts

// Model selection: always use Sonnet (predictable latency, no routing overhead)
const SONNET_MODEL = "claude-sonnet-4-6";

// ============================================================
// RELAY QUESTION FORM — state and helpers
// ============================================================

/** In-flight AskUserQuestion form state for a Telegram chat/thread. */
interface RelayQuestionForm {
  toolUseId: string;
  questions: AskUserQuestionItem[];
  /** qIdx → selected label(s). Single-select: string, multiSelect: string[]. */
  selections: Map<number, string | string[]>;
  /** Currently focused/expanded question index. */
  activeQIdx: number;
  /** message_id of the Telegram form message to edit in-place. */
  formMessageId: number;
  resolve: (answers: Record<string, string>) => void;
  reject: () => void;
  timeoutId: ReturnType<typeof setTimeout>;
  /** Called just before resolve() so the onQuestion closure can update the indicator. */
  onResolve?: () => void;
}

/** Key: streamKey(chatId, threadId) */
const pendingRelayForms = new Map<string, RelayQuestionForm>();

/** Force-reply routing: messageId → {key, qIdx} */
interface PendingCustomReply {
  key: string;   // streamKey(chatId, threadId)
  qIdx: number;
}
const pendingRelayCustomReplies = new Map<number, PendingCustomReply>();

const RELAY_FORM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Build the form message text for a RelayQuestionForm. */
function buildFormText(form: RelayQuestionForm): string {
  const { questions, selections, activeQIdx } = form;
  const n = questions.length;
  const answeredCount = [...Array(n).keys()].filter((i) => {
    const v = selections.get(i);
    if (v === undefined) return false;
    if (Array.isArray(v)) return v.length > 0;
    return v !== "";
  }).length;

  const lines: string[] = [];
  lines.push(`📋 Claude has ${n} question${n > 1 ? "s" : ""} for you`);
  lines.push("Answer any or all, then tap Submit.");

  for (let i = 0; i < n; i++) {
    const q = questions[i];
    const sel = selections.get(i);
    const isActive = i === activeQIdx;

    if (isActive) {
      lines.push("");
      lines.push(`▶ Q${i + 1} — ${q.question}   [${q.header}]`);
      lines.push("");
      for (const opt of q.options) {
        const isSelected = sel
          ? Array.isArray(sel) ? sel.includes(opt.label) : sel === opt.label
          : false;
        const bullet = q.multiSelect
          ? isSelected ? "  ✅" : "  ☐"
          : isSelected ? "  ◉" : "  ○";
        lines.push(`${bullet} ${opt.label}`);
        if (opt.description) lines.push(`    ${opt.description}`);
      }
    } else {
      lines.push("");
      lines.push("──────────────────────────────");
      let summary: string;
      if (sel === undefined) {
        summary = "(not answered)";
      } else if (Array.isArray(sel)) {
        summary = sel.length > 0 ? "✅ " + sel.join(", ") : "(not answered)";
      } else {
        const truncated = sel.length > 60 ? sel.slice(0, 59) + "…" : sel;
        summary = "✅ " + truncated;
      }
      lines.push(`  Q${i + 1} — ${q.question} [${q.header}]`);
      lines.push(`  ${summary}`);
    }
  }

  lines.push("");
  lines.push(`${answeredCount} of ${n} answered`);
  return lines.join("\n");
}

/** Build the inline keyboard for the active question of a RelayQuestionForm. */
function buildFormKeyboard(
  form: RelayQuestionForm,
  chatId: number,
  threadId: number | null,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const { questions, selections, activeQIdx } = form;
  const q = questions[activeQIdx];
  const sel = selections.get(activeQIdx);
  const tid = threadId ?? 0;
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];

  // Option buttons (2 per row max)
  for (let i = 0; i < q.options.length; i += 2) {
    const row: Array<{ text: string; callback_data: string }> = [];
    for (let j = i; j < Math.min(i + 2, q.options.length); j++) {
      const opt = q.options[j];
      const isSelected = sel
        ? Array.isArray(sel) ? sel.includes(opt.label) : sel === opt.label
        : false;
      const btnText = q.multiSelect
        ? isSelected ? `✅ ${opt.label}` : opt.label
        : isSelected ? `◉ ${opt.label}` : opt.label;
      row.push({
        text: btnText,
        callback_data: `rq:s:${chatId}:${tid}:${activeQIdx}:${j}`,
      });
    }
    rows.push(row);
  }

  // [Other...] button — always last in option area
  const lastOptionRow = rows[rows.length - 1];
  const otherBtn = {
    text: "Other...",
    callback_data: `rq:o:${chatId}:${tid}:${activeQIdx}`,
  };
  if (lastOptionRow && lastOptionRow.length < 2) {
    lastOptionRow.push(otherBtn);
  } else {
    rows.push([otherBtn]);
  }

  // Navigation row (only if multiple questions)
  if (questions.length > 1) {
    const navRow: Array<{ text: string; callback_data: string }> = [];
    if (activeQIdx > 0) {
      navRow.push({ text: `← Q${activeQIdx}`, callback_data: `rq:n:${chatId}:${tid}:${activeQIdx - 1}` });
    }
    if (activeQIdx < questions.length - 1) {
      navRow.push({ text: `Q${activeQIdx + 2} →`, callback_data: `rq:n:${chatId}:${tid}:${activeQIdx + 1}` });
    }
    if (navRow.length > 0) rows.push(navRow);
  }

  // Submit + Cancel row
  rows.push([
    { text: "✓ Submit All", callback_data: `rq:sub:${chatId}:${tid}` },
    { text: "✗ Cancel",    callback_data: `rq:cxl:${chatId}:${tid}` },
  ]);

  return { inline_keyboard: rows };
}

/** Convert form selections to the answers dict expected by AskUserQuestion tool_result. */
function collectAnswers(form: RelayQuestionForm): Record<string, string> {
  const answers: Record<string, string> = {};
  for (let i = 0; i < form.questions.length; i++) {
    const sel = form.selections.get(i);
    if (sel === undefined) continue;
    const key = form.questions[i].question;
    answers[key] = Array.isArray(sel) ? sel.join(", ") : sel;
  }
  return answers;
}

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================


async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  chatId?: number,
  agentId?: string,
  threadId?: number | null
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
      chat_id: chatId ?? null,
      agent_id: agentId ?? null,
      thread_id: threadId ?? null,
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// Check fallback availability at startup
let fallbackAvailable = false;
if (process.env.FALLBACK_MODEL) {
  fallbackAvailable = await checkOllamaAvailable();
  if (fallbackAvailable) {
    console.log(`Fallback model available: ${process.env.FALLBACK_MODEL}`);
  } else {
    console.warn("Fallback model configured but not available. Claude will be used exclusively.");
  }
}

const bot = new Bot(BOT_TOKEN);

// ── Resume failure: pending context injection store ──────────────────────────
// When resume fails we ask the user via inline keyboard whether to inject
// shortTermContext into the next call. The formatted context is held here until
// the user responds (or the entry is garbage-collected by restart).
const pendingResumeContext = new Map<string, string>(); // key → formatted context

function resumeCtxKey(chatId: number, threadId: number | null): string {
  return `${chatId}_${threadId ?? ""}`;
}

async function sendResumeFailedKeyboard(
  ctx: Context,
  chatId: number,
  threadId: number | null,
  formattedContext: string,
): Promise<void> {
  const key = resumeCtxKey(chatId, threadId);
  pendingResumeContext.set(key, formattedContext);

  const keyboard = new InlineKeyboard()
    .text("✓ Inject context", `rsm_ctx:yes:${chatId}:${threadId ?? ""}`)
    .text("✗ Fresh start", `rsm_ctx:no:${chatId}:${threadId ?? ""}`);

  await ctx.reply(
    "⚠️ *Session reset* — resume failed, fresh session started.\n\n" +
    "Inject recent conversation context into the next reply for continuity?",
    { parse_mode: "Markdown", reply_markup: keyboard },
  ).catch(console.error);
}

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  // If ALLOWED_USER_ID is set, enforce it
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    return;
  }

  await next();
});

// Auto-discover and register groups by matching title to agent
bot.use(async (ctx, next) => {
  await autoDiscoverGroup(ctx);
  await next();
});

// Register session management commands (/status, /new, /memory, /history, /help)
// NOTE: Registered AFTER security middleware so commands are protected
const allowedUserId = parseInt(ALLOWED_USER_ID || "0", 10);
registerCommands(bot, {
  supabase,
  userId: allowedUserId,
  projectDir: PROJECT_DIR || undefined,
  agentResolver: (chatId) => getAgentForChat(chatId).id,
  // Allow /new <prompt> to immediately process the follow-up text as a user message
  onMessage: async (chatId: number, text: string, ctx: Context) => {
    const threadId = ctx.message?.message_thread_id ?? null;
    if (!queueManager.hasCapacity(chatId, threadId)) {
      await ctx.reply("Queue is full. Please try again shortly.");
      return;
    }
    queueManager.getOrCreate(chatId, threadId).enqueue({
      label: `[chat:${chatId}] /new: ${text.substring(0, 30)}`,
      run: () => processTextMessage(chatId, threadId, text, ctx),
    });
  },
});

// Register tshoot commands (/scan, /ts-new, /ts-sessions, /ts-resume, /ts-status)
registerTshoOtCommands(bot, {
  agentResolver: (chatId) => getAgentForChat(chatId).id,
});

// Register routine creation callback handler (inline keyboard for output target)
registerCallbackHandler(bot);

// Register memory confirmation callback handler (inline keyboard for uncertain memory items)
registerMemoryConfirmHandler(bot, supabase);

// Register weekly dedup review callback handler (mdr_yes / mdr_no from memory-dedup-review routine)
registerDedupReviewCallbackHandler(bot, supabase);

// Kept for backward compat: handles "New topic / Continue" button clicks from any
// context-switch prompts that were sent before topic detection was removed. Safe to
// keep indefinitely — it no-ops when there are no pending context-switch messages.
registerContextSwitchCallbackHandler(bot, async (chatId: number, text: string, ctx: Context) => {
  const threadId = ctx.message?.message_thread_id ?? null;
  if (!queueManager.hasCapacity(chatId, threadId)) {
    await ctx.reply("Queue is full. Please try again shortly.");
    return;
  }
  queueManager.getOrCreate(chatId, threadId).enqueue({
    label: `[chat:${chatId}] ctxswitch: ${text.substring(0, 30)}`,
    run: () => processTextMessage(chatId, threadId, text, ctx),
  });
});

// ============================================================
// CORE: Call Claude CLI (delegates to unified claude-process)
// ============================================================

async function callClaude(
  prompt: string,
  options?: {
    resume?: boolean;
    sessionId?: string | null;
    onProgress?: (summary: string) => void;
    onSessionId?: (sessionId: string) => void;
    /** When set, registers an AbortController in activeStreams so the user can cancel. */
    chatId?: number;
    threadId?: number | null;
    /** Claude model to use (resolved by model router). Omit to use CLI default. */
    model?: string;
    /** Working directory for the Claude subprocess. Overrides PROJECT_DIR when set. */
    cwd?: string;
    /**
     * Called when Claude invokes AskUserQuestion. The stream suspends until
     * the returned Promise resolves with the user's answers.
     * Set by processTextMessage; unset for routines and fallback callers.
     */
    onQuestion?: (event: AskUserQuestionEvent) => Promise<Record<string, string>>;
  }
): Promise<string> {
  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  const controller = new AbortController();
  const key = options?.chatId != null
    ? streamKey(options.chatId, options.threadId ?? null)
    : null;
  if (key) activeStreams.set(key, { controller });

  try {
    const chatId = options?.chatId;
    const threadId = options?.threadId ?? null;
    return await claudeStream(prompt, {
      sessionId: options?.resume && options?.sessionId ? options.sessionId : undefined,
      cwd: options?.cwd ?? (PROJECT_DIR || undefined),
      claudePath: CLAUDE_PATH,
      onProgress: options?.onProgress,
      onSessionId: options?.onSessionId,
      signal: controller.signal,
      model: options?.model,
      onQuestion: options?.onQuestion,
      // Notify the user in Telegram when Claude has been running for 30 min (soft ceiling).
      // The stream is NOT killed — the user can tap /cancel if they want to stop.
      onSoftCeiling: chatId != null ? (msg) => {
        bot.api.sendMessage(
          chatId,
          msg,
          threadId != null ? { message_thread_id: threadId } : undefined
        ).catch(() => {});
      } : undefined,
    });
  } catch (error) {
    console.error("Claude error:", error);

    // Don't fall back to Ollama for idle timeouts — stalled streams won't recover.
    const isIdleTimeout = error instanceof Error && error.message.includes("idle timeout");

    // Try fallback if available (skip for idle timeouts)
    if (!isIdleTimeout && fallbackAvailable && process.env.FALLBACK_MODEL) {
      console.log("Claude failed, trying fallback model...");
      try {
        const fallbackResponse = await callOllama(prompt);
        return `[via ${process.env.FALLBACK_MODEL}]\n\n${fallbackResponse}`;
      } catch (fallbackError) {
        console.error("Fallback also failed:", fallbackError);
        return `Error: Both Claude and fallback failed. Claude: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    return `Error: ${error instanceof Error ? error.message : "Could not run Claude CLI"}`;
  } finally {
    if (key) activeStreams.delete(key);
  }
}

// ============================================================
// MESSAGE QUEUE — per-group queues for concurrent processing
// ============================================================

const queueManager = new GroupQueueManager({
  maxDepth: QUEUE_MAX_DEPTH,
  idleTimeout: QUEUE_IDLE_TIMEOUT,
  statsInterval: QUEUE_STATS_INTERVAL,
});

// ============================================================
// AGENTIC CODING
// ============================================================

const sessionManager = new CodingSessionManager(bot);
const inputRouter = new InputRouter();
const reminderManager = new ReminderManager();

// Initialize: load persisted sessions
await sessionManager.init();

// Register /code command
registerCodingCommands(bot, sessionManager, inputRouter, supabase);

// Lightweight Claude caller for /plan question generation.
// Uses claudeText (--output-format text, no project cwd) which is more
// reliable for structured JSON tasks than the streaming claudeStream.
// Falls back to Ollama when the CLI is unavailable.
async function questionCallClaude(prompt: string): Promise<string> {
  try {
    return await claudeText(prompt, {
      model: "claude-haiku-4-5-20251001",
      timeoutMs: 60_000,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[interactive] claudeText failed:", errMsg);
    if (fallbackAvailable && process.env.FALLBACK_MODEL) {
      console.log("[interactive] Falling back to Ollama...");
      return await callOllama(prompt);
    }
    throw err;
  }
}

// Interactive Q&A flow (/plan command)
const interactive = new InteractiveStateMachine(bot, callClaude, questionCallClaude);
bot.command("plan", (ctx) => interactive.handlePlanCommand(ctx));

// Cancel the active claudeStream for this chat/thread
bot.command("cancel", async (ctx) => {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id ?? null;
  if (!chatId) return;
  await handleCancelCommand(chatId, threadId, ctx, bot);
});

// Background: auto-scan for desktop sessions
if (CODING_AUTO_SCAN_INTERVAL > 0 && ALLOWED_USER_ID) {
  const allowedChatId = parseInt(ALLOWED_USER_ID, 10);
  setInterval(() => {
    sessionManager.syncDesktopSessions(allowedChatId).catch(console.error);
  }, CODING_AUTO_SCAN_INTERVAL);
}

// Handle iq: and cancel: callback queries.
// code_*: callbacks are fully consumed by registerCodingCommands middleware (no next()).
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data || "";
  if (data.startsWith("rq:")) {
    // ── Relay Question Form callbacks ────────────────────────────────────────
    await ctx.answerCallbackQuery().catch(() => {});

    const parts = data.split(":");
    const action = parts[1]; // s | n | o | sub | cxl
    const chatId = parseInt(parts[2] ?? "0", 10);
    const tid = parseInt(parts[3] ?? "0", 10);
    const threadId = tid === 0 ? null : tid;
    const key = streamKey(chatId, threadId);
    const form = pendingRelayForms.get(key);
    if (!form) return; // form already resolved/cancelled

    if (action === "s") {
      // Select/toggle option: rq:s:{chatId}:{tid}:{qIdx}:{oIdx}
      const qIdx = parseInt(parts[4] ?? "0", 10);
      const oIdx = parseInt(parts[5] ?? "0", 10);
      console.debug(`[relay-form] rq:s key=${key} qIdx=${qIdx} oIdx=${oIdx}`);
      const q = form.questions[qIdx];
      if (!q) { console.warn(`[relay-form] rq:s: no question at qIdx=${qIdx}`); return; }
      const opt = q.options[oIdx];
      if (!opt) { console.warn(`[relay-form] rq:s: no option at oIdx=${oIdx}`); return; }

      if (q.multiSelect) {
        const current = (form.selections.get(qIdx) as string[] | undefined) ?? [];
        const newSel = current.includes(opt.label)
          ? current.filter((l) => l !== opt.label)
          : [...current, opt.label];
        form.selections.set(qIdx, newSel);
      } else {
        // Toggle: tap selected option again → deselect
        const current = form.selections.get(qIdx);
        form.selections.set(qIdx, current === opt.label ? "" : opt.label);
      }
      console.debug(`[relay-form] rq:s: stored selections for qIdx=${qIdx}:`, JSON.stringify(form.selections.get(qIdx)));

      // Edit form message in-place
      try {
        await bot.api.editMessageText(chatId, form.formMessageId, buildFormText(form), {
          reply_markup: buildFormKeyboard(form, chatId, threadId),
        });
      } catch { /* message not modified is fine */ }

    } else if (action === "n") {
      // Navigate: rq:n:{chatId}:{tid}:{qIdx}
      const newQIdx = parseInt(parts[4] ?? "0", 10);
      if (newQIdx >= 0 && newQIdx < form.questions.length) {
        form.activeQIdx = newQIdx;
        try {
          await bot.api.editMessageText(chatId, form.formMessageId, buildFormText(form), {
            reply_markup: buildFormKeyboard(form, chatId, threadId),
          });
        } catch { /* ignore */ }
      }

    } else if (action === "o") {
      // Other (force-reply): rq:o:{chatId}:{tid}:{qIdx}
      const qIdx = parseInt(parts[4] ?? "0", 10);
      const q = form.questions[qIdx];
      if (!q) return;

      try {
        const promptMsg = await bot.api.sendMessage(
          chatId,
          `✏ Type your answer for [${q.header}]:`,
          {
            ...(threadId != null && { message_thread_id: threadId }),
            reply_markup: { force_reply: true, selective: true },
          }
        );
        pendingRelayCustomReplies.set(promptMsg.message_id, { key, qIdx });
      } catch (err) {
        console.error("[relay-form] Failed to send force-reply prompt:", err);
      }

    } else if (action === "sub") {
      // Submit All: rq:sub:{chatId}:{tid}
      const submittedAnswers = collectAnswers(form);
      console.debug(`[relay-form] rq:sub key=${key} answers:`, JSON.stringify(submittedAnswers));
      pendingRelayForms.delete(key);
      clearTimeout(form.timeoutId);

      try {
        await bot.api.editMessageReplyMarkup(chatId, form.formMessageId, {
          reply_markup: undefined,
        });
      } catch { /* ignore */ }

      form.onResolve?.();
      form.resolve(submittedAnswers);

    } else if (action === "cxl") {
      // Cancel: rq:cxl:{chatId}:{tid}
      pendingRelayForms.delete(key);
      clearTimeout(form.timeoutId);

      try {
        await bot.api.editMessageReplyMarkup(chatId, form.formMessageId, {
          reply_markup: undefined,
        });
      } catch { /* ignore */ }

      form.reject();
    }
    return;
  } else if (data.startsWith("iq:")) {
    await interactive.handleCallback(ctx, data);
  } else if (data.startsWith("cancel:")) {
    // Parse chatId/threadId directly from callback_data to avoid relying on
    // ctx.chat?.id which can be undefined in certain Grammy edge cases.
    const { chatId, threadId } = parseCancelKey(data);
    await ctx.answerCallbackQuery().catch(() => {});
    await handleCancelCallback(chatId, threadId, ctx, bot);
  } else if (data.startsWith("rsm_ctx:")) {
    // Resume failure context injection: rsm_ctx:{yes|no}:{chatId}:{threadId}
    const parts = data.split(":");
    const choice = parts[1];         // "yes" | "no"
    const chatId = parseInt(parts[2] ?? "0", 10);
    const threadIdRaw = parts[3] ?? "";
    const threadId = threadIdRaw === "" ? null : parseInt(threadIdRaw, 10);

    await ctx.answerCallbackQuery().catch(() => {});
    // Remove the keyboard from the prompt message
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

    if (choice === "yes") {
      const key = resumeCtxKey(chatId, threadId);
      const stored = pendingResumeContext.get(key);
      pendingResumeContext.delete(key);

      if (stored) {
        // Set flag — next Claude call will force-inject the stored context
        const agentId = getAgentForChat(chatId).id;
        const session = await loadGroupSession(chatId, agentId, threadId);
        session.pendingContextInjection = true;
        await saveSession(session);
        await ctx.reply(
          "✓ Context injection queued — your next message will include recent conversation history.",
        ).catch(console.error);
      } else {
        await ctx.reply("Context already expired. Just continue — Claude will ask if needed.").catch(console.error);
      }
    } else {
      pendingResumeContext.delete(resumeCtxKey(chatId, threadId));
      // no-op — user wants a fresh start
    }
  }
});

// ============================================================
// MESSAGE HANDLERS
// ============================================================

/** Send "typing" action every 5s until cleared. */
function startTypingIndicator(ctx: Context): ReturnType<typeof setInterval> {
  return setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 5000);
}

/**
 * Core Claude processing for a single text message.
 * Extracted so it can be reused by /new <prompt> and the normal message handler.
 */
async function processTextMessage(
  chatId: number,
  threadId: number | null,
  text: string,
  ctx: Context
): Promise<void> {
  const requestStart = Date.now();
  const typingInterval = startTypingIndicator(ctx);
  try {
    const agent = getAgentForChat(chatId);
    const traceId = generateTraceId();
    trace({ event: "message_received", traceId, chatId, agentId: agent.id, textLength: text.length, threadId });
    console.log(`[${agent.name}] Message from chat ${chatId}: ${text.substring(0, 50)}...`);
    await ctx.replyWithChatAction("typing");

    const session = await loadGroupSession(chatId, agent.id, threadId);

    // ── Capture resume state BEFORE calling Claude ────────────────────
    const prevSessionId = session.sessionId;
    const capturedGen = session.resetGen;  // guard against stale onSessionId after /new
    const triedResume = isResumeReliable(session);
    // Consume pendingContextInjection flag (set when user tapped "Inject context"
    // after a previous resume failure). Force inject even if session looks resumable.
    const forceInjectContext = session.pendingContextInjection === true;
    if (forceInjectContext) {
      session.pendingContextInjection = false;
      // saveSession is called below after messageCount update
    }

    const suppressContext = session.suppressContextInjection === true;
    if (suppressContext) {
      session.suppressContextInjection = false;
      // saveSession is called below after messageCount update
    }

    const userId = ctx.from?.id ?? 0;
    const [shortTermCtxRaw, userProfile, relevantContext, memoryContext, docSearchResult] = await Promise.all([
      supabase ? getShortTermContext(supabase, chatId, threadId) : Promise.resolve({ verbatimMessages: [], summaries: [], totalMessages: 0 }),
      supabase ? getUserProfile(supabase, userId) : Promise.resolve(""),
      getRelevantContext(supabase, text, chatId),
      getMemoryContext(supabase, chatId),
      supabase ? searchDocuments(supabase, text) : Promise.resolve({ chunks: [], context: "", hasResults: false }),
    ]);
    // Skip shortTermContext when --resume is active and the session is recent enough —
    // Claude already has the conversation history in its context window.
    // Exception: forceInjectContext = true (user requested injection after resume failure).
    const shortTermContext = (supabase && !suppressContext && (!isResumeReliable(session) || forceInjectContext))
      ? formatShortTermContext(shortTermCtxRaw, USER_TIMEZONE)
      : "";

    const now = new Date();
    const timeStr = now.toLocaleString("en-US", {
      timeZone: USER_TIMEZONE,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const enrichedPrompt = buildAgentPrompt(agent, text, {
      shortTermContext,
      userProfile,
      relevantContext,
      memoryContext,
      profileContext,
      userName: USER_NAME,
      timeStr,
      documentContext: docSearchResult.hasResults ? docSearchResult.context : undefined,
      isResumedSession: session.messageCount > 1 && triedResume && !forceInjectContext,
    });

    // Start indicator before model routing so it's visible during the classifier call (3-8s)
    const cancelKey = streamKey(chatId, threadId);
    const indicator = new ProgressIndicator();
    indicator.start(chatId, bot, threadId, {
      cancelKey,
      onMessageId: (msgId) => {
        const entry = activeStreams.get(cancelKey);
        if (entry) entry.progressMessageId = msgId;
      },
    }).catch(() => {}); // fire-and-forget
    indicator.setModelLabel("Sonnet");
    void indicator.update("Using Sonnet", { immediate: true });

    // Lock activeCwd for this session (no-op if sessionId already set — resume coherence).
    await lockActiveCwd(chatId, threadId, PROJECT_DIR || undefined);

    // ── AskUserQuestion: relay form handler ──────────────────────────
    // Builds and manages a Telegram form while claudeStream is suspended.
    const onQuestion = async (event: AskUserQuestionEvent): Promise<Record<string, string>> => {
      const formKey = streamKey(chatId, threadId);

      void indicator.update("⏳ Waiting for your answer...", { immediate: true });

      const form: RelayQuestionForm = {
        toolUseId: event.toolUseId,
        questions: event.questions,
        selections: new Map(),
        activeQIdx: 0,
        formMessageId: 0,
        resolve: () => {},
        reject: () => {},
        timeoutId: setTimeout(() => {}, 0),
      };

      const answerPromise = new Promise<Record<string, string>>((resolve, reject) => {
        form.resolve = resolve;
        form.reject = reject;
      });

      // Send form message
      const formText = buildFormText(form);
      const keyboard = buildFormKeyboard(form, chatId, threadId);
      try {
        const formMsg = await bot.api.sendMessage(chatId, formText, {
          ...(threadId != null && { message_thread_id: threadId }),
          reply_markup: keyboard,
        });
        form.formMessageId = formMsg.message_id;
      } catch (err) {
        console.error("[relay-form] Failed to send form message:", err);
        form.resolve({});
        return {};
      }

      // Wire indicator update: called by submit handler and timeout before resolving.
      form.onResolve = () => { void indicator.update("↩ Resuming...", { immediate: true }); };

      // 5-minute form timeout — resolve with whatever is answered so far
      form.timeoutId = setTimeout(() => {
        const key = streamKey(chatId, threadId);
        const f = pendingRelayForms.get(key);
        if (!f) return;
        pendingRelayForms.delete(key);
        // Remove keyboard
        bot.api.editMessageReplyMarkup(chatId, f.formMessageId, { reply_markup: undefined }).catch(() => {});
        f.onResolve?.();
        f.resolve(collectAnswers(f));
      }, RELAY_FORM_TIMEOUT_MS);

      pendingRelayForms.set(formKey, form);
      return answerPromise;
    };

    let rawResponse: string;
    const callStart = Date.now();
    trace({ event: "claude_start", traceId, chatId, promptLength: enrichedPrompt.length, resume: !!session.sessionId, sessionId: session.sessionId });
    try {
      rawResponse = await callClaude(enrichedPrompt, {
        resume: !!session.sessionId,
        sessionId: session.sessionId,
        onProgress: (summary) => void indicator.update(enrichProgressText(summary), { immediate: true }),
        onSessionId: (id) => void updateSessionIdGuarded(chatId, id, capturedGen, threadId),
        chatId,
        threadId,
        model: SONNET_MODEL,
        cwd: session.activeCwd,
        onQuestion,
      });
      await indicator.finish(true);
    } catch (claudeErr) {
      trace({ event: "claude_complete", traceId, chatId, responseLength: 0, durationMs: Date.now() - callStart, fallback: false, error: String(claudeErr) });
      await indicator.finish(false);
      throw claudeErr;
    }
    const callDurationMs = Date.now() - callStart;
    trace({ event: "claude_complete", traceId, chatId, responseLength: rawResponse.length, durationMs: callDurationMs, fallback: rawResponse.startsWith("[via "), error: null });
    console.log(`Claude raw response length: ${rawResponse.length} (${callDurationMs}ms)`);

    const { nextStep, response: rawWithoutNext } = extractNextStep(rawResponse);
    const response = await processMemoryIntents(supabase, rawWithoutNext, chatId);
    console.log(`Processed response length: ${response.length}`);

    // ── Detect resume failure ─────────────────────────────────────────
    // session.sessionId was updated in-memory by onSessionId callback above.
    const resumeFailed = didResumeFail(triedResume, prevSessionId, session.sessionId);
    if (resumeFailed) {
      // New session was silently created — reset the turn counter.
      session.messageCount = 1;
    }

    // ── Update session metadata ──────────────────────────────────────
    if (!resumeFailed) {
      session.messageCount = (session.messageCount || 0) + 1;
    }
    session.lastActivity = new Date().toISOString();
    await saveSession(session);

    await saveMessage("user", text, undefined, chatId, agent.id, threadId);
    await saveMessage("assistant", response || rawWithoutNext, undefined, chatId, agent.id, threadId);

    // Per-chat queue ensures every message is processed — no silent drops during bursts.
    if (supabase) {
      const db = supabase;
      const msgCount = session.messageCount;
      const assistantText = response || rawWithoutNext;
      // Snapshot of injected system context: tells LTM extractor what to ignore so it
      // doesn't re-store facts that the assistant merely echoed back from the profile/memory.
      const ltmInjectedContext = [userProfile, memoryContext, relevantContext, profileContext]
        .filter(Boolean)
        .join("\n\n") || undefined;
      trace({ event: "ltm_enqueued", traceId, chatId, userTextLength: text.length, assistantResponseLength: assistantText.length, queueDepth: 0 });
      enqueueExtraction({ chatId, userId, text, assistantResponse: assistantText, threadId, injectedContext: ltmInjectedContext }, async (item) => {
        const { uncertain, inserted } = await extractAndStore(db, item.chatId, item.userId, item.text, item.assistantResponse, traceId, item.injectedContext);
        if (uncertain && hasMemoryItems(uncertain)) {
          await sendMemoryConfirmation(bot, item.chatId, uncertain, item.threadId).catch(() => {});
        }
        if (msgCount % 5 === 0 && inserted > 0) {
          await rebuildProfileSummary(db, item.userId);
        }
      });
    }

    // Async STM summarization (independent, every 5 messages)
    if (supabase && session.messageCount % 5 === 0) {
      const db = supabase;
      setImmediate(async () => {
        try {
          if (await shouldSummarize(db, chatId, threadId)) {
            await summarizeOldMessages(db, chatId, threadId);
          }
        } catch (err) {
          console.error("STM summarization failed:", err);
        }
      });
    }

    const footer: FooterData = {
      elapsedMs: Date.now() - requestStart,
      turnCount: session.messageCount,
      nextStep,
      sessionId: session.sessionId,
      cwd: session.activeCwd,
    };
    await sendResponse(ctx, response || rawWithoutNext || "No response generated", footer);

    // Offer context re-injection after resume failure (shown after the response)
    if (resumeFailed) {
      const formattedCtx = formatShortTermContext(shortTermCtxRaw, USER_TIMEZONE);
      await sendResumeFailedKeyboard(ctx, chatId, threadId, formattedCtx);
    }
  } catch (error) {
    console.error("Text handler error:", error);
    try {
      await ctx.reply("Something went wrong processing your message. Please try again.");
    } catch (replyError) {
      console.error("Failed to send error reply:", replyError);
    }
  } finally {
    clearInterval(typingInterval);
  }
}

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id ?? null;

  if (!chatId) return;

  // Priority 0: TRO Monthly Update Q&A — capture Furi's context answers
  // Skip bot commands (start with /) so /new, /plan, /cancel still work normally.
  {
    const troQA = getTROQAState();
    if (troQA && troQA.chatId === chatId && !text.startsWith("/")) {
      appendQAAnswer(troQA, text);
      await ctx.reply("Got it — recorded your answer.");
      return;
    }
  }

  // Priority 1: /code answer explicit routing to coding sessions
  if (text.startsWith("/code answer ")) {
    await sessionManager.answerCurrentWaiting(chatId, text.slice(13).trim());
    return;
  }

  // Priority 2: Reply-to-message routing to coding sessions
  if (await inputRouter.tryRouteReply(ctx, sessionManager)) return;

  // Priority 2b: Relay question form — force-reply "Other..." answer routing
  {
    const replyToId = ctx.message?.reply_to_message?.message_id;
    if (replyToId != null) {
      const pending = pendingRelayCustomReplies.get(replyToId);
      if (pending) {
        pendingRelayCustomReplies.delete(replyToId);
        const form = pendingRelayForms.get(pending.key);
        if (form) {
          form.selections.set(pending.qIdx, text);
          // Parse chatId/threadId from the key so we can rebuild the keyboard
          const colonIdx = pending.key.indexOf(":");
          const kChatId = parseInt(pending.key.slice(0, colonIdx), 10);
          const tidStr = pending.key.slice(colonIdx + 1);
          const kThreadId = tidStr === "" ? null : parseInt(tidStr, 10);
          try {
            await bot.api.editMessageText(kChatId, form.formMessageId, buildFormText(form), {
              reply_markup: buildFormKeyboard(form, kChatId, kThreadId),
            });
          } catch { /* ignore "message not modified" */ }
          await ctx.reply("✓ Noted!", { reply_to_message_id: ctx.message.message_id });
        }
        return;
      }
    }
  }

  // Priority 3: Interactive Q&A free-text answer (when user is mid-plan session)
  if (await interactive.handleFreeText(ctx, text)) return;

  // Priority 3b: Inline tshoot capture (!finding / !discovery)
  if (await handleTshoOtCapture(ctx, text, chatId, threadId, (id) => getAgentForChat(id).id)) return;

  // Priority 4: Check for routine creation intent before normal Claude processing
  if (await detectAndHandle(ctx, text)) return;

  if (!queueManager.hasCapacity(chatId, threadId)) {
    await ctx.reply("Too many pending messages. Please wait for the current ones to complete.");
    return;
  }

  queueManager.getOrCreate(chatId, threadId).enqueue({
    label: `[chat:${chatId}] ${text.substring(0, 30)}`,
    run: () => processTextMessage(chatId, threadId, text, ctx),
  });
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id ?? null;

  if (!chatId) return;

  if (!queueManager.hasCapacity(chatId, threadId)) {
    await ctx.reply("Too many pending messages. Please wait for the current ones to complete.");
    return;
  }

  queueManager.getOrCreate(chatId, threadId).enqueue({
    label: `[chat:${chatId}] voice: ${voice.duration}s`,
    run: async () => {
      const voiceRequestStart = Date.now();
      const typingInterval = startTypingIndicator(ctx);
      try {
        const agent = getAgentForChat(chatId);
        console.log(`[${agent.name}] Voice message: ${voice.duration}s`);
        await ctx.replyWithChatAction("typing");

        if (!process.env.VOICE_PROVIDER) {
          await ctx.reply(
            "Voice transcription is not set up yet. " +
              "Run the setup again and choose a voice provider (Groq or local Whisper)."
          );
          return;
        }

        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(url);
        const buffer = Buffer.from(await response.arrayBuffer());

        const transcription = await transcribe(buffer);
        if (!transcription) {
          await ctx.reply("Could not transcribe voice message.");
          return;
        }

        const session = await loadGroupSession(chatId, agent.id, threadId);
        const voiceUserId = ctx.from?.id ?? 0;

        // ── Capture resume state BEFORE calling Claude ────────────────
        const voicePrevSessionId = session.sessionId;
        const voiceCapturedGen = session.resetGen;  // guard against stale onSessionId after /new
        const voiceTriedResume = isResumeReliable(session);
        const voiceForceInjectContext = session.pendingContextInjection === true;
        if (voiceForceInjectContext) session.pendingContextInjection = false;

        await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`, undefined, chatId, agent.id, threadId);

        const [shortTermCtxRaw, userProfile, relevantContext, memoryContext] = await Promise.all([
          supabase ? getShortTermContext(supabase, chatId, threadId) : Promise.resolve({ verbatimMessages: [], summaries: [], totalMessages: 0 }),
          supabase ? getUserProfile(supabase, voiceUserId) : Promise.resolve(""),
          getRelevantContext(supabase, transcription, chatId),
          getMemoryContext(supabase, chatId),
        ]);
        // Skip shortTermContext when --resume is active and the session is recent enough.
        const shortTermContext = (supabase && (!isResumeReliable(session) || voiceForceInjectContext))
          ? formatShortTermContext(shortTermCtxRaw, USER_TIMEZONE)
          : "";

        const now = new Date();
        const timeStr = now.toLocaleString("en-US", {
          timeZone: USER_TIMEZONE,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });

        const enrichedPrompt = buildAgentPrompt(agent, `[Voice message transcribed]: ${transcription}`, {
          shortTermContext,
          userProfile,
          relevantContext,
          memoryContext,
          profileContext,
          userName: USER_NAME,
          timeStr,
          isResumedSession: session.messageCount > 1 && triedResume && !voiceForceInjectContext,
        });

        const voiceCancelKey = streamKey(chatId, threadId);
        const voiceIndicator = new ProgressIndicator();
        voiceIndicator.start(chatId, bot, threadId, {
          cancelKey: voiceCancelKey,
          onMessageId: (msgId) => {
            const entry = activeStreams.get(voiceCancelKey);
            if (entry) entry.progressMessageId = msgId;
          },
        }).catch(() => {}); // fire-and-forget
        voiceIndicator.setModelLabel("Sonnet");

        await lockActiveCwd(chatId, threadId, PROJECT_DIR || undefined);

        let rawResponse: string;
        const voiceCallStart = Date.now();
        try {
          rawResponse = await callClaude(enrichedPrompt, {
            resume: !!session.sessionId,
            sessionId: session.sessionId,
            onProgress: (summary) => void voiceIndicator.update(summary, { immediate: true }),
            onSessionId: (id) => void updateSessionIdGuarded(chatId, id, voiceCapturedGen, threadId),
            chatId,
            threadId,
            model: SONNET_MODEL,
            cwd: session.activeCwd,
          });
          await voiceIndicator.finish(true);
        } catch (claudeErr) {
          await voiceIndicator.finish(false);
          throw claudeErr;
        }
        const voiceCallDurationMs = Date.now() - voiceCallStart;

        const { nextStep: voiceNextStep, response: voiceRawWithoutNext } = extractNextStep(rawResponse);
        const claudeResponse = await processMemoryIntents(supabase, voiceRawWithoutNext, chatId);

        // ── Detect resume failure ─────────────────────────────────────
        const voiceResumeFailed = didResumeFail(voiceTriedResume, voicePrevSessionId, session.sessionId);
        if (voiceResumeFailed) {
          session.messageCount = 1;
        }

        // Update session metadata
        if (!voiceResumeFailed) {
          session.messageCount = (session.messageCount || 0) + 1;
        }
        session.lastActivity = new Date().toISOString();
        await saveSession(session);

        await saveMessage("assistant", claudeResponse, undefined, chatId, agent.id, threadId);

        // Same per-chat queue as text handler — now with uncertain item confirmation parity.
        if (supabase) {
          const db = supabase;
          const msgCount = session.messageCount;
          const voiceLtmInjectedContext = [userProfile, memoryContext, relevantContext, profileContext]
            .filter(Boolean)
            .join("\n\n") || undefined;
          enqueueExtraction({ chatId, userId: voiceUserId, text: transcription, assistantResponse: claudeResponse, threadId, injectedContext: voiceLtmInjectedContext }, async (item) => {
            const { uncertain, inserted } = await extractAndStore(db, item.chatId, item.userId, item.text, item.assistantResponse, undefined, item.injectedContext);
            if (uncertain && hasMemoryItems(uncertain)) {
              await sendMemoryConfirmation(bot, item.chatId, uncertain, item.threadId).catch(() => {});
            }
            if (msgCount % 5 === 0 && inserted > 0) {
              await rebuildProfileSummary(db, item.userId);
            }
          });
        }

        // Async STM summarization (independent, every 5 messages)
        if (supabase && session.messageCount % 5 === 0) {
          const db = supabase;
          setImmediate(async () => {
            try {
              if (await shouldSummarize(db, chatId, threadId)) {
                await summarizeOldMessages(db, chatId, threadId);
              }
            } catch (err) {
              console.error("STM summarization failed:", err);
            }
          });
        }

        const voiceFooter: FooterData = {
          elapsedMs: Date.now() - voiceRequestStart,
          turnCount: session.messageCount,
          nextStep: voiceNextStep,
          cwd: session.activeCwd,
        };
        await sendResponse(ctx, claudeResponse, voiceFooter);

        if (voiceResumeFailed) {
          const formattedCtx = formatShortTermContext(shortTermCtxRaw, USER_TIMEZONE);
          await sendResumeFailedKeyboard(ctx, chatId, threadId, formattedCtx);
        }
      } catch (error) {
        console.error("Voice handler error:", error);
        try {
          await ctx.reply("Could not process voice message. Please try again.");
        } catch (replyError) {
          console.error("Failed to send error reply:", replyError);
        }
      } finally {
        clearInterval(typingInterval);
      }
    },
  });
});

// Photos/Images
// ── Media group (album) accumulator ──────────────────────────────────────────
// Telegram sends each photo in an album as a separate message:photo event
// sharing the same media_group_id. We buffer them over a short window and
// process all images in one batch to give the user a single coherent reply.

interface AlbumAccumulator {
  caption: string;
  chatId: number;
  threadId: number | null;
  ctx: Parameters<Parameters<typeof bot.on>[1]>[0]; // grammY Context
  /** Telegram file_ids collected during the debounce window — NOT buffers.
   * Downloads happen in processAlbum() only after the window closes, eliminating
   * the race where a slow download on an early photo finishes after the timer fires. */
  fileIds: string[];
  timer: ReturnType<typeof setTimeout>;
}

const MEDIA_GROUP_DEBOUNCE_MS = 800;
const albumAccumulators = new Map<string, AlbumAccumulator>();

// ── Shared photo processing ────────────────────────────────────────────────────
// Called either directly (single photo) or from the debounce timer (album).

function enqueuePhotoJob(
  ctx: Parameters<Parameters<typeof bot.on>[1]>[0],
  chatId: number,
  threadId: number | null,
  imageBuffers: Buffer[],
  caption: string
): void {
  if (!queueManager.hasCapacity(chatId, threadId)) {
    ctx.reply("Too many pending messages. Please wait for the current ones to complete.").catch(() => {});
    return;
  }

  const batchLabel = imageBuffers.length > 1 ? ` x${imageBuffers.length}` : "";

  queueManager.getOrCreate(chatId, threadId).enqueue({
    label: `[chat:${chatId}] photo${batchLabel}`,
    run: async () => {
      const photoRequestStart = Date.now();
      const typingInterval = startTypingIndicator(ctx);
      try {
        const agent = getAgentForChat(chatId);
        const traceId = generateTraceId();
        console.log(`[${agent.name}] Image(s) received x${imageBuffers.length} (caption: ${caption.substring(0, 40)})`);
        await ctx.replyWithChatAction("typing");

        // Analyze all images in parallel — each in its own separate claudeText process
        // (--dangerously-skip-permissions, cwd=/tmp). Partial failures are tolerated.
        //
        // Diagnostic agents (aws-architect, security-analyst, code-quality-coach) use
        // structured domain-specific extraction prompts → result injected as <diagnostic_image>.
        // All other agents use the user's caption → result injected as <image_analysis>.
        let imageContext: string | undefined;
        let diagnosticContext: string | undefined;
        try {
          if (agent.diagnostics?.enabled) {
            diagnosticContext = await analyzeDiagnosticImages(imageBuffers, agent.id, PROJECT_ROOT);
            if (!diagnosticContext) {
              await ctx.reply("Could not extract diagnostic information from the image(s). Please try again.");
              return;
            }
          } else {
            const results = await analyzeImages(imageBuffers, caption);
            imageContext = combineImageContexts(results);
            if (!imageContext) {
              await ctx.reply("Could not analyze the image(s). Please try again.");
              return;
            }
          }
        } catch (visionErr) {
          const errMsg = visionErr instanceof Error ? visionErr.message : String(visionErr);
          console.error("[vision] Analysis failed:", errMsg);
          await ctx.reply(`Could not analyze image: ${errMsg}`);
          return;
        }

        const photoUserId = ctx.from?.id ?? 0;
        const session = await loadGroupSession(chatId, agent.id, threadId);

        // ── Capture resume state BEFORE calling Claude ────────────────
        const photoPrevSessionId = session.sessionId;
        const photoCapturedGen = session.resetGen;  // guard against stale onSessionId after /new
        const photoTriedResume = isResumeReliable(session);
        const photoForceInjectContext = session.pendingContextInjection === true;
        if (photoForceInjectContext) session.pendingContextInjection = false;

        const [shortTermCtxRaw, userProfile, relevantContext, memoryContext] = await Promise.all([
          supabase ? getShortTermContext(supabase, chatId, threadId) : Promise.resolve({ verbatimMessages: [], summaries: [], totalMessages: 0 }),
          supabase ? getUserProfile(supabase, photoUserId) : Promise.resolve(""),
          getRelevantContext(supabase, caption, chatId),
          getMemoryContext(supabase, chatId),
        ]);
        // Skip shortTermContext when --resume is active and the session is recent enough.
        const shortTermContext = (supabase && (!isResumeReliable(session) || photoForceInjectContext))
          ? formatShortTermContext(shortTermCtxRaw, USER_TIMEZONE)
          : "";

        const now = new Date();
        const timeStr = now.toLocaleString("en-US", {
          timeZone: USER_TIMEZONE,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });

        // Build enriched prompt — vision analysis injected as <image_analysis> or <diagnostic_image>
        const enrichedPrompt = buildAgentPrompt(agent, caption, {
          shortTermContext,
          userProfile,
          relevantContext,
          memoryContext,
          profileContext,
          userName: USER_NAME,
          timeStr,
          imageContext,
          diagnosticContext,
          isResumedSession: session.messageCount > 1 && photoTriedResume && !photoForceInjectContext,
        });

        // Always Sonnet for images — vision analysis requires Sonnet+
        const imageDisplayName = "Sonnet";

        await saveMessage("user", `[Image]: ${caption}`, undefined, chatId, agent.id, threadId);

        const photoCancelKey = streamKey(chatId, threadId);
        const photoIndicator = new ProgressIndicator();
        photoIndicator.setModelLabel(`📸 ${imageDisplayName}`);
        photoIndicator.start(chatId, bot, threadId, {
          cancelKey: photoCancelKey,
          onMessageId: (msgId) => {
            const entry = activeStreams.get(photoCancelKey);
            if (entry) entry.progressMessageId = msgId;
          },
        }).catch(() => {}); // fire-and-forget

        await lockActiveCwd(chatId, threadId, PROJECT_DIR || undefined);

        let rawResponse: string;
        const callStart = Date.now();
        trace({ event: "claude_start", traceId, chatId, promptLength: enrichedPrompt.length, resume: !!session.sessionId, sessionId: session.sessionId });
        try {
          rawResponse = await callClaude(enrichedPrompt, {
            resume: !!session.sessionId,
            sessionId: session.sessionId,
            onProgress: (summary) => void photoIndicator.update(summary, { immediate: true }),
            onSessionId: (id) => void updateSessionIdGuarded(chatId, id, photoCapturedGen, threadId),
            chatId,
            threadId,
            model: SONNET_MODEL,
            cwd: session.activeCwd,
          });
          await photoIndicator.finish(true);
        } catch (claudeErr) {
          await photoIndicator.finish(false);
          throw claudeErr;
        }
        const callDurationMs = Date.now() - callStart;
        trace({ event: "claude_complete", traceId, chatId, responseLength: rawResponse.length, durationMs: callDurationMs, fallback: false, error: null });

        const { nextStep: photoNextStep, response: photoRawWithoutNext } = extractNextStep(rawResponse);
        const cleanResponse = await processMemoryIntents(supabase, photoRawWithoutNext, chatId);

        // ── Detect resume failure ─────────────────────────────────────
        const photoResumeFailed = didResumeFail(photoTriedResume, photoPrevSessionId, session.sessionId);
        if (photoResumeFailed) {
          session.messageCount = 1;
        } else {
          session.messageCount = (session.messageCount || 0) + 1;
        }
        session.lastActivity = new Date().toISOString();
        await saveSession(session);

        await saveMessage("assistant", cleanResponse, undefined, chatId, agent.id, threadId);

        if (supabase) {
          const db = supabase;
          const msgCount = session.messageCount;
          const photoLtmInjectedContext = [userProfile, memoryContext, relevantContext, profileContext]
            .filter(Boolean)
            .join("\n\n") || undefined;
          enqueueExtraction({ chatId, userId: photoUserId, text: caption, assistantResponse: cleanResponse, threadId, injectedContext: photoLtmInjectedContext }, async (item) => {
            const { uncertain, inserted } = await extractAndStore(db, item.chatId, item.userId, item.text, item.assistantResponse, traceId, item.injectedContext);
            if (uncertain && hasMemoryItems(uncertain)) {
              await sendMemoryConfirmation(bot, item.chatId, uncertain, item.threadId).catch(() => {});
            }
            if (msgCount % 5 === 0 && inserted > 0) {
              await rebuildProfileSummary(db, item.userId);
            }
          });
        }

        if (supabase && session.messageCount % 5 === 0) {
          const db = supabase;
          setImmediate(async () => {
            try {
              if (await shouldSummarize(db, chatId, threadId)) {
                await summarizeOldMessages(db, chatId, threadId);
              }
            } catch (err) {
              console.error("STM summarization failed:", err);
            }
          });
        }

        const photoFooter: FooterData = {
          elapsedMs: Date.now() - photoRequestStart,
          turnCount: session.messageCount,
          nextStep: photoNextStep,
          cwd: session.activeCwd,
        };
        await sendResponse(ctx, cleanResponse || "No response generated", photoFooter);

        if (photoResumeFailed) {
          const formattedCtx = formatShortTermContext(shortTermCtxRaw, USER_TIMEZONE);
          await sendResumeFailedKeyboard(ctx, chatId, threadId, formattedCtx);
        }
      } catch (error) {
        console.error("Photo handler error:", error);
        try {
          await ctx.reply("Could not process image. Please try again.");
        } catch (replyError) {
          console.error("Failed to send error reply:", replyError);
        }
      } finally {
        clearInterval(typingInterval);
      }
    },
  });
}

// ── Album processor (Phase 2 of two-phase download) ──────────────────────────
// Called once the debounce window closes. At this point we know exactly how
// many photos are in the album and can download them all in parallel without
// any race condition from interleaved event/download timing.

async function processAlbum(acc: AlbumAccumulator): Promise<void> {
  console.log(`[album] Window closed — downloading ${acc.fileIds.length} image(s) in parallel`);

  const downloadResults = await Promise.allSettled(
    acc.fileIds.map(async (fileId) => {
      const file = await bot.api.getFile(fileId);
      const resp = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
      return Buffer.from(await resp.arrayBuffer());
    })
  );

  const buffers = downloadResults
    .filter((r): r is PromiseFulfilledResult<Buffer> => r.status === "fulfilled")
    .map((r) => r.value);

  const failCount = downloadResults.filter((r) => r.status === "rejected").length;
  if (failCount > 0) {
    console.warn(`[album] ${failCount}/${acc.fileIds.length} download(s) failed — proceeding with ${buffers.length} successful`);
  }

  if (buffers.length === 0) {
    await acc.ctx.reply("Could not download any images from the album. Please try again.").catch(() => {});
    return;
  }

  const caption = acc.caption || "Describe these images in detail.";
  enqueuePhotoJob(acc.ctx, acc.chatId, acc.threadId, buffers, caption);
}

// ── Photo event handler ────────────────────────────────────────────────────────

bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id ?? null;
  if (!chatId) return;

  // Download the highest-resolution variant immediately.
  // For media groups we need the buffer before the debounce timer fires.
  const photos = ctx.message.photo;
  const photo = photos[photos.length - 1]; // highest-resolution variant
  const mediaGroupId = ctx.message.media_group_id;

  if (mediaGroupId) {
    // ── Album (two-phase) ──────────────────────────────────────────────────────
    // Phase 1 (here): collect file_id — NO download yet.
    // Downloads happen in processAlbum() once the debounce window closes and we
    // know the full set of photos. This eliminates the race where a slow download
    // on an early photo completes after the timer fires and gets silently dropped.
    const existing = albumAccumulators.get(mediaGroupId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.fileIds.push(photo.file_id);
      // Caption appears only on the first album message — preserve it
      if (!existing.caption && ctx.message.caption) {
        existing.caption = ctx.message.caption;
      }
    } else {
      albumAccumulators.set(mediaGroupId, {
        caption: ctx.message.caption || "",
        chatId,
        threadId,
        ctx,
        fileIds: [photo.file_id],
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      });
    }
    const acc = albumAccumulators.get(mediaGroupId)!;
    acc.timer = setTimeout(async () => {
      albumAccumulators.delete(mediaGroupId);
      await processAlbum(acc); // Phase 2: download all → enqueue
    }, MEDIA_GROUP_DEBOUNCE_MS);
    return;
  }

  // ── Single photo ───────────────────────────────────────────────────────────
  // No album window needed — download immediately and process.
  let imageBuffer: Buffer;
  try {
    const file = await ctx.api.getFile(photo.file_id);
    const photoResponse = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    imageBuffer = Buffer.from(await photoResponse.arrayBuffer());
  } catch (downloadErr) {
    console.error("[photo] Download failed:", downloadErr);
    await ctx.reply("Could not download image. Please try again.").catch(() => {});
    return;
  }

  const caption = ctx.message.caption || "Describe this image in detail.";
  enqueuePhotoJob(ctx, chatId, threadId, [imageBuffer], caption);
});

// Documents — index into RAG on upload
// ── Document album (multi-file) accumulator ───────────────────────────────────
// Telegram sends each file in a multi-document send as a separate message:document
// event sharing the same media_group_id. Buffer them over a short window and
// process all in one batch to give the user a single coherent reply.

interface DocAlbumEntry {
  fileId: string;
  /** Canonical filename — used as the stable source key in Supabase (no timestamp).
   * Re-uploading the same file always replaces its old chunks (Issue 3 fix). */
  fileName: string;
  mimeType: string | undefined;
}

interface DocAlbumAccumulator {
  caption: string;
  chatId: number;
  threadId: number | null;
  ctx: Parameters<Parameters<typeof bot.on>[1]>[0];
  /** File IDs collected during the debounce window — downloads happen in
   * processDocumentAlbum() only after the window closes (same two-phase pattern
   * as the image album accumulator, eliminating any download/timer race). */
  entries: DocAlbumEntry[];
  timer: ReturnType<typeof setTimeout>;
}

const DOCUMENT_GROUP_DEBOUNCE_MS = 800;
const docAlbumAccumulators = new Map<string, DocAlbumAccumulator>();

// ── Document album processor (Phase 2 of two-phase approach) ─────────────────

async function processDocumentAlbum(acc: DocAlbumAccumulator): Promise<void> {
  console.log(`[doc-album] Window closed — downloading ${acc.entries.length} file(s) in parallel`);
  const typingInterval = startTypingIndicator(acc.ctx);
  try {
    if (!supabase) {
      await acc.ctx.reply("Document indexing requires Supabase. Please configure your database first.").catch(() => {});
      return;
    }

    // Phase 1: parallel downloads
    const downloadResults = await Promise.allSettled(
      acc.entries.map(async (entry) => {
        const file = await bot.api.getFile(entry.fileId);
        const resp = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
        return { buffer: Buffer.from(await resp.arrayBuffer()), entry };
      })
    );

    const failedDownloads = downloadResults.filter((r) => r.status === "rejected").length;
    if (failedDownloads > 0) {
      console.warn(`[doc-album] ${failedDownloads}/${acc.entries.length} download(s) failed`);
    }

    const downloaded = downloadResults
      .filter((r): r is PromiseFulfilledResult<{ buffer: Buffer; entry: DocAlbumEntry }> => r.status === "fulfilled")
      .map((r) => r.value);

    if (downloaded.length === 0) {
      await acc.ctx.reply("Could not download any documents from the album. Please try again.").catch(() => {});
      return;
    }

    // Phase 2: parallel ingestion — each file uses its canonical fileName as source
    // (Issue 3 fix: re-uploading the same file replaces its old chunks, not accumulates)
    const ingestResults = await Promise.allSettled(
      downloaded.map(async ({ buffer, entry }) => {
        const timestamp = Date.now() + Math.random(); // avoid collisions for parallel writes
        const tempPath = join(UPLOADS_DIR, `${timestamp}_${entry.fileName}`);
        try {
          await writeFile(tempPath, buffer);
          const title = acc.caption || basename(entry.fileName, extname(entry.fileName));
          // Issue 3: pass canonical fileName as source (not the timestamped tempPath)
          const result = await ingestDocument(supabase!, tempPath, title, {
            mimeType: entry.mimeType,
            source: entry.fileName,
          });
          return { fileName: entry.fileName, title: result.title, chunksInserted: result.chunksInserted };
        } finally {
          // Issue 1: always clean up temp file even if ingestDocument throws
          await unlink(tempPath).catch(() => {});
        }
      })
    );

    // Build single summary reply
    type IngestOk = { fileName: string; title: string; chunksInserted: number };
    const indexed = ingestResults.filter((r): r is PromiseFulfilledResult<IngestOk> => r.status === "fulfilled" && r.value.chunksInserted > 0);
    const empty   = ingestResults.filter((r): r is PromiseFulfilledResult<IngestOk> => r.status === "fulfilled" && r.value.chunksInserted === 0);
    const failed  = ingestResults.filter((r) => r.status === "rejected");

    const lines: string[] = [];
    if (indexed.length > 0) {
      lines.push(`✅ Indexed ${indexed.length} document${indexed.length === 1 ? "" : "s"}:`);
      for (const r of indexed) {
        lines.push(`  • "${r.value.title}" — ${r.value.chunksInserted} chunk${r.value.chunksInserted === 1 ? "" : "s"}`);
      }
      lines.push("\nYou can now ask me anything about these documents.");
    }
    if (empty.length > 0) {
      lines.push(`⚠️ No text extracted from: ${empty.map((r) => `"${r.value.fileName}"`).join(", ")}`);
    }
    if (failed.length > 0) {
      lines.push(`❌ Failed to index ${failed.length} file${failed.length === 1 ? "" : "s"}.`);
    }
    if (lines.length === 0) {
      lines.push("Could not process any documents. Please try again.");
    }

    await acc.ctx.reply(lines.join("\n")).catch(() => {});
  } catch (error) {
    console.error("[doc-album] Handler error:", error);
    await acc.ctx.reply("Could not index documents. Please try again.").catch(() => {});
  } finally {
    clearInterval(typingInterval);
  }
}

bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id ?? null;

  if (!chatId) return;

  const mediaGroupId = ctx.message.media_group_id;

  if (mediaGroupId) {
    // ── Multi-document album (two-phase) ─────────────────────────────────────
    // Phase 1: collect file_id + metadata — NO download yet.
    // Downloads happen in processDocumentAlbum() once the debounce window closes.
    const entry: DocAlbumEntry = {
      fileId: doc.file_id,
      fileName: doc.file_name || `file_${Date.now()}`,
      mimeType: doc.mime_type,
    };
    const existing = docAlbumAccumulators.get(mediaGroupId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.entries.push(entry);
      if (!existing.caption && ctx.message.caption) {
        existing.caption = ctx.message.caption.trim();
      }
    } else {
      docAlbumAccumulators.set(mediaGroupId, {
        caption: ctx.message.caption?.trim() || "",
        chatId,
        threadId,
        ctx,
        entries: [entry],
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      });
    }
    const acc = docAlbumAccumulators.get(mediaGroupId)!;
    acc.timer = setTimeout(async () => {
      docAlbumAccumulators.delete(mediaGroupId);
      await processDocumentAlbum(acc); // Phase 2: download all → ingest → reply
    }, DOCUMENT_GROUP_DEBOUNCE_MS);
    return;
  }

  // ── Single document ───────────────────────────────────────────────────────
  if (!queueManager.hasCapacity(chatId, threadId)) {
    await ctx.reply("Too many pending messages. Please wait for the current ones to complete.");
    return;
  }

  queueManager.getOrCreate(chatId, threadId).enqueue({
    label: `[chat:${chatId}] doc: ${doc.file_name}`,
    run: async () => {
      const typingInterval = startTypingIndicator(ctx);
      // Issue 1: declare filePath before try so finally can always clean it up
      let filePath: string | undefined;
      try {
        console.log(`[RAG] Document upload: ${doc.file_name}`);
        await ctx.replyWithChatAction("typing");

        if (!supabase) {
          await ctx.reply("Document indexing requires Supabase. Please configure your database first.");
          return;
        }

        const file = await ctx.getFile();
        const timestamp = Date.now();
        // Issue 3: canonical fileName (no timestamp) used as Supabase source key
        const fileName = doc.file_name || `file_${timestamp}`;
        filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

        const response = await fetch(
          `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
        );
        const buffer = await response.arrayBuffer();
        await writeFile(filePath, Buffer.from(buffer));

        // Use caption as title if provided, otherwise derive from filename
        const caption = (ctx.message.caption ?? "").trim();
        const title = caption || basename(fileName, extname(fileName));

        const result = await ingestDocument(supabase, filePath, title, {
          mimeType: doc.mime_type,
          // Issue 3: pass canonical fileName as source — re-uploading the same file
          // replaces its old chunks rather than creating a second source entry
          source: fileName,
        });

        if (result.chunksInserted === 0) {
          await ctx.reply(
            `⚠️ No text extracted from "${fileName}".\n` +
            "If this is a scanned image, try sending it as a photo instead."
          );
        } else {
          await ctx.reply(
            `✅ Indexed: "${result.title}"\n` +
            `📦 ${result.chunksInserted} chunk${result.chunksInserted === 1 ? "" : "s"} stored — embeddings generating.\n\n` +
            "You can now ask me anything about this document."
          );
        }
      } catch (error) {
        console.error("Document handler error:", error);
        try {
          await ctx.reply("Could not index document. Please try again.");
        } catch (replyError) {
          console.error("Failed to send error reply:", replyError);
        }
      } finally {
        clearInterval(typingInterval);
        // Issue 1: always delete temp file — even when ingestDocument throws
        if (filePath) await unlink(filePath).catch(() => {});
      }
    },
  });
});

// ============================================================
// HELPERS
// ============================================================

// Load profile once at startup
let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

// Prompt building is now handled by src/agents/promptBuilder.ts (buildAgentPrompt)

/**
 * Convert Claude's Markdown output to Telegram HTML.
 *
 * Telegram HTML supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href>
 * Order matters — process block-level before inline to avoid double-escaping.
 */
function isBalancedHtml(html: string): boolean {
  const tagStack: string[] = [];
  const selfClosing = new Set(["br", "hr", "img"]);
  const tagRe = /<\/?([a-zA-Z]+)[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    if (selfClosing.has(tag)) continue;
    if (m[0].startsWith("</")) {
      if (tagStack[tagStack.length - 1] === tag) tagStack.pop();
      else return false;
    } else {
      tagStack.push(tag);
    }
  }
  return tagStack.length === 0;
}

async function sendResponse(ctx: Context, response: string, footer?: FooterData): Promise<void> {
  // Handle empty responses
  if (!response || response.trim().length === 0) {
    console.error("Warning: Attempted to send empty response, using fallback");
    await ctx.reply("(Processing completed but no response generated)");
    return;
  }

  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;
  const html = markdownToHtml(response);
  const footerHtml = footer ? buildFooter(footer) : "";

  if (html.length + footerHtml.length <= MAX_LENGTH) {
    try {
      await ctx.reply(html + footerHtml, { parse_mode: "HTML" });
    } catch {
      // Telegram rejected the HTML (e.g. unbalanced tags from markdownToHtml).
      // Fall back to plain text so the response is never silently lost.
      const plain = html.replace(/<[^>]+>/g, "");
      const footerPlain = footerHtml.replace(/<[^>]+>/g, "");
      await ctx.reply(plain + footerPlain);
    }
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = html;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const chunk = isLast ? chunks[i] + footerHtml : chunks[i];
    if (isBalancedHtml(chunk)) {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } else {
      // HTML is not balanced in this chunk — strip tags and send as plain text.
      // For the last chunk, still append the footer as plain text so it's always visible.
      const plain = chunks[i].replace(/<[^>]+>/g, "");
      const footerPlain = isLast ? footerHtml.replace(/<[^>]+>/g, "") : "";
      await ctx.reply(plain + footerPlain);
    }
  }
}

// ============================================================
// START
// ============================================================

// Initialize per-group sessions directory and pre-load all sessions into memory.
// loadAllSessions() must run before any /new command handler can touch the Map —
// without it, resetSession() silently no-ops (sessions.get() returns undefined)
// and /new fails to clear sessionId or messageCount.
await initSessions();
const loadedCount = await loadAllSessions();
console.log(`Sessions pre-loaded: ${loadedCount}`);

// Load pre-configured group mappings from .env
loadGroupMappings();

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);
console.log(`Bot token configured: ${BOT_TOKEN ? "YES" : "NO"}`);
console.log("Group-based multi-agent routing enabled");
console.log("Groups not pre-configured will be auto-discovered by title match");

// Handle process signals to keep bot running
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  reminderManager.cancelAll();
  await sessionManager.pauseAllRunning();
  await queueManager.shutdown(QUEUE_SHUTDOWN_GRACE);
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  reminderManager.cancelAll();
  await sessionManager.pauseAllRunning();
  await queueManager.shutdown(QUEUE_SHUTDOWN_GRACE);
  bot.stop();
  process.exit(0);
});

// Catch unhandled errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Catch grammY-level errors (network issues, middleware failures, etc.)
bot.catch((err) => console.error("Bot error:", err));

// Memory diagnostics: log heap every 60s to correlate spikes with operations.
setInterval(() => {
  const m = process.memoryUsage();
  console.log(
    `[MEM] heapUsed=${Math.round(m.heapUsed / 1024 / 1024)}MB` +
    ` rss=${Math.round(m.rss / 1024 / 1024)}MB` +
    ` external=${Math.round(m.external / 1024 / 1024)}MB`
  );
  // Heap-based OOM guard: exit if heap genuinely leaks (not just high RSS from Bun runtime)
  const HEAP_OOM_THRESHOLD = 400 * 1024 * 1024; // 400MB heap = genuine leak
  if (m.heapUsed > HEAP_OOM_THRESHOLD) {
    console.error(`[MEM] CRITICAL: heapUsed exceeds ${HEAP_OOM_THRESHOLD / 1024 / 1024}MB — exiting for PM2 restart`);
    process.exit(1);
  }
}, 60_000).unref();

// Start bot without await so launchd doesn't time out
bot.start({
  drop_pending_updates: true,
  onStart: (botInfo) => {
    console.log("Bot is running!");
    console.log(`Bot username: @${botInfo.username}`);
    // Signal PM2 that the bot is ready (wait_ready mode)
    if (typeof process.send === "function") {
      process.send("ready");
    }
  },
}).catch((error) => {
  console.error("ERROR starting bot:", error);
  process.exit(1);
});

console.log("bot.start() initiated - waiting for connection...")
