/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InlineKeyboard } from "grammy";
import { writeFile, mkdir, readFile, unlink, appendFile } from "fs/promises";
import { readFileSync, existsSync } from "fs";
import { join, dirname, basename, extname } from "path";
import { insertMessageRecord, deleteDocumentRecords } from "./local/storageBackend";
import {
  activeStreams,
  streamKey,
  parseCancelKey,
  handleCancelCallback,
  handleCancelCommand,
} from "./cancel.ts";
import { markdownToHtml, splitMarkdown } from "./utils/htmlFormat.ts";
import { transcribe } from "./transcribe.ts";
import {
  processMemoryIntents,
  stripMemoryTags,
  getMemoryContext,
  getRelevantContext,
  GENERIC_COMMAND_RE,
} from "./memory.ts";
import {
  getShortTermContext,
  formatShortTermContext,
  shouldSummarize,
  summarizeOldMessages,
  getLastRoutineMessage,
  getLastRealAssistantTurn,
  ROUTINE_SOURCE,
} from "./memory/shortTermMemory.ts";
import {
  getUserProfile,
} from "./memory/longTermExtractor.ts";
import { learnTopicName, learnChatName, getTopicName } from "./utils/chatNames.ts";
import { isMlxAvailable } from "./mlx/index.ts";
import { callRoutineModel } from "./routines/routineModel.ts";
import { getAgentForChat, autoDiscoverGroup, loadGroupMappings } from "./routing/groupRouter.ts";
import { isCommandCenter, orchestrateMessage, registerOrchestrationCallbacks, setDispatchRunner, setTopicCreator, setDispatchNotifier, setMeshNotifier, setInterviewStateMachine, handleOrchestrationComplete, parseFinalCallback, handleFinalAction } from "./orchestration/index.ts";
// Router removed: always use Sonnet for simplicity and predictable latency
import { loadSession as loadGroupSession, updateSessionIdGuarded, initSessions, loadAllSessions, saveSession, isResumeReliable, didResumeFail, lockActiveCwd, resetSession, getSessionSince } from "./session/groupSessions.ts";
import { buildAgentPrompt } from "./agents/promptBuilder.ts";
import { GroupQueueManager } from "./queue/groupQueueManager.ts";
import { registerCommands, registerContextSwitchCallbackHandler, registerRebootCallbackHandler } from "./commands/botCommands.ts";
import { registerTshoOtCommands, handleTshoOtCapture } from "./commands/tshoOtCommands.ts";
import { registerCallbackHandler } from "./routines/routineHandler.ts";
import { getTROQAState, appendQAAnswer } from "./tro/troQAState.ts";
import { registerDedupReviewCallbackHandler } from "./memory/dedupReviewCallbackHandler.ts";
import { registerConflictCallbackHandler } from "./memory/conflictCallbackHandler.ts";
import { registerTaskSuggestionHandler } from "./callbacks/taskSuggestionHandler.ts";
import { registerLearningRetroHandler } from "./callbacks/learningRetroCallbackHandler.ts";
import { registerReflectCommand } from "./callbacks/reflectCommandHandler.ts";
import { InteractiveStateMachine } from "./interactive/index.ts";
import { registerReportCommands, hasActiveReportQA, RPQ_PREFIX } from "./report/index.ts";
import { claudeText, claudeStream, enrichProgressText, type AskUserQuestionItem, type AskUserQuestionEvent } from "./claude-process.ts";
import { ProgressIndicator } from "./utils/progressIndicator.ts";
import { trace, generateTraceId } from "./utils/tracer.ts";
import { extractDocTitle } from "./utils/docTitle.ts";
import { searchDocuments } from "./rag/documentSearch.ts";
import { hasDocuments, invalidateDocumentsCache } from "./rag/hasDocuments.ts";
import { ingestDocument, ingestText, resolveUniqueTitle, checkTitleCollision, deleteDocument } from "./documents/documentProcessor.ts";
import { handleIngestTitleConfirmed as _handleIngestTitleConfirmed, handleDocOverwrite as _handleDocOverwrite } from "./documents/docIngestCallbacks.ts";
import { PendingIngestState, PendingSaveState, INGEST_STATE_TTL_MS, makeIngestState, buildSaveState, appendAssistantPart, resetAssistantParts } from "./documents/ingestFlow.ts";
import { SUPPORTED_DOC_EXTS, buildExtractPrompt } from "./documents/extractFileText.ts";
import { analyzeImages, combineImageContexts } from "./vision/visionClient.ts";
import { analyzeDiagnosticImages } from "./documents/diagnosticAnalyzer.ts";
import { USER_NAME, USER_TIMEZONE } from "./config/userConfig.ts";
import { buildFooter, extractNextStep, type FooterData } from "./utils/footer.ts";
import { getPm2LogsDir } from "../config/observability.ts";

/**
 * Build an enriched search query by prepending recent user messages for domain context.
 * This disambiguates generic commands like "implement this" by including surrounding topic keywords.
 */
export function buildEnrichedQuery(
  verbatimMessages: Array<{ role: string; content: string }> | undefined,
  currentText: string
): string {
  if (!verbatimMessages?.length) return currentText;
  const recentUserMsgs = verbatimMessages
    .filter((m) => m.role === "user")
    .slice(-2)
    .map((m) => m.content)
    .join(" ");
  const enriched = `${recentUserMsgs} ${currentText}`.trim();
  // Truncate to 512 chars to stay within embedding model's optimal input range
  return enriched.length > 512 ? enriched.slice(0, 512) : enriched;
}

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// Load .env files explicitly (for launchd and other non-interactive contexts).
// Layering order (later wins):
//   1. process.env  — runtime / PM2 / shell exports (never overridden)
//   2. project .env — committed defaults
//   3. ~/.claude-relay/.env — user-specific secrets and overrides
function _loadEnvFile(filePath: string, override: boolean): void {
  try {
    const envFile = readFileSync(filePath, "utf-8");
    for (const line of envFile.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      const k = key?.trim();
      if (k && valueParts.length > 0) {
        const value = valueParts.join("=").trim();
        // Project .env: only set if not already set (respects runtime env).
        // User .env (override=true): always wins — user config is authoritative
        // over both project defaults and stale shell-inherited vars.
        if (override || !process.env[k]) {
          process.env[k] = value;
        }
      }
    }
  } catch {
    // file might not exist or be unreadable — continue
  }
}

// 1. Project .env — defaults, don't override runtime env
_loadEnvFile(join(PROJECT_ROOT, ".env"), false);

// 2. ~/.claude-relay/.env — user overrides (wins over project .env, not over runtime env)
const _relayDir = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
_loadEnvFile(join(_relayDir, ".env"), true);

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

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session management is now per-group — see src/session/groupSessions.ts

import {
  SONNET_MODEL,
  OPUS_MODEL,
  HAIKU_MODEL,
  LOCAL_MODEL_TOKEN,
  resolveModelPrefix,
} from "./utils/modelPrefix.ts";

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
  reject: (reason?: Error) => void;
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
/** Insertion timestamps for pendingRelayCustomReplies TTL sweep. */
const pendingRelayCustomReplyTimestamps = new Map<number, number>();

const RELAY_FORM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================
// ============================================================
// FM-2+3: PENDING KB SAVES
// ============================================================

/** Pending KB save state, keyed by saveId = "{chatId}:{timestamp}". Capped at 200 entries. */
const pendingKBSaves = new Map<string, { text: string; title: string; chatId: number; threadId: number | null }>();
const MAX_PENDING_KB_SAVES = 50;
/** Expiry timer IDs for pendingKBSaves — cleared before a key is removed to prevent zombie timers. */
const pendingKBSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Remove a pending KB save and cancel its expiry timer. */
function deletePendingKBSave(key: string): void {
  pendingKBSaves.delete(key);
  const t = pendingKBSaveTimers.get(key);
  if (t) { clearTimeout(t); pendingKBSaveTimers.delete(key); }
}

// ============================================================
// DOC INGEST STATE
// Tracks /doc ingest flow state per chat (await-content, await-title, etc.)
// Also tracks [💾 Save to KB] button flows and last assistant responses.
// ============================================================

/** Keyed by streamKey(chatId, threadId). Tracks /doc ingest flow per chat. */
const pendingIngestStates = new Map<string, PendingIngestState>();

/** Keyed by streamKey(chatId, threadId). Tracks [💾 Save to KB] button flow. */
const pendingSaveStates = new Map<string, PendingSaveState>();

/** Keyed by streamKey(chatId, threadId). Accumulates last bot turn message parts. */
const lastAssistantResponses = new Map<string, string[]>();

// ============================================================
// FM-1: TEXT BURST DEBOUNCE
// Telegram splits long pasted text into N fragments sent within milliseconds.
// We accumulate fragments for 600ms then flush as one assembled message.
// 600ms matches the photo-album debounce; imperceptible for normal replies.
// ============================================================

const TEXT_BURST_DEBOUNCE_MS = 600;

interface TextBurstAccumulator {
  texts: string[];
  chatId: number;
  threadId: number | null;
  ctx: Context;  // most-recent ctx — reply goes to the last fragment's thread
  timer: ReturnType<typeof setTimeout>;
}

const textBurstAccumulators = new Map<string, TextBurstAccumulator>();

function flushTextBurst(burstKey: string): void {
  const acc = textBurstAccumulators.get(burstKey);
  if (!acc) return;
  textBurstAccumulators.delete(burstKey);

  const { chatId, threadId, ctx, texts } = acc;
  const assembled = texts.join("\n\n");

  if (!queueManager.hasCapacity(chatId, threadId)) {
    ctx.reply("Too many pending messages. Please wait for the current ones to complete.").catch(() => {});
    return;
  }

  if (texts.length > 1) {
    console.log(`[burst] assembled ${texts.length} fragments (${assembled.length} chars) for chat ${chatId}`);
  }

  // Check for pending /doc ingest — text is KB content, not a Claude message
  const ingestState = pendingIngestStates.get(burstKey);
  if (ingestState && ingestState.stage === "await-content") {
    if (Date.now() > ingestState.expiresAt) {
      pendingIngestStates.delete(burstKey);
      ctx.reply("Timed out. Send `/doc ingest` again.").catch(() => {});
      return;
    }
    queueManager.getOrCreate(chatId, threadId).enqueue({
      label: `[chat:${chatId}] doc-ingest-flush`,
      run: () => handleIngestFlush(chatId, threadId, burstKey, assembled, ctx),
    });
    return;
  }

  // Command Center intercept — route through orchestration layer instead of normal Claude flow
  if (isCommandCenter(chatId)) {
    queueManager.getOrCreate(chatId, threadId).enqueue({
      label: `[chat:${chatId}] CC orchestrate: ${assembled.substring(0, 30)}`,
      run: () => orchestrateMessage(bot, ctx, assembled, chatId, threadId),
    });
    return;
  }

  queueManager.getOrCreate(chatId, threadId).enqueue({
    label: `[chat:${chatId}] ${assembled.substring(0, 30)}`,
    run: () => processTextMessage(chatId, threadId, assembled, ctx),
  });

  // /doc save: track last large paste per chatId (>200 chars); evict after 30min
  if (assembled.length > 200) {
    const oldTimer = lastLargePasteTimers.get(chatId);
    if (oldTimer) clearTimeout(oldTimer);
    lastLargePastes.set(chatId, assembled);
    // M-LEAK: Cap large paste cache
    if (lastLargePastes.size > 10) {
      const oldest = lastLargePastes.keys().next().value;
      if (oldest !== undefined) {
        lastLargePastes.delete(oldest);
        const t = lastLargePasteTimers.get(oldest);
        if (t) { clearTimeout(t); lastLargePasteTimers.delete(oldest); }
      }
    }
    lastLargePasteTimers.set(chatId, setTimeout(() => {
      lastLargePastes.delete(chatId);
      lastLargePasteTimers.delete(chatId);
    }, 30 * 60 * 1000));
  }
}

/**
 * FM-6: Embed verification — no-op in local mode.
 * Local embeddings are generated synchronously during insert;
 * if insertDocumentRecords succeeded, embeddings exist.
 */
function scheduleEmbedVerification(
  _bot: Bot,
  _pending: { chatId: number; threadId: number | null },
  _title: string,
  _totalChunks: number
): void {
  // No-op: local embeddings are generated synchronously during insert.
}

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
// MESSAGE PERSISTENCE
// ============================================================


async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  chatId?: number,
  agentId?: string,
  threadId?: number | null
): Promise<void> {
  try {
    const threadName =
      threadId == null
        ? "#General"
        : (getTopicName(threadId) ?? null);
    await insertMessageRecord({
      role,
      content,
      chat_id: chatId,
      thread_id: threadId,
      agent_id: agentId,
      channel: "telegram",
      metadata,
      thread_name: threadName,
    });
  } catch (error) {
    console.error("Message save error:", error);
  }
}

// Check fallback availability at startup
let fallbackAvailable = false;
{
  fallbackAvailable = await isMlxAvailable();
  if (fallbackAvailable) {
    console.log("Fallback model available: MLX (Qwen3.5-9B)");
  } else {
    console.warn("MLX server not reachable. Claude will be used exclusively.");
  }
}

const bot = new Bot(BOT_TOKEN);
export { bot };

// ── Resume failure: pending context injection store ──────────────────────────
// When resume fails we ask the user via inline keyboard whether to inject
// shortTermContext into the next call. The formatted context is held here until
// the user responds (or the entry is garbage-collected by restart).
const pendingResumeContext = new Map<string, string>(); // key → formatted context
/** Insertion timestamps for pendingResumeContext TTL sweep. */
const pendingResumeContextTimestamps = new Map<string, number>();

/** TTL for routine context injection — only inject routine messages within this window. */
const ROUTINE_INJECT_TTL_MS = parseInt(process.env.ROUTINE_INJECT_TTL_MS || String(4 * 60 * 60 * 1000), 10);

/** Tracks the most recent large paste (>200 chars) per chatId for /doc save. */
const lastLargePastes = new Map<number, string>();
/** Eviction timer per chatId — cleared before setting a new one to prevent zombie timers. */
const lastLargePasteTimers = new Map<number, ReturnType<typeof setTimeout>>();

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
  pendingResumeContextTimestamps.set(key, Date.now());

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

// Learn topic and chat names from incoming messages for source label resolution
bot.use(async (ctx, next) => {
  const msg = ctx.message;
  if (msg) {
    // Learn group chat name (for non-agent groups like project chats)
    const chatTitle = ctx.chat && "title" in ctx.chat ? ctx.chat.title : undefined;
    if (chatTitle && ctx.chat?.id) {
      learnChatName(ctx.chat.id, chatTitle);
    }

    // Learn from forum_topic_created service messages
    const topicCreated = msg.forum_topic_created;
    if (topicCreated && msg.message_thread_id) {
      learnTopicName(msg.message_thread_id, topicCreated.name);
    }
    // Learn from reply_to_message that contains forum_topic info
    const replyTopic = msg.reply_to_message?.forum_topic_created;
    if (replyTopic && msg.message_thread_id) {
      learnTopicName(msg.message_thread_id, replyTopic.name);
    }
  }
  await next();
});

// Register session management commands (/status, /new, /memory, /history, /help)
// NOTE: Registered AFTER security middleware so commands are protected
const allowedUserId = parseInt(ALLOWED_USER_ID || "0", 10);
// Intercept /doc ingest BEFORE registerCommands so state machine lives in relay.ts
bot.command("doc", async (ctx, next) => {
  const args = ((ctx.match as string) ?? "").trim();
  const firstWord = args.split(" ")[0];
  if (firstWord !== "ingest") return next();

  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id ?? null;
  if (!chatId) return;
  // Local storage always available

  const key = streamKey(chatId, threadId);
  const titleArg = args.slice("ingest".length).trim(); // everything after "ingest"

  // Path A: no file attached (pure text command) → enter await-content
  pendingIngestStates.set(key, makeIngestState(titleArg || undefined));
  // Expiry is enforced by the 60s sweep (M2); no proactive setTimeout needed.
  await ctx.reply("📋 Ready. Paste your content now. (/cancel to abort)");
});

// Register orchestration callback handlers (Pause/Edit/Cancel + agent picker)
registerOrchestrationCallbacks(bot);

// Register finalizer governance callbacks (Approve/Override/Retry/Discard)
bot.on("callback_query:data", async (ctx, next) => {
  const data = ctx.callbackQuery.data;
  const parsed = parseFinalCallback(data);
  if (!parsed) return next();

  const { getDb } = await import("./local/db.ts");
  const db = getDb();
  const result = handleFinalAction(db, parsed.action, parsed.sessionId);

  await ctx.answerCallbackQuery({ text: result.message.slice(0, 200) });

  // Post result to the chat
  if (ctx.callbackQuery.message) {
    await bot.api.sendMessage(
      ctx.callbackQuery.message.chat.id,
      result.message,
      { message_thread_id: ctx.callbackQuery.message.message_thread_id ?? undefined },
    ).catch(() => {});

    // Remove the keyboard from the original message
    await bot.api.editMessageReplyMarkup(
      ctx.callbackQuery.message.chat.id,
      ctx.callbackQuery.message.message_id,
      {},
    ).catch(() => {});
  }
});

// Register dispatch runner — dispatch engine calls processTextMessage directly
// instead of going through Telegram API (outgoing bot messages don't trigger handlers).
setDispatchRunner(async (chatId: number, topicId: number | null, text: string) => {
  const syntheticCtx = {
    replyWithChatAction: (action: string) =>
      bot.api.sendChatAction(chatId, action as Parameters<typeof bot.api.sendChatAction>[1], {
        message_thread_id: topicId ?? undefined,
      }).catch(() => {}),
    reply: (replyText: string, other?: Record<string, unknown>) =>
      bot.api.sendMessage(chatId, replyText, {
        message_thread_id: topicId ?? undefined,
        ...(other ?? {}),
      }),
    chat: { id: chatId },
    message: { message_thread_id: topicId ?? undefined },
    from: { id: allowedUserId },
  } as unknown as Context;

  await processTextMessage(chatId, topicId, text, syntheticCtx);
  return lastAssistantResponses.get(streamKey(chatId, topicId))?.join("") ?? null;
});

// Register topic creator — dispatch engine creates forum topics for session visibility
setTopicCreator(async (chatId: number, title: string): Promise<number | null> => {
  try {
    const topic = await bot.api.createForumTopic(chatId, title);
    return topic.message_thread_id;
  } catch (err) {
    // Non-forum groups will throw — expected, fall back to root chat
    console.warn(`[relay] createForumTopic failed for chat ${chatId}:`, err instanceof Error ? err.message : err);
    return null;
  }
});

// Register dispatch notifier — sends header messages to agent groups
setDispatchNotifier(async (chatId: number, topicId: number | null, text: string): Promise<void> => {
  await bot.api.sendMessage(chatId, text, {
    message_thread_id: topicId ?? undefined,
  }).catch((err) => {
    console.warn(`[relay] dispatch notifier failed for chat ${chatId}:`, err instanceof Error ? err.message : err);
  });
});

// Register mesh notifier — posts agent-to-agent messages to dedicated mesh topics
setMeshNotifier(async (chatId: number, topicId: number | null, text: string): Promise<void> => {
  await bot.api.sendMessage(chatId, text, {
    message_thread_id: topicId ?? undefined,
    parse_mode: "Markdown",
  }).catch((err) => {
    console.warn(`[relay] mesh notifier failed for chat ${chatId}:`, err instanceof Error ? err.message : err);
  });
});

registerCommands(bot, {
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
    if (isCommandCenter(chatId)) {
      queueManager.getOrCreate(chatId, threadId).enqueue({
        label: `[chat:${chatId}] CC orchestrate: ${text.substring(0, 30)}`,
        run: () => orchestrateMessage(bot, ctx, text, chatId, threadId),
      });
    } else {
      queueManager.getOrCreate(chatId, threadId).enqueue({
        label: `[chat:${chatId}] /new: ${text.substring(0, 30)}`,
        run: () => processTextMessage(chatId, threadId, text, ctx),
      });
    }
  },
  getLastPaste: (chatId: number) => lastLargePastes.get(chatId),
});

// Register tshoot commands (/scan, /ts-new, /ts-sessions, /ts-resume, /ts-status)
registerTshoOtCommands(bot, {
  agentResolver: (chatId) => getAgentForChat(chatId).id,
});

// Register routine creation callback handler (inline keyboard for output target)
registerCallbackHandler(bot);

// Register /reboot confirmation callback handler (reboot:confirm / reboot:cancel)
registerRebootCallbackHandler(bot);

// Register weekly dedup review callback handler (mdr_yes / mdr_no from memory-dedup-review routine)
registerDedupReviewCallbackHandler(bot);

// Register memory conflict resolution callback handler (mcr_keep / mcr_all / mcr_skip from /memory dedup)
registerConflictCallbackHandler(bot);

// Register task suggestion callback handler (ts:all / ts:skip from morning-summary / smart-checkin)
registerTaskSuggestionHandler(bot);

// Register learning retro callback handler (lr:promote / lr:reject / lr:later from weekly-retro)
registerLearningRetroHandler(bot);

// Register /reflect command for explicit learning feedback
registerReflectCommand(bot, (chatId) => getAgentForChat(chatId).id);

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

/**
 * Thrown by callClaude when a --resume attempt fails with the stale-session
 * fingerprint (exit 1, empty stderr). The caller should clear the session ID,
 * rebuild the prompt with full context injection, and retry without --resume.
 */
class StaleSessionError extends Error {
  constructor() {
    super("stale-session: Claude exited 1 with empty stderr on --resume");
    this.name = "StaleSessionError";
  }
}

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
    /** Raw tool_use event callback — used to detect worktree/branch changes. */
    onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
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

    // Guard: if the requested cwd no longer exists (e.g. a deleted worktree), fall back to
    // PROJECT_DIR rather than letting the Claude CLI fail with exit 1 + empty stderr, which
    // is indistinguishable from the stale-session fingerprint and triggers a false reset.
    const requestedCwd = options?.cwd;
    const resolvedCwd = requestedCwd && !existsSync(requestedCwd)
      ? (() => {
          console.warn(`[callClaude] cwd does not exist: ${requestedCwd} — falling back to PROJECT_DIR`);
          return PROJECT_DIR || undefined;
        })()
      : (requestedCwd ?? (PROJECT_DIR || undefined));

    return await claudeStream(prompt, {
      sessionId: options?.resume && options?.sessionId ? options.sessionId : undefined,
      cwd: resolvedCwd,
      claudePath: CLAUDE_PATH,
      onProgress: options?.onProgress,
      onSessionId: options?.onSessionId,
      onToolUse: options?.onToolUse,
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
      // Send a persistent Telegram message when maxTurns kill fires.
      // onProgress routes to ProgressIndicator which gets deleted on finish —
      // this direct sendMessage ensures the user sees a durable alert.
      onMaxTurns: chatId != null ? (msg) => {
        bot.api.sendMessage(
          chatId,
          msg,
          threadId != null ? { message_thread_id: threadId } : undefined
        ).catch(() => {});
      } : undefined,
    });
  } catch (error) {
    console.error("Claude error:", error);

    // Don't fall back to MLX for idle timeouts — stalled streams won't recover.
    const isIdleTimeout = error instanceof Error && error.message.includes("idle timeout");

    // Stale session fingerprint: --resume was attempted, exit 1, empty stderr.
    // Throw StaleSessionError so the caller (processTextMessage) can rebuild the
    // prompt with full context injection before retrying without --resume.
    if (options?.resume && error instanceof Error && /claudeStream: exit 1 —\s*$/.test(error.message)) {
      throw new StaleSessionError();
    }

    // Try fallback if available (skip for idle timeouts)
    if (!isIdleTimeout && fallbackAvailable) {
      console.log("Claude failed, trying MLX fallback...");
      const notifyChatId = options?.chatId;
      const notifyThreadId = options?.threadId ?? null;
      if (notifyChatId != null) {
        bot.api.sendMessage(
          notifyChatId,
          `⚠️ Claude unavailable — retrying with local model…`,
          notifyThreadId != null ? { message_thread_id: notifyThreadId } : undefined
        ).catch(() => {});
      }
      try {
        const fallbackResponse = await callRoutineModel(prompt, { label: "chat-fallback", timeoutMs: 60_000 });
        return `[via Qwen3.5-9B (MLX)]\n\n${fallbackResponse}`;
      } catch (fallbackError) {
        console.error("Fallback also failed:", fallbackError);
        return `Error: Both Claude and local model failed. Please try again in a moment.`;
      }
    }

    // No fallback available — return a user-friendly error string.
    const isEmptyStderr = error instanceof Error && /claudeStream: exit 1 —\s*$/.test(error.message);
    if (isEmptyStderr) {
      return "⚠️ Claude exited unexpectedly (no error details). This can happen when the context is very large. Try /new to start a fresh session.";
    }
    return `Error: ${error instanceof Error ? error.message : "Could not run Claude CLI"}`;
  } finally {
    if (key) activeStreams.delete(key);
  }
}

// ============================================================
// DOC INGEST HELPERS
// ============================================================

/**
 * Extract text from a downloaded file.
 * TXT/MD: direct read. PDF/DOCX/PPTX/XLSX: delegate to Claude Code (uses Read tool).
 */
interface ExtractedFile {
  text: string;
  pages?: import("./documents/pdfExtractor").PageText[];
}

async function extractFileText(filePath: string, ext: string): Promise<ExtractedFile> {
  if (ext === ".txt" || ext === ".md") {
    return { text: await Bun.file(filePath).text() };
  }
  // Use unpdf for fast PDF extraction; fall back to Claude CLI for other formats
  // or if unpdf yields sparse text (scanned/image PDFs)
  if (ext === ".pdf") {
    const { extractPdf } = await import("./documents/pdfExtractor");
    const result = await extractPdf(filePath);
    if (result.fullText.trim()) {
      // Return raw page text (without [PAGE N] markers) for proper chunking
      const rawText = result.pages.map((p) => p.text).join("\n\n");
      return { text: rawText, pages: result.pages };
    }
  }
  const text = await callClaude(buildExtractPrompt(filePath, ext), { model: SONNET_MODEL });
  return { text };
}

/**
 * Download a Telegram document to the uploads directory.
 * Returns { filePath, fileName, ext } on success, or null after replying with an error.
 */
async function downloadTelegramDoc(
  ctx: Context,
  doc: { file_id: string; file_name?: string; mime_type?: string; file_size?: number },
  unsupportedMsg: string
): Promise<{ filePath: string; fileName: string; ext: string } | null> {
  const fileName = doc.file_name || `file_${Date.now()}`;
  const ext = extname(fileName).toLowerCase();

  if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
    await ctx.reply("❌ File too large (max 20 MB).");
    return null;
  }

  if (!SUPPORTED_DOC_EXTS.has(ext)) {
    await ctx.reply(unsupportedMsg);
    return null;
  }

  const file = await ctx.getFile();
  const timestamp = Date.now();
  const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);
  await ctx.reply(`📄 Reading ${fileName}…`);

  const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
  const buffer = await response.arrayBuffer();
  await writeFile(filePath, Buffer.from(buffer));

  return { filePath, fileName, ext };
}

/** Show title confirmation keyboard for doc ingest/save flows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function showTitleKeyboard(
  ctx: any,
  suggestedTitle: string,
  confirmAction: string,
  newTitleAction: string,
  cancelAction: string
): Promise<void> {
  const kb = new InlineKeyboard()
    .text("✔ Use this title", confirmAction)
    .text("✏️ Enter new title", newTitleAction)
    .row()
    .text("❌ Cancel", cancelAction);
  await ctx.reply(`Suggested title: "${suggestedTitle}"`, { reply_markup: kb });
}

/** Show collision keyboard — always 2 buttons. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function showCollisionKeyboard(
  ctx: any,
  title: string,
  overwriteAction: string,
  cancelAction: string
): Promise<void> {
  const kb = new InlineKeyboard()
    .text("✅ Overwrite", overwriteAction)
    .text("❌ Cancel", cancelAction);
  await ctx.reply(`⚠️ "${title}" already exists.`, { reply_markup: kb });
}

/**
 * Called after TextBurstAccumulator flushes during an await-content state.
 * Handles title suggestion or fast-path save.
 */
async function handleIngestFlush(
  chatId: number,
  threadId: number | null,
  key: string,
  content: string,
  ctx: Context
): Promise<void> {
  // Local storage always available
  const state = pendingIngestStates.get(key);
  if (!state || state.stage !== "await-content") return;

  if (Date.now() > state.expiresAt) {
    pendingIngestStates.delete(key);
    await ctx.reply("Timed out. Send `/doc ingest` again.");
    return;
  }

  state.body = content;

  if (state.title) {
    // Fast path: title known → dedup check → save
    const collision = await checkTitleCollision(state.title);
    if (collision.exists) {
      state.stage = "await-dedup-resolution";
      pendingIngestStates.set(key, state);
      await showCollisionKeyboard(ctx, state.title, `di_overwrite:${key}`, `di_cancel:${key}`);
    } else {
      pendingIngestStates.delete(key);
      await performIngestSave(chatId, threadId, content, state.title, ctx);
    }
  } else {
    // No title → suggest one
    const suggested = extractDocTitle(content);
    state.stage = "await-title";
    state.title = suggested;
    pendingIngestStates.set(key, state);
    await showTitleKeyboard(ctx, suggested, `di_use_title:${key}`, `di_new_title:${key}`, `di_cancel:${key}`);
  }
}

/** Handle Path B: file attached with /doc ingest (or file sent while in await-content). */
async function handleIngestFilePathB(
  chatId: number,
  threadId: number | null,
  key: string,
  doc: { file_id: string; file_name?: string; mime_type?: string; file_size?: number },
  titleArg: string,
  ctx: Context
): Promise<void> {
  // Local storage always available

  const indicator = new ProgressIndicator();
  indicator.setModelLabel("📄 Doc");
  indicator.start(chatId, bot, threadId, {}).catch(() => {});
  let filePath: string | undefined;
  try {
    void indicator.update("Downloading file…", { immediate: true });

    const downloaded = await downloadTelegramDoc(ctx, doc, `❌ Unsupported file type. Supported: PDF, DOCX, PPTX, XLSX, .md, .txt`);
    if (!downloaded) { await indicator.finish(false); return; }
    const { filePath: fp, fileName, ext } = downloaded;
    filePath = fp;

    // Extract text with progress updates
    void indicator.update(`Extracting text from ${fileName}…`, { immediate: true });
    const extracted = await extractFileText(filePath, ext);
    const text = extracted.text;
    if (!text.trim()) {
      await indicator.finish(false);
      await ctx.reply("❌ Could not extract text from this file.");
      return;
    }
    void indicator.update(`Extracted ${text.length.toLocaleString()} chars`, { immediate: true });

    // Clear any existing pending state
    pendingIngestStates.delete(key);

    if (titleArg) {
      // Fast path: title provided → dedup check → save
      const collision = await checkTitleCollision(titleArg);
      if (collision.exists) {
        pendingIngestStates.set(key, {
          stage: "await-dedup-resolution",
          title: titleArg,
          body: text,
          expiresAt: Date.now() + INGEST_STATE_TTL_MS,
        });
        await indicator.finish();
        await showCollisionKeyboard(ctx, titleArg, `di_overwrite:${key}`, `di_cancel:${key}`);
      } else {
        await performIngestSave(chatId, threadId, text, titleArg, ctx, indicator, extracted.pages);
      }
    } else {
      // No title → suggest from content or filename
      const suggested = extractDocTitle(text) || basename(fileName, ext);
      pendingIngestStates.set(key, {
        stage: "await-title",
        title: suggested,
        body: text,
        expiresAt: Date.now() + INGEST_STATE_TTL_MS,
      });
      await indicator.finish();
      await showTitleKeyboard(ctx, suggested, `di_use_title:${key}`, `di_new_title:${key}`, `di_cancel:${key}`);
    }
  } catch (err) {
    console.error("[doc-ingest-file] error:", err);
    await indicator.finish(false);
    await ctx.reply("Could not process file. Please try again.").catch(() => {});
  } finally {
    if (filePath) await unlink(filePath).catch(() => {});
  }
}

/** Perform the actual ingest save and reply with confirmation. */
async function performIngestSave(
  chatId: number,
  threadId: number | null,
  body: string,
  title: string,
  ctx: Context,
  indicator?: InstanceType<typeof ProgressIndicator>,
  pages?: import("./documents/pdfExtractor").PageText[],
): Promise<void> {
  // Local storage always available
  if (indicator) void indicator.update(`Chunking & indexing "${title}"…`, { immediate: true });
  const result = await ingestText(body, title, {
    pages,
    onProgress: (msg) => { if (indicator) void indicator.update(msg, { immediate: true }); },
  });
  if (indicator) await indicator.finish();
  if (result.duplicate) {
    await ctx.reply(`ℹ️ Already in knowledge base as "${result.title}". Nothing changed.`);
  } else {
    await ctx.reply(`✅ Saved: "${title}" — ${result.chunksInserted} chunk${result.chunksInserted === 1 ? "" : "s"} (${body.length.toLocaleString()} chars)`);
    scheduleEmbedVerification(bot,{ chatId, threadId }, title, result.chunksInserted);
  }
}

/** Handle free-text title capture for /doc ingest flow. */
async function handleIngestTitleConfirmed(
  chatId: number,
  threadId: number | null,
  key: string,
  newTitle: string,
  ctx: Context
): Promise<void> {
  // Local storage always available
  await _handleIngestTitleConfirmed(chatId, threadId, key, newTitle, {
    pendingIngestStates,
    checkTitleCollision: (title) => checkTitleCollision(title),
    showCollisionKeyboard: (title, overwriteKey, cancelKey) => showCollisionKeyboard(ctx, title, overwriteKey, cancelKey),
    performSave: (cid, tid, body, title) => performIngestSave(cid, tid, body, title, ctx),
  });
}

/** Handle bare file (no /doc ingest) — extract text and send to Claude. Task 5. */
async function handleBareFileToClaudeInternal(
  chatId: number,
  threadId: number | null,
  doc: { file_id: string; file_name?: string; mime_type?: string; file_size?: number },
  caption: string,
  ctx: Context
): Promise<void> {
  const typingInterval = startTypingIndicator(ctx);
  let filePath: string | undefined;
  try {
    await ctx.replyWithChatAction("typing");

    const downloaded = await downloadTelegramDoc(ctx, doc, `❌ Unsupported file type. To save to KB: send with /doc ingest`);
    if (!downloaded) return;
    const { filePath: fp, fileName, ext } = downloaded;
    filePath = fp;

    const extracted = await extractFileText(filePath, ext);
    if (!extracted.text.trim()) { await ctx.reply("❌ Could not extract text from this file."); return; }

    // Build Claude prompt: caption as question or default to summarise
    const userPrompt = caption || `Summarise this file.`;
    const contextPrefix = `[Attached: ${fileName}]\n${extracted.text}\n\n`;
    const fullPrompt = contextPrefix + userPrompt;

    // Route to processTextMessage so session/memory/etc. all work
    await processTextMessage(chatId, threadId, fullPrompt, ctx);
  } catch (err) {
    console.error("[doc-to-claude] error:", err);
    await ctx.reply("Could not process file. Please try again.").catch(() => {});
  } finally {
    clearInterval(typingInterval);
    if (filePath) await unlink(filePath).catch(() => {});
  }
}

/** Handle free-text title capture for [💾 Save to KB] flow. */
async function handleSaveTitleConfirmed(
  chatId: number,
  threadId: number | null,
  key: string,
  newTitle: string,
  ctx: Context
): Promise<void> {
  // Local storage always available
  const state = pendingSaveStates.get(key);
  if (!state) return;

  const collision = await checkTitleCollision(newTitle);
  if (collision.exists) {
    state.stage = "await-dedup-resolution";
    state.suggestedTitle = newTitle;
    pendingSaveStates.set(key, state);
    await showCollisionKeyboard(ctx, newTitle, `ks_overwrite:${key}`, `ks_cancel:${key}`);
  } else {
    pendingSaveStates.delete(key);
    const result = await ingestText(state.body, newTitle);
    if (result.duplicate) {
      await ctx.reply(`ℹ️ Already in knowledge base as "${result.title}". Nothing changed.`);
    } else {
      await ctx.reply(`✅ Saved: "${newTitle}"`);
      scheduleEmbedVerification(bot,{ chatId, threadId }, newTitle, result.chunksInserted);
    }
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

// Lightweight caller for /plan question generation.
// Tries local MLX first, falls back to Claude Haiku.
async function questionCallClaude(prompt: string): Promise<string> {
  try {
    const result = await callRoutineModel(prompt, {
      label: "interactive-question",
      timeoutMs: 10_000,
    });
    console.log("[interactive] MLX succeeded");
    return result;
  } catch (mlxErr) {
    console.warn("[interactive] MLX failed, falling back to Haiku:", mlxErr instanceof Error ? mlxErr.message : mlxErr);
    try {
      const result = await claudeText(prompt, {
        model: "claude-haiku-4-5-20251001",
        timeoutMs: 60_000,
      });
      console.log("[interactive] Haiku fallback succeeded");
      return result;
    } catch (haikuErr) {
      console.error("[interactive] Both MLX and Haiku failed:");
      console.error("  MLX:", mlxErr instanceof Error ? mlxErr.message : mlxErr);
      console.error("  Haiku:", haikuErr instanceof Error ? haikuErr.message : haikuErr);
      throw haikuErr;
    }
  }
}

// Interactive Q&A flow (/plan command)
const interactive = new InteractiveStateMachine(bot, callClaude, questionCallClaude);

// Wire constrained mesh: inject interview SM into CC for compound/ambiguous tasks
setInterviewStateMachine(interactive);
interactive.setOrchestrationHandler((session) => handleOrchestrationComplete(bot, session));

bot.command("plan", (ctx) => interactive.handlePlanCommand(ctx));

// Report Generator integration (/report command + QA sessions)
const reportQA = registerReportCommands(bot);

// Cancel the active claudeStream for this chat/thread
bot.command("cancel", async (ctx) => {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id ?? null;
  if (!chatId) return;

  // Also clear pending doc ingest / save-to-KB states
  const key = streamKey(chatId, threadId);
  const hadDocState = pendingIngestStates.has(key) || pendingSaveStates.has(key);
  pendingIngestStates.delete(key);
  pendingSaveStates.delete(key);
  if (hadDocState) { await ctx.reply("Cancelled."); return; }

  await handleCancelCommand(chatId, threadId, ctx, bot);
});

// Handle iq: and cancel: callback queries.
bot.on("callback_query:data", async (ctx, next) => {
  if (process.env.E2E_DEBUG) console.log("[e2e:callback_query]", JSON.stringify({ callbackQuery: ctx.callbackQuery, chat: ctx.chat, from: ctx.from }));
  const data = ctx.callbackQuery.data || "";
  if (data.startsWith("rq:")) {
    // ── Relay Question Form callbacks ────────────────────────────────────────
    const ackResult = await ctx.answerCallbackQuery().catch(() => undefined);
    if (process.env.E2E_DEBUG) console.log("[e2e:outgoing:answerCallbackQuery]", JSON.stringify(ackResult));

    const parts = data.split(":");
    const action = parts[1]; // s | n | o | sub | cxl
    const chatId = parseInt(parts[2] ?? "0", 10);
    const tid = parseInt(parts[3] ?? "0", 10);
    const threadId = tid === 0 ? null : tid;
    const key = streamKey(chatId, threadId);
    const form = pendingRelayForms.get(key);

    const dbgRq = process.env.INTERACTIVE_DEBUG === "1";
    if (dbgRq) console.log(`[rq:DEBUG] action=${action} key=${key} formFound=${!!form} pendingFormsCount=${pendingRelayForms.size} data=${data}`);

    if (!form) {
      console.warn(`[rq] no pending form for key=${key} action=${action} — form may have already resolved/cancelled or process was killed`);
      return;
    }

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
        const editResult = await bot.api.editMessageText(chatId, form.formMessageId, buildFormText(form), {
          reply_markup: buildFormKeyboard(form, chatId, threadId),
        });
        if (process.env.E2E_DEBUG) console.log("[e2e:outgoing:editMessageText]", JSON.stringify(editResult));
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
        pendingRelayCustomReplyTimestamps.set(promptMsg.message_id, Date.now());
      } catch (err) {
        console.error("[relay-form] Failed to send force-reply prompt:", err);
      }

    } else if (action === "sub") {
      // Submit All: rq:sub:{chatId}:{tid}
      const submittedAnswers = collectAnswers(form);
      console.debug(`[relay-form] rq:sub key=${key} answers:`, JSON.stringify(submittedAnswers));
      if (dbgRq) console.log(`[rq:DEBUG] rq:sub — submittedAnswers=${JSON.stringify(submittedAnswers)} toolUseId=${form.toolUseId} selectionsSize=${form.selections.size}`);
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
      if (dbgRq) console.log(`[rq:DEBUG] rq:cxl — cancelling form key=${key} toolUseId=${form.toolUseId}`);
      pendingRelayForms.delete(key);
      clearTimeout(form.timeoutId);

      try {
        await bot.api.editMessageReplyMarkup(chatId, form.formMessageId, {
          reply_markup: undefined,
        });
      } catch { /* ignore */ }

      console.warn(`[relay-form] rq:cxl key=${key} — user cancelled form, rejecting onQuestion promise`);
      form.reject(new Error("user cancelled"));
    }
    return;
  } else if (data.startsWith("rpq:")) {
    await reportQA.handleCallback(ctx, data);
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
      pendingResumeContextTimestamps.delete(key);

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
      pendingResumeContextTimestamps.delete(resumeCtxKey(chatId, threadId));
      // no-op — user wants a fresh start
    }
  } else {
    // Unrecognised prefix — let specific bot.callbackQuery() handlers take over
    return next();
  }
});

// ============================================================
// FM-2+3: KB SAVE CALLBACK HANDLERS
// ============================================================

// Save to KB
bot.callbackQuery(/^save_to_kb:/, async (ctx) => {
  const saveId = ctx.callbackQuery.data.replace("save_to_kb:", "");
  const pending = pendingKBSaves.get(saveId);
  console.log(`[kb-save] callback saveId=${saveId} found=${!!pending} pendingMapSize=${pendingKBSaves.size}`);
  if (!pending) {
    const reason = "key-miss";
    console.warn(`[kb-save] aborted reason=${reason} saveId=${saveId}`);
    await ctx.answerCallbackQuery("Session expired — please resend your message.");
    await ctx.editMessageText("⚠️ Session expired — paste your content again, then tap Save to KB.").catch(() => {});
    return;
  }
  deletePendingKBSave(saveId);

  try {
    const result = await ingestText(pending.text, pending.title);

    if (result.duplicate) {
      await ctx.editMessageText(`ℹ️ Already in knowledge base as "${result.title}". Nothing changed.`);
    } else if (result.conflict === "title") {
      const replaceId = `replace:${saveId}`;
      pendingKBSaves.set(replaceId, pending);
      pendingKBSaveTimers.set(replaceId, setTimeout(() => deletePendingKBSave(replaceId), 600_000));

      const keyboard = new InlineKeyboard()
        .text("🔄 Replace existing", `kb_replace:${replaceId}`)
        .text("➕ New version", `kb_new_version:${replaceId}`)
        .row()
        .text("❌ Cancel", `kb_conflict_cancel:${replaceId}`);

      await ctx.editMessageText(
        `⚠️ A document named "${pending.title}" already exists.\n\nWhat would you like to do?`,
        { reply_markup: keyboard }
      );
    } else {
      await ctx.editMessageText(
        `✅ Saved "${pending.title}" — ${result.chunksInserted} chunk${result.chunksInserted !== 1 ? "s" : ""} indexed.\n\nSearch with /doc query`
      );
      scheduleEmbedVerification(bot,pending, pending.title, result.chunksInserted);
    }
    await ctx.answerCallbackQuery();
  } catch (err) {
    await ctx.editMessageText(`❌ Save failed: ${err instanceof Error ? err.message : String(err)}`);
    await ctx.answerCallbackQuery();
  }
});

// Discard KB save
bot.callbackQuery(/^discard_kb_save:/, async (ctx) => {
  const saveId = ctx.callbackQuery.data.replace("discard_kb_save:", "");
  deletePendingKBSave(saveId);
  await ctx.editMessageText("❌ Discarded — content not saved.");
  await ctx.answerCallbackQuery();
});

// Replace existing KB document
bot.callbackQuery(/^kb_replace:/, async (ctx) => {
  const replaceId = ctx.callbackQuery.data.replace("kb_replace:", "");
  const pending = pendingKBSaves.get(replaceId);
  if (!pending) {
    await ctx.answerCallbackQuery("Session expired.");
    return;
  }
  deletePendingKBSave(replaceId);

  try {
    await deleteDocumentRecords(pending.title);
    const result = await ingestText(pending.text, pending.title);
    await ctx.editMessageText(`✅ Replaced "${pending.title}" — ${result.chunksInserted} chunks updated.`);
    scheduleEmbedVerification(bot,pending, pending.title, result.chunksInserted);
    await ctx.answerCallbackQuery();
  } catch (err) {
    await ctx.editMessageText(`❌ Replace failed: ${err instanceof Error ? err.message : String(err)}`);
    await ctx.answerCallbackQuery();
  }
});

// Save as new version (auto-suffix title)
bot.callbackQuery(/^kb_new_version:/, async (ctx) => {
  const replaceId = ctx.callbackQuery.data.replace("kb_new_version:", "");
  const pending = pendingKBSaves.get(replaceId);
  if (!pending) {
    await ctx.answerCallbackQuery("Session expired.");
    return;
  }
  deletePendingKBSave(replaceId);

  try {
    const versionTitle = await resolveUniqueTitle(pending.title);
    const result = await ingestText(pending.text, versionTitle);
    await ctx.editMessageText(`✅ Saved as "${versionTitle}" — ${result.chunksInserted} chunks.`);
    scheduleEmbedVerification(bot,pending, versionTitle, result.chunksInserted);
    await ctx.answerCallbackQuery();
  } catch (err) {
    await ctx.editMessageText(`❌ Save failed: ${err instanceof Error ? err.message : String(err)}`);
    await ctx.answerCallbackQuery();
  }
});

// Cancel conflict resolution
bot.callbackQuery(/^kb_conflict_cancel:/, async (ctx) => {
  const replaceId = ctx.callbackQuery.data.replace("kb_conflict_cancel:", "");
  deletePendingKBSave(replaceId);
  await ctx.editMessageText("❌ Cancelled — no changes made.");
  await ctx.answerCallbackQuery();
});

// ============================================================
// DOC INGEST CALLBACKS (di_*) — for /doc ingest flow
// ============================================================

// Use suggested title
bot.callbackQuery(/^di_use_title:/, async (ctx) => {
  const key = ctx.callbackQuery.data.replace("di_use_title:", "");
  const chatId = ctx.chat?.id ?? 0;
  const threadId = (ctx.callbackQuery?.message as any)?.message_thread_id ?? null;
  const state = pendingIngestStates.get(key);
  if (!state || !state.body || !state.title) {
    await ctx.answerCallbackQuery("Session expired."); return;
  }
  // Local storage always available
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

  const collision = await checkTitleCollision(state.title);
  if (collision.exists) {
    state.stage = "await-dedup-resolution";
    pendingIngestStates.set(key, state);
    await showCollisionKeyboard(ctx, state.title, `di_overwrite:${key}`, `di_cancel:${key}`);
  } else {
    pendingIngestStates.delete(key);
    await performIngestSave(chatId, threadId, state.body, state.title, ctx);
  }
});

// Enter new title
bot.callbackQuery(/^di_new_title:/, async (ctx) => {
  const key = ctx.callbackQuery.data.replace("di_new_title:", "");
  const state = pendingIngestStates.get(key);
  if (!state) { await ctx.answerCallbackQuery("Session expired."); return; }
  state.stage = "await-title-text";
  pendingIngestStates.set(key, state);
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("Enter the new title:");
});

// Overwrite existing doc
bot.callbackQuery(/^di_overwrite:/, async (ctx) => {
  const key = ctx.callbackQuery.data.replace("di_overwrite:", "");
  const chatId = ctx.chat?.id ?? 0;
  const threadId = (ctx.callbackQuery?.message as any)?.message_thread_id ?? null;
  // Local storage always available
  await _handleDocOverwrite(key, chatId, threadId, {
    pendingIngestStates,
    answerExpired: () => ctx.answerCallbackQuery("Session expired."),
    answerOk: () => ctx.answerCallbackQuery(),
    removeKeyboard: () => ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {}),
    deleteExistingDoc: (title) => deleteDocumentRecords(title).then(() => {}),
    saveDoc: (body, title) => ingestText(body, title),
    replySuccess: (title, bodyLength) => ctx.reply(`✅ Saved: "${title}" (${bodyLength.toLocaleString()} chars)`),
    scheduleVerification: (cid, tid, title, chunks) => scheduleEmbedVerification(bot, { chatId: cid, threadId: tid }, title, chunks),
  });
});

// Cancel ingest
bot.callbackQuery(/^di_cancel:/, async (ctx) => {
  const key = ctx.callbackQuery.data.replace("di_cancel:", "");
  pendingIngestStates.delete(key);
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("Cancelled.");
});

// ============================================================
// SAVE TO KB CALLBACKS (ks_*) — for [💾 Save to KB] button
// ============================================================

// Tap [💾 Save to KB] — initiate save flow
bot.callbackQuery(/^ks_tap:/, async (ctx) => {
  const key = ctx.callbackQuery.data.replace("ks_tap:", "");
  const parts = lastAssistantResponses.get(key);
  if (!parts?.length) {
    await ctx.answerCallbackQuery("Session expired — please ask again.");
    return;
  }
  const saveState = buildSaveState(parts, extractDocTitle);
  pendingSaveStates.set(key, saveState);
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await showTitleKeyboard(ctx, saveState.suggestedTitle, `ks_use_title:${key}`, `ks_new_title:${key}`, `ks_cancel:${key}`);
});

// Use suggested title for KB save
bot.callbackQuery(/^ks_use_title:/, async (ctx) => {
  const key = ctx.callbackQuery.data.replace("ks_use_title:", "");
  const chatId = ctx.chat?.id ?? 0;
  const threadId = (ctx.callbackQuery?.message as any)?.message_thread_id ?? null;
  const state = pendingSaveStates.get(key);
  if (!state) { await ctx.answerCallbackQuery("Session expired."); return; }
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

  const collision = await checkTitleCollision(state.suggestedTitle);
  if (collision.exists) {
    state.stage = "await-dedup-resolution";
    pendingSaveStates.set(key, state);
    await showCollisionKeyboard(ctx, state.suggestedTitle, `ks_overwrite:${key}`, `ks_cancel:${key}`);
  } else {
    pendingSaveStates.delete(key);
    const result = await ingestText(state.body, state.suggestedTitle);
    await ctx.reply(`✅ Saved: "${state.suggestedTitle}"`);
    scheduleEmbedVerification(bot,{ chatId, threadId }, state.suggestedTitle, result.chunksInserted);
  }
});

// Enter new title for KB save
bot.callbackQuery(/^ks_new_title:/, async (ctx) => {
  const key = ctx.callbackQuery.data.replace("ks_new_title:", "");
  const state = pendingSaveStates.get(key);
  if (!state) { await ctx.answerCallbackQuery("Session expired."); return; }
  state.stage = "await-title-text";
  pendingSaveStates.set(key, state);
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("Enter the new title:");
});

// Overwrite existing doc for KB save
bot.callbackQuery(/^ks_overwrite:/, async (ctx) => {
  const key = ctx.callbackQuery.data.replace("ks_overwrite:", "");
  const chatId = ctx.chat?.id ?? 0;
  const threadId = (ctx.callbackQuery?.message as any)?.message_thread_id ?? null;
  const state = pendingSaveStates.get(key);
  if (!state) { await ctx.answerCallbackQuery("Session expired."); return; }
  pendingSaveStates.delete(key);
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await deleteDocumentRecords(state.suggestedTitle);
  const result = await ingestText(state.body, state.suggestedTitle);
  await ctx.reply(`✅ Saved: "${state.suggestedTitle}"`);
  scheduleEmbedVerification(bot,{ chatId, threadId }, state.suggestedTitle, result.chunksInserted);
});

// Cancel KB save
bot.callbackQuery(/^ks_cancel:/, async (ctx) => {
  const key = ctx.callbackQuery.data.replace("ks_cancel:", "");
  pendingSaveStates.delete(key);
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("Cancelled.");
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
 * Returns an onToolUse callback that tracks git worktree lifecycle events and
 * keeps session.activeCwd in sync so the footer shows the correct branch.
 *
 * Events handled:
 *   git worktree add <path>   → set activeCwd to worktree dir (branch enters)
 *   git worktree remove <…>   → reset activeCwd to project root (branch exits)
 *   git checkout master|main  → reset activeCwd to project root (branch exits)
 */
function makeWorktreeTracker(session: { activeCwd?: string; cwd?: string }): (toolName: string, input: Record<string, unknown>) => void {
  return (toolName, input) => {
    if (toolName !== "Bash" && toolName !== "bash") return;
    const cmd = (input.command as string) ?? "";

    // Worktree creation: move activeCwd into the new worktree
    const addMatch = cmd.match(/git\s+worktree\s+add\s+(\S+)/);
    if (addMatch) {
      const relPath = addMatch[1];
      const base = session.activeCwd || PROJECT_DIR || process.cwd();
      const newCwd = relPath.startsWith("/") ? relPath : join(base, relPath);
      console.log(`[worktree-tracker] worktree add — activeCwd: ${session.activeCwd} → ${newCwd}`);
      session.activeCwd = newCwd;
      return;
    }

    // Worktree removal or checkout to main → reset activeCwd to project root
    const isWorktreeRemove = /git\s+worktree\s+remove/.test(cmd);
    const isCheckoutMain   = /git\s+checkout\s+(master|main)\b/.test(cmd);
    if (isWorktreeRemove || isCheckoutMain) {
      const root = session.cwd || PROJECT_DIR || process.cwd();
      console.log(`[worktree-tracker] ${isWorktreeRemove ? "worktree remove" : "checkout master/main"} — activeCwd reset to: ${root}`);
      session.activeCwd = root;
    }
  };
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
  // M1: Clear last-turn accumulator on each new user message to prevent unbounded growth.
  lastAssistantResponses.delete(streamKey(chatId, threadId));
  const requestStart = Date.now();
  const typingInterval = startTypingIndicator(ctx);
  try {
    const agent = getAgentForChat(chatId);
    const traceId = generateTraceId();
    trace({ event: "message_received", traceId, chatId, agentId: agent.id, textLength: text.length, threadId });
    console.log(`[${agent.name}] Message from chat ${chatId}: ${text.substring(0, 50)}...`);
    // Fire typing action without awaiting — the progress indicator message (below) is
    // more visible; we don't want to block 100-300ms before starting context fetch.
    void ctx.replyWithChatAction("typing");

    const session = await loadGroupSession(chatId, agent.id, threadId);

    // ── Capture resume state BEFORE calling Claude ────────────────────
    const prevSessionId = session.sessionId;
    const capturedGen = session.resetGen;  // guard against stale onSessionId after /new
    const triedResume = isResumeReliable(session);
    let staleCorrected = false;  // set true when StaleSessionError retry succeeds — skips resumeFailed check
    // Consume pendingContextInjection flag (set when user tapped "Inject context"
    // after a previous resume failure). Suppresses isResumedSession hint to Claude.
    // Note: context injection is now unconditional; this flag only affects isResumedSession.
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

    // Resolve model prefix before building prompt so stripped text flows everywhere.
    // Priority: user prefix [O/H/Q] > agent.defaultModel > Sonnet.
    const { model: resolvedModel, label: modelLabel, text: cleanText } = resolveModelPrefix(text, agent.defaultModel);
    text = cleanText;

    // ── Show progress indicator immediately ──────────────────────────
    // Started here — before context fetch — so the user sees feedback while
    // SQLite queries, MLX embeds, and Qdrant searches run in the background.
    // Previously placed after all pre-processing, causing a 600ms–1.4s blank window.
    const cancelKey = streamKey(chatId, threadId);
    const indicator = new ProgressIndicator();
    indicator.start(chatId, bot, threadId, {
      cancelKey,
      onMessageId: (msgId) => {
        const entry = activeStreams.get(cancelKey);
        if (entry) entry.progressMessageId = msgId;
      },
    }).catch(() => {}); // fire-and-forget
    indicator.setModelLabel(modelLabel);
    void indicator.update(`Using ${modelLabel}`, { immediate: true });

    const userId = ctx.from?.id ?? 0;
    const [shortTermCtxRaw, userProfile, memoryContext, docSearchResult] = await Promise.all([
      getShortTermContext(chatId, threadId, { since: getSessionSince(session) }),
      getUserProfile(userId),
      getMemoryContext(chatId),
      // Auto-injection path: two-gate design.
      // Gate 1 (semantic gate): skip embedding call for commands or filler acks.
      //   - No length floor — short domain queries like "IM8?" (4 chars) are valid and must trigger search.
      //   - FILLER_RE catches social ack messages ("Thanks!", "Got it", "ok") regardless of length.
      // Gate 2 (quality gate): similarity threshold 0.58 — the real noise filter.
      //   Explicit /doc query uses 0.50; auto-injection uses 0.58 to stay conservative.
      //   Generic follow-ups ("Can you elaborate?") score <0.58 and are filtered here, not at Gate 1.
      (() => {
        const FILLER_RE = /^(yes|no|ok|okay|sure|thanks|thank you|got it|noted|sounds good|great|alright|perfect)[\s!.?,]*$/i;
        const shouldSearch = !text.startsWith("/") && !FILLER_RE.test(text.trim());
        if (!shouldSearch) return Promise.resolve({ chunks: [], context: "", hasResults: false });
        return hasDocuments().then((has) =>
          has
            ? searchDocuments(text, { matchThreshold: 0.58 })
            : { chunks: [], context: "", hasResults: false }
        );
      })(),
    ]);
    // Deduplicate: exclude short-term verbatim message IDs from semantic search results
    const shortTermIds = new Set(shortTermCtxRaw.verbatimMessages.map((m) => m.id));
    const enrichedQuery = buildEnrichedQuery(shortTermCtxRaw.verbatimMessages, text);
    // Skip semantic search when no context enrichment happened and message is generic noise
    const relevantContext = (enrichedQuery === text.trim() && GENERIC_COMMAND_RE.test(text.trim()))
      ? ""
      : await getRelevantContext(enrichedQuery, chatId, undefined,shortTermIds);
    // Always inject shortTermContext — Claude's --resume context window gets compressed
    // and loses recent messages, so we must always provide conversation history.
    const shortTermContext = (!suppressContext)
      ? formatShortTermContext(shortTermCtxRaw, USER_TIMEZONE)
      : "";

    // Routine context injection — fires when resume is reliable (shortTermContext skipped)
    // but the last assistant turn the user saw was a routine message Claude never received.
    let routineContext: string | undefined;
    if (isResumeReliable(session)) {
      const [lastRoutine, lastRealTurn] = await Promise.all([
        getLastRoutineMessage(chatId, threadId),
        getLastRealAssistantTurn(chatId, threadId),
      ]);
      const routineIsNewer =
        lastRoutine &&
        (!lastRealTurn || lastRoutine.created_at > lastRealTurn.created_at);
      const routineIsFresh =
        lastRoutine &&
        Date.now() - new Date(lastRoutine.created_at).getTime() < ROUTINE_INJECT_TTL_MS;
      if (routineIsNewer && routineIsFresh) {
        const label = lastRoutine.metadata?.routine ?? ROUTINE_SOURCE;
        const routineSummary = lastRoutine.metadata?.summary
          ?? (lastRoutine.content.length > 500 ? lastRoutine.content.slice(0, 500) + "..." : lastRoutine.content);
        routineContext = `[${label}]: ${routineSummary}`;
      }
    }

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
      documentTitles: docSearchResult.hasResults
        ? [...new Set(docSearchResult.chunks.map((c) => c.title))]
        : undefined,
      routineContext,
    });

    if (process.env.CONTEXT_DEBUG === "1") {
      const ts = new Date().toISOString();
      const debugLines = [
        `=== CONTEXT DEBUG ${ts} ===`,
        `agent=${agent.id} chatId=${chatId} threadId=${threadId ?? "null"}`,
        `sessionId=${session.sessionId ?? "null"} messageCount=${session.messageCount} startedAt=${session.startedAt}`,
        `triedResume=${triedResume} forceInjectContext=${forceInjectContext} suppressContext=${suppressContext}`,
        `isResumedSession=removed (always inject system prompt)`,
        ``,
        `--- sizes ---`,
        `shortTermContext=${shortTermContext.length}chars (verbatim=${shortTermCtxRaw.verbatimMessages.length} summaries=${shortTermCtxRaw.summaries.length} totalMessages=${shortTermCtxRaw.totalMessages})`,
        `userProfile=${userProfile.length}chars memoryContext=${memoryContext.length}chars relevantContext=${relevantContext.length}chars`,
        `documentContext=${docSearchResult.hasResults ? docSearchResult.context.length : 0}chars (${docSearchResult.chunks.length} chunks) routineContext=${routineContext?.length ?? 0}chars`,
        `prompt total=${enrichedPrompt.length}chars`,
        ``,
        `--- user message ---`,
        text,
        ``,
        `--- shortTermContext ---`,
        shortTermContext || "(empty)",
        ``,
        `--- memoryContext ---`,
        memoryContext || "(empty)",
        ``,
        `--- relevantContext ---`,
        relevantContext || "(empty)",
        ``,
        `--- documentContext ---`,
        docSearchResult.hasResults ? docSearchResult.context : "(none)",
        ``,
        `--- routineContext ---`,
        routineContext ?? "(none)",
        ``,
        `--- full prompt ---`,
        enrichedPrompt,
        ``,
        `=== END CONTEXT DEBUG ===`,
        ``,
      ];
      const debugContent = debugLines.join("\n");
      const logDir = getPm2LogsDir();
      console.log(`[context-debug] Written to ${logDir}/context-debug.log (${debugContent.length} chars)`);
      await mkdir(logDir, { recursive: true }).catch(() => {});
      appendFile(join(logDir, "context-debug.log"), debugContent + "\n").catch((e) =>
        console.error("[context-debug] Failed to write:", e.message)
      );
    }

    // Lock activeCwd for this session (no-op if sessionId already set — resume coherence).
    await lockActiveCwd(chatId, threadId, PROJECT_DIR || undefined);

    // ── AskUserQuestion: relay form handler ──────────────────────────
    // Builds and manages a Telegram form while claudeStream is suspended.
    const onQuestion = async (event: AskUserQuestionEvent): Promise<Record<string, string>> => {
      const formKey = streamKey(chatId, threadId);
      const dbg = process.env.INTERACTIVE_DEBUG === "1";
      if (dbg) console.log(`[onQuestion:DEBUG] called — toolUseId=${event.toolUseId} questionCount=${event.questions.length} formKey=${formKey} pendingFormsCount=${pendingRelayForms.size}`);

      void indicator.update("⏳ Waiting for your answer...", { immediate: true });

      const form: RelayQuestionForm = {
        toolUseId: event.toolUseId,
        questions: event.questions,
        selections: new Map(),
        activeQIdx: 0,
        formMessageId: 0,
        resolve: () => {},
        reject: () => {},
        timeoutId: undefined as unknown as ReturnType<typeof setTimeout>,
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
        if (process.env.E2E_DEBUG) console.log("[e2e:outgoing:sendMessage]", JSON.stringify(formMsg));
        form.formMessageId = formMsg.message_id;
      } catch (err) {
        console.error("[relay-form] Failed to send form message:", err);
        form.resolve({});
        return {};
      }

      // Wire indicator update: called by submit handler and timeout before resolving.
      form.onResolve = () => { void indicator.update("↩ Resuming...", { immediate: true }); };

      // M-7: register the form and set real timeout only after sendMessage succeeds
      pendingRelayForms.set(formKey, form);

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
      if (dbg) console.log(`[onQuestion:DEBUG] form registered key=${formKey} formMessageId=${form.formMessageId}`);
      return answerPromise;
    };

    let rawResponse: string;
    const callStart = Date.now();
    trace({ event: "claude_start", traceId, chatId, promptLength: enrichedPrompt.length, resume: !!session.sessionId, sessionId: session.sessionId });

    // [Q] prefix or agent defaultModel="local" → skip Claude CLI, call local Qwen directly.
    if (resolvedModel === LOCAL_MODEL_TOKEN) {
      try {
        void indicator.update("Using Qwen (local)…", { immediate: true });
        rawResponse = await callRoutineModel(enrichedPrompt, { label: "chat-local", timeoutMs: 120_000 });
        await indicator.finish(true);
      } catch (localErr) {
        await indicator.finish(false);
        console.error("[local model] callRoutineModel failed:", localErr);
        rawResponse = "⚠️ Local Qwen model failed. Is `mlx serve` running on port 8800?";
      }
    } else

    try {
      rawResponse = await callClaude(enrichedPrompt, {
        resume: !!session.sessionId,
        sessionId: session.sessionId,
        onProgress: (summary) => void indicator.update(enrichProgressText(summary), { immediate: true }),
        onSessionId: (id) => void updateSessionIdGuarded(chatId, id, capturedGen, threadId),
        chatId,
        threadId,
        model: resolvedModel,
        cwd: session.activeCwd,
        onQuestion,
        onToolUse: makeWorktreeTracker(session),
      });
      await indicator.finish(true);
    } catch (claudeErr) {
      if (claudeErr instanceof StaleSessionError) {
        // Clear stale session and rebuild prompt with full context injection so the
        // retry starts fresh with conversation history Claude no longer has in memory.
        console.log(`[processTextMessage] StaleSessionError — clearing session and retrying with full context for chat ${chatId}`);
        const sessionAge = session.startedAt
          ? Date.now() - new Date(session.startedAt).getTime()
          : Infinity;
        session.sessionId = null;
        session.activeCwd = undefined;
        await saveSession(session);

        // Rebuild prompt: force shortTermContext regardless of resume state.
        const retryShortTermContext = !suppressContext
          ? formatShortTermContext(shortTermCtxRaw, USER_TIMEZONE)
          : "";
        const retryPrompt = buildAgentPrompt(agent, text, {
          shortTermContext: retryShortTermContext,
          userProfile,
          relevantContext,
          memoryContext,
          profileContext,
          userName: USER_NAME,
          timeStr,
          documentContext: docSearchResult.hasResults ? docSearchResult.context : undefined,
          documentTitles: docSearchResult.hasResults
            ? [...new Set(docSearchResult.chunks.map((c) => c.title))]
            : undefined,
          routineContext,
        });

        try {
          void indicator.update("Reconnecting...", { immediate: true });
          rawResponse = await callClaude(retryPrompt, {
            resume: false,
            onProgress: (summary) => void indicator.update(enrichProgressText(summary), { immediate: true }),
            onSessionId: (id) => void updateSessionIdGuarded(chatId, id, capturedGen, threadId),
            chatId,
            threadId,
            model: resolvedModel,
            cwd: session.cwd ?? PROJECT_DIR ?? undefined,
            onQuestion,
            onToolUse: makeWorktreeTracker(session),
          });
          await indicator.finish(true);
          staleCorrected = true;  // retry succeeded — suppress false resumeFailed detection below

          // Notify only when the session expired unexpectedly early (< 30 min).
          if (sessionAge < 30 * 60 * 1000) {
            bot.api.sendMessage(
              chatId,
              "Session expired unexpectedly (was less than 30 min old) — started a fresh one.",
              threadId != null ? { message_thread_id: threadId } : undefined
            ).catch(() => {});
          }
        } catch (retryErr) {
          trace({ event: "claude_complete", traceId, chatId, responseLength: 0, durationMs: Date.now() - callStart, fallback: false, error: String(retryErr) });
          await indicator.finish(false);
          // Retry also failed — alert user before MLX takes over.
          bot.api.sendMessage(
            chatId,
            "Claude is unavailable — using fallback AI. If this persists, check the Claude CLI.",
            threadId != null ? { message_thread_id: threadId } : undefined
          ).catch(() => {});
          throw retryErr;
        }
      } else {
        trace({ event: "claude_complete", traceId, chatId, responseLength: 0, durationMs: Date.now() - callStart, fallback: false, error: String(claudeErr) });
        await indicator.finish(false);
        throw claudeErr;
      }
    }
    const callDurationMs = Date.now() - callStart;
    trace({ event: "claude_complete", traceId, chatId, responseLength: rawResponse.length, durationMs: callDurationMs, fallback: rawResponse.startsWith("[via "), error: null });
    console.log(`Claude raw response length: ${rawResponse.length} (${callDurationMs}ms)`);

    const { nextStep, response: rawWithoutNext } = extractNextStep(rawResponse);
    // Strip tags synchronously so the user sees clean text immediately.
    // The actual DB/Qdrant work runs in the background after sendResponse.
    const displayResponse = stripMemoryTags(rawWithoutNext);

    // ── Detect resume failure ─────────────────────────────────────────
    // session.sessionId was updated in-memory by onSessionId callback above.
    const resumeFailed = !staleCorrected && didResumeFail(triedResume, prevSessionId, session.sessionId);
    if (resumeFailed) {
      console.warn(`[resume] Silent failure detected — session ${prevSessionId} → ${session.sessionId}`);
      // New session was silently created — reset the turn counter.
      session.messageCount = 1;
    }

    // ── Update session metadata in-memory (no await — persisted in background) ──
    if (!resumeFailed) {
      session.messageCount = (session.messageCount || 0) + 1;
    }
    session.lastActivity = new Date().toISOString();

    const footer: FooterData = {
      elapsedMs: Date.now() - requestStart,
      turnCount: session.messageCount,
      nextStep,
      sessionId: session.sessionId,
      cwd: session.activeCwd,
    };
    // Append resume failure notice to the response itself
    let finalResponse = displayResponse || "No response generated";
    if (resumeFailed) {
      finalResponse += "\n\n⚠️ _Session was reset — context from previous turns may be incomplete_";
    }

    // ── Send to Telegram immediately ──────────────────────────────────
    await sendResponse(ctx, finalResponse, footer);

    // Offer context re-injection after resume failure (shown after the response)
    if (resumeFailed) {
      const formattedCtx = formatShortTermContext(shortTermCtxRaw, USER_TIMEZONE);
      await sendResumeFailedKeyboard(ctx, chatId, threadId, formattedCtx);
    }

    // ── Background post-processing (non-blocking) ─────────────────────
    // Memory intents, message persistence, and session save happen after the
    // reply is delivered so the user sees the response without the delay.
    const capturedMessageCount = session.messageCount;
    setImmediate(async () => {
      try {
        await processMemoryIntents(rawWithoutNext, chatId, threadId);
        await saveSession(session);
        await saveMessage("user", text, undefined, chatId, agent.id, threadId);
        await saveMessage("assistant", displayResponse, undefined, chatId, agent.id, threadId);

        // LTM auto-extraction removed (feat/ltm_overhaul) — memory now intentional-only
        // via [REMEMBER:], [GOAL:], [DONE:] tags and /remember command.

        // STM summarization check (every 5 messages)
        if (capturedMessageCount % 5 === 0) {
          if (await shouldSummarize(chatId, threadId)) {
            await summarizeOldMessages(chatId, threadId);
          }
        }
      } catch (err) {
        console.error("[post-processing] background task failed:", err);
      }
    });
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
  if (process.env.E2E_DEBUG) console.log("[e2e:text]", JSON.stringify({ message: ctx.message, chat: ctx.chat, from: ctx.from }));
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

  // Priority 1: Relay question form — force-reply "Other..." answer routing
  {
    const replyToId = ctx.message?.reply_to_message?.message_id;
    if (replyToId != null) {
      const pending = pendingRelayCustomReplies.get(replyToId);
      if (pending) {
        pendingRelayCustomReplies.delete(replyToId);
        pendingRelayCustomReplyTimestamps.delete(replyToId);
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

  // Priority 1.8: Report QA free-text capture (when user is in active QA session)
  if (reportQA.handleFreeText(ctx, text)) return;

  // Priority 2: Interactive Q&A free-text answer (when user is mid-plan session)
  if (await interactive.handleFreeText(ctx, text)) return;

  // Priority 3: Inline tshoot capture (!finding / !discovery)
  if (await handleTshoOtCapture(ctx, text, chatId, threadId, (id) => getAgentForChat(id).id)) return;

  // Priority 4.5: Pending doc ingest / save-to-KB title capture
  if (!text.startsWith("/")) {
    const stateKey = streamKey(chatId, threadId);
    const ingestState = pendingIngestStates.get(stateKey);
    if (ingestState?.stage === "await-title-text") {
      await handleIngestTitleConfirmed(chatId, threadId, stateKey, text.trim(), ctx);
      return;
    }
    const saveState = pendingSaveStates.get(stateKey);
    if (saveState?.stage === "await-title-text") {
      await handleSaveTitleConfirmed(chatId, threadId, stateKey, text.trim(), ctx);
      return;
    }
  }

  // FM-1: Debounce rapid text bursts — Telegram splits long pastes into N fragments.
  // Accumulate within a 600ms window; flush as one assembled message.
  const burstKey = streamKey(chatId, threadId);
  const existing = textBurstAccumulators.get(burstKey);
  if (existing) {
    existing.texts.push(text);
    existing.ctx = ctx;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushTextBurst(burstKey), TEXT_BURST_DEBOUNCE_MS);
    return;
  }

  const acc: TextBurstAccumulator = {
    texts: [text],
    chatId,
    threadId,
    ctx,
    timer: setTimeout(() => flushTextBurst(burstKey), TEXT_BURST_DEBOUNCE_MS),
  };
  textBurstAccumulators.set(burstKey, acc);
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

        // Report QA: if active, buffer the transcription as an answer part
        if (reportQA.handleVoice(chatId, transcription)) {
          await ctx.reply(`Voice captured for QA: "${transcription.slice(0, 100)}${transcription.length > 100 ? "…" : ""}"`);
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

        const [shortTermCtxRaw, userProfile, memoryContext] = await Promise.all([
          getShortTermContext(chatId, threadId, { since: getSessionSince(session) }),
          getUserProfile(voiceUserId),
          getMemoryContext(chatId),
        ]);
        const voiceExcludeIds = new Set(shortTermCtxRaw.verbatimMessages.map((m) => m.id));
        const enrichedQuery = buildEnrichedQuery(shortTermCtxRaw.verbatimMessages, transcription);
        // Skip semantic search when no context enrichment happened and message is generic noise
        const relevantContext = (enrichedQuery === transcription.trim() && GENERIC_COMMAND_RE.test(transcription.trim()))
          ? ""
          : await getRelevantContext(enrichedQuery, chatId, undefined,voiceExcludeIds);
        // Always inject shortTermContext — Claude's --resume loses recent messages.
        const shortTermContext = formatShortTermContext(shortTermCtxRaw, USER_TIMEZONE);

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
        const claudeResponse = await processMemoryIntents(voiceRawWithoutNext, chatId, threadId);

        // ── Detect resume failure ─────────────────────────────────────
        const voiceResumeFailed = didResumeFail(voiceTriedResume, voicePrevSessionId, session.sessionId);
        if (voiceResumeFailed) {
          console.warn(`[resume] Silent failure detected (voice) — session ${voicePrevSessionId} → ${session.sessionId}`);
          session.messageCount = 1;
        }

        // Update session metadata
        if (!voiceResumeFailed) {
          session.messageCount = (session.messageCount || 0) + 1;
        }
        session.lastActivity = new Date().toISOString();
        await saveSession(session);

        await saveMessage("assistant", claudeResponse, undefined, chatId, agent.id, threadId);

        // LTM auto-extraction removed (feat/ltm_overhaul)

        // Async STM summarization (independent, every 5 messages)
        if (session.messageCount % 5 === 0) {
          setImmediate(async () => {
            try {
              if (await shouldSummarize(chatId, threadId)) {
                await summarizeOldMessages(chatId, threadId);
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

        // Honour [O]/[H]/[Q] prefix in caption for Phase 2 (agent response).
        // Phase 1 (vision description) always uses Sonnet — it requires vision capability.
        // [Q] is silently downgraded to Sonnet: local Qwen has no vision capability.
        const { model: rawPhotoModel, label: rawPhotoLabel, text: cleanCaption } = resolveModelPrefix(caption, agent.defaultModel);
        const resolvedModel = rawPhotoModel === LOCAL_MODEL_TOKEN ? SONNET_MODEL : rawPhotoModel;
        const resolvedLabel = rawPhotoModel === LOCAL_MODEL_TOKEN ? "Sonnet" : rawPhotoLabel;
        caption = cleanCaption;

        console.log(`[${agent.name}] Image(s) received x${imageBuffers.length} (caption: ${caption.substring(0, 40)})`);
        await ctx.replyWithChatAction("typing");

        // Start progress indicator early so the user sees feedback during vision analysis
        const photoCancelKey = streamKey(chatId, threadId);
        const photoIndicator = new ProgressIndicator();
        const imageDisplayName = resolvedLabel;
        photoIndicator.setModelLabel(`📸 ${imageDisplayName}`);
        photoIndicator.start(chatId, bot, threadId, {
          cancelKey: photoCancelKey,
          onMessageId: (msgId) => {
            const entry = activeStreams.get(photoCancelKey);
            if (entry) entry.progressMessageId = msgId;
          },
        }).catch(() => {}); // fire-and-forget

        // Analyze all images in parallel — each in its own separate claudeText process
        // (--dangerously-skip-permissions, cwd=/tmp). Partial failures are tolerated.
        //
        // Diagnostic agents (aws-architect, security-analyst, code-quality-coach) use
        // structured domain-specific extraction prompts → result injected as <diagnostic_image>.
        // All other agents use the user's caption → result injected as <image_analysis>.
        let imageContext: string | undefined;
        let diagnosticContext: string | undefined;
        void photoIndicator.update("Analyzing image...", { immediate: true });
        try {
          if (agent.diagnostics?.enabled) {
            diagnosticContext = await analyzeDiagnosticImages(imageBuffers, agent.id, PROJECT_ROOT);
            if (!diagnosticContext) {
              await photoIndicator.finish(false);
              await ctx.reply("Could not extract diagnostic information from the image(s). Please try again.");
              return;
            }
          } else {
            const results = await analyzeImages(imageBuffers, caption);
            imageContext = combineImageContexts(results);
            if (!imageContext) {
              await photoIndicator.finish(false);
              await ctx.reply("Could not analyze the image(s). Please try again.");
              return;
            }
          }
        } catch (visionErr) {
          const errMsg = visionErr instanceof Error ? visionErr.message : String(visionErr);
          console.error("[vision] Analysis failed:", errMsg);
          await photoIndicator.finish(false);
          await ctx.reply(`Could not analyze image: ${errMsg}`);
          return;
        }
        void photoIndicator.update("Building context...", { immediate: true });

        const photoUserId = ctx.from?.id ?? 0;
        const session = await loadGroupSession(chatId, agent.id, threadId);

        // ── Capture resume state BEFORE calling Claude ────────────────
        const photoPrevSessionId = session.sessionId;
        const photoCapturedGen = session.resetGen;  // guard against stale onSessionId after /new
        const photoTriedResume = isResumeReliable(session);
        let photoStaleCorrected = false;  // set true when StaleSessionError retry succeeds
        const photoForceInjectContext = session.pendingContextInjection === true;
        if (photoForceInjectContext) session.pendingContextInjection = false;

        const [shortTermCtxRaw, userProfile, memoryContext] = await Promise.all([
          getShortTermContext(chatId, threadId, { since: getSessionSince(session) }),
          getUserProfile(photoUserId),
          getMemoryContext(chatId),
        ]);
        const photoExcludeIds = new Set(shortTermCtxRaw.verbatimMessages.map((m) => m.id));
        const enrichedQuery = buildEnrichedQuery(shortTermCtxRaw.verbatimMessages, caption);
        // Skip semantic search when no context enrichment happened and message is generic noise
        const relevantContext = (enrichedQuery === caption.trim() && GENERIC_COMMAND_RE.test(caption.trim()))
          ? ""
          : await getRelevantContext(enrichedQuery, chatId, undefined,photoExcludeIds);
        // Always inject shortTermContext — Claude's --resume loses recent messages.
        const shortTermContext = formatShortTermContext(shortTermCtxRaw, USER_TIMEZONE);

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
        });

        await saveMessage("user", `[Image]: ${caption}`, undefined, chatId, agent.id, threadId);
        void photoIndicator.update("Processing message...", { immediate: true });

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
            model: resolvedModel,
            cwd: session.activeCwd,
          });
          await photoIndicator.finish(true);
        } catch (claudeErr) {
          if (claudeErr instanceof StaleSessionError) {
            // Clear stale session and retry fresh — same pattern as text handler.
            console.log(`[photo] StaleSessionError — clearing session and retrying for chat ${chatId}`);
            session.sessionId = null;
            session.activeCwd = undefined;
            await saveSession(session);
            void photoIndicator.update("Reconnecting...", { immediate: true });
            try {
              rawResponse = await callClaude(enrichedPrompt, {
                resume: false,
                onProgress: (summary) => void photoIndicator.update(summary, { immediate: true }),
                onSessionId: (id) => void updateSessionIdGuarded(chatId, id, photoCapturedGen, threadId),
                chatId,
                threadId,
                model: resolvedModel,
                cwd: session.cwd ?? PROJECT_DIR ?? undefined,
              });
              await photoIndicator.finish(true);
              photoStaleCorrected = true;  // retry succeeded — suppress false resumeFailed detection
            } catch (retryErr) {
              await photoIndicator.finish(false);
              throw retryErr;
            }
          } else {
            await photoIndicator.finish(false);
            throw claudeErr;
          }
        }
        const callDurationMs = Date.now() - callStart;
        trace({ event: "claude_complete", traceId, chatId, responseLength: rawResponse.length, durationMs: callDurationMs, fallback: false, error: null });

        const { nextStep: photoNextStep, response: photoRawWithoutNext } = extractNextStep(rawResponse);
        const cleanResponse = await processMemoryIntents(photoRawWithoutNext, chatId, threadId);

        // ── Detect resume failure ─────────────────────────────────────
        const photoResumeFailed = !photoStaleCorrected && didResumeFail(photoTriedResume, photoPrevSessionId, session.sessionId);
        if (photoResumeFailed) {
          console.warn(`[resume] Silent failure detected (photo) — session ${photoPrevSessionId} → ${session.sessionId}`);
          session.messageCount = 1;
        } else {
          session.messageCount = (session.messageCount || 0) + 1;
        }
        session.lastActivity = new Date().toISOString();
        await saveSession(session);

        await saveMessage("assistant", cleanResponse, undefined, chatId, agent.id, threadId);

        // LTM auto-extraction removed (feat/ltm_overhaul)

        if (session.messageCount % 5 === 0) {
          setImmediate(async () => {
            try {
              if (await shouldSummarize(chatId, threadId)) {
                await summarizeOldMessages(chatId, threadId);
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

  let caption = acc.caption || "Describe these images in detail.";

  // Handle /new prefix in caption — reset session before processing, same as text /new command.
  const albumNewMatch = caption.match(/^\/new\s*(.*)/is);
  if (albumNewMatch) {
    await resetSession(acc.chatId, acc.threadId);
    caption = albumNewMatch[1].trim() || "Describe these images in detail.";
  }

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

  let caption = ctx.message.caption || "Describe this image in detail.";

  // Handle /new prefix in caption — reset session before processing, same as text /new command.
  const newMatch = caption.match(/^\/new\s*(.*)/is);
  if (newMatch) {
    await resetSession(chatId, threadId);
    caption = newMatch[1].trim() || "Describe this image in detail.";
  }

  enqueuePhotoJob(ctx, chatId, threadId, [imageBuffer], caption);
});

// Documents — index into RAG on upload
// ── Document album (multi-file) accumulator ───────────────────────────────────
// Telegram sends each file in a multi-document send as a separate message:document
// event sharing the same media_group_id. Buffer them over a short window and
// process all in one batch to give the user a single coherent reply.

interface DocAlbumEntry {
  fileId: string;
  /** Canonical filename — used as the stable source key in the documents table (no timestamp).
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
  // Determine ingest intent before any download.
  // A document arriving with media_group_id (e.g. sent alongside an image) must NOT
  // auto-ingest — only ingest when explicitly requested via caption or pending state.
  const docKey = streamKey(acc.chatId, acc.threadId);
  const isExplicitIngest = /^\/doc\s+ingest/i.test(acc.caption ?? "");
  const pendingState = pendingIngestStates.get(docKey);
  const hasPendingIngest = pendingState?.stage === "await-content";
  const isIngestIntent = isExplicitIngest || hasPendingIngest;
  if (hasPendingIngest) pendingIngestStates.delete(docKey); // consume

  console.log(`[doc-album] Window closed — downloading ${acc.entries.length} file(s) in parallel (ingest=${isIngestIntent})`);
  const indicator = new ProgressIndicator();
  indicator.setModelLabel("📄 Doc");
  indicator.start(acc.chatId, bot, acc.threadId, {}).catch(() => {});
  try {
    // Phase 1: parallel downloads
    void indicator.update(`Downloading ${acc.entries.length} file(s)…`, { immediate: true });
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
      await indicator.finish(false);
      await acc.ctx.reply("Could not download any documents from the album. Please try again.").catch(() => {});
      return;
    }

    // ── Non-ingest path: extract text and send to Claude as context ───────────
    if (!isIngestIntent) {
      await indicator.finish();
      const caption = acc.caption || "";
      const contextParts: string[] = [];
      const tempPaths: string[] = [];
      try {
        for (const { buffer, entry } of downloaded) {
          const ext = extname(entry.fileName).toLowerCase();
          if (!SUPPORTED_DOC_EXTS.has(ext)) continue;
          const tempPath = join(UPLOADS_DIR, `${Date.now()}_${Math.random()}_${entry.fileName}`);
          tempPaths.push(tempPath);
          await writeFile(tempPath, buffer);
          const extracted = await extractFileText(tempPath, ext);
          if (extracted.text.trim()) {
            contextParts.push(`[Attached: ${entry.fileName}]\n${extracted.text}`);
          }
        }
      } finally {
        for (const p of tempPaths) await unlink(p).catch(() => {});
      }
      if (contextParts.length === 0) {
        await acc.ctx.reply("❌ Could not extract text from the attached file(s).").catch(() => {});
        return;
      }
      const userPrompt = caption || "Summarise the attached file(s).";
      const fullPrompt = contextParts.join("\n\n") + "\n\n" + userPrompt;
      await processTextMessage(acc.chatId, acc.threadId, fullPrompt, acc.ctx);
      return;
    }

    // ── Ingest path ───────────────────────────────────────────────────────────
    void indicator.update(`Downloaded ${downloaded.length} file(s), indexing…`, { immediate: true });
    const ingestTitleBase = hasPendingIngest ? (pendingState?.title ?? "") : "";
    const ingestResults = await Promise.allSettled(
      downloaded.map(async ({ buffer, entry }, idx) => {
        const timestamp = Date.now() + Math.random();
        const tempPath = join(UPLOADS_DIR, `${timestamp}_${entry.fileName}`);
        try {
          await writeFile(tempPath, buffer);
          const title = ingestTitleBase || acc.caption || basename(entry.fileName, extname(entry.fileName));
          void indicator.update(`[${idx + 1}/${downloaded.length}] Processing ${entry.fileName}…`, { immediate: true });
          const result = await ingestDocument(tempPath, title, {
            mimeType: entry.mimeType,
            source: entry.fileName,
            onProgress: (msg) => void indicator.update(`[${idx + 1}/${downloaded.length}] ${msg}`, { immediate: true }),
          });
          return { fileName: entry.fileName, title: result.title, chunksInserted: result.chunksInserted };
        } finally {
          await unlink(tempPath).catch(() => {});
        }
      })
    );

    await indicator.finish();

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
    await indicator.finish(false);
    await acc.ctx.reply("Could not index documents. Please try again.").catch(() => {});
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

  const docKey = streamKey(chatId, threadId);
  const caption = (ctx.message.caption ?? "").trim();

  // Check if caption is a /doc ingest command → Path B (single-shot KB ingest)
  const ingestCaptionMatch = caption.match(/^\/doc\s+ingest(?:\s+(.*))?$/i);
  if (ingestCaptionMatch) {
    const titleArg = (ingestCaptionMatch[1] ?? "").trim();
    queueManager.getOrCreate(chatId, threadId).enqueue({
      label: `[chat:${chatId}] doc-ingest-file: ${doc.file_name}`,
      run: () => handleIngestFilePathB(chatId, threadId, docKey, doc, titleArg, ctx),
    });
    return;
  }

  // Check if there's an active await-content state → user attached file instead of pasting
  const ingestState = pendingIngestStates.get(docKey);
  if (ingestState?.stage === "await-content") {
    pendingIngestStates.delete(docKey); // consume state
    queueManager.getOrCreate(chatId, threadId).enqueue({
      label: `[chat:${chatId}] doc-ingest-file-pending: ${doc.file_name}`,
      run: () => handleIngestFilePathB(chatId, threadId, docKey, doc, ingestState.title ?? "", ctx),
    });
    return;
  }

  // ── Bare file → Claude path (Task 5) ─────────────────────────────────────
  queueManager.getOrCreate(chatId, threadId).enqueue({
    label: `[chat:${chatId}] doc-to-claude: ${doc.file_name}`,
    run: () => handleBareFileToClaudeInternal(chatId, threadId, doc, caption, ctx),
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

async function sendResponse(ctx: Context, response: string, footer?: FooterData): Promise<void> {
  // Handle empty responses
  if (!response || response.trim().length === 0) {
    console.error("Warning: Attempted to send empty response, using fallback");
    await ctx.reply("(Processing completed but no response generated)");
    return;
  }

  // Track this response for [💾 Save to KB] button
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id ?? null;
  const responseKey = chatId ? streamKey(chatId, threadId) : null;
  if (responseKey) resetAssistantParts(lastAssistantResponses, responseKey);

  // Split markdown BEFORE converting to HTML.
  // This ensures each chunk is self-contained markdown — no HTML tag is ever
  // bisected by a split boundary. Each chunk is converted independently, so
  // inline code (`code`), bold (**text**), and fenced blocks all render correctly.
  //
  // 3800 < 4096 (Telegram limit) to leave headroom for HTML tag expansion
  // (markdown `**x**` becomes `<b>x</b>`, adding ~50% overhead for formatted spans).
  const MARKDOWN_SPLIT_LEN = 3800;
  const footerHtml = footer ? buildFooter(footer) : "";
  const chunks = splitMarkdown(response, MARKDOWN_SPLIT_LEN);

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const html = markdownToHtml(chunks[i]);
    const fullHtml = isLast ? html + footerHtml : html;

    // Append [💾 Save to KB] inline keyboard to last message of the turn
    const saveKeyboard = isLast && responseKey
      ? new InlineKeyboard().text("💾 Save to KB", `ks_tap:${responseKey}`)
      : undefined;

    const TELEGRAM_MAX = 4096;
    try {
      if (fullHtml.length > TELEGRAM_MAX) {
        // HTML expanded beyond Telegram's limit (tables are common cause).
        // Strip tags and send as plain text sub-chunks.
        const plain = fullHtml.replace(/<[^>]+>/g, "");
        const subChunks = [];
        for (let j = 0; j < plain.length; j += TELEGRAM_MAX) subChunks.push(plain.slice(j, j + TELEGRAM_MAX));
        for (let k = 0; k < subChunks.length; k++) {
          const isLastSub = k === subChunks.length - 1;
          await ctx.reply(subChunks[k], isLastSub && saveKeyboard ? { reply_markup: saveKeyboard } : undefined);
          if (responseKey) appendAssistantPart(lastAssistantResponses, responseKey, subChunks[k]);
        }
      } else {
        await ctx.reply(fullHtml, {
          parse_mode: "HTML",
          ...(isLast && saveKeyboard ? { reply_markup: saveKeyboard } : {}),
        });
        if (responseKey) appendAssistantPart(lastAssistantResponses, responseKey, chunks[i]);
      }
    } catch {
      // Telegram rejected the HTML — fall back to plain text so the response
      // is never silently lost.
      const plain = fullHtml.replace(/<[^>]+>/g, "");
      const subChunks = [];
      for (let j = 0; j < plain.length; j += TELEGRAM_MAX) subChunks.push(plain.slice(j, j + TELEGRAM_MAX));
      for (let k = 0; k < subChunks.length; k++) {
        const isLastSub = k === subChunks.length - 1;
        await ctx.reply(subChunks[k], isLastSub && saveKeyboard ? { reply_markup: saveKeyboard } : undefined);
        if (responseKey) appendAssistantPart(lastAssistantResponses, responseKey, subChunks[k]);
      }
    }
  }
}

// ============================================================
// START
// ============================================================

// Guard: only run startup side-effects when relay.ts is the entry point.
// When imported in tests, _isEntry is false and bot.start() is never called.
const _isEntry =
  import.meta.main ||
  process.env.RELAY_IS_ENTRY === "1" ||
  process.env.pm_exec_path === import.meta.url?.replace("file://", "");

if (_isEntry) {
  // Initialize per-group sessions directory and pre-load all sessions into memory.
  // loadAllSessions() must run before any /new command handler can touch the Map —
  // without it, resetSession() silently no-ops (sessions.get() returns undefined)
  // and /new fails to clear sessionId or messageCount.
  // Initialize local storage (SQLite + Qdrant)
  const { initLocalStorage } = await import("./local/storageBackend.ts");
  await initLocalStorage("bge-m3_1024", 1024);

  await initSessions();
  const loadedCount = await loadAllSessions();
  console.log(`Sessions pre-loaded: ${loadedCount}`);

  // Load pre-configured group mappings from .env
  loadGroupMappings();

  // Seed topic names from messages DB so previously-seen threads resolve correctly
  try {
    const { getDb } = await import("./local/db.ts");
    const db = getDb();
    const rows = db
      .query("SELECT DISTINCT thread_id, thread_name FROM messages WHERE thread_id IS NOT NULL AND thread_name IS NOT NULL")
      .all() as Array<{ thread_id: string; thread_name: string }>;
    for (const row of rows) {
      learnTopicName(Number(row.thread_id), row.thread_name);
    }
    console.log(`Seeded ${rows.length} topic names from messages DB`);
  } catch (err) {
    console.warn("[startup] Failed to seed topic names from DB:", err);
  }

  console.log("Starting Claude Telegram Relay...");
  console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
  console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);
  console.log(`Bot token configured: ${BOT_TOKEN ? "YES" : "NO"}`);
  console.log("Group-based multi-agent routing enabled");
  console.log("Groups not pre-configured will be auto-discovered by title match");

  // Handle process signals to keep bot running
  process.once('SIGINT', async () => {
    console.log('Received SIGINT, shutting down gracefully...');
    // FM-1: flush any pending text burst accumulators before queue drains
    for (const [key, acc] of textBurstAccumulators) { clearTimeout(acc.timer); flushTextBurst(key); }
    await queueManager.shutdown(QUEUE_SHUTDOWN_GRACE);
    bot.stop();
    process.exit(0);
  });

  process.once('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    // FM-1: flush any pending text burst accumulators before queue drains
    for (const [key, acc] of textBurstAccumulators) { clearTimeout(acc.timer); flushTextBurst(key); }
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
  let memTickCount = 0;
  setInterval(() => {
    const m = process.memoryUsage();
    console.log(
      `[MEM] heapUsed=${Math.round(m.heapUsed / 1024 / 1024)}MB` +
      ` rss=${Math.round(m.rss / 1024 / 1024)}MB` +
      ` external=${Math.round(m.external / 1024 / 1024)}MB`
    );
    memTickCount++;
    if (memTickCount % 5 === 0) {
      console.log(
        `[MEM:maps] customReplies=${pendingRelayCustomReplies.size}` +
        ` assistantResp=${lastAssistantResponses.size}` +
        ` largePastes=${lastLargePastes.size}` +
        ` resumeCtx=${pendingResumeContext.size}` +
        ` kbSaves=${pendingKBSaves.size}` +
        ` ingest=${pendingIngestStates.size}` +
        ` saveStates=${pendingSaveStates.size}` +
        ` bursts=${textBurstAccumulators.size}`
      );
    }
    // Heap-based OOM guard: exit if heap genuinely leaks (not just high RSS from Bun runtime)
    const HEAP_OOM_THRESHOLD = 400 * 1024 * 1024; // 400MB heap = genuine leak
    // M-LEAK: Warning threshold — aggressive cleanup to prevent hitting critical
    const HEAP_WARN_THRESHOLD = 300 * 1024 * 1024; // 300MB
    if (m.heapUsed > HEAP_WARN_THRESHOLD && m.heapUsed <= HEAP_OOM_THRESHOLD) {
      console.warn(`[MEM] WARNING: heapUsed=${Math.round(m.heapUsed / 1024 / 1024)}MB — running aggressive cleanup`);
      lastAssistantResponses.clear();
      lastLargePastes.clear();
      for (const [k, t] of lastLargePasteTimers) { clearTimeout(t); }
      lastLargePasteTimers.clear();
      pendingResumeContext.clear();
      pendingResumeContextTimestamps.clear();
      pendingRelayCustomReplies.clear();
      pendingRelayCustomReplyTimestamps.clear();
      if (typeof Bun !== "undefined" && typeof Bun.gc === "function") Bun.gc(true);
    }
    // M-LEAK: Periodic GC hint when heap is elevated
    if (m.heapUsed > 200 * 1024 * 1024 && typeof Bun !== "undefined" && typeof Bun.gc === "function") {
      Bun.gc(true);
    }
    if (m.heapUsed > HEAP_OOM_THRESHOLD) {
      console.error(`[MEM] CRITICAL: heapUsed exceeds ${HEAP_OOM_THRESHOLD / 1024 / 1024}MB — exiting for PM2 restart`);
      process.exit(1);
    }

    // M2: Sweep expired ingest/save states — enforces TTL for all stages uniformly.
    const now = Date.now();
    for (const [k, v] of pendingIngestStates) {
      if (now > v.expiresAt) {
        pendingIngestStates.delete(k);
        const [chatIdStr, threadIdStr] = k.split(":");
        const chatId = Number(chatIdStr);
        const threadId = threadIdStr ? Number(threadIdStr) : null;
        if (chatId) {
          bot.api.sendMessage(
            chatId,
            "⏱ Doc ingest session expired — nothing was saved. Send `/doc ingest` to start again.",
            { ...(threadId != null && { message_thread_id: threadId }) }
          ).catch(() => {});
        }
      }
    }
    for (const [k, v] of pendingSaveStates) {
      if (now > v.expiresAt) pendingSaveStates.delete(k);
    }
    // M-LEAK: Tighter cap on assistant response cache
    if (lastAssistantResponses.size > 20) {
      // Evict oldest half
      const keys = [...lastAssistantResponses.keys()];
      for (let i = 0; i < keys.length - 10; i++) lastAssistantResponses.delete(keys[i]);
    }
    // M-LEAK: Sweep expired custom-reply entries (30 min TTL)
    const CUSTOM_REPLY_TTL = 30 * 60 * 1000;
    for (const [msgId, ts] of pendingRelayCustomReplyTimestamps) {
      if (now - ts > CUSTOM_REPLY_TTL) {
        pendingRelayCustomReplies.delete(msgId);
        pendingRelayCustomReplyTimestamps.delete(msgId);
      }
    }
    // M-LEAK: Sweep expired pendingResumeContext entries (30 min TTL)
    const RESUME_CTX_TTL = 30 * 60 * 1000;
    for (const [k, ts] of pendingResumeContextTimestamps) {
      if (now - ts > RESUME_CTX_TTL) {
        pendingResumeContext.delete(k);
        pendingResumeContextTimestamps.delete(k);
      }
    }
    // M-LEAK: Hard cap on pendingResumeContext
    if (pendingResumeContext.size > 20) {
      const keys = [...pendingResumeContext.keys()];
      for (let i = 0; i < keys.length - 10; i++) {
        pendingResumeContext.delete(keys[i]);
        pendingResumeContextTimestamps.delete(keys[i]);
      }
    }
    // M-LEAK: Hard cap on concurrent ingest states
    if (pendingIngestStates.size > 20) {
      const keys = [...pendingIngestStates.keys()];
      for (let i = 0; i < keys.length - 10; i++) {
        pendingIngestStates.delete(keys[i]);
      }
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
      // Notify owner that the bot is (back) online
      if (ALLOWED_USER_ID) {
        bot.api.sendMessage(ALLOWED_USER_ID, "✅ Jarvis is back online.").catch(() => {});
      }
    },
  }).catch((error) => {
    console.error("ERROR starting bot:", error);
    process.exit(1);
  });

  console.log("bot.start() initiated - waiting for connection...");
}
