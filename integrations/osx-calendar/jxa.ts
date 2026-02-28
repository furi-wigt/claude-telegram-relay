/**
 * JXA helpers for Apple Calendar.app.
 * Reuses the same JXA runner pattern as osx-notes.
 */

import { runJXAWithJSON } from "../osx-notes/jxa.ts";

export interface RawCalendar {
  id: string;
  title: string;
}

export interface RawEvent {
  id: string;
  title: string;
  start: string;   // ISO string
  end: string;     // ISO string
  isAllDay: boolean;
  calendar: string;
  location: string | null;
  notes: string | null;
}

/** List all calendars visible in Calendar.app. */
export async function listCalendarsJXA(): Promise<RawCalendar[]> {
  return runJXAWithJSON<Record<string, never>, RawCalendar[]>(
    `
    const app = Application('Calendar');
    JSON.stringify(app.calendars().map((c, i) => ({
      id: (function() { try { return c.id(); } catch (_) { return 'calendar-' + i; } })(),
      title: c.name(),
    })));
    `,
    {}
  );
}

/**
 * Large synthetic calendars that contain thousands of auto-generated recurring
 * events (OS-managed, read-only). Iterating them with cal.events() hangs JXA.
 * Skip them unless explicitly requested via calendarNames.
 */
const SKIP_BY_DEFAULT = ["Birthdays", "Siri Suggestions", "Scheduled Reminders"];

/** Get events in a date range, optionally filtered to specific calendar names. */
export async function getEventsInRangeJXA(
  start: Date,
  end: Date,
  calendarNames?: string[]
): Promise<RawEvent[]> {
  return runJXAWithJSON<
    { start: string; end: string; calendarNames?: string[]; skipByDefault: string[] },
    RawEvent[]
  >(
    `
    const app = Application('Calendar');
    const startDate = new Date(input.start);
    const endDate = new Date(input.end);

    // Build the calendar list: explicit filter wins; otherwise skip large synthetic calendars.
    let allCals = app.calendars();
    let calendars;
    if (input.calendarNames && input.calendarNames.length > 0) {
      calendars = allCals.filter(c => input.calendarNames.includes(c.name()));
    } else {
      calendars = allCals.filter(c => {
        const name = c.name();
        if (input.skipByDefault.includes(name)) return false;
        if (name.startsWith('Holidays')) return false; // "Holidays in X" calendars
        return true;
      });
    }

    const events = [];
    for (const cal of calendars) {
      // Use whose() so Calendar.app filters natively — avoids fetching all events
      // into JS before date-filtering (which hangs on large/synced calendars).
      const calEvents = cal.events.whose({ _and: [
        { startDate: { _greaterThanEquals: startDate } },
        { startDate: { _lessThanEquals: endDate } }
      ]})();
      for (const evt of calEvents) {
        events.push({
          id: evt.uid(),
          title: evt.summary(),
          start: evt.startDate().toISOString(),
          end: evt.endDate().toISOString(),
          isAllDay: evt.alldayEvent(),
          calendar: cal.name(),
          location: evt.location() || null,
          notes: evt.description() || null,
        });
      }
    }
    JSON.stringify(events);
    `,
    { start: start.toISOString(), end: end.toISOString(), calendarNames, skipByDefault: SKIP_BY_DEFAULT }
  );
}

/** Create an event in a calendar. */
export async function createEventJXA(params: {
  title: string;
  start: string;
  end: string;
  calendarTitle?: string;
  location?: string;
  notes?: string;
  isAllDay?: boolean;
}): Promise<void> {
  await runJXAWithJSON<typeof params, { ok: boolean }>(
    `
    const app = Application('Calendar');
    const cal = input.calendarTitle
      ? app.calendars.whose({name: {_equals: input.calendarTitle}})[0]
      : app.calendars()[0];
    if (!cal) throw new Error('Calendar not found: ' + (input.calendarTitle || 'default'));

    const startDate = new Date(input.start);
    const endDate = new Date(input.end);

    const newEvent = app.Event({
      summary: input.title,
      startDate: startDate,
      endDate: endDate,
      alldayEvent: input.isAllDay ?? false,
    });

    if (input.location) newEvent.location = input.location;
    if (input.notes) newEvent.description = input.notes;

    cal.events.push(newEvent);
    app.saveCalendars();
    JSON.stringify({ ok: true });
    `,
    params
  );
}

/** Delete an event by its UID. */
export async function deleteEventJXA(eventId: string): Promise<void> {
  await runJXAWithJSON<{ id: string }, { ok: boolean }>(
    `
    const app = Application('Calendar');
    for (const cal of app.calendars()) {
      const matching = cal.events.whose({uid: {_equals: input.id}})();
      if (matching.length > 0) {
        cal.events.remove(matching[0]);
        app.saveCalendars();
        JSON.stringify({ ok: true });
        return;
      }
    }
    throw new Error('Event not found: ' + input.id);
    `,
    { id: eventId }
  );
}

/** Test if Calendar access is granted (returns true on success). */
export async function checkCalendarAccess(): Promise<boolean> {
  try {
    await runJXAWithJSON<Record<string, never>, { count: number }>(
      `
      const app = Application('Calendar');
      JSON.stringify({ count: app.calendars().length });
      `,
      {}
    );
    return true;
  } catch {
    return false;
  }
}
