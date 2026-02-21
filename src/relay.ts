/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context } from "grammy";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { supabase } from "./utils/supabase.ts";
import {
  activeStreams,
  streamKey,
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
import { loadModelRouterConfig, resolveModel } from "./routing/modelRouter.ts";
import { loadSession as loadGroupSession, updateSessionId, initSessions, saveSession } from "./session/groupSessions.ts";
import { buildAgentPrompt } from "./agents/promptBuilder.ts";
import { GroupQueueManager } from "./queue/groupQueueManager.ts";
import { registerCommands, buildProgressFooter, registerContextSwitchCallbackHandler } from "./commands/botCommands.ts";
import { detectAndHandle, registerCallbackHandler } from "./routines/routineHandler.ts";
import { CodingSessionManager } from "./coding/sessionManager.ts";
import { InputRouter } from "./coding/inputRouter.ts";
import { ReminderManager } from "./coding/reminderManager.ts";
import { registerCodingCommands } from "./coding/codingCommands.ts";
import { InteractiveStateMachine } from "./interactive/index.ts";
import { claudeText, claudeStream } from "./claude-process.ts";
import { ProgressIndicator } from "./utils/progressIndicator.ts";
import { trace, generateTraceId } from "./utils/tracer.ts";

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

// Model routing config — loaded once at startup from config/models.json
const modelRouterConfig = loadModelRouterConfig();

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
  // Allow /new <prompt> to immediately process the follow-up text as a user message
  onMessage: async (chatId: number, text: string, ctx: Context) => {
    if (!queueManager.hasCapacity(chatId, null)) {
      await ctx.reply("Queue is full. Please try again shortly.");
      return;
    }
    queueManager.getOrCreate(chatId, null).enqueue({
      label: `[chat:${chatId}] /new: ${text.substring(0, 30)}`,
      run: () => processTextMessage(chatId, null, text, ctx),
    });
  },
});

// Register routine creation callback handler (inline keyboard for output target)
registerCallbackHandler(bot);

// Register memory confirmation callback handler (inline keyboard for uncertain memory items)
registerMemoryConfirmHandler(bot, supabase);

// Kept for backward compat: handles "New topic / Continue" button clicks from any
// context-switch prompts that were sent before topic detection was removed. Safe to
// keep indefinitely — it no-ops when there are no pending context-switch messages.
registerContextSwitchCallbackHandler(bot, async (chatId: number, text: string, ctx: Context) => {
  if (!queueManager.hasCapacity(chatId, null)) {
    await ctx.reply("Queue is full. Please try again shortly.");
    return;
  }
  queueManager.getOrCreate(chatId, null).enqueue({
    label: `[chat:${chatId}] ctxswitch: ${text.substring(0, 30)}`,
    run: () => processTextMessage(chatId, null, text, ctx),
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
      cwd: PROJECT_DIR || undefined,
      claudePath: CLAUDE_PATH,
      onProgress: options?.onProgress,
      onSessionId: options?.onSessionId,
      signal: controller.signal,
      model: options?.model,
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

// Handle coding session callback queries (answer, plan, dashboard only — NOT code_perm:)
// code_perm: is handled exclusively in registerCodingCommands via handlePermCallback
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data || "";
  if (
    data.startsWith("code_answer:") ||
    data.startsWith("code_plan:") ||
    data.startsWith("code_dash:")
  ) {
    await inputRouter.handleCallbackQuery(ctx, sessionManager);
    await ctx.answerCallbackQuery().catch(() => {});
  } else if (data.startsWith("iq:")) {
    await interactive.handleCallback(ctx, data);
  } else if (data.startsWith("cancel:")) {
    const chatId = ctx.chat?.id ?? 0;
    const threadId = ctx.message?.message_thread_id ?? null;
    await ctx.answerCallbackQuery().catch(() => {});
    await handleCancelCallback(chatId, threadId, ctx, bot);
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
  const typingInterval = startTypingIndicator(ctx);
  try {
    const agent = getAgentForChat(chatId);
    const traceId = generateTraceId();
    trace({ event: "message_received", traceId, chatId, agentId: agent.id, textLength: text.length, threadId });
    console.log(`[${agent.name}] Message from chat ${chatId}: ${text.substring(0, 50)}...`);
    await ctx.replyWithChatAction("typing");

    const session = await loadGroupSession(chatId, agent.id, threadId);

    const userId = ctx.from?.id ?? 0;
    const [shortTermCtxRaw, userProfile, relevantContext, memoryContext] = await Promise.all([
      supabase ? getShortTermContext(supabase, chatId, threadId) : Promise.resolve({ verbatimMessages: [], summaries: [], totalMessages: 0 }),
      supabase ? getUserProfile(supabase, userId) : Promise.resolve(""),
      getRelevantContext(supabase, text, chatId),
      getMemoryContext(supabase, chatId),
    ]);
    const shortTermContext = supabase ? formatShortTermContext(shortTermCtxRaw, USER_TIMEZONE) : "";

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
    });

    // Resolve model via two-pass router (classifier runs in Pass 1, result used in Pass 2)
    const routing = await resolveModel(text, modelRouterConfig);

    const cancelKey = streamKey(chatId, threadId);
    const indicator = new ProgressIndicator();
    indicator.setModelLabel(routing.displayName);
    indicator.start(chatId, bot, threadId, {
      cancelKey,
      onMessageId: (msgId) => {
        const entry = activeStreams.get(cancelKey);
        if (entry) entry.progressMessageId = msgId;
      },
    }).catch(() => {}); // fire-and-forget

    let rawResponse: string;
    const callStart = Date.now();
    trace({ event: "claude_start", traceId, chatId, promptLength: enrichedPrompt.length, resume: !!session.sessionId, sessionId: session.sessionId });
    try {
      rawResponse = await callClaude(enrichedPrompt, {
        resume: !!session.sessionId,
        sessionId: session.sessionId,
        onProgress: (summary) => void indicator.update(summary, { immediate: true }),
        onSessionId: (id) => void updateSessionId(chatId, id, threadId),
        chatId,
        threadId,
        model: routing.model,
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

    const response = await processMemoryIntents(supabase, rawResponse, chatId);
    console.log(`Processed response length: ${response.length}`);

    // ── Update session metadata ──────────────────────────────────────
    session.messageCount = (session.messageCount || 0) + 1;
    session.lastActivity = new Date().toISOString();
    await saveSession(session);

    await saveMessage("user", text, undefined, chatId, agent.id, threadId);
    await saveMessage("assistant", response || rawResponse, undefined, chatId, agent.id, threadId);

    // Per-chat queue ensures every message is processed — no silent drops during bursts.
    if (supabase) {
      const db = supabase;
      const msgCount = session.messageCount;
      const assistantText = response || rawResponse;
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

    // Append progress footer for slow Claude calls (>30s)
    const footer = buildProgressFooter(chatId, callDurationMs);
    const finalResponse = (response || rawResponse || "No response generated") +
      (footer ? `\n\n${footer}` : "");

    await sendResponse(ctx, finalResponse);
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

  // Priority 1: /code answer explicit routing to coding sessions
  if (text.startsWith("/code answer ")) {
    await sessionManager.answerCurrentWaiting(chatId, text.slice(13).trim());
    return;
  }

  // Priority 2: Reply-to-message routing to coding sessions
  if (await inputRouter.tryRouteReply(ctx, sessionManager)) return;

  // Priority 3: Interactive Q&A free-text answer (when user is mid-plan session)
  if (await interactive.handleFreeText(ctx, text)) return;

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

        await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`, undefined, chatId, agent.id, threadId);

        const [shortTermCtxRaw, userProfile, relevantContext, memoryContext] = await Promise.all([
          supabase ? getShortTermContext(supabase, chatId, threadId) : Promise.resolve({ verbatimMessages: [], summaries: [], totalMessages: 0 }),
          supabase ? getUserProfile(supabase, voiceUserId) : Promise.resolve(""),
          getRelevantContext(supabase, transcription, chatId),
          getMemoryContext(supabase, chatId),
        ]);
        const shortTermContext = supabase ? formatShortTermContext(shortTermCtxRaw, USER_TIMEZONE) : "";

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

        let rawResponse: string;
        const voiceCallStart = Date.now();
        try {
          rawResponse = await callClaude(enrichedPrompt, {
            resume: !!session.sessionId,
            sessionId: session.sessionId,
            onProgress: (summary) => void voiceIndicator.update(summary, { immediate: true }),
            onSessionId: (id) => void updateSessionId(chatId, id, threadId),
            chatId,
            threadId,
          });
          await voiceIndicator.finish(true);
        } catch (claudeErr) {
          await voiceIndicator.finish(false);
          throw claudeErr;
        }
        const voiceCallDurationMs = Date.now() - voiceCallStart;

        const claudeResponse = await processMemoryIntents(supabase, rawResponse, chatId);

        // Update session metadata
        session.messageCount = (session.messageCount || 0) + 1;
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

        const voiceFooter = buildProgressFooter(chatId, voiceCallDurationMs);
        const finalVoiceResponse = claudeResponse + (voiceFooter ? `\n\n${voiceFooter}` : "");
        await sendResponse(ctx, finalVoiceResponse);
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
bot.on("message:photo", async (ctx) => {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id ?? null;

  if (!chatId) return;

  if (!queueManager.hasCapacity(chatId, threadId)) {
    await ctx.reply("Too many pending messages. Please wait for the current ones to complete.");
    return;
  }

  queueManager.getOrCreate(chatId, threadId).enqueue({
    label: `[chat:${chatId}] photo`,
    run: async () => {
      const typingInterval = startTypingIndicator(ctx);
      try {
        const agent = getAgentForChat(chatId);
        console.log(`[${agent.name}] Image received`);
        await ctx.replyWithChatAction("typing");

        const photos = ctx.message.photo;
        const photo = photos[photos.length - 1];
        const file = await ctx.api.getFile(photo.file_id);

        const timestamp = Date.now();
        const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

        const response = await fetch(
          `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
        );
        const buffer = await response.arrayBuffer();
        await writeFile(filePath, Buffer.from(buffer));

        const caption = ctx.message.caption || "Analyze this image.";
        const prompt = `[Image: ${filePath}]\n\n${caption}`;

        const session = await loadGroupSession(chatId, agent.id, threadId);

        await saveMessage("user", `[Image]: ${caption}`, undefined, chatId, agent.id, threadId);

        const photoCancelKey = streamKey(chatId, threadId);
        const photoIndicator = new ProgressIndicator();
        photoIndicator.start(chatId, bot, threadId, {
          cancelKey: photoCancelKey,
          onMessageId: (msgId) => {
            const entry = activeStreams.get(photoCancelKey);
            if (entry) entry.progressMessageId = msgId;
          },
        }).catch(() => {}); // fire-and-forget

        let claudeResponse: string;
        try {
          claudeResponse = await callClaude(prompt, {
            resume: !!session.sessionId,
            sessionId: session.sessionId,
            onProgress: (summary) => void photoIndicator.update(summary, { immediate: true }),
            onSessionId: (id) => void updateSessionId(chatId, id, threadId),
            chatId,
            threadId,
          });
          await photoIndicator.finish(true);
        } catch (claudeErr) {
          await photoIndicator.finish(false);
          throw claudeErr;
        }

        await unlink(filePath).catch(() => {});

        const cleanResponse = await processMemoryIntents(supabase, claudeResponse, chatId);
        await saveMessage("assistant", cleanResponse, undefined, chatId, agent.id, threadId);
        await sendResponse(ctx, cleanResponse);
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
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id ?? null;

  if (!chatId) return;

  if (!queueManager.hasCapacity(chatId, threadId)) {
    await ctx.reply("Too many pending messages. Please wait for the current ones to complete.");
    return;
  }

  queueManager.getOrCreate(chatId, threadId).enqueue({
    label: `[chat:${chatId}] doc: ${doc.file_name}`,
    run: async () => {
      const typingInterval = startTypingIndicator(ctx);
      try {
        const agent = getAgentForChat(chatId);
        console.log(`[${agent.name}] Document: ${doc.file_name}`);
        await ctx.replyWithChatAction("typing");

        const file = await ctx.getFile();
        const timestamp = Date.now();
        const fileName = doc.file_name || `file_${timestamp}`;
        const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

        const response = await fetch(
          `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
        );
        const buffer = await response.arrayBuffer();
        await writeFile(filePath, Buffer.from(buffer));

        const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
        const prompt = `[File: ${filePath}]\n\n${caption}`;

        const session = await loadGroupSession(chatId, agent.id, threadId);

        await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`, undefined, chatId, agent.id, threadId);

        const docCancelKey = streamKey(chatId, threadId);
        const docIndicator = new ProgressIndicator();
        docIndicator.start(chatId, bot, threadId, {
          cancelKey: docCancelKey,
          onMessageId: (msgId) => {
            const entry = activeStreams.get(docCancelKey);
            if (entry) entry.progressMessageId = msgId;
          },
        }).catch(() => {}); // fire-and-forget

        let claudeResponse: string;
        try {
          claudeResponse = await callClaude(prompt, {
            resume: !!session.sessionId,
            sessionId: session.sessionId,
            onProgress: (summary) => void docIndicator.update(summary, { immediate: true }),
            onSessionId: (id) => void updateSessionId(chatId, id, threadId),
            chatId,
            threadId,
          });
          await docIndicator.finish(true);
        } catch (claudeErr) {
          await docIndicator.finish(false);
          throw claudeErr;
        }

        await unlink(filePath).catch(() => {});

        const cleanResponse = await processMemoryIntents(supabase, claudeResponse, chatId);
        await saveMessage("assistant", cleanResponse, undefined, chatId, agent.id, threadId);
        await sendResponse(ctx, cleanResponse);
      } catch (error) {
        console.error("Document handler error:", error);
        try {
          await ctx.reply("Could not process document. Please try again.");
        } catch (replyError) {
          console.error("Failed to send error reply:", replyError);
        }
      } finally {
        clearInterval(typingInterval);
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

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

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

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Handle empty responses
  if (!response || response.trim().length === 0) {
    console.error("Warning: Attempted to send empty response, using fallback");
    await ctx.reply("(Processing completed but no response generated)");
    return;
  }

  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;
  const html = markdownToHtml(response);

  if (html.length <= MAX_LENGTH) {
    await ctx.reply(html, { parse_mode: "HTML" });
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

  for (const chunk of chunks) {
    if (isBalancedHtml(chunk)) {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } else {
      // Strip all tags and send as plain text fallback
      const plain = chunk.replace(/<[^>]+>/g, "");
      await ctx.reply(plain);
    }
  }
}

// ============================================================
// START
// ============================================================

// Initialize per-group sessions directory
await initSessions();

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
