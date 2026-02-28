#!/usr/bin/env bun

/**
 * @routine night-summary
 * @description Evening summary of the day's activities and tomorrow's priorities
 * @schedule 0 23 * * *
 * @target Personal chat
 */

/**
 * Night Summary Routine (Claude Haiku-powered, Ollama fallback)
 *
 * Schedule: 11:00 PM daily (SGT)
 * Target: General AI Assistant group
 *
 * Pulls the day's messages, facts, and goals from Supabase, then uses
 * Claude Haiku to generate a detailed, motivational day-end reflection
 * formatted in Markdown. Falls back to Ollama when Claude is unavailable.
 * Notifies the user if both providers fail.
 *
 * Run manually: bun run routines/night-summary.ts
 */

import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import { runPrompt } from "../integrations/claude/index.ts";
import { callOllama } from "../src/fallback.ts";
import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";
import { USER_NAME, USER_TIMEZONE } from "../src/config/userConfig.ts";
import { shouldSkipToday, markRanToday } from "../src/routines/runOnceGuard.ts";

const LAST_RUN_FILE = join(import.meta.dir, "../logs/night-summary.lastrun");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

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
    const text = await providers.claude(prompt);
    return { text, provider: "claude" };
  } catch (claudeError) {
    console.warn("Claude unavailable, trying Ollama:", claudeError);
    try {
      const text = await providers.ollama(prompt);
      return { text, provider: "ollama" };
    } catch (ollamaError) {
      console.error("Both Claude and Ollama failed:");
      console.error("  Claude:", claudeError);
      console.error("  Ollama:", ollamaError);
      return {
        text: "Day review unavailable — both Claude and Ollama are offline.",
        provider: null,
      };
    }
  }
}

// ============================================================
// DATA FETCHERS
// ============================================================

function getSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

function startOfToday(): string {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.toISOString();
}

async function getTodaysMessages(): Promise<DayMessage[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("messages")
    .select("content, role, created_at, agent_id")
    .gte("created_at", startOfToday())
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error fetching messages:", error.message);
    return [];
  }
  return data || [];
}

async function getTodaysConversationSummaries(): Promise<DaySummary[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("conversation_summaries")
    .select("summary, message_count, from_timestamp, to_timestamp, chat_id")
    .gte("to_timestamp", startOfToday())
    .order("from_timestamp", { ascending: true });

  if (error) {
    console.error("Error fetching conversation summaries:", error.message);
    return [];
  }
  return data || [];
}

async function getTodaysFacts(): Promise<DayFact[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("memory")
    .select("content, created_at")
    .eq("type", "fact")
    .gte("created_at", startOfToday())
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error fetching facts:", error.message);
    return [];
  }
  return data || [];
}

async function getActiveGoals(): Promise<DayGoal[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("memory")
    .select("content, deadline, created_at")
    .eq("type", "goal")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    console.error("Error fetching goals:", error.message);
    return [];
  }

  return (data || []).map((row) => {
    try {
      const parsed = JSON.parse(row.content);
      return {
        content: parsed.goal_text || parsed.text || row.content,
        deadline: parsed.deadline || row.deadline,
        completed: parsed.completed || false,
        completed_at: parsed.completed_at,
      };
    } catch {
      return {
        content: row.content,
        deadline: row.deadline,
        completed: false,
      };
    }
  });
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
    ollama: callOllama,
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

  if (shouldSkipToday(LAST_RUN_FILE)) {
    console.log("[night-summary] Already ran today, skipping.");
    process.exit(0);
  }

  if (!validateGroup("GENERAL")) {
    console.error("Cannot run — GENERAL group not configured");
    console.error("Set chatId for the 'GENERAL' agent in config/agents.json");
    process.exit(0); // graceful skip — PM2 will retry on next cron cycle
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env");
    process.exit(0); // graceful skip — retrying immediately won't fix missing config
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
  main().catch((error) => {
    console.error("Error running night summary:", error);
    process.exit(0); // exit 0 so PM2 does not immediately restart — next run at scheduled cron time
  });
}
