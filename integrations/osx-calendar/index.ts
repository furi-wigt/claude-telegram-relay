/**
 * OSX Calendar Integration — Apple Calendar via JXA (osascript -l JavaScript).
 *
 * macOS-only. Reads all calendars visible in Calendar.app (iCloud, Exchange,
 * Google synced, local, subscriptions).
 *
 * SETUP: Run `bun run integrations/osx-calendar/grant-permission.ts` once
 * before starting PM2 to grant macOS Calendar access permission.
 *
 * Usage:
 *   import { createAppleCalendarClient } from 'integrations/osx-calendar';
 *   const cal = await createAppleCalendarClient();
 *   if (!cal) return;  // not macOS or access denied
 *
 *   const events = await cal.getTodayEvents();
 *   const upcoming = await cal.getUpcomingEvents(7);
 */

import {
  listCalendarsJXA,
  getEventsInRangeJXA,
  createEventJXA,
  deleteEventJXA,
  checkCalendarAccess,
  type RawCalendar,
  type RawEvent,
} from "./jxa.ts";

export interface CalendarInfo {
  id: string;
  title: string;
  color: string;   // hex placeholder (#000000) — JXA doesn't expose calendar color
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

function rawToEvent(raw: RawEvent): AppleCalendarEvent {
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

function rawToCalendarInfo(raw: RawCalendar): CalendarInfo {
  return {
    id: raw.id,
    title: raw.title,
    color: "#000000",  // JXA doesn't expose calendar color
    type: "calDAV",    // JXA doesn't expose calendar type
  };
}

function getFilteredCalendarNames(): string[] | undefined {
  const env = process.env.APPLE_CALENDAR_NAMES;
  if (!env) return undefined;
  return env.split(",").map(s => s.trim()).filter(Boolean);
}

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function endOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
}

/**
 * Factory — async because it checks Calendar access.
 * Returns null if: not macOS, or Calendar access denied.
 */
export async function createAppleCalendarClient(): Promise<AppleCalendarClient | null> {
  if (process.platform !== "darwin") {
    console.warn("createAppleCalendarClient: not macOS — returning null");
    return null;
  }

  const hasAccess = await checkCalendarAccess();
  if (!hasAccess) {
    console.warn(
      "createAppleCalendarClient: Calendar access denied. " +
      "Run: bun run integrations/osx-calendar/grant-permission.ts"
    );
    return null;
  }

  const calendarFilter = getFilteredCalendarNames();

  return {
    async getCalendars() {
      const raw = await listCalendarsJXA();
      return raw
        .filter(c => !calendarFilter || calendarFilter.includes(c.title))
        .map(rawToCalendarInfo);
    },

    async getTodayEvents() {
      const now = new Date();
      const raw = await getEventsInRangeJXA(startOfDay(now), endOfDay(now), calendarFilter);
      return raw.map(rawToEvent);
    },

    async getUpcomingEvents(days = 7) {
      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate() + days);
      const raw = await getEventsInRangeJXA(now, end, calendarFilter);
      return raw.map(rawToEvent);
    },

    async getEventsInRange(start, end) {
      const raw = await getEventsInRangeJXA(start, end, calendarFilter);
      return raw.map(rawToEvent);
    },

    async createEvent(event) {
      await createEventJXA({
        title: event.title,
        start: event.start.toISOString(),
        end: event.end.toISOString(),
        calendarTitle: event.calendarTitle,
        location: event.location,
        notes: event.notes,
        isAllDay: event.isAllDay,
      });
    },

    async deleteEvent(eventId) {
      await deleteEventJXA(eventId);
    },
  };
}
