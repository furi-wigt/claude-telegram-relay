/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { supabase } from "./utils/supabase.ts";
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
import { callOllama, checkOllamaAvailable } from "./fallback.ts";
import { getAgentForChat, autoDiscoverGroup, loadGroupMappings } from "./routing/groupRouter.ts";
import { loadSession as loadGroupSession, updateSessionId, initSessions, saveSession } from "./session/groupSessions.ts";
import { buildAgentPrompt } from "./agents/promptBuilder.ts";
import { GroupQueueManager } from "./queue/groupQueueManager.ts";
import { checkContextRelevanceSmart, updateTopicKeywords } from "./session/contextRelevance.ts";
import { registerCommands, buildProgressFooter, buildContextSwitchPrompt } from "./commands/botCommands.ts";
import { detectAndHandle, registerCallbackHandler } from "./routines/routineHandler.ts";
import { CodingSessionManager } from "./coding/sessionManager.ts";
import { InputRouter } from "./coding/inputRouter.ts";
import { ReminderManager } from "./coding/reminderManager.ts";
import { registerCodingCommands } from "./coding/codingCommands.ts";
import { InteractiveStateMachine } from "./interactive/index.ts";
import { callClaudeText } from "./claude.ts";
import { ProgressIndicator } from "./utils/progressIndicator.ts";

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
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || "900000", 10);

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
// FIX 7: Mutex to prevent concurrent Ollama extraction jobs from queuing up.
let extractionInFlight = false;
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

// ============================================================
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: {
    resume?: boolean;
    sessionId?: string | null;
    imagePath?: string;
    onProgress?: (summary: string) => void;
    onSessionId?: (sessionId: string) => void;
  }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
  if (options?.resume && options?.sessionId) {
    args.push("--resume", options.sessionId);
  }

  args.push("--output-format", "stream-json", "--verbose");

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  try {
    const env = { ...process.env };
    // Remove ALL Claude Code session detection vars to prevent nested session errors
    for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']) {
      delete env[key];
    }
    env.CLAUDE_SUBPROCESS = "1";

    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env,
    });

    let resultText = "";
    let lastAssistantText = "";
    let stderrText = "";

    // Parse NDJSON stream line-by-line, emitting granular progress events
    const parseStream = async (): Promise<void> => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let event: Record<string, unknown>;
            try { event = JSON.parse(trimmed); } catch { continue; }

            const type = event.type as string;
            if (type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
              options?.onSessionId?.(event.session_id as string);
            } else if (type === "assistant") {
              const message = event.message as { content?: Array<{ type: string; text?: string }> } | undefined;
              const text = message?.content
                ?.filter((b) => b.type === "text" && b.text)
                .map((b) => b.text)
                .join("\n") ?? "";
              if (text) {
                lastAssistantText = text;
                options?.onProgress?.(text.length > 120 ? text.slice(0, 120) + "..." : text);
              }
            } else if (type === "tool_use") {
              const toolName = event.name as string;
              const input = (event.input as Record<string, unknown>) ?? {};
              let summary = toolName;
              if (toolName === "Bash" || toolName === "bash") {
                const cmd = (input.command as string) ?? "";
                summary = `bash: ${cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd}`;
              } else if (input.file_path) {
                summary = `${toolName}: ${input.file_path as string}`;
              }
              options?.onProgress?.(summary);
            } else if (type === "result" && event.subtype === "success") {
              resultText = (event.result as string) ?? "";
            }
          }
        }
        // Flush remaining buffer
        if (buf.trim()) {
          try {
            const event = JSON.parse(buf.trim()) as Record<string, unknown>;
            if (event.type === "result" && event.subtype === "success") {
              resultText = (event.result as string) ?? "";
            }
          } catch { /* incomplete JSON at end of stream */ }
        }
      } catch { /* stream closed */ }
    };

    const drainStderr = async (): Promise<void> => {
      try { stderrText = await new Response(proc.stderr).text(); } catch { /* ignore */ }
    };

    // Add configurable timeout to prevent infinite hangs
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Claude timeout after ${CLAUDE_TIMEOUT / 1000}s`)), CLAUDE_TIMEOUT)
    );

    await Promise.race([
      Promise.all([parseStream(), drainStderr(), proc.exited]),
      timeout,
    ]).catch((error) => {
      proc.kill();
      throw error;
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error("Claude error:", stderrText);

      // Try fallback if available
      if (fallbackAvailable && process.env.FALLBACK_MODEL) {
        console.log("Claude failed, trying fallback model...");
        try {
          const fallbackResponse = await callOllama(prompt);
          return `[via ${process.env.FALLBACK_MODEL}]\n\n${fallbackResponse}`;
        } catch (fallbackError) {
          console.error("Fallback also failed:", fallbackError);
          return `Error: Both Claude and fallback failed. Claude: ${stderrText}`;
        }
      }

      return `Error: ${stderrText || "Claude exited with code " + exitCode}`;
    }

    return (resultText || lastAssistantText).trim();
  } catch (error) {
    console.error("Spawn error:", error);

    // Try fallback if available
    if (fallbackAvailable && process.env.FALLBACK_MODEL) {
      console.log("Claude spawn failed, trying fallback model...");
      try {
        const fallbackResponse = await callOllama(prompt);
        return `[via ${process.env.FALLBACK_MODEL}]\n\n${fallbackResponse}`;
      } catch (fallbackError) {
        console.error("Fallback also failed:", fallbackError);
        return `Error: Both Claude and fallback failed`;
      }
    }

    return `Error: Could not run Claude CLI`;
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
// Uses callClaudeText (--output-format text, no project cwd) which is more
// reliable for structured JSON tasks than the stream-json callClaude.
// Falls back to Ollama when the CLI is unavailable.
async function questionCallClaude(prompt: string): Promise<string> {
  try {
    return await callClaudeText(prompt, {
      model: "claude-haiku-4-5-20251001",
      timeoutMs: 60_000,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[interactive] callClaudeText failed:", errMsg);
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
    console.log(`[${agent.name}] Message from chat ${chatId}: ${text.substring(0, 50)}...`);
    await ctx.replyWithChatAction("typing");

    const session = await loadGroupSession(chatId, agent.id, threadId);

    // ── Context Relevance Check ──────────────────────────────────────
    // If a session is active and has context, check if this message
    // belongs to the same topic. Low relevance triggers a soft prompt
    // asking the user if they want to start fresh, without assuming.
    if (session.sessionId && session.messageCount > 0) {
      if (session.pendingContextSwitch) {
        // User sent a message after context-switch prompt: clear flag and continue.
        // They can always use /new to explicitly start a new session.
        session.pendingContextSwitch = false;
        await saveSession(session);
      } else {
        const relevance = await checkContextRelevanceSmart(text, {
          topicKeywords: session.topicKeywords,
          lastUserMessages: session.lastUserMessages,
          lastActivity: session.lastActivity,
        });
        console.log(`Context relevance [${relevance.method}]: ${relevance.score.toFixed(2)} — ${relevance.reason}`);

        if (!relevance.isRelevant) {
          // Prompt user: new topic or continue?
          session.pendingContextSwitch = true;
          await saveSession(session);
          await ctx.reply(buildContextSwitchPrompt(session.topicKeywords.slice(0, 5)));
          return; // Don't process with Claude until user decides
        }
      }
    }

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

    const indicator = new ProgressIndicator();
    indicator.start(chatId, bot, threadId).catch(() => {}); // fire-and-forget

    let rawResponse: string;
    const callStart = Date.now();
    try {
      rawResponse = await callClaude(enrichedPrompt, {
        resume: !!session.sessionId,
        sessionId: session.sessionId,
        onProgress: (summary) => void indicator.update(summary, { immediate: true }),
        onSessionId: (id) => void updateSessionId(chatId, id, threadId),
      });
      await indicator.finish(true);
    } catch (claudeErr) {
      await indicator.finish(false);
      throw claudeErr;
    }
    const callDurationMs = Date.now() - callStart;
    console.log(`Claude raw response length: ${rawResponse.length} (${callDurationMs}ms)`);

    const response = await processMemoryIntents(supabase, rawResponse, chatId);
    console.log(`Processed response length: ${response.length}`);

    // ── Update session metadata ──────────────────────────────────────
    session.topicKeywords = updateTopicKeywords(session.topicKeywords, text);
    session.messageCount = (session.messageCount || 0) + 1;
    session.lastUserMessages = [...(session.lastUserMessages || []), text].slice(-3);
    session.lastActivity = new Date().toISOString();
    await saveSession(session);

    await saveMessage("user", text, undefined, chatId, agent.id, threadId);
    await saveMessage("assistant", response || rawResponse, undefined, chatId, agent.id, threadId);

    // Async LTM extraction (non-blocking — runs after response is sent)
    // FIX 7: Skip if a previous extraction is still running to prevent Ollama queue buildup.
    // NOTE: Only the user's message (text) is passed — assistant response is intentionally
    // excluded to prevent memory contamination from the bot's own output.
    if (supabase && !extractionInFlight) {
      const db = supabase; // capture non-null ref — TS narrowing doesn't cross setImmediate
      extractionInFlight = true;
      setImmediate(async () => {
        try {
          const { uncertain, inserted } = await extractAndStore(db, chatId, userId, text);
          if (uncertain && hasMemoryItems(uncertain)) {
            await sendMemoryConfirmation(bot, chatId, uncertain, threadId).catch(() => {});
          }
          if (session.messageCount % 5 === 0 && inserted > 0) {
            await rebuildProfileSummary(db, userId);
          }
        } catch (err) {
          console.error("Async memory extraction failed:", err);
        } finally {
          extractionInFlight = false;
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

        const voiceIndicator = new ProgressIndicator();
        voiceIndicator.start(chatId, bot, threadId).catch(() => {}); // fire-and-forget

        let rawResponse: string;
        const voiceCallStart = Date.now();
        try {
          rawResponse = await callClaude(enrichedPrompt, {
            resume: !!session.sessionId,
            sessionId: session.sessionId,
            onProgress: (summary) => void voiceIndicator.update(summary, { immediate: true }),
            onSessionId: (id) => void updateSessionId(chatId, id, threadId),
          });
          await voiceIndicator.finish(true);
        } catch (claudeErr) {
          await voiceIndicator.finish(false);
          throw claudeErr;
        }
        const voiceCallDurationMs = Date.now() - voiceCallStart;

        const claudeResponse = await processMemoryIntents(supabase, rawResponse, chatId);

        // Update session metadata
        session.topicKeywords = updateTopicKeywords(session.topicKeywords, transcription);
        session.messageCount = (session.messageCount || 0) + 1;
        session.lastUserMessages = [...(session.lastUserMessages || []), transcription].slice(-3);
        session.lastActivity = new Date().toISOString();
        await saveSession(session);

        await saveMessage("assistant", claudeResponse, undefined, chatId, agent.id, threadId);

        // Async LTM extraction (non-blocking — runs after response is sent)
        // FIX 7: Same mutex as text handler — skip if extraction already in-flight.
        if (supabase && !extractionInFlight) {
          const db = supabase; // capture non-null ref — TS narrowing doesn't cross setImmediate
          extractionInFlight = true;
          setImmediate(async () => {
            try {
              const { inserted } = await extractAndStore(db, chatId, voiceUserId, transcription);
              if (session.messageCount % 5 === 0 && inserted > 0) {
                await rebuildProfileSummary(db, voiceUserId);
              }
            } catch (err) {
              console.error("Async memory extraction failed:", err);
            } finally {
              extractionInFlight = false;
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

        const photoIndicator = new ProgressIndicator();
        photoIndicator.start(chatId, bot, threadId).catch(() => {}); // fire-and-forget

        let claudeResponse: string;
        try {
          claudeResponse = await callClaude(prompt, {
            resume: !!session.sessionId,
            sessionId: session.sessionId,
            onProgress: (summary) => void photoIndicator.update(summary, { immediate: true }),
            onSessionId: (id) => void updateSessionId(chatId, id, threadId),
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

        const docIndicator = new ProgressIndicator();
        docIndicator.start(chatId, bot, threadId).catch(() => {}); // fire-and-forget

        let claudeResponse: string;
        try {
          claudeResponse = await callClaude(prompt, {
            resume: !!session.sessionId,
            sessionId: session.sessionId,
            onProgress: (summary) => void docIndicator.update(summary, { immediate: true }),
            onSessionId: (id) => void updateSessionId(chatId, id, threadId),
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

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Handle empty responses
  if (!response || response.trim().length === 0) {
    console.error("Warning: Attempted to send empty response, using fallback");
    await ctx.reply("(Processing completed but no response generated)");
    return;
  }

  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = response;

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
    await ctx.reply(chunk);
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
