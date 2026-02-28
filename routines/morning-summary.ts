#!/usr/bin/env bun

/**
 * @routine morning-summary
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
 * 1. Singapore weather: 2hr area forecasts (4 locations) + 24hr + air quality
 * 2. Yesterday's recap as a Claude Haiku narrative summary
 * 3. Daily devotional (stub — Gmail integration pending)
 * 4. Suggested tasks calendar-aware, slotted around Apple Calendar events
 * 5. Markdown output — sendAndRecord auto-converts to HTML
 *
 * Run manually: bun run routines/morning-summary.ts
 */

import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";
import { claudeText } from "../src/claude-process.ts";
import { createWeatherClient } from "../integrations/weather/index.ts";
import {
  createAppleCalendarClient,
  type AppleCalendarEvent,
} from "../integrations/osx-calendar/index.ts";
import { USER_NAME, USER_TIMEZONE } from "../src/config/userConfig.ts";
import { shouldSkipToday, markRanToday } from "../src/routines/runOnceGuard.ts";

const LAST_RUN_FILE = join(import.meta.dir, "../logs/morning-summary.lastrun");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

// ── Area targets for 2-hour forecast ─────────────────────────────────────────
// Matched against NEA area names using case-insensitive substring search.
// Configure via WEATHER_AREAS env var (comma-separated, e.g. "Ang Mo Kio,Bedok,Tampines").
// If unset, falls back to Singapore-wide forecast summary only.

const FORECAST_AREA_TARGETS = (process.env.WEATHER_AREAS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((label) => ({ label, match: label.toLowerCase() }));

// ============================================================
// TYPES
// ============================================================

interface WeatherSection {
  areaForecasts: { label: string; forecast: string }[];  // 2hr for 4 areas
  summary24h: string;          // e.g. "Thundery Showers (25–33°C)"
  airQuality: string;          // e.g. "PSI 42 (Good), PM2.5 12"
  uvIndex: number;
}

interface YesterdayActivity {
  messageCount: number;
  factsLearned: number;
  messageContent: string[];    // up to 15 message snippets for Haiku recap
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
// WEATHER (integration layer)
// ============================================================

async function getWeatherData(): Promise<WeatherSection> {
  const fallback: WeatherSection = {
    areaForecasts: [],
    summary24h: "Forecast unavailable",
    airQuality: "Air quality unavailable",
    uvIndex: 0,
  };

  try {
    const weather = createWeatherClient();
    const [summaryRes, twoHrRes] = await Promise.allSettled([
      weather.getMorningSummary(),
      weather.get2HourForecast(),
    ]);

    // 2hr area forecasts — filter for 4 target locations
    let areaForecasts: { label: string; forecast: string }[] = [];
    if (twoHrRes.status === "fulfilled") {
      const allAreas = twoHrRes.value;
      areaForecasts = FORECAST_AREA_TARGETS.flatMap(({ label, match }) => {
        const hit = allAreas.find(a => a.area.toLowerCase().includes(match));
        return hit ? [{ label, forecast: hit.forecast }] : [];
      });
    }

    if (summaryRes.status === "rejected") {
      return { ...fallback, areaForecasts };
    }

    return {
      areaForecasts,
      summary24h: summaryRes.value.forecast24h,
      airQuality: summaryRes.value.airQuality,
      uvIndex: summaryRes.value.uvIndex,
    };
  } catch (err) {
    console.error("getWeatherData failed:", err);
    return fallback;
  }
}

// ============================================================
// YESTERDAY'S ACTIVITY
// ============================================================

async function getYesterdaysActivity(): Promise<YesterdayActivity> {
  const empty: YesterdayActivity = {
    messageCount: 0,
    factsLearned: 0,
    messageContent: [],
    completedGoals: [],
  };

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return empty;

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [messagesResult, factsResult, goalsResult] = await Promise.all([
      supabase
        .from("messages")
        .select("id, content", { count: "exact" })
        .gte("created_at", yesterday.toISOString())
        .lt("created_at", today.toISOString())
        .order("created_at", { ascending: false })
        .limit(15),
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

    const messageContent = (messagesResult.data || [])
      .map((m: any) => (m.content || "").slice(0, 200))
      .filter(Boolean);

    return {
      messageCount: messagesResult.count || 0,
      factsLearned: factsResult.count || 0,
      messageContent,
      completedGoals: goalsResult.data?.map((g: any) => g.content) || [],
    };
  } catch (error) {
    console.error("Error fetching yesterday's activity:", error);
    return empty;
  }
}

// ============================================================
// RECAP NARRATIVE (Claude Haiku)
// ============================================================

async function generateRecapNarrative(activity: YesterdayActivity): Promise<string> {
  if (activity.messageCount === 0) {
    return "No conversations recorded yesterday.";
  }

  const sampleContent = activity.messageContent
    .slice(0, 10)
    .map((c, i) => `[${i + 1}] ${c}`)
    .join("\n");

  const completedStr = activity.completedGoals.length > 0
    ? `Completed goals: ${activity.completedGoals.join(", ")}.`
    : "No goals were completed.";

  const prompt =
    `Summarize yesterday's AI assistant activity in 2-3 sentences for a morning briefing.\n\n` +
    `Stats: ${activity.messageCount} messages, ${activity.factsLearned} new facts learned.\n` +
    `${completedStr}\n\n` +
    `Sample messages:\n${sampleContent}\n\n` +
    `Write a concise, specific narrative in past tense. Plain text only, no markdown, no bullet points.`;

  try {
    const narrative = await _deps.claudeText(prompt, {
      model: "claude-haiku-4-5-20251001",
      timeoutMs: 20_000,
    });
    return narrative.trim();
  } catch (err) {
    console.warn("Haiku recap failed, using fallback:", err);
    const parts: string[] = [`${activity.messageCount} messages exchanged`];
    if (activity.factsLearned > 0) parts.push(`${activity.factsLearned} facts learned`);
    if (activity.completedGoals.length > 0) {
      parts.push(`completed: ${activity.completedGoals.join(", ")}`);
    }
    return parts.join(", ") + ".";
  }
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
      .limit(20);

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
// CALENDAR (OSX integration — null-safe)
// ============================================================

async function getTodayCalendarEvents(): Promise<AppleCalendarEvent[] | null> {
  // checkCalendarAccess() (inside createAppleCalendarClient) takes ~1-3s.
  // getTodayEvents() (JXA getEventsInRangeJXA with whose()) takes ~23s for GovTech.
  // Use separate budgets to avoid conflating the two operations.
  // Note: Furi's Personal is a slow CalDAV calendar — removed from APPLE_CALENDAR_NAMES.
  const ACCESS_TIMEOUT_MS = 8_000;
  const EVENTS_TIMEOUT_MS = 40_000;
  const nullAfter = (ms: number): Promise<null> =>
    new Promise(resolve => setTimeout(() => resolve(null), ms));
  try {
    const cal = await Promise.race([_deps.createAppleCalendarClient(), nullAfter(ACCESS_TIMEOUT_MS)]);
    if (!cal) {
      console.warn("Calendar unavailable (timeout or permission denied)");
      return null;
    }
    const events = await Promise.race([cal.getTodayEvents(), nullAfter(EVENTS_TIMEOUT_MS)]);
    if (events === null) {
      console.warn("Calendar event fetch timed out");
      return null;
    }
    return events;
  } catch (err) {
    console.warn("Calendar fetch failed:", err);
    return null;
  }
}

function formatCalendarEvent(e: AppleCalendarEvent): string {
  if (e.isAllDay) return `All day — ${e.title}`;
  const startStr = e.start.toLocaleTimeString("en-SG", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: USER_TIMEZONE,
  });
  const endStr = e.end.toLocaleTimeString("en-SG", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: USER_TIMEZONE,
  });
  return `${startStr}–${endStr} — ${e.title}`;
}

// ============================================================
// TASK SUGGESTION ENGINE
// ============================================================

async function suggestTasks(
  activity: YesterdayActivity,
  goals: Goal[],
  calendarEvents: AppleCalendarEvent[] | null
): Promise<SuggestedTask[]> {
  const calendarContext = calendarEvents === null
    ? "Calendar access not available."
    : calendarEvents.length === 0
      ? "No calendar events today."
      : `Today's calendar events (slot tasks around these):\n` +
        calendarEvents.map(formatCalendarEvent).join("\n");

  const context = {
    user: USER_NAME,
    timezone: USER_TIMEZONE,
    currentTime: new Date().toISOString(),
    activeGoals: goals.map(g => ({
      content: g.content,
      deadline: g.deadline,
      priority: g.priority,
      daysUntilDeadline: g.deadline
        ? Math.ceil((new Date(g.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : null,
    })),
  };

  const prompt =
    `You are a personal task planner. Suggest 3-5 actionable tasks for today.\n\n` +
    `Calendar:\n${calendarContext}\n\n` +
    `Goals:\n${JSON.stringify(context.activeGoals, null, 2)}\n\n` +
    `Requirements:\n` +
    `1. Prioritise goals with deadlines within 3 days\n` +
    `2. Suggest realistic time slots (08:00–18:00) that do not overlap calendar events\n` +
    `3. Estimate duration 15–120 minutes\n` +
    `4. Provide a brief rationale for each task\n\n` +
    `Output ONLY a valid JSON array:\n` +
    `[{"description":"...","rationale":"...","suggestedTime":"HH:MM","estimatedDuration":60,"relatedGoal":"id or null"}]\n` +
    `No explanation, no markdown, just the JSON array.`;

  try {
    const response = await _deps.claudeText(prompt, {
      model: "claude-haiku-4-5-20251001",
      timeoutMs: 30_000,
    });

    if (!response) return getFallbackTasks(goals);

    let jsonText = response.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const tasks = JSON.parse(jsonText);
    if (!Array.isArray(tasks)) return getFallbackTasks(goals);

    const validated: SuggestedTask[] = tasks
      .filter(
        (t: any) =>
          t.description && t.rationale && t.suggestedTime && typeof t.estimatedDuration === "number"
      )
      .map((t: any) => ({
        description: t.description,
        rationale: t.rationale,
        suggestedTime: t.suggestedTime,
        estimatedDuration: t.estimatedDuration,
        relatedGoal: t.relatedGoal || undefined,
      }));

    if (validated.length === 0) return getFallbackTasks(goals);

    console.log(`✓ Generated ${validated.length} task suggestions`);
    return validated;
  } catch (error) {
    console.error("suggestTasks error:", error);
    return getFallbackTasks(goals);
  }
}

function getFallbackTasks(goals: Goal[]): SuggestedTask[] {
  const tasks: SuggestedTask[] = [];

  const urgentGoals = goals.filter(g => {
    if (!g.deadline) return false;
    const days = Math.ceil((new Date(g.deadline).getTime() - Date.now()) / 864e5);
    return days <= 3 && days >= 0;
  });
  urgentGoals.forEach(g => {
    tasks.push({
      description: `Work on: ${g.content}`,
      rationale: `Deadline: ${new Date(g.deadline!).toLocaleDateString()}`,
      suggestedTime: "09:00",
      estimatedDuration: 120,
      relatedGoal: g.id,
    });
  });

  goals.filter(g => g.priority === "high").slice(0, 2).forEach(g => {
    tasks.push({
      description: g.content,
      rationale: "High priority goal",
      suggestedTime: "11:00",
      estimatedDuration: 90,
      relatedGoal: g.id,
    });
  });

  tasks.push({
    description: "Review and respond to messages",
    rationale: "Daily routine",
    suggestedTime: "08:00",
    estimatedDuration: 30,
  });

  return tasks.sort((a, b) => a.suggestedTime.localeCompare(b.suggestedTime));
}

// ============================================================
// GMAIL DEVOTIONAL (STUB)
// ============================================================

async function getDailyDevotional(): Promise<DevotionalContent | null> {
  // TODO: Implement Gmail API connector
  return {
    passage: "[Devotional passage will be fetched from Gmail]",
    reference: "Placeholder Reference",
    reflection: "[Devotional reflection will be fetched from Gmail]",
  };
}

// ============================================================
// BUILD BRIEFING (HTML output)
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

  // Parallel fetches
  const [weatherData, goals, activity, devotional, calendarEvents] = await Promise.all([
    getWeatherData(),
    getActiveGoals(),
    getYesterdaysActivity(),
    getDailyDevotional(),
    getTodayCalendarEvents(),
  ]);

  // Sequential: needs activity + goals + calendar
  const [recapNarrative, suggestedTasks] = await Promise.all([
    generateRecapNarrative(activity),
    suggestTasks(activity, goals, calendarEvents),
  ]);

  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────────
  lines.push(`🌅 **Good morning ${USER_NAME}!**`);
  lines.push(dateStr);
  lines.push("");

  // ── Weather ─────────────────────────────────────────────────────────────────
  lines.push(`🌤️ **Weather Update**`);

  if (weatherData.areaForecasts.length > 0) {
    lines.push("_2-hour forecast:_");
    weatherData.areaForecasts.forEach(({ label, forecast }) => {
      lines.push(`• ${label}: ${forecast}`);
    });
  }

  lines.push(`_Today:_ ${weatherData.summary24h}`);
  lines.push(`_Air quality:_ ${weatherData.airQuality}`);
  if (weatherData.uvIndex > 0) {
    lines.push(`_UV index:_ ${weatherData.uvIndex}`);
  }
  lines.push("");

  // ── Yesterday's Recap ───────────────────────────────────────────────────────
  if (activity.messageCount > 0 || activity.completedGoals.length > 0) {
    lines.push(`📊 **Yesterday's Recap**`);
    lines.push(recapNarrative);
    lines.push("");
  }

  // ── Active Goals ────────────────────────────────────────────────────────────
  if (goals.length > 0) {
    lines.push(`🎯 **Active Goals**`);
    goals.slice(0, 5).forEach(g => {
      const deadline = g.deadline
        ? ` _(by ${new Date(g.deadline).toLocaleDateString()})_`
        : "";
      const priority = g.priority === "high" ? "⚡ " : "";
      lines.push(`• ${priority}${g.content}${deadline}`);
    });
    lines.push("");
  }

  // ── Calendar ────────────────────────────────────────────────────────────────
  if (calendarEvents !== null && calendarEvents.length > 0) {
    lines.push(`📅 **Today's Calendar**`);
    calendarEvents.forEach(e => {
      lines.push(`• ${formatCalendarEvent(e)}`);
    });
    lines.push("");
  } else if (calendarEvents === null) {
    lines.push(`📅 _Calendar unavailable — run \`bun run integrations/osx-calendar/grant-permission.ts\` and check PM2 logs_`);
    lines.push("");
  }

  // ── Devotional ──────────────────────────────────────────────────────────────
  if (devotional) {
    lines.push(`📖 **Daily Devotional**`);
    lines.push(`_${devotional.reference}_`);
    lines.push(`"${devotional.passage}"`);
    lines.push(devotional.reflection);
    lines.push("");
  }

  // ── Suggested Tasks ─────────────────────────────────────────────────────────
  if (suggestedTasks.length > 0) {
    lines.push(`✅ **Suggested Tasks for Today**`);
    suggestedTasks.forEach((task, idx) => {
      lines.push(`${idx + 1}. **[${task.suggestedTime}]** ${task.description}`);
      lines.push(`   _${task.rationale}_ (${task.estimatedDuration} min)`);
    });
    lines.push("");
    lines.push(`_Reply "confirm" to set reminders, or "skip" to proceed._`);
  }

  return { message: lines.join("\n"), tasks: suggestedTasks };
}

// ============================================================
// TASK REMINDER SCHEDULER
// ============================================================

async function scheduleTaskReminders(tasks: SuggestedTask[]): Promise<void> {
  if (!BOT_TOKEN || !GROUPS.GENERAL.chatId) {
    console.warn("Cannot schedule reminders — missing bot token or chat ID");
    return;
  }

  const chatId = GROUPS.GENERAL.chatId;
  const today = new Date();

  for (const task of tasks) {
    const [hours, minutes] = task.suggestedTime.split(":").map(Number);
    const reminderTime = new Date(today);
    reminderTime.setHours(hours, minutes, 0, 0);

    if (reminderTime <= new Date()) continue;

    const delayMs = reminderTime.getTime() - Date.now();
    setTimeout(async () => {
      const text = `⏰ Reminder: ${task.description}\n(Est. ${task.estimatedDuration} min)`;
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
      } catch (err) {
        console.error(`Failed to send reminder for ${task.description}:`, err);
      }
    }, delayMs);

    console.log(`Scheduled reminder ${task.suggestedTime}: ${task.description}`);
  }
}

// ============================================================
// DEPENDENCY INJECTION (for testing)
// ============================================================

/**
 * Overrideable dependency references — allows tests to inject mocks without
 * using mock.module() at module level (which pollutes bun's module cache and
 * breaks other test files that need the real claude-process and osx-calendar).
 *
 * Usage in tests:
 *   _deps.claudeText = async () => "[]";
 *   _deps.createAppleCalendarClient = mockFn;
 */
export const _deps = {
  claudeText: claudeText as typeof claudeText,
  createAppleCalendarClient: createAppleCalendarClient as typeof createAppleCalendarClient,
};

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running Enhanced Morning Summary...");

  if (shouldSkipToday(LAST_RUN_FILE)) {
    console.log("[morning-summary] Already ran today, skipping.");
    process.exit(0);
  }

  if (!validateGroup("GENERAL")) {
    console.error("Cannot run — GENERAL group not configured");
    console.error("Set chatId for the 'GENERAL' agent in config/agents.json");
    process.exit(0); // graceful skip — PM2 will retry on next cron cycle
  }

  const { message, tasks } = await buildEnhancedBriefing();
  await sendAndRecord(GROUPS.GENERAL.chatId, message, {
    routineName: "morning-summary",
    agentId: "general-assistant",
    topicId: GROUPS.GENERAL.topicId,
  });
  markRanToday(LAST_RUN_FILE);
  console.log("Enhanced morning summary sent to General group");

  if (tasks.length > 0) {
    console.log(`${tasks.length} tasks suggested, awaiting user confirmation`);
  }
}

// PM2's bun container uses require() internally, which sets import.meta.main = false.
// Fall back to pm_exec_path to detect when PM2 is the entry runner.
const _isEntry =
  import.meta.main ||
  process.env.pm_exec_path === import.meta.url?.replace("file://", "");

if (_isEntry) {
  main().catch(error => {
    console.error("Error running enhanced morning summary:", error);
    process.exit(0); // exit 0 so PM2 does not immediately restart — next run at scheduled cron time
  });
}

// ============================================================
// EXPORTS FOR TESTING
// ============================================================

export {
  getWeatherData,
  getYesterdaysActivity,
  getActiveGoals,
  getTodayCalendarEvents,
  generateRecapNarrative,
  suggestTasks,
  getDailyDevotional,
  buildEnhancedBriefing,
  scheduleTaskReminders,
  getFallbackTasks,
  formatCalendarEvent,
};

export type {
  WeatherSection,
  YesterdayActivity,
  Goal,
  SuggestedTask,
  DevotionalContent,
};
