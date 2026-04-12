/**
 * @routine smart-checkin
 * @description Context-aware check-in with calendar, Things 3, and meeting awareness
 * @schedule *\/30 * * * *
 * @target General AI Assistant group
 *
 * Handler — pure logic only. No standalone entry point, no PM2 boilerplate.
 * Use ctx.send() for Telegram output and ctx.log() for console output.
 */

import { join } from "path";
import { readFile, writeFile } from "fs/promises";
import {
  createAppleCalendarClient,
  type AppleCalendarEvent,
} from "../../integrations/osx-calendar/index.ts";
import { fetchThingsTasks, type T3Task } from "../../src/utils/t3Helper.ts";
import { breakdownTasks, scanPendingTodos, formatAtomicTaskBlock, type AtomicTask } from "../../src/utils/atomicBreakdown.ts";
import { callRoutineModel } from "../../src/routines/routineModel.ts";
import { initRegistry } from "../../src/models/index.ts";
import { storeTaskSession, buildTaskKeyboardJSON } from "../../src/callbacks/taskSuggestionHandler.ts";
import { USER_NAME, USER_TIMEZONE } from "../../src/config/userConfig.ts";
import type { RoutineContext } from "../../src/jobs/executors/routineContext.ts";

const STATE_FILE = process.env.CHECKIN_STATE_FILE || "/tmp/group-checkin-state.json";

// ============================================================
// SCHEDULE GUARD
// ============================================================

/**
 * Check if current time is within allowed check-in hours.
 * Mon–Sat (1-6): 06:00–22:00
 * Sunday  (0):   12:00–23:00
 */
export function isWithinSchedule(): boolean {
  const now = new Date();
  const hour = parseInt(
    now.toLocaleTimeString("en-US", { hour: "numeric", hour12: false, timeZone: USER_TIMEZONE })
  );
  const dayOfWeek = new Date(
    now.toLocaleString("en-US", { timeZone: USER_TIMEZONE })
  ).getDay(); // 0 = Sunday

  if (dayOfWeek === 0) {
    // Sunday: 12:00–23:00
    return hour >= 12 && hour < 23;
  }
  // Mon–Sat: 06:00–22:00
  return hour >= 6 && hour < 22;
}

// ============================================================
// STATE MANAGEMENT
// ============================================================

interface CheckinState {
  lastMessageTime: string;
  lastCheckinTime: string;
  lastMeetingPrepId: string | null; // prevent duplicate prep reminders
  pendingItems: string[];
}

async function loadState(): Promise<CheckinState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      lastMessageTime: new Date().toISOString(),
      lastCheckinTime: "",
      lastMeetingPrepId: null,
      pendingItems: [],
    };
  }
}

async function saveState(state: CheckinState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// CONTEXT GATHERING
// ============================================================

async function getActiveGoals(): Promise<{ content: string; deadline: string | null }[]> {
  try {
    const { getDb } = await import("../../src/local/db");
    const db = getDb();
    const rows = db.query(
      "SELECT content, deadline FROM memory WHERE type = 'goal' AND status = 'active' ORDER BY created_at DESC LIMIT 5"
    ).all() as { content: string; deadline: string | null }[];
    return rows;
  } catch {
    return [];
  }
}

async function getStaleActivityItems(): Promise<string[]> {
  // TODO: implement when activity log module exists
  return [];
}

async function getRecentMessageCount(): Promise<number> {
  try {
    const { getDb } = await import("../../src/local/db");
    const db = getDb();
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const row = db.query(
      "SELECT COUNT(*) as cnt FROM messages WHERE created_at >= ?"
    ).get(fourHoursAgo.toISOString()) as { cnt: number };
    return row.cnt || 0;
  } catch {
    return 0;
  }
}

async function getTodayCalendarEvents(): Promise<AppleCalendarEvent[] | null> {
  const ACCESS_TIMEOUT_MS = 15_000;
  const EVENTS_TIMEOUT_MS = 30_000;
  const nullAfter = (ms: number): Promise<null> =>
    new Promise(resolve => setTimeout(() => resolve(null), ms));
  try {
    const cal = await Promise.race([createAppleCalendarClient(), nullAfter(ACCESS_TIMEOUT_MS)]);
    if (!cal) return null;
    const events = await Promise.race([cal.getTodayEvents(), nullAfter(EVENTS_TIMEOUT_MS)]);
    return events;
  } catch (err) {
    console.warn("[smart-checkin] Calendar fetch failed:", err);
    return null;
  }
}

// ============================================================
// MEETING DETECTION
// ============================================================

export interface MeetingContext {
  /** Meeting starting within 30 min that hasn't been prepped */
  upcomingMeeting: AppleCalendarEvent | null;
  /** Meeting that ended within the last 30 min */
  recentlyEndedMeeting: AppleCalendarEvent | null;
}

export function detectMeetingContext(
  events: AppleCalendarEvent[] | null,
  state: CheckinState
): MeetingContext {
  if (!events) return { upcomingMeeting: null, recentlyEndedMeeting: null };

  const now = Date.now();
  const thirtyMin = 30 * 60 * 1000;

  // Find meeting starting within 30 min (but not already started)
  const upcoming = events.find(e => {
    if (e.isAllDay) return false;
    const startsIn = e.start.getTime() - now;
    return startsIn > 0 && startsIn <= thirtyMin;
  });

  // Don't re-notify for same meeting
  const upcomingMeeting = upcoming && upcoming.title !== state.lastMeetingPrepId
    ? upcoming
    : null;

  // Find meeting that ended within the last 30 min
  const recentlyEnded = events.find(e => {
    if (e.isAllDay) return false;
    const endedAgo = now - e.end.getTime();
    return endedAgo >= 0 && endedAgo <= thirtyMin;
  });

  return {
    upcomingMeeting,
    recentlyEndedMeeting: recentlyEnded || null,
  };
}

export function formatCalendarEvent(e: AppleCalendarEvent): string {
  if (e.isAllDay) return `All day — ${e.title}`;
  const startStr = e.start.toLocaleTimeString("en-SG", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: USER_TIMEZONE,
  });
  const endStr = e.end.toLocaleTimeString("en-SG", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: USER_TIMEZONE,
  });
  return `${startStr}–${endStr} — ${e.title}`;
}

// ============================================================
// CHECK-IN DECISION (Ollama)
// ============================================================

export interface CheckinDecision {
  shouldCheckin: boolean;
  message: string;
  reason: string;
  suggestTasks: boolean; // whether to include atomic task suggestions
}

export async function decideCheckin(
  goals: { content: string; deadline: string | null }[],
  staleItems: string[],
  recentMessages: number,
  calendarEvents: AppleCalendarEvent[] | null,
  thingsTasks: T3Task[],
  meetingCtx: MeetingContext,
  state: CheckinState
): Promise<CheckinDecision> {
  const now = new Date();
  const hour = parseInt(
    now.toLocaleTimeString("en-US", { hour: "numeric", hour12: false, timeZone: USER_TIMEZONE })
  );
  const timeContext = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

  const hoursSinceLastCheckin = state.lastCheckinTime
    ? (now.getTime() - new Date(state.lastCheckinTime).getTime()) / (1000 * 60 * 60)
    : 999;

  // Calendar context
  const calendarStr = calendarEvents === null
    ? "Calendar unavailable."
    : calendarEvents.length === 0
      ? "No calendar events today."
      : calendarEvents.map(formatCalendarEvent).join("\n");

  // Things 3 context
  const thingsStr = thingsTasks.length === 0
    ? "No Things 3 tasks for today."
    : thingsTasks
        .filter(t => t.status === "incomplete")
        .slice(0, 8)
        .map(t => {
          const parts = [t.title];
          if (t.deadline) parts.push(`(deadline: ${t.deadline})`);
          if (t.project_title) parts.push(`[${t.project_title}]`);
          return `- ${parts.join(" ")}`;
        })
        .join("\n");

  // Meeting context
  let meetingNote = "";
  if (meetingCtx.upcomingMeeting) {
    const mins = Math.round((meetingCtx.upcomingMeeting.start.getTime() - now.getTime()) / 60000);
    meetingNote = `⚠️ UPCOMING MEETING in ${mins} minutes: "${meetingCtx.upcomingMeeting.title}". Provide a brief prep reminder.`;
  } else if (meetingCtx.recentlyEndedMeeting) {
    meetingNote = `📋 JUST ENDED: "${meetingCtx.recentlyEndedMeeting.title}". Suggest post-meeting actions (follow-ups, notes, action items).`;
  }

  const prompt = `You are a proactive AI assistant deciding whether to check in with ${USER_NAME} via Telegram.

CONTEXT:
- Current time: ${now.toLocaleTimeString("en-US", { timeZone: USER_TIMEZONE })} (${timeContext})
- Hours since last check-in: ${hoursSinceLastCheckin.toFixed(1)}
- Messages in last 4 hours: ${recentMessages}
- Active goals: ${goals.length > 0 ? goals.map(g => `${g.content}${g.deadline ? ` (by ${g.deadline})` : ""}`).join("; ") : "None"}
- Pending follow-ups: ${state.pendingItems.length > 0 ? state.pendingItems.join("; ") : "None"}
- Stale activities: ${staleItems.length > 0 ? staleItems.join("; ") : "None"}

CALENDAR:
${calendarStr}

THINGS 3 TASKS:
${thingsStr}

${meetingNote ? `MEETING ALERT:\n${meetingNote}\n` : ""}RULES:
1. Maximum 3 check-ins per day — do not be annoying
2. Only check in if there is a concrete reason:
   - Meeting starting soon (ALWAYS check in for this)
   - Meeting just ended (suggest follow-ups)
   - Approaching deadline on a goal or task
   - Long silence (>4 hours) with pending goals
   - Useful task suggestion or reminder
3. Be brief and genuinely helpful
4. Do NOT check in during deep-work hours (10 AM–12 PM, 2 PM–4 PM) UNLESS there's a meeting alert
5. If nothing warrants a message, respond NO
6. Set SUGGEST_TASKS to YES if you think an atomic task breakdown would be helpful (e.g., complex tasks, unclear next steps)

RESPOND IN THIS EXACT FORMAT:
DECISION: YES or NO
MESSAGE: [Your short, helpful message if YES, or "none" if NO]
SUGGEST_TASKS: YES or NO
REASON: [One line explaining your decision]`;

  try {
    const response = await callRoutineModel(prompt, {
      label: "smart-checkin:decide",
      timeoutMs: 60_000,
    });

    if (!response) {
      console.log("[smart-checkin] Ollama returned empty response");
      return { shouldCheckin: false, message: "", reason: "Empty Ollama response", suggestTasks: false };
    }

    const decisionMatch = response.match(/DECISION:\s*(YES|NO)/i);
    const messageMatch = response.match(/MESSAGE:\s*(.+?)(?=\nSUGGEST_TASKS:|$)/is);
    const suggestMatch = response.match(/SUGGEST_TASKS:\s*(YES|NO)/i);
    const reasonMatch = response.match(/REASON:\s*(.+)/is);

    const shouldCheckin = decisionMatch?.[1]?.toUpperCase() === "YES";
    const message = messageMatch?.[1]?.trim() || "";
    const suggestTasks = suggestMatch?.[1]?.toUpperCase() === "YES";
    const reason = reasonMatch?.[1]?.trim() || "";

    console.log(`[smart-checkin] Decision: ${shouldCheckin ? "YES" : "NO"} | Tasks: ${suggestTasks} | Reason: ${reason}`);

    return { shouldCheckin, message, reason, suggestTasks };
  } catch (err) {
    console.error("[smart-checkin] Ollama decision failed:", err);
    // If there's an upcoming meeting, always check in even if Ollama fails
    if (meetingCtx.upcomingMeeting) {
      const mins = Math.round((meetingCtx.upcomingMeeting.start.getTime() - now.getTime()) / 60000);
      return {
        shouldCheckin: true,
        message: `📅 Heads up — "${meetingCtx.upcomingMeeting.title}" starts in ${mins} minutes.`,
        reason: "Meeting prep fallback",
        suggestTasks: false,
      };
    }
    return { shouldCheckin: false, message: "", reason: "Ollama unavailable", suggestTasks: false };
  }
}

// ============================================================
// BUILD TASK SUGGESTION MESSAGE
// ============================================================

export async function buildTaskSuggestions(
  thingsTasks: T3Task[],
  calendarEvents: AppleCalendarEvent[] | null,
  goals: { content: string; deadline: string | null }[]
): Promise<{ text: string; replyMarkup?: unknown } | null> {
  const todosDir = join(import.meta.dir, "../../.claude/todos");
  const pendingTodos = await scanPendingTodos(todosDir);

  const atomicTasks = await breakdownTasks(
    thingsTasks,
    pendingTodos,
    calendarEvents,
    goals
  );

  if (atomicTasks.length === 0) return null;

  const block = formatAtomicTaskBlock(atomicTasks, storeTaskSession, buildTaskKeyboardJSON);
  return { text: `📋 **Suggested Tasks**\n${block.text}`, replyMarkup: block.replyMarkup };
}

// ============================================================
// RUN — RoutineContext interface
// ============================================================

export async function run(ctx: RoutineContext): Promise<void> {
  ctx.log("Running...");
  initRegistry();

  // Schedule guard — skip if outside allowed hours
  if (!isWithinSchedule()) {
    ctx.log("Outside scheduled hours, skipping.");
    return;
  }

  const state = await loadState();

  // Parallel context gathering
  const [goals, staleItems, recentMessages, calendarEvents, thingsTasks] = await Promise.all([
    getActiveGoals(),
    getStaleActivityItems(),
    getRecentMessageCount(),
    getTodayCalendarEvents(),
    fetchThingsTasks(["today", "deadlines"]),
  ]);

  const meetingCtx = detectMeetingContext(calendarEvents, state);

  // Ask model whether to check in
  const decision = await decideCheckin(
    goals, staleItems, recentMessages, calendarEvents,
    thingsTasks, meetingCtx, state
  );

  if (!decision.shouldCheckin || !decision.message || decision.message === "none") {
    ctx.log("No check-in needed.");
    return;
  }

  // Send the main check-in message
  ctx.log("Sending check-in...");
  await ctx.send(decision.message);

  // If model suggested tasks, generate and send atomic breakdown
  if (decision.suggestTasks) {
    const taskSuggestions = await buildTaskSuggestions(thingsTasks, calendarEvents, goals);
    if (taskSuggestions) {
      await ctx.send(taskSuggestions.text, { reply_markup: taskSuggestions.replyMarkup });
      ctx.log("Task suggestions sent with inline keyboard.");
    }
  }

  // Update state
  state.lastCheckinTime = new Date().toISOString();
  if (meetingCtx.upcomingMeeting) {
    state.lastMeetingPrepId = meetingCtx.upcomingMeeting.title;
  }
  await saveState(state);
  ctx.log("Done.");
}
