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
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { transcribe } from "./transcribe.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";
import { callOllama, checkOllamaAvailable } from "./fallback.ts";
import { getAgentForChat, autoDiscoverGroup, loadGroupMappings } from "./routing/groupRouter.ts";
import { loadSession as loadGroupSession, updateSessionId, initSessions } from "./session/groupSessions.ts";
import { buildAgentPrompt } from "./agents/promptBuilder.ts";
import { GroupQueueManager } from "./queue/groupQueueManager.ts";

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
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || "180000", 10);

// Queue Configuration
const QUEUE_MAX_DEPTH = parseInt(process.env.QUEUE_MAX_DEPTH || "50", 10);
const QUEUE_IDLE_TIMEOUT = parseInt(process.env.QUEUE_IDLE_TIMEOUT_MS || "86400000", 10);
const QUEUE_STATS_INTERVAL = parseInt(process.env.QUEUE_STATS_LOG_INTERVAL_MS || "300000", 10);
const QUEUE_SHUTDOWN_GRACE = parseInt(process.env.QUEUE_SHUTDOWN_GRACE_MS || "30000", 10);

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

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  chatId?: number,
  agentId?: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
      chat_id: chatId ?? null,
      agent_id: agentId ?? null,
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

// ============================================================
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; sessionId?: string | null; imagePath?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
  if (options?.resume && options?.sessionId) {
    args.push("--resume", options.sessionId);
  }

  args.push("--output-format", "text");

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: {
        ...process.env,
      },
    });

    // Add configurable timeout to prevent infinite hangs
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Claude timeout after ${CLAUDE_TIMEOUT / 1000}s`)), CLAUDE_TIMEOUT)
    );

    const [output, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ]),
      timeout
    ]).catch(error => {
      proc.kill();
      throw error;
    });

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);

      // Try fallback if available
      if (fallbackAvailable && process.env.FALLBACK_MODEL) {
        console.log("Claude failed, trying fallback model...");
        try {
          const fallbackResponse = await callOllama(prompt);
          return `[via ${process.env.FALLBACK_MODEL}]\n\n${fallbackResponse}`;
        } catch (fallbackError) {
          console.error("Fallback also failed:", fallbackError);
          return `Error: Both Claude and fallback failed. Claude: ${stderr}`;
        }
      }

      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    return output.trim();
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
// MESSAGE HANDLERS
// ============================================================

/** Send "typing" action every 5s until cleared. */
function startTypingIndicator(ctx: Context): ReturnType<typeof setInterval> {
  return setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 5000);
}

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const chatId = ctx.chat?.id;

  if (!chatId) return;

  if (!queueManager.hasCapacity(chatId)) {
    await ctx.reply("Too many pending messages. Please wait for the current ones to complete.");
    return;
  }

  queueManager.getOrCreate(chatId).enqueue({
    label: `[chat:${chatId}] ${text.substring(0, 30)}`,
    run: async () => {
      const typingInterval = startTypingIndicator(ctx);
      try {
        const agent = getAgentForChat(chatId);
        console.log(`[${agent.name}] Message from chat ${chatId}: ${text.substring(0, 50)}...`);
        await ctx.replyWithChatAction("typing");

        const session = await loadGroupSession(chatId, agent.id);

        const [relevantContext, memoryContext] = await Promise.all([
          getRelevantContext(supabase, text),
          getMemoryContext(supabase, chatId),
        ]);

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
          relevantContext,
          memoryContext,
          profileContext,
          userName: USER_NAME,
          timeStr,
        });

        const rawResponse = await callClaude(enrichedPrompt, {
          resume: !!session.sessionId,
          sessionId: session.sessionId,
        });
        console.log(`Claude raw response length: ${rawResponse.length}`);

        // Extract and update session ID if present
        const sessionMatch = rawResponse.match(/Session ID: ([a-f0-9-]+)/i);
        if (sessionMatch) {
          await updateSessionId(chatId, sessionMatch[1]);
        }

        const response = await processMemoryIntents(supabase, rawResponse, chatId);
        console.log(`Processed response length: ${response.length}`);

        await saveMessage("user", text, undefined, chatId, agent.id);
        await saveMessage("assistant", response || rawResponse, undefined, chatId, agent.id);
        await sendResponse(ctx, response || rawResponse || "No response generated");
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
    },
  });
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  const chatId = ctx.chat?.id;

  if (!chatId) return;

  if (!queueManager.hasCapacity(chatId)) {
    await ctx.reply("Too many pending messages. Please wait for the current ones to complete.");
    return;
  }

  queueManager.getOrCreate(chatId).enqueue({
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

        const session = await loadGroupSession(chatId, agent.id);

        await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`, undefined, chatId, agent.id);

        const [relevantContext, memoryContext] = await Promise.all([
          getRelevantContext(supabase, transcription),
          getMemoryContext(supabase, chatId),
        ]);

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
          relevantContext,
          memoryContext,
          profileContext,
          userName: USER_NAME,
          timeStr,
        });

        const rawResponse = await callClaude(enrichedPrompt, {
          resume: !!session.sessionId,
          sessionId: session.sessionId,
        });

        const sessionMatch = rawResponse.match(/Session ID: ([a-f0-9-]+)/i);
        if (sessionMatch) {
          await updateSessionId(chatId, sessionMatch[1]);
        }

        const claudeResponse = await processMemoryIntents(supabase, rawResponse, chatId);

        await saveMessage("assistant", claudeResponse, undefined, chatId, agent.id);
        await sendResponse(ctx, claudeResponse);
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

  if (!chatId) return;

  if (!queueManager.hasCapacity(chatId)) {
    await ctx.reply("Too many pending messages. Please wait for the current ones to complete.");
    return;
  }

  queueManager.getOrCreate(chatId).enqueue({
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

        const session = await loadGroupSession(chatId, agent.id);

        await saveMessage("user", `[Image]: ${caption}`, undefined, chatId, agent.id);

        const claudeResponse = await callClaude(prompt, {
          resume: !!session.sessionId,
          sessionId: session.sessionId,
        });

        await unlink(filePath).catch(() => {});

        const sessionMatch = claudeResponse.match(/Session ID: ([a-f0-9-]+)/i);
        if (sessionMatch) {
          await updateSessionId(chatId, sessionMatch[1]);
        }

        const cleanResponse = await processMemoryIntents(supabase, claudeResponse, chatId);
        await saveMessage("assistant", cleanResponse, undefined, chatId, agent.id);
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

  if (!chatId) return;

  if (!queueManager.hasCapacity(chatId)) {
    await ctx.reply("Too many pending messages. Please wait for the current ones to complete.");
    return;
  }

  queueManager.getOrCreate(chatId).enqueue({
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

        const session = await loadGroupSession(chatId, agent.id);

        await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`, undefined, chatId, agent.id);

        const claudeResponse = await callClaude(prompt, {
          resume: !!session.sessionId,
          sessionId: session.sessionId,
        });

        await unlink(filePath).catch(() => {});

        const sessionMatch = claudeResponse.match(/Session ID: ([a-f0-9-]+)/i);
        if (sessionMatch) {
          await updateSessionId(chatId, sessionMatch[1]);
        }

        const cleanResponse = await processMemoryIntents(supabase, claudeResponse, chatId);
        await saveMessage("assistant", cleanResponse, undefined, chatId, agent.id);
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
  await queueManager.shutdown(QUEUE_SHUTDOWN_GRACE);
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
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
