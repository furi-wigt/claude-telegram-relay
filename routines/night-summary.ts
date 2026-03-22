#!/usr/bin/env bun

/**
 * @routine night-summary
 * @description Evening summary of the day's activities and tomorrow's priorities
 * @schedule 0 23 * * *
 * @target Personal chat
 */

/**
 * Night Summary Routine (Ollama-first, Haiku fallback)
 *
 * Schedule: 11:00 PM daily (SGT)
 * Target: General AI Assistant group
 *
 * Pulls the day's messages, facts, and goals from local SQLite, then uses
 * local Ollama to generate a detailed, motivational day-end reflection
 * formatted in Markdown. Falls back to Claude Haiku when Ollama is unavailable.
 * Notifies the user if both providers fail.
 *
 * Run manually: bun run routines/night-summary.ts
 */

import { join } from "path";
import { runPrompt } from "../integrations/claude/index.ts";
import { callRoutineModel } from "../src/routines/routineModel.ts";
import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { sendToGroup } from "../src/utils/sendToGroup.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";
import { USER_NAME, USER_TIMEZONE } from "../src/config/userConfig.ts";
import { shouldSkipRecently, markRanToday } from "../src/routines/runOnceGuard.ts";
import { getPm2LogsDir } from "../config/observability.ts";

const LAST_RUN_FILE = join(getPm2LogsDir(), "night-summary.lastrun");

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const CLAUDE_TIMEOUT_MS = 90_000;

// ============================================================
// TYPES (exported for tests)
// ============================================================

export interface DayMessage {
  content: string;
  role: "user" | "assistant";
  created_at: string;
  agent_id?: string | null;  // which agent/group handled this message
}

export interface DaySummary {
  summary: string;
  message_count: number;
  from_timestamp: string | null;
  to_timestamp: string | null;
  chat_id?: number | null;
}

export interface DayFact {
  content: string;
  created_at: string;
}

export interface DayGoal {
  content: string;
  deadline?: string;
  completed: boolean;
  completed_at?: string;
}

export interface AnalysisResult {
  text: string;
  provider: "claude" | "ollama" | null;
}

// ============================================================
// PURE FUNCTIONS (exported for tests)
// ============================================================

/**
 * Format a single HH:mm time string from an ISO timestamp.
 * Pure helper — no side effects.
 */
function formatTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString("en-SG", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: USER_TIMEZONE,
  });
}

/**
 * Build a structured day timeline from messages and conversation summaries.
 * Two tiers:
 *   1. Earlier Today — conversation summaries covering morning/afternoon
 *   2. Recent — verbatim messages (all, no arbitrary cap)
 *
 * Pure function — no side effects, no network I/O.
 */
export function buildDayTimeline(
  messages: DayMessage[],
  summaries: DaySummary[]
): string {
  if (messages.length === 0 && summaries.length === 0) {
    return "No conversations today";
  }

  const lines: string[] = [];

  if (summaries.length > 0) {
    lines.push("### Earlier Today — Summarised");
    for (const s of summaries) {
      const range =
        s.from_timestamp && s.to_timestamp
          ? `${formatTime(s.from_timestamp)}–${formatTime(s.to_timestamp)}`
          : "earlier";
      lines.push(`[${range}]: ${s.summary}`);
    }
  }

  if (messages.length > 0) {
    if (summaries.length > 0) lines.push("");
    lines.push("### Recent Conversations");
    for (const m of messages) {
      const time = formatTime(m.created_at);
      const speaker = m.role === "user" ? "User" : "Assistant";
      const group = m.agent_id ? ` (${m.agent_id})` : "";
      lines.push(`[${time}] ${speaker}${group}: ${m.content.substring(0, 500)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build the reflection prompt from today's data.
 * Pure function — no side effects, no network I/O.
 */
export function buildReflectionPrompt(
  messages: DayMessage[],
  facts: DayFact[],
  goals: DayGoal[],
  userName?: string,
  summaries?: DaySummary[]
): string {
  const name = userName || "there";
  const messageCount = messages.length;
  const daySummaries = summaries ?? [];

  const messagesSummary =
    messages.length > 0 || daySummaries.length > 0
      ? buildDayTimeline(messages, daySummaries)
      : "No messages today";

  const factsSummary =
    facts.length > 0
      ? facts.map((f) => `- ${f.content}`).join("\n")
      : "None";

  const startOfToday = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  })();

  const activeGoals = goals.filter((g) => !g.completed);
  const completedToday = goals.filter(
    (g) => g.completed && g.completed_at && new Date(g.completed_at) >= startOfToday
  );

  const activeGoalsSummary =
    activeGoals.length > 0
      ? activeGoals
          .map((g) => `- ${g.content}${g.deadline ? ` (due ${g.deadline})` : ""}`)
          .join("\n")
      : "None";

  const completedSummary =
    completedToday.length > 0
      ? completedToday.map((g) => `- ${g.content}`).join("\n")
      : "None";

  const dayQuality =
    messageCount > 10 ? "productive" : messageCount > 0 ? "light" : "quiet";

  return `You are ${name}'s personal evening reflection assistant. It is 11 PM Singapore time.

${name} had a ${dayQuality} day (${messageCount} messages).

## Today's Conversations
${messagesSummary}

## New Knowledge Gained Today
${factsSummary}

## Active Goals
${activeGoalsSummary}

## Goals Completed Today
${completedSummary}

---

Write a detailed, motivational daily reflection for ${name} in Markdown format.
Structure your reflection with these sections:

### ✅ Key Accomplishments
List 3-5 specific things ${name} accomplished or made progress on today. Be specific and celebratory. Reference actual content from conversations where possible.

### 🎯 Goal Progress
Analyse each active goal. Note any forward momentum, even small steps. Be encouraging and constructive.

### 💡 Insights & Learnings
2-3 meaningful insights from today's conversations or activities. What patterns or breakthroughs emerged?

### 🔥 Tomorrow's Focus
Top 3 concrete, actionable priorities for tomorrow. Make them specific and achievable, building on today's momentum.

### 💪 Keep Going
End with a 2-3 sentence motivational message personalised to ${name}'s situation. Acknowledge today's efforts and energise them for tomorrow.

Guidelines:
- Use Markdown formatting throughout (headers, bullet points, **bold** for emphasis)
- Be specific — reference actual topics from today's conversations
- Maintain a warm, encouraging, coach-like tone throughout
- If the day was quiet, focus on rest and tomorrow's potential
- Total length: 400-600 words`;
}

/**
 * Format the final night summary message.
 * Pure function — no side effects, no I/O.
 */
export function formatSummary(
  dateStr: string,
  messageCount: number,
  factCount: number,
  analysis: string
): string {
  const lines: string[] = [];

  lines.push(`🌙 **Night Review — ${dateStr}**`);
  lines.push(`*(${messageCount} messages, ${factCount} facts learned today)*`);
  lines.push("");
  lines.push(analysis);
  lines.push("");
  lines.push("---");
  lines.push("*Powered by Claude Haiku. Reply to reflect further.*");

  return lines.join("\n");
}

/**
 * Attempt to generate a reflection using Claude, falling back to Ollama.
 * Returns the analysis text and which provider succeeded (or null if both failed).
 */
export async function analyzeWithProviders(
  prompt: string,
  providers: {
    claude: (p: string) => Promise<string>;
    ollama: (p: string) => Promise<string>;
  }
): Promise<AnalysisResult> {
  try {
    const text = await providers.ollama(prompt);
    console.log("[night-summary] Ollama succeeded");
    return { text, provider: "ollama" };
  } catch (ollamaError) {
    console.warn("[night-summary] Ollama failed, falling back to Haiku:", ollamaError instanceof Error ? ollamaError.message : ollamaError);
    try {
      const text = await providers.claude(prompt);
      console.log("[night-summary] Haiku fallback succeeded");
      return { text, provider: "claude" };
    } catch (claudeError) {
      console.error("[night-summary] Both Ollama and Haiku failed:");
      console.error("  Ollama:", ollamaError);
      console.error("  Claude:", claudeError);
      return {
        text: "Day review unavailable — both Ollama and Claude are offline.",
        provider: null,
      };
    }
  }
}

// ============================================================
// DATA FETCHERS
// ============================================================

function startOfToday(): string {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.toISOString();
}

async function getTodaysMessages(): Promise<DayMessage[]> {
  try {
    const { getDb } = await import("../src/local/db");
    const db = getDb();
    return db.query(
      "SELECT content, role, created_at, agent_id FROM messages WHERE created_at >= ? ORDER BY created_at ASC"
    ).all(startOfToday()) as DayMessage[];
  } catch (error) {
    console.error("Error fetching messages:", error);
    return [];
  }
}

async function getTodaysConversationSummaries(): Promise<DaySummary[]> {
  try {
    const { getDb } = await import("../src/local/db");
    const db = getDb();
    return db.query(
      "SELECT summary, message_count, from_timestamp, to_timestamp, chat_id FROM conversation_summaries WHERE to_timestamp >= ? ORDER BY from_timestamp ASC"
    ).all(startOfToday()) as DaySummary[];
  } catch (error) {
    console.error("Error fetching conversation summaries:", error);
    return [];
  }
}

async function getTodaysFacts(): Promise<DayFact[]> {
  try {
    const { getDb } = await import("../src/local/db");
    const db = getDb();
    return db.query(
      "SELECT content, created_at FROM memory WHERE type = 'fact' AND created_at >= ? ORDER BY created_at ASC"
    ).all(startOfToday()) as DayFact[];
  } catch (error) {
    console.error("Error fetching facts:", error);
    return [];
  }
}

async function getActiveGoals(): Promise<DayGoal[]> {
  try {
    const { getDb } = await import("../src/local/db");
    const db = getDb();
    const rows = db.query(
      "SELECT content, deadline, created_at FROM memory WHERE type = 'goal' AND status = 'active' ORDER BY created_at DESC LIMIT 10"
    ).all() as { content: string; deadline: string | null; created_at: string }[];

    return rows.map((row) => {
      try {
        const parsed = JSON.parse(row.content);
        return {
          content: parsed.goal_text || parsed.text || row.content,
          deadline: parsed.deadline || row.deadline,
          completed: false,
          completed_at: undefined,
        };
      } catch {
        return {
          content: row.content,
          deadline: row.deadline,
          completed: false,
        };
      }
    });
  } catch (error) {
    console.error("Error fetching goals:", error);
    return [];
  }
}

// ============================================================
// ANALYSIS
// ============================================================

async function analyzeDay(
  messages: DayMessage[],
  facts: DayFact[],
  goals: DayGoal[],
  summaries: DaySummary[]
): Promise<AnalysisResult> {
  const prompt = buildReflectionPrompt(messages, facts, goals, USER_NAME, summaries);

  return analyzeWithProviders(prompt, {
    claude: (p) => runPrompt(p, { model: CLAUDE_MODEL, timeoutMs: CLAUDE_TIMEOUT_MS }),
    ollama: (p: string) => callRoutineModel(p, { label: "night-summary" }),
  });
}

// ============================================================
// BUILD SUMMARY
// ============================================================

async function buildSummary(): Promise<{ summary: string; provider: "claude" | "ollama" | null }> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: USER_TIMEZONE,
  });

  const [messages, facts, goals, summaries] = await Promise.all([
    getTodaysMessages(),
    getTodaysFacts(),
    getActiveGoals(),
    getTodaysConversationSummaries(),
  ]);

  const result = await analyzeDay(messages, facts, goals, summaries);
  const summary = formatSummary(dateStr, messages.length, facts.length, result.text);

  return { summary, provider: result.provider };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running Night Summary (Claude Haiku, Ollama fallback)...");

  if (shouldSkipRecently(LAST_RUN_FILE, 2)) {
    console.log("[night-summary] Already ran within the last 2 hours, skipping.");
    process.exit(0);
  }

  if (!validateGroup("GENERAL")) {
    console.error("Cannot run — GENERAL group not configured");
    console.error("Set chatId for the 'GENERAL' agent in config/agents.json");
    process.exit(0); // graceful skip — PM2 will retry on next cron cycle
  }

  const { summary, provider } = await buildSummary();

  if (provider === null) {
    const failureMessage =
      "⚠️ **Night summary unavailable**\n\n" +
      "Both Claude and Ollama are offline right now.\n" +
      "- Claude: check that the Claude CLI is installed and authenticated\n" +
      "- Ollama: start it with `ollama serve`\n\n" +
      "Your day was still great — pick this up tomorrow! 🌟";

    await sendAndRecord(GROUPS.GENERAL.chatId, failureMessage, {
      routineName: "night-summary",
      agentId: "general-assistant",
      topicId: GROUPS.GENERAL.topicId,
    });
    markRanToday(LAST_RUN_FILE); // failure message sent — mark ran to prevent duplicate sends
    console.error("Night summary failed — both providers unavailable");
    process.exit(0); // failure message already sent to Telegram; exit 0 prevents PM2 restart loop
  }

  await sendAndRecord(GROUPS.GENERAL.chatId, summary, {
    routineName: "night-summary",
    agentId: "general-assistant",
    topicId: GROUPS.GENERAL.topicId,
  });
  markRanToday(LAST_RUN_FILE);
  console.log(`Night summary sent to General group (via ${provider})`);
}

// PM2's bun container uses require() internally, which sets import.meta.main = false.
// Fall back to pm_exec_path to detect when PM2 is the entry runner.
const _isEntry =
  import.meta.main ||
  process.env.pm_exec_path === import.meta.url?.replace("file://", "");

if (_isEntry) {
  main().catch(async (error) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Error running night summary:", error);
    try {
      await sendToGroup(GROUPS.GENERAL.chatId, `⚠️ night-summary failed:\n\n${msg}`);
    } catch { /* ignore secondary failure */ }
    process.exit(0); // exit 0 so PM2 does not immediately restart — next run at scheduled cron time
  });
}
