/**
 * Outlook Calendar — public client interface.
 *
 * Returns null if AZURE_CLIENT_ID is not set (integration not configured).
 *
 * SETUP:
 * 1. Register an Azure app (portal.azure.com → App registrations)
 * 2. Add Calendar.ReadWrite permission (delegated)
 * 3. Set AZURE_CLIENT_ID (and optionally AZURE_TENANT_ID) in .env
 * 4. On first run, getAccessToken() triggers device code flow → message sent to Telegram
 *
 * Usage:
 *   import { createOutlookClient } from 'integrations/outlook';
 *   const outlook = createOutlookClient();
 *   if (!outlook) return;  // not configured
 *
 *   const events = await outlook.getTodayEvents();
 *   const created = await outlook.createEvent({ title: 'Standup', start, end });
 */

export type { AuthenticationResult } from "@azure/msal-node";
export { getAccessToken, triggerDeviceCodeFlow, clearTokenCache } from "./auth.ts";
export {
  fetchCalendarEvents,
  fetchEvent,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  findFreeTimes,
} from "./calendar.ts";

// ── Shared types (used by calendar.ts — must be defined here) ─────────────────

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  location?: string;
  body?: string;
  isAllDay: boolean;
  organizer: string;
}

export interface NewCalendarEvent {
  title: string;
  start: Date;
  end: Date;
  location?: string;
  body?: string;
  isAllDay?: boolean;
}

export interface TimeSlot {
  start: Date;
  end: Date;
}

// ── High-level client interface ────────────────────────────────────────────────

export interface OutlookClient {
  /** Today's events (midnight→23:59 local). */
  getTodayEvents(): Promise<CalendarEvent[]>;
  /** Events for the next N days (default 7). */
  getUpcomingEvents(days?: number): Promise<CalendarEvent[]>;
  /** Fetch a single event by its Graph ID. */
  getEvent(id: string): Promise<CalendarEvent>;
  /** Find free time slots on a given date for the given duration (minutes). */
  findFreeTimes(date: Date, durationMinutes: number): Promise<TimeSlot[]>;
  /** Create a new calendar event. */
  createEvent(event: NewCalendarEvent): Promise<CalendarEvent>;
  /** Update an existing event (partial update — unspecified fields are kept). */
  updateEvent(id: string, updates: Partial<NewCalendarEvent>): Promise<CalendarEvent>;
  /** Delete an event. */
  deleteEvent(id: string): Promise<void>;
}

/**
 * Factory — returns null if AZURE_CLIENT_ID is not set.
 * @param notifyCallback Called when device code re-auth is needed (send to Telegram).
 */
export function createOutlookClient(
  notifyCallback: (message: string) => void = console.log
): OutlookClient | null {
  if (!process.env.AZURE_CLIENT_ID) return null;

  return {
    async getTodayEvents() {
      const { fetchCalendarEvents: fetch } = await import("./calendar.ts");
      const { getAccessToken } = await import("./auth.ts");
      const token = await getAccessToken(notifyCallback);
      if (!token) throw new Error("Outlook: could not obtain access token");
      const now = new Date();
      const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
      const endOfToday = new Date(now); endOfToday.setHours(23, 59, 59, 999);
      return fetch(token, { startDate: startOfToday, endDate: endOfToday, top: 100 });
    },

    async getUpcomingEvents(days = 7) {
      const { fetchCalendarEvents: fetch } = await import("./calendar.ts");
      const { getAccessToken } = await import("./auth.ts");
      const token = await getAccessToken(notifyCallback);
      if (!token) throw new Error("Outlook: could not obtain access token");
      const start = new Date();
      const end = new Date(start.getTime() + days * 86_400_000);
      return fetch(token, { startDate: start, endDate: end, top: 50 });
    },

    async getEvent(id) {
      const { fetchEvent } = await import("./calendar.ts");
      const { getAccessToken } = await import("./auth.ts");
      const token = await getAccessToken(notifyCallback);
      if (!token) throw new Error("Outlook: could not obtain access token");
      return fetchEvent(token, id);
    },

    async findFreeTimes(date, durationMinutes) {
      const { findFreeTimes: find } = await import("./calendar.ts");
      const { getAccessToken } = await import("./auth.ts");
      const token = await getAccessToken(notifyCallback);
      if (!token) throw new Error("Outlook: could not obtain access token");
      return find(token, date, durationMinutes);
    },

    async createEvent(event) {
      const { createCalendarEvent } = await import("./calendar.ts");
      const { getAccessToken } = await import("./auth.ts");
      const token = await getAccessToken(notifyCallback);
      if (!token) throw new Error("Outlook: could not obtain access token");
      return createCalendarEvent(token, event);
    },

    async updateEvent(id, updates) {
      const { updateCalendarEvent } = await import("./calendar.ts");
      const { getAccessToken } = await import("./auth.ts");
      const token = await getAccessToken(notifyCallback);
      if (!token) throw new Error("Outlook: could not obtain access token");
      return updateCalendarEvent(token, id, updates);
    },

    async deleteEvent(id) {
      const { deleteCalendarEvent } = await import("./calendar.ts");
      const { getAccessToken } = await import("./auth.ts");
      const token = await getAccessToken(notifyCallback);
      if (!token) throw new Error("Outlook: could not obtain access token");
      return deleteCalendarEvent(token, id);
    },
  };
}
