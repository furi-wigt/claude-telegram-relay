#!/usr/bin/env bun

/**
 * @routine night-summary
 * @description Evening summary of the day's activities and tomorrow's priorities
 * @schedule 0 23 * * *
 * @target Personal chat
 */

/**
 * Night Summary Routine (Local LLM only — MLX / Qwen3.5-9B)
 *
 * Schedule: 11:00 PM daily (SGT)
 * Target: General AI Assistant group
 *
 * Pulls the day's messages, facts, and goals from local SQLite, then uses
 * local MLX (Qwen3.5-9B) to generate a detailed, motivational day-end
 * reflection formatted in Markdown. Notifies the user if the local LLM fails.
 *
 * Run manually: bun run routines/night-summary.ts
 */

import { join } from "path";
import { callRoutineModel } from "../src/routines/routineModel.ts";
import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { sendToGroup } from "../src/utils/sendToGroup.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";

/**
 * Priority: NIGHT_SUMMARY_GROUP env var → OPERATIONS → first configured group.
 */
function resolveNightGroupKey(): string | undefined {
  for (const key of [
    process.env.NIGHT_SUMMARY_GROUP,
    "OPERATIONS",
    Object.keys(GROUPS).find((k) => (GROUPS[k]?.chatId ?? 0) !== 0),
  ]) {
    if (key && (GROUPS[key]?.chatId ?? 0) !== 0) return key;
  }
  return undefined;
}

const NIGHT_GROUP_KEY = resolveNightGroupKey();
import { USER_NAME, USER_TIMEZONE } from "../src/config/userConfig.ts";
import { shouldSkipRecently, markRanToday } from "../src/routines/runOnceGuard.ts";
import { getPm2LogsDir } from "../config/observability.ts";
import { initRegistry } from "../src/models/index.ts";
import { getTodaySessionsWithMessages } from "../src/memory/sessionGrouper.ts";
import { detectCorrections } from "../src/memory/correctionDetector.ts";
import {
  buildLearningFromCorrection,
  buildExtractionPrompt,
  parseLLMExtractions,
  llmExtractionsToLearnings,
  type LearningCandidate,
} from "../src/memory/learningExtractor.ts";
import { insertMemoryRecord } from "../src/local/storageBackend.ts";
import { checkSemanticDuplicate } from "../src/utils/semanticDuplicateChecker.ts";

const LAST_RUN_FILE = join(getPm2LogsDir(), "night-summary.lastrun");

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

export interface QaPair {
  time: string;           // ISO timestamp of the user question
  question: string;       // user message content (truncated at 600 chars)
  answer: string;         // assistant response content (truncated at 800 chars)
  agent?: string | null;  // which agent handled this exchange
}

export interface AnalysisResult {
  text: string;
  provider: "local" | null;
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
 * Pair user messages with the immediately following assistant response.
 * Produces one QaPair per user turn. An orphaned user message with no
 * assistant follow-up is included with answer="(no response yet)".
 * Pure function — O(n) on messages, no side effects.
 */
export function buildQaPairs(messages: DayMessage[]): QaPair[] {
  const pairs: QaPair[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user") continue;

    const next = messages[i + 1];
    const answer =
      next?.role === "assistant"
        ? next.content.substring(0, 800)
        : "(no response yet)";

    pairs.push({
      time: msg.created_at,
      question: msg.content.substring(0, 600),
      answer,
      agent: msg.agent_id ?? next?.agent_id,
    });

    // skip the assistant turn so we don't re-pair it
    if (next?.role === "assistant") i++;
  }
  return pairs;
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

  const qaPairs = buildQaPairs(messages);
  const qaSummary =
    qaPairs.length > 0
      ? qaPairs
          .map((p, idx) => {
            const time = formatTime(p.time);
            const agent = p.agent ? ` [${p.agent}]` : "";
            return `Q${idx + 1} [${time}]${agent}:\n  User: ${p.question}\n  Assistant: ${p.answer}`;
          })
          .join("\n\n")
      : "No Q&A sessions today";

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

## Today's Q&A Sessions (Full Detail)
${qaSummary}

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

### 📚 Today's Learning Lessons
This is the most important section. Analyse the Q&A sessions above and extract 4-6 concrete, specific lessons.
For each lesson:
- **Topic**: Name the concept or skill (e.g. "SQLite WAL mode", "PM2 bun entrypoint fix")
- **What was learned**: The specific insight or answer discovered in today's conversation
- **Why it matters**: Practical implication — when and why to apply this
- **Takeaway**: One-line actionable rule (e.g. "Always use _isEntry, not import.meta.main, under PM2")

If there were no Q&A sessions today, write one reflection lesson from any conversation or activity.
Ground every lesson in actual exchanges — no generic observations.

### 🔥 Tomorrow's Focus
Top 3 concrete, actionable priorities for tomorrow. Make them specific and achievable, building on today's momentum.

### 💪 Keep Going
End with a 2-3 sentence motivational message personalised to ${name}'s situation. Acknowledge today's efforts and energise them for tomorrow.

Guidelines:
- Use Markdown formatting throughout (headers, bullet points, **bold** for emphasis)
- Be specific — reference actual topics and exchanges from today
- Maintain a warm, encouraging, coach-like tone throughout
- If the day was quiet, focus on rest and tomorrow's potential
- Total length: 500-700 words`;
}

/**
 * Format the final night summary message.
 * Pure function — no side effects, no I/O.
 */
export function formatSummary(
  dateStr: string,
  messageCount: number,
  factCount: number,
  analysis: string,
  provider: "local" | null = null
): string {
  const lines: string[] = [];

  lines.push(`🌙 **Night Review — ${dateStr}**`);
  lines.push(`*(${messageCount} messages, ${factCount} facts learned today)*`);
  lines.push("");
  lines.push(analysis);
  lines.push("");
  lines.push("---");

  const providerLabel = provider === "local" ? "Local LLM" : "Unknown";
  lines.push(`*Powered by ${providerLabel}. Reply to reflect further.*`);

  return lines.join("\n");
}

/**
 * Generate a reflection using the local MLX server.
 * Returns the analysis text and provider ("local" or null on failure).
 */
export async function analyzeWithLocalLLM(
  prompt: string,
  generate: (p: string) => Promise<string>
): Promise<AnalysisResult> {
  try {
    const text = await generate(prompt);
    console.log("[night-summary] Local LLM succeeded");
    return { text, provider: "local" };
  } catch (error) {
    console.error("[night-summary] Local LLM failed:", error instanceof Error ? error.message : error);
    return {
      text: "Day review unavailable — MLX server is offline. Check that `mlx serve` is running.",
      provider: null,
    };
  }
}

/**
 * Format captured learnings into a summary section for the night summary message.
 * Pure function — no side effects.
 */
export function buildLearningsSummarySection(
  learnings: Array<{ content: string; category: string; confidence: number }>
): string {
  if (learnings.length === 0) return "";

  const lines = [
    "",
    "---",
    "",
    "**Learnings Captured Today**",
    "",
  ];

  for (const l of learnings) {
    lines.push(`- [${l.category}] ${l.content} *(confidence: ${l.confidence.toFixed(2)})*`);
  }

  return lines.join("\n");
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

  // 60s chunk timeout: analyzeDay fires at 23:00 alongside smart-checkin.
  // If MLX is busy serving another request, the first keepalive may arrive
  // up to ~45s late — 60s gives headroom without masking real hangs.
  return analyzeWithLocalLLM(prompt, (p) =>
    callRoutineModel(p, { label: "night-summary", maxTokens: 4096, timeoutMs: 300_000, chunkTimeoutMs: 60_000 })
  );
}

// ============================================================
// LEARNING EXTRACTION
// ============================================================

/**
 * Run learning extraction on today's sessions.
 * Detects corrections, stores learning entries, returns summary for night message.
 */
async function extractTodaysLearnings(): Promise<
  Array<{ content: string; category: string; confidence: number }>
> {
  try {
    const sessionsWithMessages = await getTodaySessionsWithMessages();
    const stored: Array<{ content: string; category: string; confidence: number }> = [];

    for (const { session, messages } of sessionsWithMessages) {
      // 1. Detect correction pairs
      const corrections = detectCorrections(messages);
      if (corrections.length === 0) continue;

      // 2. Build direct learnings from each correction pair
      for (const pair of corrections) {
        const learning = buildLearningFromCorrection(pair, session);

        // Dedup check
        const dup = await checkSemanticDuplicate(learning.content, "learning", session.chatId);
        if (dup.isDuplicate) {
          console.log(`[night-summary] Skipping duplicate learning: "${learning.content.substring(0, 60)}"`);
          continue;
        }

        await insertMemoryRecord({
          type: learning.type,
          content: learning.content,
          chat_id: session.chatId,
          thread_id: session.threadId,
          category: learning.category,
          confidence: learning.confidence,
          importance: learning.importance,
          stability: learning.stability,
        });

        stored.push({
          content: learning.content,
          category: learning.category,
          confidence: learning.confidence,
        });
      }

      // 3. Optional: LLM synthesis for generalized rules (if 2+ corrections in session)
      if (corrections.length >= 2) {
        try {
          const prompt = buildExtractionPrompt(corrections, session.agentId);
          const raw = await callRoutineModel(prompt, {
            label: "night-summary-learning",
            maxTokens: 1024,
          });
          const extractions = parseLLMExtractions(raw);
          const correctionIds = corrections.flatMap((c) => [
            c.assistant_message_id,
            c.user_correction_id,
          ]);
          const llmLearnings = llmExtractionsToLearnings(extractions, session, correctionIds);

          for (const learning of llmLearnings) {
            const dup = await checkSemanticDuplicate(learning.content, "learning", session.chatId);
            if (dup.isDuplicate) continue;

            await insertMemoryRecord({
              type: learning.type,
              content: learning.content,
              chat_id: session.chatId,
              thread_id: session.threadId,
              category: learning.category,
              confidence: learning.confidence,
              importance: learning.importance,
              stability: learning.stability,
            });

            stored.push({
              content: learning.content,
              category: learning.category,
              confidence: learning.confidence,
            });
          }
        } catch (err) {
          console.error("[night-summary] LLM extraction failed:", err instanceof Error ? err.message : err);
        }
      }
    }

    console.log(`[night-summary] Captured ${stored.length} learnings from ${sessionsWithMessages.length} sessions`);
    return stored;
  } catch (err) {
    console.error("[night-summary] Learning extraction failed:", err);
    return [];
  }
}

// ============================================================
// BUILD SUMMARY
// ============================================================

async function buildSummary(): Promise<{ summary: string; provider: "local" | null }> {
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

  // Extract learnings from today's sessions (correction pairs → memory)
  const learnings = await extractTodaysLearnings();
  const learningSection = buildLearningsSummarySection(learnings);

  const summary = formatSummary(dateStr, messages.length, facts.length, result.text, result.provider) + learningSection;

  return { summary, provider: result.provider };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running Night Summary (Model Registry)...");

  // Initialize model registry for standalone routine execution
  initRegistry();

  if (shouldSkipRecently(LAST_RUN_FILE, 2)) {
    console.log("[night-summary] Already ran within the last 2 hours, skipping.");
    process.exit(0);
  }

  if (!NIGHT_GROUP_KEY) {
    console.error("Cannot run — no group configured");
    console.error("Set NIGHT_SUMMARY_GROUP env var or ensure at least one agent has a chatId in agents.json");
    process.exit(0); // graceful skip — PM2 will retry on next cron cycle
  }
  const NIGHT_GROUP = GROUPS[NIGHT_GROUP_KEY];
  console.log(`[night-summary] Sending to group: ${NIGHT_GROUP_KEY}`);

  const { summary, provider } = await buildSummary();

  if (provider === null) {
    const failureMessage =
      "⚠️ **Night summary unavailable**\n\n" +
      "Local LLM (MLX) is offline.\n" +
      "Check that `mlx serve` is running.\n\n" +
      "Your day was still great — pick this up tomorrow! 🌟";

    await sendAndRecord(NIGHT_GROUP.chatId, failureMessage, {
      routineName: "night-summary",
      agentId: "general-assistant",
      topicId: NIGHT_GROUP.topicId,
    });
    markRanToday(LAST_RUN_FILE);
    console.error("Night summary failed — local LLM unavailable");
    process.exit(0); // failure message already sent to Telegram; exit 0 prevents PM2 restart loop
  }

  await sendAndRecord(NIGHT_GROUP.chatId, summary, {
    routineName: "night-summary",
    agentId: "general-assistant",
    topicId: NIGHT_GROUP.topicId,
  });
  markRanToday(LAST_RUN_FILE);
  console.log(`Night summary sent to ${NIGHT_GROUP_KEY} group (via ${provider})`);
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
      await sendToGroup((NIGHT_GROUP_KEY ? GROUPS[NIGHT_GROUP_KEY]?.chatId : undefined) ?? 0, `⚠️ night-summary failed:\n\n${msg}`);
    } catch { /* ignore secondary failure */ }
    process.exit(0); // exit 0 so PM2 does not immediately restart — next run at scheduled cron time
  });
}
