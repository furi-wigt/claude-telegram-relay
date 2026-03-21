/**
 * OSX Calendar Integration — Apple Calendar via compiled Swift EventKit binary.
 *
 * macOS-only. Uses ~/.claude/skills/osx-calendar/scripts/calendar-helper
 * which talks directly to EventKit. Correctly handles recurring event
 * exceptions (unlike JXA, which returns the base occurrence date).
 *
 * Usage:
 *   import { createAppleCalendarClient } from 'integrations/osx-calendar';
 *   const cal = await createAppleCalendarClient();
 *   if (!cal) return;  // not macOS or access denied
 *
 *   const events = await cal.getTodayEvents();
 *   const upcoming = await cal.getUpcomingEvents(7);
 */

const CALENDAR_BINARY = `${process.env.HOME}/.claude/skills/osx-calendar/scripts/calendar-helper`;

// ── Interfaces (unchanged — same contract for all consumers) ────────────────

export interface CalendarInfo {
  id: string;
  title: string;
  color: string;
  type: 'local' | 'calDAV' | 'exchange' | 'subscription' | 'birthday';
}

export interface AppleCalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  calendar: string;
  location?: string;
  notes?: string;
}

export interface NewAppleCalendarEvent {
  title: string;
  start: Date;
  end: Date;
  calendarTitle?: string;
  location?: string;
  notes?: string;
  isAllDay?: boolean;
}

export interface AppleCalendarClient {
  getCalendars(): Promise<CalendarInfo[]>;
  getTodayEvents(): Promise<AppleCalendarEvent[]>;
  getUpcomingEvents(days?: number): Promise<AppleCalendarEvent[]>;
  getEventsInRange(start: Date, end: Date): Promise<AppleCalendarEvent[]>;
  createEvent(event: NewAppleCalendarEvent): Promise<void>;
  deleteEvent(eventId: string): Promise<void>;
}

// ── Swift binary runner ─────────────────────────────────────────────────────

interface SwiftEvent {
  id: string;
  title: string;
  start: string;  // UTC ISO string
  end: string;
  all_day: boolean;
  calendar_id: string;
  calendar_title: string;
  location?: string;
  notes?: string;
}

interface SwiftCalendar {
  id: string;
  title: string;
  type: string;
  source: string;
  editable: boolean;
  subscribed: boolean;
}

/**
 * Run the Swift calendar-helper binary with the given arguments.
 * Returns parsed JSON output. Throws on non-zero exit or invalid JSON.
 */
async function runCalendarHelperImpl<T>(args: string[]): Promise<T> {
  const proc = Bun.spawn([CALENDAR_BINARY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(`calendar-helper exited ${exitCode}: ${errText.trim()}`);
  }
  return JSON.parse(text) as T;
}

/** Injectable for testing — tests override _deps.runCalendarHelper. */
export const _deps = {
  runCalendarHelper: runCalendarHelperImpl as <T>(args: string[]) => Promise<T>,
};

/** Run the Swift calendar-helper binary. Delegates to _deps for testability. */
export function runCalendarHelper<T>(args: string[]): Promise<T> {
  return _deps.runCalendarHelper<T>(args);
}

// ── Converters ──────────────────────────────────────────────────────────────

function swiftEventToAppleEvent(e: SwiftEvent): AppleCalendarEvent {
  return {
    id: e.id,
    title: e.title,
    start: new Date(e.start),
    end: new Date(e.end),
    isAllDay: e.all_day,
    calendar: e.calendar_title,
    location: e.location ?? undefined,
    notes: e.notes ?? undefined,
  };
}

function swiftCalToInfo(c: SwiftCalendar): CalendarInfo {
  const typeMap: Record<string, CalendarInfo["type"]> = {
    local: "local",
    calDAV: "calDAV",
    exchange: "exchange",
    subscription: "subscription",
    birthday: "birthday",
  };
  return {
    id: c.id,
    title: c.title,
    color: "#000000",
    type: typeMap[c.type] ?? "calDAV",
  };
}

// ── Pure helpers (kept for consumers + tests) ───────────────────────────────

export function getFilteredCalendarNames(): string[] | undefined {
  const env = process.env.APPLE_CALENDAR_NAMES;
  if (!env) return undefined;
  return env.split(",").map(s => s.trim()).filter(Boolean);
}

export function getUserTimezone(): string {
  return process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Format a Date as "YYYY-MM-DD" in the user's timezone.
 * The Swift binary interprets date-only strings as midnight local time.
 */
export function toLocalDateStr(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: getUserTimezone() });
}

/**
 * Compute midnight in the user's timezone as a UTC Date.
 */
export function tzMidnight(d: Date): Date {
  const tz = getUserTimezone();
  const dateStr = d.toLocaleDateString("en-CA", { timeZone: tz });
  const [year, month, day] = dateStr.split("-").map(Number);
  const utcBase = new Date(Date.UTC(year, month - 1, day));
  const tzStr = utcBase.toLocaleString("en-US", { timeZone: tz });
  const utcStr = utcBase.toLocaleString("en-US", { timeZone: "UTC" });
  const offsetMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
  return new Date(utcBase.getTime() - offsetMs);
}

export function startOfDay(d: Date): Date {
  return tzMidnight(d);
}

export function endOfDay(d: Date): Date {
  const nextDay = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  return new Date(tzMidnight(nextDay).getTime() - 1);
}

// ── Backward-compat exports (used by existing tests) ────────────────────────

/** @deprecated — only kept for test compat. Prefer swiftEventToAppleEvent. */
export interface RawEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  isAllDay: boolean;
  calendar: string;
  location: string | null;
  notes: string | null;
}

/** @deprecated */
export function rawToEvent(raw: RawEvent): AppleCalendarEvent {
  return {
    id: raw.id,
    title: raw.title,
    start: new Date(raw.start),
    end: new Date(raw.end),
    isAllDay: raw.isAllDay,
    calendar: raw.calendar,
    location: raw.location ?? undefined,
    notes: raw.notes ?? undefined,
  };
}

/** @deprecated */
export function rawToCalendarInfo(raw: { id: string; title: string }): CalendarInfo {
  return { id: raw.id, title: raw.title, color: "#000000", type: "calDAV" };
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Factory — async because it checks Calendar access via Swift binary.
 * Returns null if: not macOS, or Calendar access denied.
 */
export async function createAppleCalendarClient(): Promise<AppleCalendarClient | null> {
  if (process.platform !== "darwin") {
    console.warn("createAppleCalendarClient: not macOS — returning null");
    return null;
  }

  try {
    const result = await runCalendarHelper<{ status: string; has_real_calendars?: boolean }>(["check-access"]);
    if (result.status !== "full_access" || !result.has_real_calendars) {
      console.warn("createAppleCalendarClient: Calendar access denied or no real calendars");
      return null;
    }
  } catch (err) {
    console.warn("createAppleCalendarClient: Swift binary failed:", err instanceof Error ? err.message : err);
    return null;
  }

  const calendarFilter = getFilteredCalendarNames();

  return {
    async getCalendars() {
      const { calendars } = await runCalendarHelper<{ calendars: SwiftCalendar[] }>(["list-calendars"]);
      return calendars
        .filter(c => !calendarFilter || calendarFilter.includes(c.title))
        .map(swiftCalToInfo);
    },

    async getTodayEvents() {
      const tz = getUserTimezone();
      const now = new Date();
      const todayStr = now.toLocaleDateString("en-CA", { timeZone: tz });
      const nextDay = new Date(now.getTime() + 86_400_000);
      const tomorrowStr = nextDay.toLocaleDateString("en-CA", { timeZone: tz });

      const { events } = await runCalendarHelper<{ events: SwiftEvent[] }>(["list-events", todayStr, tomorrowStr]);
      return events
        .filter(e => !calendarFilter || calendarFilter.includes(e.calendar_title))
        .map(swiftEventToAppleEvent);
    },

    async getUpcomingEvents(days = 7) {
      const tz = getUserTimezone();
      const now = new Date();
      const startStr = now.toLocaleDateString("en-CA", { timeZone: tz });
      const end = new Date(now.getTime() + days * 86_400_000);
      const endStr = end.toLocaleDateString("en-CA", { timeZone: tz });

      const { events } = await runCalendarHelper<{ events: SwiftEvent[] }>(["list-events", startStr, endStr]);
      return events
        .filter(e => !calendarFilter || calendarFilter.includes(e.calendar_title))
        .map(swiftEventToAppleEvent);
    },

    async getEventsInRange(start, end) {
      const startStr = toLocalDateStr(start);
      const endStr = toLocalDateStr(end);

      const { events } = await runCalendarHelper<{ events: SwiftEvent[] }>(["list-events", startStr, endStr]);
      return events
        .filter(e => !calendarFilter || calendarFilter.includes(e.calendar_title))
        .map(swiftEventToAppleEvent);
    },

    async createEvent(event) {
      // Resolve calendar_id from title
      const { calendars } = await runCalendarHelper<{ calendars: SwiftCalendar[] }>(["list-calendars"]);
      const targetCal = event.calendarTitle
        ? calendars.find(c => c.title === event.calendarTitle)
        : calendars.find(c => c.editable);
      if (!targetCal) throw new Error(`Calendar not found: ${event.calendarTitle || "default editable"}`);

      const args: string[] = [
        "create-event",
        event.title,
        event.start.toISOString(),
        event.end.toISOString(),
        targetCal.id,
      ];
      if (event.location) args.push("--location", event.location);
      if (event.notes) args.push("--notes", event.notes);
      if (event.isAllDay) args.push("--all-day");

      await runCalendarHelper(args);
    },

    async deleteEvent(eventId) {
      await runCalendarHelper(["delete-event", eventId]);
    },
  };
}
