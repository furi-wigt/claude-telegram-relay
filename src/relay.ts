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

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

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
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
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

// ============================================================
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
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
        // Pass through any env vars Claude might need
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

    // Extract session ID from output if present (for --resume)
    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
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
  const typingInterval = startTypingIndicator(ctx);
  try {
    const text = ctx.message.text;
    console.log(`Message: ${text.substring(0, 50)}...`);

    await ctx.replyWithChatAction("typing");

    await saveMessage("user", text);

    // Gather context: semantic search + facts/goals
    const [relevantContext, memoryContext] = await Promise.all([
      getRelevantContext(supabase, text),
      getMemoryContext(supabase),
    ]);

    const enrichedPrompt = buildPrompt(text, relevantContext, memoryContext);
    const rawResponse = await callClaude(enrichedPrompt, { resume: true });

    console.log(`Claude raw response length: ${rawResponse.length}`);

    // Parse and save any memory intents, strip tags from response
    const response = await processMemoryIntents(supabase, rawResponse);

    console.log(`Processed response length: ${response.length}`);

    await saveMessage("assistant", response || rawResponse);
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
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const typingInterval = startTypingIndicator(ctx);
  try {
    const voice = ctx.message.voice;
    console.log(`Voice message: ${voice.duration}s`);
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

    await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`);

    const [relevantContext, memoryContext] = await Promise.all([
      getRelevantContext(supabase, transcription),
      getMemoryContext(supabase),
    ]);

    const enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${transcription}`,
      relevantContext,
      memoryContext
    );
    const rawResponse = await callClaude(enrichedPrompt, { resume: true });
    const claudeResponse = await processMemoryIntents(supabase, rawResponse);

    await saveMessage("assistant", claudeResponse);
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
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  const typingInterval = startTypingIndicator(ctx);
  try {
    console.log("Image received");
    await ctx.replyWithChatAction("typing");

    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Image]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
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
});

// Documents
bot.on("message:document", async (ctx) => {
  const typingInterval = startTypingIndicator(ctx);
  try {
    const doc = ctx.message.document;
    console.log(`Document: ${doc.file_name}`);
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

    await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });

    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
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

function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string
): string {
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

  const parts = [
    "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational.",
  ];

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
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

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);
console.log(`Bot token configured: ${BOT_TOKEN ? "YES" : "NO"}`);
console.log(`Attempting to start Telegram bot...`);

// Handle process signals to keep bot running
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
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
