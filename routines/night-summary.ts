#!/usr/bin/env bun

/**
 * @routine night-summary
 * @description Evening summary of the day's activities and tomorrow's priorities
 * @schedule 0 23 * * *
 * @target Personal chat
 */

/**
 * Night Summary Routine (Ollama-powered)
 *
 * Schedule: 11:00 PM daily (SGT)
 * Target: General AI Assistant group
 *
 * Pulls the day's messages, facts, and goals from Supabase, then
 * uses local Ollama to generate a structured day-end reflection.
 * Ollama keeps this routine free and offline-capable.
 *
 * Run manually: bun run routines/night-summary.ts
 */

import { createClient } from "@supabase/supabase-js";
import { callOllama } from "../src/fallback.ts";
import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || "Asia/Singapore";

// ============================================================
// DATA FETCHERS
// ============================================================

interface DayMessage {
  content: string;
  role: "user" | "assistant";
  created_at: string;
}

interface DayFact {
  content: string;
  created_at: string;
}

interface DayGoal {
  content: string;
  deadline?: string;
  completed: boolean;
  completed_at?: string;
}

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
    .select("content, role, created_at")
    .gte("created_at", startOfToday())
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error fetching messages:", error.message);
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
// OLLAMA ANALYSIS
// ============================================================

async function analyzeDay(
  messages: DayMessage[],
  facts: DayFact[],
  goals: DayGoal[]
): Promise<string> {
  const messagesSummary =
    messages.length > 0
      ? messages
          .slice(-30) // Last 30 messages max to fit context
          .map((m) => `[${m.role}]: ${m.content.substring(0, 150)}`)
          .join("\n")
      : "No messages today";

  const factsSummary =
    facts.length > 0
      ? facts.map((f) => `- ${f.content}`).join("\n")
      : "None";

  const activeGoals = goals.filter((g) => !g.completed);
  const completedToday = goals.filter(
    (g) => g.completed && g.completed_at && new Date(g.completed_at) >= new Date(startOfToday())
  );

  const goalsSummary =
    activeGoals.length > 0
      ? activeGoals.map((g) => `- ${g.content}`).join("\n")
      : "None";

  const completedSummary =
    completedToday.length > 0
      ? completedToday.map((g) => `- ${g.content}`).join("\n")
      : "None";

  const prompt = `You are reviewing Furi's day. It is 11 PM Singapore time.

Today's conversations (${messages.length} messages):
${messagesSummary}

New facts learned today:
${factsSummary}

Active goals:
${goalsSummary}

Goals completed today:
${completedSummary}

Write a concise nightly reflection with these sections:

1. Key Accomplishments - What got done today (2-3 bullet points)
2. Goal Progress - Status update on active goals
3. Insights - What was learned or discovered (1-2 points)
4. Tomorrow's Focus - Top 3 priorities for tomorrow

Keep it concise and actionable. If the day was light, be brief and encouraging.
Do not use markdown headers, just use the section names followed by a colon.
Keep the total response under 300 words.`;

  try {
    const response = await callOllama(prompt);
    return response;
  } catch (error) {
    console.error("Ollama analysis failed:", error);
    return "Day review unavailable — Ollama is not running. Start it with: ollama serve";
  }
}

// ============================================================
// BUILD SUMMARY
// ============================================================

async function buildSummary(): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: USER_TIMEZONE,
  });

  const [messages, facts, goals] = await Promise.all([
    getTodaysMessages(),
    getTodaysFacts(),
    getActiveGoals(),
  ]);

  const lines: string[] = [];

  lines.push(`Night Review — ${dateStr}`);
  lines.push(`(${messages.length} messages, ${facts.length} facts learned today)`);
  lines.push("");

  const analysis = await analyzeDay(messages, facts, goals);
  lines.push(analysis);

  lines.push("");
  lines.push("---");
  lines.push("Powered by local Ollama. Reply to reflect further.");

  return lines.join("\n");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running Night Summary (Ollama)...");

  if (!validateGroup("GENERAL")) {
    console.error("Cannot run — GENERAL group not configured in .env");
    console.error("Set GROUP_GENERAL_CHAT_ID in your .env file");
    process.exit(1);
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env");
    process.exit(1);
  }

  const summary = await buildSummary();
  await sendAndRecord(GROUPS.GENERAL, summary, { routineName: 'night-summary', agentId: 'general-assistant' });
  console.log("Night summary sent to General group");
}

main().catch((error) => {
  console.error("Error running night summary:", error);
  process.exit(1);
});
