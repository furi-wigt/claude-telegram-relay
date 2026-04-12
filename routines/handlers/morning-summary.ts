/**
 * @routine morning-summary
 * @description Daily morning briefing with news, weather, and goals summary
 * @schedule 0 7 * * *
 * @target Personal chat
 *
 * Handler — pure logic only. No standalone entry point, no PM2 boilerplate.
 * Use ctx.send() for Telegram output and ctx.log() for console output.
 *
 * Features:
 * 1. Singapore weather: 2hr area forecasts (4 locations) + 24hr + air quality
 * 2. Yesterday's recap as a Claude Haiku narrative summary
 * 3. Daily devotional (stub — Gmail integration pending)
 * 4. Suggested tasks calendar-aware, slotted around Apple Calendar events
 * 5. Markdown output — sendAndRecord auto-converts to HTML
 */

import { join } from "path";
import { claudeText } from "../../src/claude-process.ts";
import { callRoutineModel } from "../../src/routines/routineModel.ts";
import { initRegistry } from "../../src/models/index.ts";
import { createWeatherClient } from "../../integrations/weather/index.ts";
import {
  createAppleCalendarClient,
  type AppleCalendarEvent,
} from "../../integrations/osx-calendar/index.ts";
import { USER_NAME, USER_TIMEZONE } from "../../src/config/userConfig.ts";
import { scanPendingE2ETests, formatPendingE2ESection } from "../../src/routines/pendingE2EScanner.ts";
import { fetchThingsTasks } from "../../src/utils/t3Helper.ts";
import { breakdownTasks, scanPendingTodos, formatAtomicTaskBlock, formatDevTodosMessage, type AtomicTask } from "../../src/utils/atomicBreakdown.ts";
import { storeTaskSession, buildTaskKeyboardJSON } from "../../src/callbacks/taskSuggestionHandler.ts";
import type { RoutineContext } from "../../src/jobs/executors/routineContext.ts";

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

export interface WeatherSection {
  areaForecasts: { label: string; forecast: string }[];  // 2hr for 4 areas
  summary24h: string;          // e.g. "Thundery Showers (25–33°C)"
  airQuality: string;          // e.g. "PSI 42 (Good), PM2.5 12"
  uvIndex: number;
}

export interface YesterdayActivity {
  messageCount: number;
  factsLearned: number;
  messageContent: string[];    // up to 15 message snippets for Haiku recap
  completedGoals: string[];
}

export interface Goal {
  id: string;
  content: string;
  deadline?: string;
  priority?: "high" | "medium" | "low";
}

export interface DevotionalContent {
  passage: string;
  reference: string;
  reflection: string;
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
// WEATHER (integration layer)
// ============================================================

export async function getWeatherData(): Promise<WeatherSection> {
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

export async function getYesterdaysActivity(): Promise<YesterdayActivity> {
  const empty: YesterdayActivity = {
    messageCount: 0,
    factsLearned: 0,
    messageContent: [],
    completedGoals: [],
  };

  try {
    const { getDb } = await import("../../src/local/db");
    const db = getDb();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yISO = yesterday.toISOString();
    const tISO = today.toISOString();

    const messages = db.query(
      "SELECT id, content FROM messages WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 15"
    ).all(yISO, tISO) as { id: string; content: string }[];

    const messageCountRow = db.query(
      "SELECT COUNT(*) as cnt FROM messages WHERE created_at >= ? AND created_at < ?"
    ).get(yISO, tISO) as { cnt: number };

    const factsCountRow = db.query(
      "SELECT COUNT(*) as cnt FROM memory WHERE type = 'fact' AND created_at >= ? AND created_at < ?"
    ).get(yISO, tISO) as { cnt: number };

    const completedGoals = db.query(
      "SELECT content FROM memory WHERE type = 'completed_goal' AND completed_at >= ? AND completed_at < ?"
    ).all(yISO, tISO) as { content: string }[];

    const messageContent = messages
      .map((m) => (m.content || "").slice(0, 200))
      .filter(Boolean);

    return {
      messageCount: messageCountRow.cnt || 0,
      factsLearned: factsCountRow.cnt || 0,
      messageContent,
      completedGoals: completedGoals.map((g) => g.content),
    };
  } catch (error) {
    console.error("Error fetching yesterday's activity:", error);
    return empty;
  }
}

// ============================================================
// RECAP NARRATIVE (Claude Haiku)
// ============================================================

export async function generateRecapNarrative(activity: YesterdayActivity): Promise<string> {
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
    const narrative = await callRoutineModel(prompt, {
      label: "morning-summary:recap",
      timeoutMs: 90_000,
    });
    return narrative.trim();
  } catch (err) {
    console.error("[morning-summary:recap] LLM failed:", err);
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

export async function getActiveGoals(): Promise<Goal[]> {
  try {
    const { getDb } = await import("../../src/local/db");
    const db = getDb();
    const rows = db.query(
      "SELECT id, content, deadline FROM memory WHERE type = 'goal' AND status = 'active' ORDER BY created_at DESC LIMIT 20"
    ).all() as { id: string; content: string; deadline: string | null }[];

    if (!rows.length) return [];

    return rows.map((g) => ({
      id: g.id,
      content: g.content,
      deadline: g.deadline,
      priority: "medium",
    }));
  } catch (error) {
    console.error("Error fetching goals:", error);
    return [];
  }
}

// ============================================================
// CALENDAR (OSX integration — null-safe)
// ============================================================

export async function getTodayCalendarEvents(): Promise<AppleCalendarEvent[] | null> {
  // checkCalendarAccess() (inside createAppleCalendarClient) takes ~1-3s.
  // getTodayEvents() (JXA getEventsInRangeJXA with whose()) takes ~23s for GovTech.
  // Use separate budgets to avoid conflating the two operations.
  // Note: Furi's Personal is a slow CalDAV calendar — removed from APPLE_CALENDAR_NAMES.
  const ACCESS_TIMEOUT_MS = 20_000; // EventKit init at 7am under PM2 can take ~8-15s
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

export function formatCalendarEvent(e: AppleCalendarEvent): string {
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
// GMAIL DEVOTIONAL (STUB)
// ============================================================

export async function getDailyDevotional(): Promise<DevotionalContent | null> {
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

export async function buildEnhancedBriefing(): Promise<{
  message: string;
  tasks: AtomicTask[];
  replyMarkup?: unknown;
  devTodosMessage: string | null;
}> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: USER_TIMEZONE,
  });

  const todosDir = join(import.meta.dir, "../../.claude/todos");

  // Parallel fetches — Things 3 + todos added
  const [weatherData, goals, activity, devotional, calendarEvents, pendingE2E, thingsTasks, pendingTodos] = await Promise.all([
    getWeatherData(),
    getActiveGoals(),
    getYesterdaysActivity(),
    getDailyDevotional(),
    getTodayCalendarEvents(),
    scanPendingE2ETests(todosDir),
    fetchThingsTasks(["today", "deadlines"]),
    scanPendingTodos(todosDir),
  ]);

  // Sequential: both hit local LLM (serialized via mutex), so run one after the other
  const goalsForBreakdown = goals.map(g => ({ content: g.content, deadline: g.deadline }));
  const recapNarrative = await generateRecapNarrative(activity);
  // Dev todos kept separate — not passed to LLM for time-slotting
  const atomicTasks = await breakdownTasks(thingsTasks, [], calendarEvents, goalsForBreakdown);
  const devTodosMessage = formatDevTodosMessage(pendingTodos);

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

  // ── Cross-Agent Activity Digest (Orchestration) ───────────────────────────
  try {
    const { getYesterdayActivity } = await import("../../src/orchestration/dispatchEngine");
    const agentActivity = getYesterdayActivity();
    if (agentActivity.length > 0) {
      const { AGENTS } = await import("../../src/agents/config");
      lines.push(`🤖 **Yesterday Across Agents:**`);
      for (const row of agentActivity) {
        const agent = AGENTS[row.agent_id];
        const name = agent?.shortName ?? agent?.name ?? row.agent_id;
        const intents = row.intents ? ` (${row.intents})` : "";
        lines.push(`• ${name}: ${row.count} dispatch${row.count > 1 ? "es" : ""}${intents}`);
      }
      lines.push("");
    }
  } catch {
    // Orchestration tables may not exist yet — graceful skip
  }

  // ── Mesh Board Activity (Constrained Mesh sessions) ────────────────────────
  try {
    const { getDb } = await import("../../src/local/db");
    const db = getDb();
    const boardActivity = db.query(`
      SELECT
        s.status,
        COUNT(DISTINCT s.id) as session_count,
        COUNT(r.id) as record_count
      FROM bb_sessions s
      LEFT JOIN bb_records r ON r.session_id = s.id
      WHERE s.created_at >= datetime('now', '-1 day')
      GROUP BY s.status
    `).all() as Array<{ status: string; session_count: number; record_count: number }>;

    if (boardActivity.length > 0) {
      const totalSessions = boardActivity.reduce((sum, r) => sum + r.session_count, 0);
      const totalRecords = boardActivity.reduce((sum, r) => sum + r.record_count, 0);
      const completedSessions = boardActivity.find(r => r.status === "done")?.session_count ?? 0;
      const activeSessions = boardActivity.find(r => r.status === "active")?.session_count ?? 0;

      lines.push(`🕸️ **Mesh Activity:**`);
      lines.push(`• ${totalSessions} session${totalSessions !== 1 ? "s" : ""} (${completedSessions} done, ${activeSessions} active), ${totalRecords} board records`);
      lines.push("");
    }
  } catch {
    // bb_sessions table may not exist yet — graceful skip
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

  // ── Pending E2E Tests ────────────────────────────────────────────────────────
  const e2eSection = formatPendingE2ESection(pendingE2E);
  if (e2eSection) {
    lines.push(e2eSection);
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

  // ── Atomic Tasks (replaces old suggestTasks) ─────────────────────────────────
  let replyMarkup: unknown;
  if (atomicTasks.length > 0) {
    lines.push(`📋 **Today's Action Plan**`);
    const block = formatAtomicTaskBlock(atomicTasks, storeTaskSession, buildTaskKeyboardJSON);
    lines.push(block.text);
    lines.push("");
    replyMarkup = block.replyMarkup;
  }

  return { message: lines.join("\n"), tasks: atomicTasks, replyMarkup, devTodosMessage };
}

// ============================================================
// RUN — RoutineContext interface
// ============================================================

export async function run(ctx: RoutineContext): Promise<void> {
  ctx.log("Running Enhanced Morning Summary...");
  initRegistry();

  // Skip if already ran today
  if (await ctx.skipIfRanWithin(20)) {
    ctx.log("Already ran today, skipping.");
    return;
  }

  const { message, tasks, replyMarkup, devTodosMessage } = await buildEnhancedBriefing();
  await ctx.send(message, { reply_markup: replyMarkup });
  ctx.log("Enhanced morning summary sent.");

  // Send dev todos as a separate reference message
  if (devTodosMessage) {
    try {
      await ctx.send(devTodosMessage);
      ctx.log("Dev todos message sent.");
    } catch (err) {
      console.warn("[morning-summary] Failed to send dev todos:", err instanceof Error ? err.message : err);
    }
  }

  if (tasks.length > 0) {
    ctx.log(`${tasks.length} tasks suggested, awaiting user confirmation.`);
  }
}
