/**
 * Forum Thread ID Inspector
 *
 * Starts the bot temporarily and prints the raw thread/chat fields
 * for every message it receives. Use this to discover what
 * message_thread_id looks like in your forum group.
 *
 * Usage: bun run setup/test-forum-thread.ts
 * Stop:  Ctrl+C
 */

import { Bot } from "grammy";
import { join, dirname } from "path";
import { readFileSync } from "fs";

const PROJECT_ROOT = dirname(import.meta.dir);

// Load .env
try {
  const envFile = readFileSync(join(PROJECT_ROOT, ".env"), "utf-8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set in .env");
  process.exit(1);
}

const bold  = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan  = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim   = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const bot = new Bot(BOT_TOKEN);

bot.on("message", (ctx) => {
  const msg = ctx.message;
  const chat = ctx.chat;

  const threadId      = msg.message_thread_id;
  const chatId        = chat.id;
  const chatType      = chat.type;
  const chatTitle     = ("title" in chat) ? chat.title : "(DM)";
  const isTopicMsg    = (msg as any).is_topic_message ?? false;
  const text          = ("text" in msg) ? msg.text : "(non-text)";
  const from          = msg.from?.username ?? msg.from?.first_name ?? "unknown";

  console.log("\n" + "─".repeat(52));
  console.log(bold("  Incoming message"));
  console.log("─".repeat(52));
  console.log(`  ${cyan("chat_id")}          ${chatId}`);
  console.log(`  ${cyan("chat_type")}        ${chatType}`);
  console.log(`  ${cyan("chat_title")}       ${chatTitle}`);
  console.log(`  ${cyan("is_forum")}         ${("is_forum" in chat) ? (chat as any).is_forum : false}`);
  console.log(`  ${cyan("is_topic_message")} ${isTopicMsg}`);

  if (threadId !== undefined) {
    console.log(`  ${green("message_thread_id")} ${bold(String(threadId))}  ← forum topic ID ✓`);
  } else {
    console.log(`  ${yellow("message_thread_id")} (not set — not a forum topic message)`);
  }

  console.log(`  ${dim("from")}             @${from}`);
  console.log(`  ${dim("text")}             ${String(text).slice(0, 80)}`);

  if (threadId !== undefined) {
    console.log("\n  " + green("✓ This message came from a forum topic."));
    console.log(`    Use chat_id=${bold(String(chatId))} and thread_id=${bold(String(threadId))}`);
  } else {
    console.log("\n  " + yellow("→ Not a forum topic message (no message_thread_id)."));
    console.log("    Send this message inside a forum topic thread instead.");
  }
});

bot.catch((err) => console.error("Bot error:", err));

console.log("");
console.log(bold("  Forum Thread ID Inspector"));
console.log("  " + dim("─".repeat(48)));
console.log("");
console.log("  Instructions:");
console.log("  1. Open your Telegram group that has Topics/Forum mode enabled");
console.log("  2. Go into any topic (thread)");
console.log("  3. Send any message — the thread ID will appear here");
console.log("  4. Try different topics to see their different thread IDs");
console.log("  5. Press Ctrl+C when done");
console.log("");
console.log("  Waiting for messages...");
console.log("");

bot.start({ drop_pending_updates: true });
