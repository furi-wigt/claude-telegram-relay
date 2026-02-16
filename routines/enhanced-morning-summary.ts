#!/usr/bin/env bun

/**
 * @routine enhanced-morning-summary
 * @description Daily morning briefing with news, weather, and goals summary
 * @schedule 0 7 * * *
 * @target Personal chat
 */

/**
 * Enhanced Morning Summary Routine
 *
 * Schedule: 7:00 AM daily (SGT)
 * Target: General AI Assistant group
 *
 * Features:
 * 1. Singapore weather data from NEA API
 * 2. Task suggestions based on yesterday's activities and current goals
 * 3. Daily devotional from Gmail (stub for now)
 * 4. Interactive task confirmation
 * 5. Time reminders for confirmed tasks
 *
 * Run manually: bun run routines/enhanced-morning-summary.ts
 */

import { createClient } from "@supabase/supabase-js";
import { sendToGroup } from "../src/utils/sendToGroup.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";
import { spawn } from "bun";
import { getSingaporeWeather2Hr, getSingaporeWeatherOpenMeteo } from "../src/utils/weather.ts";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const USER_NAME = process.env.USER_NAME || "there";
const USER_TIMEZONE = process.env.USER_TIMEZONE || "Asia/Singapore";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || "900000", 10);

// ============================================================
// TYPES
// ============================================================

interface WeatherData {
  summary: string;
  timestamp: string;
}

interface YesterdayActivity {
  messageCount: number;
  factsLearned: number;
  topicsDiscussed: string[];
  completedGoals: string[];
}

interface Goal {
  id: string;
  content: string;
  deadline?: string;
  priority?: "high" | "medium" | "low";
}

interface SuggestedTask {
  description: string;
  rationale: string;
  suggestedTime: string;
  estimatedDuration: number; // minutes
  relatedGoal?: string;
}

interface DevotionalContent {
  passage: string;
  reference: string;
  reflection: string;
}

// ============================================================
// WEATHER FETCHER (Singapore NEA API)
// ============================================================

async function getWeather(): Promise<WeatherData> {
  /**
   * Uses Singapore weather utilities with automatic fallback
   * 1. Tries NEA (data.gov.sg) first
   * 2. Falls back to Open-Meteo if needed
   */

  try {
    const weatherSummary = await getSingaporeWeather2Hr();
    return {
      summary: weatherSummary,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.warn("NEA API failed, trying Open-Meteo fallback:", error);

    try {
      const weatherSummary = await getSingaporeWeatherOpenMeteo();
      return {
        summary: weatherSummary,
        timestamp: new Date().toISOString(),
      };
    } catch (fallbackError) {
      console.error("All weather APIs failed:", fallbackError);
      return {
        summary: "Weather data unavailable",
        timestamp: new Date().toISOString(),
      };
    }
  }
}

// ============================================================
// YESTERDAY'S ACTIVITY
// ============================================================

async function getYesterdaysActivity(): Promise<YesterdayActivity> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return {
      messageCount: 0,
      factsLearned: 0,
      topicsDiscussed: [],
      completedGoals: [],
    };
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get message count and facts
    const [messagesResult, factsResult, goalsResult] = await Promise.all([
      supabase
        .from("messages")
        .select("id, content", { count: "exact" })
        .gte("created_at", yesterday.toISOString())
        .lt("created_at", today.toISOString()),
      supabase
        .from("memory")
        .select("id", { count: "exact", head: true })
        .eq("type", "fact")
        .gte("created_at", yesterday.toISOString())
        .lt("created_at", today.toISOString()),
      supabase
        .from("memory")
        .select("content")
        .eq("type", "goal")
        .eq("completed", true)
        .gte("completed_at", yesterday.toISOString())
        .lt("completed_at", today.toISOString()),
    ]);

    // Extract topics from messages (simple keyword extraction)
    const topics = extractTopicsFromMessages(messagesResult.data || []);

    return {
      messageCount: messagesResult.count || 0,
      factsLearned: factsResult.count || 0,
      topicsDiscussed: topics,
      completedGoals: goalsResult.data?.map((g: any) => g.content) || [],
    };
  } catch (error) {
    console.error("Error fetching yesterday's activity:", error);
    return {
      messageCount: 0,
      factsLearned: 0,
      topicsDiscussed: [],
      completedGoals: [],
    };
  }
}

function extractTopicsFromMessages(messages: any[]): string[] {
  // Simple topic extraction - can be enhanced with NLP
  const topics = new Set<string>();
  const keywords = ["project", "meeting", "code", "design", "deployment", "review", "testing"];

  messages.forEach((msg: any) => {
    const content = msg.content?.toLowerCase() || "";
    keywords.forEach((keyword) => {
      if (content.includes(keyword)) {
        topics.add(keyword);
      }
    });
  });

  return Array.from(topics);
}

// ============================================================
// ACTIVE GOALS
// ============================================================

async function getActiveGoals(): Promise<Goal[]> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return [];

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await supabase
      .from("memory")
      .select("id, content, deadline, metadata")
      .eq("type", "goal")
      .is("completed", null)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error || !data?.length) return [];

    return data.map((g: any) => ({
      id: g.id,
      content: g.content,
      deadline: g.deadline,
      priority: g.metadata?.priority || "medium",
    }));
  } catch (error) {
    console.error("Error fetching goals:", error);
    return [];
  }
}

// ============================================================
// CLAUDE HELPER
// ============================================================

async function callClaude(prompt: string): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt, "--output-format", "text"];

  console.log(`Calling Claude for task suggestions...`);

  try {
    // Remove CLAUDECODE to prevent nested session detection
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: env,
    });

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
      return "";
    }

    return output.trim();
  } catch (error) {
    console.error("Claude call error:", error);
    return "";
  }
}

// ============================================================
// TASK SUGGESTION ENGINE (AI-Powered)
// ============================================================

async function suggestTasks(
  activity: YesterdayActivity,
  goals: Goal[]
): Promise<SuggestedTask[]> {
  // Build context for Claude
  const context = {
    user: USER_NAME,
    timezone: USER_TIMEZONE,
    yesterday: {
      messageCount: activity.messageCount,
      factsLearned: activity.factsLearned,
      topicsDiscussed: activity.topicsDiscussed,
      completedGoals: activity.completedGoals,
    },
    activeGoals: goals.map(g => ({
      content: g.content,
      deadline: g.deadline,
      priority: g.priority,
      daysUntilDeadline: g.deadline
        ? Math.ceil((new Date(g.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : null,
    })),
    currentTime: new Date().toISOString(),
  };

  const prompt = `You are a personal task planner. Based on the user's context below, suggest 3-5 actionable tasks for today.

Context:
${JSON.stringify(context, null, 2)}

Requirements:
1. Prioritize urgent goals (deadlines within 3 days)
2. Consider yesterday's activity and topics
3. Include high-priority goals
4. Suggest realistic time slots (08:00 - 18:00)
5. Estimate duration in minutes (15-120 range)
6. Provide clear rationale for each task

Output ONLY valid JSON array in this exact format:
[
  {
    "description": "Task description",
    "rationale": "Why this task is important",
    "suggestedTime": "HH:MM",
    "estimatedDuration": 60,
    "relatedGoal": "goal-id or null"
  }
]

Do not include any explanation, markdown formatting, or extra text. Just the JSON array.`;

  try {
    const response = await callClaude(prompt);

    if (!response) {
      console.warn("Claude returned empty response, using fallback");
      return getFallbackTasks(activity, goals);
    }

    // Strip markdown code fences if present (```json ... ``` or ``` ... ```)
    let jsonText = response.trim();
    if (jsonText.startsWith('```')) {
      // Remove opening ``` and optional language identifier
      jsonText = jsonText.replace(/^```(?:json)?\n?/, '');
      // Remove closing ```
      jsonText = jsonText.replace(/\n?```$/, '');
    }

    // Try to parse Claude's response
    const tasks = JSON.parse(jsonText);

    if (!Array.isArray(tasks)) {
      console.warn("Claude response is not an array, using fallback");
      return getFallbackTasks(activity, goals);
    }

    // Validate and transform tasks
    const validatedTasks: SuggestedTask[] = tasks
      .filter((t: any) =>
        t.description &&
        t.rationale &&
        t.suggestedTime &&
        typeof t.estimatedDuration === 'number'
      )
      .map((t: any) => ({
        description: t.description,
        rationale: t.rationale,
        suggestedTime: t.suggestedTime,
        estimatedDuration: t.estimatedDuration,
        relatedGoal: t.relatedGoal || undefined,
      }));

    if (validatedTasks.length === 0) {
      console.warn("No valid tasks from Claude, using fallback");
      return getFallbackTasks(activity, goals);
    }

    console.log(`✓ Generated ${validatedTasks.length} AI-powered task suggestions`);
    return validatedTasks;

  } catch (error) {
    console.error("Error parsing Claude response:", error);
    console.warn("Using fallback task suggestions");
    return getFallbackTasks(activity, goals);
  }
}

// Fallback task generation (simple heuristics)
function getFallbackTasks(
  activity: YesterdayActivity,
  goals: Goal[]
): SuggestedTask[] {
  const tasks: SuggestedTask[] = [];

  // Urgent goals
  const urgentGoals = goals.filter((g) => {
    if (!g.deadline) return false;
    const daysUntil = Math.ceil((new Date(g.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    return daysUntil <= 3 && daysUntil >= 0;
  });

  urgentGoals.forEach((goal) => {
    tasks.push({
      description: `Work on: ${goal.content}`,
      rationale: `Deadline approaching (${new Date(goal.deadline!).toLocaleDateString()})`,
      suggestedTime: "09:00",
      estimatedDuration: 120,
      relatedGoal: goal.id,
    });
  });

  // High-priority goals
  const highPriorityGoals = goals.filter((g) => g.priority === "high");
  highPriorityGoals.slice(0, 2).forEach((goal) => {
    tasks.push({
      description: `High priority: ${goal.content}`,
      rationale: "Marked as high priority",
      suggestedTime: "11:00",
      estimatedDuration: 90,
      relatedGoal: goal.id,
    });
  });

  // Default routine task
  tasks.push({
    description: "Review and respond to messages",
    rationale: "Daily routine",
    suggestedTime: "08:00",
    estimatedDuration: 30,
  });

  return tasks.sort((a, b) => a.suggestedTime.localeCompare(b.suggestedTime));
}

// ============================================================
// GMAIL DEVOTIONAL READER (STUB)
// ============================================================

async function getDailyDevotional(): Promise<DevotionalContent | null> {
  /**
   * STUB: Gmail connector to be implemented
   *
   * Future implementation:
   * 1. Connect to Gmail API using MCP or direct API
   * 2. Search for emails with subject "Daily Devotional" or from specific sender
   * 3. Extract passage, reference, and reflection from email body
   * 4. Parse and structure the content
   *
   * For now, returning a placeholder structure
   */

  // TODO: Implement Gmail API connector
  // const gmail = await connectToGmail("furi.karnapi@gmail.com");
  // const devotional = await gmail.searchEmails({
  //   from: "devotional@example.com",
  //   subject: "Daily Devotional",
  //   after: new Date().toISOString().split("T")[0]
  // });

  return {
    passage: "[Devotional passage will be fetched from Gmail]",
    reference: "Placeholder Reference",
    reflection: "[Devotional reflection will be fetched from Gmail]",
  };
}

// ============================================================
// BUILD ENHANCED BRIEFING
// ============================================================

async function buildEnhancedBriefing(): Promise<{
  message: string;
  tasks: SuggestedTask[];
}> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: USER_TIMEZONE,
  });

  const [weather, goals, activity, devotional] = await Promise.all([
    getWeather(),
    getActiveGoals(),
    getYesterdaysActivity(),
    getDailyDevotional(),
  ]);

  const suggestedTasks = await suggestTasks(activity, goals);

  const lines: string[] = [];

  // Header
  lines.push(`🌅 Good morning ${USER_NAME}!`);
  lines.push(`${dateStr}`);
  lines.push("");

  // Weather
  lines.push(`🌤️ **Weather (Singapore)**`);
  lines.push(weather.summary);
  lines.push("");

  // Yesterday's recap
  if (activity.messageCount > 0 || activity.completedGoals.length > 0) {
    lines.push(`📊 **Yesterday's Recap**`);
    lines.push(`- ${activity.messageCount} messages exchanged`);
    lines.push(`- ${activity.factsLearned} new facts learned`);

    if (activity.topicsDiscussed.length > 0) {
      lines.push(`- Topics: ${activity.topicsDiscussed.join(", ")}`);
    }

    if (activity.completedGoals.length > 0) {
      lines.push(`- ✅ Completed: ${activity.completedGoals.join(", ")}`);
    }
    lines.push("");
  }

  // Active goals
  if (goals.length > 0) {
    lines.push(`🎯 **Active Goals**`);
    goals.slice(0, 5).forEach((g) => {
      const deadline = g.deadline
        ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
        : "";
      const priority = g.priority === "high" ? "⚡ " : "";
      lines.push(`- ${priority}${g.content}${deadline}`);
    });
    lines.push("");
  }

  // Daily devotional
  if (devotional) {
    lines.push(`📖 **Daily Devotional**`);
    lines.push(`${devotional.reference}`);
    lines.push(`"${devotional.passage}"`);
    lines.push(`${devotional.reflection}`);
    lines.push("");
  }

  // Suggested tasks
  if (suggestedTasks.length > 0) {
    lines.push(`✅ **Suggested Tasks for Today**`);
    lines.push(`Based on your goals and yesterday's activity:`);
    lines.push("");

    suggestedTasks.forEach((task, idx) => {
      lines.push(`${idx + 1}. [${task.suggestedTime}] ${task.description}`);
      lines.push(`   ${task.rationale} (Est. ${task.estimatedDuration}min)`);
    });
    lines.push("");
    lines.push(`Please reply "confirm" to add these to your reminders, or "skip" to proceed without.`);
  }

  return {
    message: lines.join("\n"),
    tasks: suggestedTasks,
  };
}

// ============================================================
// TASK REMINDER SCHEDULER
// ============================================================

async function scheduleTaskReminders(tasks: SuggestedTask[]): Promise<void> {
  /**
   * Schedules Telegram reminders for confirmed tasks
   * Uses Telegram's sendMessage with scheduled time
   */

  if (!BOT_TOKEN || !GROUPS.GENERAL) {
    console.warn("Cannot schedule reminders - missing bot token or chat ID");
    return;
  }

  const chatId = GROUPS.GENERAL;
  const today = new Date();

  for (const task of tasks) {
    const [hours, minutes] = task.suggestedTime.split(":").map(Number);
    const reminderTime = new Date(today);
    reminderTime.setHours(hours, minutes, 0, 0);

    // Skip if time has passed
    if (reminderTime <= new Date()) continue;

    const delayMs = reminderTime.getTime() - Date.now();

    // Schedule reminder
    setTimeout(async () => {
      const message = `⏰ Reminder: ${task.description}\n(Est. ${task.estimatedDuration} minutes)`;

      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
          }),
        });
        console.log(`Reminder sent for: ${task.description}`);
      } catch (error) {
        console.error(`Failed to send reminder for ${task.description}:`, error);
      }
    }, delayMs);

    console.log(`Scheduled reminder for ${task.suggestedTime}: ${task.description}`);
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running Enhanced Morning Summary...");

  if (!validateGroup("GENERAL")) {
    console.error("Cannot run — GENERAL group not configured in .env");
    console.error("Set GROUP_GENERAL_CHAT_ID in your .env file");
    process.exit(1);
  }

  const { message, tasks } = await buildEnhancedBriefing();
  await sendToGroup(GROUPS.GENERAL, message);
  console.log("Enhanced morning summary sent to General group");

  // Note: Task confirmation and reminder scheduling would be handled
  // by the interactive response from the user in the main relay loop
  // For standalone execution, we can save tasks to Supabase for later pickup
  if (tasks.length > 0) {
    console.log(`${tasks.length} tasks suggested, awaiting user confirmation`);
    // TODO: Store suggested tasks in Supabase for relay to pick up
  }
}

main().catch((error) => {
  console.error("Error running enhanced morning summary:", error);
  process.exit(1);
});

// ============================================================
// EXPORTS FOR TESTING
// ============================================================

export {
  getWeather,
  getYesterdaysActivity,
  getActiveGoals,
  suggestTasks,
  getDailyDevotional,
  buildEnhancedBriefing,
  scheduleTaskReminders,
  extractTopicsFromMessages,
  callClaude,
  getFallbackTasks,
};

export type {
  WeatherData,
  YesterdayActivity,
  Goal,
  SuggestedTask,
  DevotionalContent,
};
