#!/usr/bin/env bun

/**
 * @routine smart-checkin
 * @description Context-aware check-in with calendar, Things 3, and meeting awareness
 * @schedule *\/30 * * * *
 * @target General AI Assistant group
 */

/**
 * Smart Check-in Routine
 *
 * Schedule: Every 30 min (PM2 cron), with in-code day/hour guard:
 *   Mon–Sat: 06:00–22:00
 *   Sunday:  12:00–23:00
 *
 * Features:
 * - Meeting prep reminders (30min before meetings)
 * - Post-meeting task suggestions
 * - Things 3 task awareness
 * - Calendar-aware context for Claude decision
 * - Atomic task breakdown with inline keyboard
 *
 * Run manually: bun run routines/smart-checkin.ts
 */

import { join } from "path";
import { readFile, writeFile } from "fs/promises";
import { sendAndRecord } from "../src/utils/routineMessage.ts";
import { sendToGroup } from "../src/utils/sendToGroup.ts";
import { GROUPS, validateGroup } from "../src/config/groups.ts";

/**
 * Priority: SMART_CHECKIN_GROUP env var → OPERATIONS → first configured group.
 */
function resolveCheckinGroupKey(): string | undefined {
  for (const key of [
    process.env.SMART_CHECKIN_GROUP,
    "OPERATIONS",
    Object.keys(GROUPS).find((k) => (GROUPS[k]?.chatId ?? 0) !== 0),
  ]) {
    if (key && (GROUPS[key]?.chatId ?? 0) !== 0) return key;
  }
  return undefined;
}

const CHECKIN_GROUP_KEY = resolveCheckinGroupKey();
import { USER_NAME, USER_TIMEZONE } from "../src/config/userConfig.ts";
import {
  createAppleCalendarClient,
  type AppleCalendarEvent,
} from "../integrations/osx-calendar/index.ts";
import { fetchThingsTasks, type T3Task } from "../src/utils/t3Helper.ts";
import { breakdownTasks, scanPendingTodos, formatAtomicTaskBlock, type AtomicTask } from "../src/utils/atomicBreakdown.ts";
import { callRoutineModel } from "../src/routines/routineModel.ts";
import { initRegistry } from "../src/models/index.ts";
import { storeTaskSession, buildTaskKeyboardJSON } from "../src/callbacks/taskSuggestionHandler.ts";

const STATE_FILE = process.env.CHECKIN_STATE_FILE || "/tmp/group-checkin-state.json";

// ============================================================
// SCHEDULE GUARD
// ============================================================

/**
 * Check if current time is within allowed check-in hours.
 * Mon–Sat (1-6): 06:00–22:00
 * Sunday  (0):   12:00–23:00
 */
function isWithinSchedule(): boolean {
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
    const { getDb } = await import("../src/local/db");
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
    const { getDb } = await import("../src/local/db");
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

interface MeetingContext {
  /** Meeting starting within 30 min that hasn't been prepped */
  upcomingMeeting: AppleCalendarEvent | null;
  /** Meeting that ended within the last 30 min */
  recentlyEndedMeeting: AppleCalendarEvent | null;
}

function detectMeetingContext(
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

function formatCalendarEvent(e: AppleCalendarEvent): string {
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

interface CheckinDecision {
  shouldCheckin: boolean;
  message: string;
  reason: string;
  suggestTasks: boolean; // whether to include atomic task suggestions
}

async function decideCheckin(
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

${meetingNote ? `MEETING ALERT:\n${meetingNote}\n` : ""}
RULES:
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

async function buildTaskSuggestions(
  thingsTasks: T3Task[],
  calendarEvents: AppleCalendarEvent[] | null,
  goals: { content: string; deadline: string | null }[]
): Promise<{ text: string; replyMarkup?: unknown } | null> {
  const todosDir = join(import.meta.dir, "../.claude/todos");
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
// MAIN
// ============================================================

async function main() {
  console.log("[smart-checkin] Running...");
  initRegistry();

  // Schedule guard — exit early if outside allowed hours
  if (!isWithinSchedule()) {
    console.log("[smart-checkin] Outside scheduled hours, skipping.");
    process.exit(0);
  }

  if (!CHECKIN_GROUP_KEY) {
    console.error("[smart-checkin] No group configured");
    console.error("Set SMART_CHECKIN_GROUP env var or ensure at least one agent has a chatId in agents.json");
    process.exit(0);
  }
  const CHECKIN_GROUP = GROUPS[CHECKIN_GROUP_KEY];
  console.log(`[smart-checkin] Sending to group: ${CHECKIN_GROUP_KEY}`);

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

  // Ask Ollama whether to check in
  const decision = await decideCheckin(
    goals, staleItems, recentMessages, calendarEvents,
    thingsTasks, meetingCtx, state
  );

  if (!decision.shouldCheckin || !decision.message || decision.message === "none") {
    console.log("[smart-checkin] No check-in needed.");
    process.exit(0);
  }

  // Send the main check-in message
  console.log("[smart-checkin] Sending check-in...");
  await sendAndRecord(CHECKIN_GROUP.chatId, decision.message, {
    routineName: "smart-checkin",
    agentId: "general-assistant",
    topicId: CHECKIN_GROUP.topicId,
  });

  // If Haiku suggested tasks, generate and send atomic breakdown
  if (decision.suggestTasks) {
    const taskSuggestions = await buildTaskSuggestions(thingsTasks, calendarEvents, goals);
    if (taskSuggestions) {
      await sendAndRecord(CHECKIN_GROUP.chatId, taskSuggestions.text, {
        routineName: "smart-checkin",
        agentId: "general-assistant",
        topicId: CHECKIN_GROUP.topicId,
        reply_markup: taskSuggestions.replyMarkup,
      });
      console.log("[smart-checkin] Task suggestions sent with inline keyboard.");
    }
  }

  // Update state
  state.lastCheckinTime = new Date().toISOString();
  if (meetingCtx.upcomingMeeting) {
    state.lastMeetingPrepId = meetingCtx.upcomingMeeting.title;
  }
  await saveState(state);
  console.log("[smart-checkin] Done.");
}

// PM2's bun container uses require() internally, which sets import.meta.main = false.
// Fall back to pm_exec_path to detect when PM2 is the entry runner.
const _isEntry =
  import.meta.main ||
  process.env.pm_exec_path === import.meta.url?.replace("file://", "");

if (_isEntry) {
  main().catch(async (error) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[smart-checkin] Error:", error);
    try {
      await sendToGroup((CHECKIN_GROUP_KEY ? GROUPS[CHECKIN_GROUP_KEY]?.chatId : undefined) ?? 0, `⚠️ smart-checkin failed:\n\n${msg}`);
    } catch { /* ignore secondary failure */ }
    process.exit(0);
  });
}

// ============================================================
// EXPORTS FOR TESTING
// ============================================================

export {
  isWithinSchedule,
  detectMeetingContext,
  formatCalendarEvent,
  buildTaskSuggestions,
};
