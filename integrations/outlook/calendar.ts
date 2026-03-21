/**
 * Outlook Calendar — Microsoft Graph API CRUD operations.
 * Handles 429 rate limiting with Retry-After backoff.
 */

import "isomorphic-fetch";
import type { CalendarEvent, NewCalendarEvent, TimeSlot } from "./index.ts";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function graphRequest<T>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  let res = await fetch(`${GRAPH_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // Handle 429 rate limiting — retry once
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "10", 10);
    console.warn(`Outlook Graph API 429 — retrying after ${retryAfter}s`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    res = await fetch(`${GRAPH_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph API ${method} ${path}: ${res.status} — ${text}`);
  }

  if (res.status === 204) return undefined as unknown as T;

  return res.json() as Promise<T>;
}

// ── Type mapping ──────────────────────────────────────────────────────────────

interface GraphEvent {
  id?: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  body?: { content?: string };
  isAllDay?: boolean;
  organizer?: { emailAddress?: { name?: string } };
}

function toCalendarEvent(e: GraphEvent): CalendarEvent {
  return {
    id: e.id ?? "",
    title: e.subject ?? "(no title)",
    start: new Date(e.start?.dateTime ?? Date.now()),
    end: new Date(e.end?.dateTime ?? Date.now()),
    location: e.location?.displayName,
    body: e.body?.content,
    isAllDay: e.isAllDay ?? false,
    organizer: e.organizer?.emailAddress?.name ?? "",
  };
}

function toGraphEvent(event: NewCalendarEvent): GraphEvent {
  const graphEvent: GraphEvent = {
    subject: event.title,
    start: { dateTime: event.start.toISOString(), timeZone: "UTC" },
    end: { dateTime: event.end.toISOString(), timeZone: "UTC" },
    isAllDay: event.isAllDay ?? false,
  };
  if (event.location) {
    graphEvent.location = { displayName: event.location };
  }
  if (event.body) {
    graphEvent.body = { content: event.body };
  }
  return graphEvent;
}

// ── API functions ─────────────────────────────────────────────────────────────

export async function fetchCalendarEvents(
  accessToken: string,
  options?: { startDate?: Date; endDate?: Date; top?: number }
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    $orderby: "start/dateTime",
    $top: String(options?.top ?? 50),
  });

  if (options?.startDate) {
    params.set("$filter", `start/dateTime ge '${options.startDate.toISOString()}'`);
  }

  interface GraphList { value?: GraphEvent[] }
  const data = await graphRequest<GraphList>(
    accessToken, "GET", `/me/calendarView?${params}&startDateTime=${
      (options?.startDate ?? new Date()).toISOString()
    }&endDateTime=${
      (options?.endDate ?? new Date(Date.now() + 7 * 86400_000)).toISOString()
    }`
  );

  return (data.value ?? []).map(toCalendarEvent);
}

export async function fetchEvent(
  accessToken: string,
  id: string
): Promise<CalendarEvent> {
  const data = await graphRequest<GraphEvent>(accessToken, "GET", `/me/events/${id}`);
  return toCalendarEvent(data);
}

export async function createCalendarEvent(
  accessToken: string,
  event: NewCalendarEvent
): Promise<CalendarEvent> {
  const data = await graphRequest<GraphEvent>(
    accessToken, "POST", "/me/events", toGraphEvent(event)
  );
  return toCalendarEvent(data);
}

export async function updateCalendarEvent(
  accessToken: string,
  id: string,
  updates: Partial<NewCalendarEvent>
): Promise<CalendarEvent> {
  const existing = await fetchEvent(accessToken, id);
  const merged: NewCalendarEvent = {
    title: updates.title ?? existing.title,
    start: updates.start ?? existing.start,
    end: updates.end ?? existing.end,
    location: updates.location ?? existing.location,
    body: updates.body ?? existing.body,
    isAllDay: updates.isAllDay ?? existing.isAllDay,
  };
  const data = await graphRequest<GraphEvent>(
    accessToken, "PATCH", `/me/events/${id}`, toGraphEvent(merged)
  );
  return toCalendarEvent(data);
}

export async function deleteCalendarEvent(
  accessToken: string,
  id: string
): Promise<void> {
  await graphRequest<void>(accessToken, "DELETE", `/me/events/${id}`);
}

export async function findFreeTimes(
  accessToken: string,
  date: Date,
  durationMinutes: number
): Promise<TimeSlot[]> {
  const startOfDay = new Date(date);
  startOfDay.setHours(8, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(18, 0, 0, 0);

  interface ScheduleResponse {
    value?: Array<{
      scheduleItems?: Array<{ start?: { dateTime?: string }; end?: { dateTime?: string }; status?: string }>;
    }>;
  }

  // Get busy slots via schedule API
  const data = await graphRequest<ScheduleResponse>(
    accessToken, "POST", "/me/calendar/getSchedule",
    {
      schedules: ["me"],
      startTime: { dateTime: startOfDay.toISOString(), timeZone: "UTC" },
      endTime: { dateTime: endOfDay.toISOString(), timeZone: "UTC" },
      availabilityViewInterval: durationMinutes,
    }
  );

  const busySlots = (data.value?.[0]?.scheduleItems ?? [])
    .filter(s => s.status !== "free")
    .map(s => ({
      start: new Date(s.start?.dateTime ?? startOfDay),
      end: new Date(s.end?.dateTime ?? endOfDay),
    }));

  // Find free slots by inverting busy slots
  const freeSlots: TimeSlot[] = [];
  let cursor = startOfDay.getTime();

  for (const busy of busySlots.sort((a, b) => a.start.getTime() - b.start.getTime())) {
    if (cursor + durationMinutes * 60_000 <= busy.start.getTime()) {
      freeSlots.push({ start: new Date(cursor), end: busy.start });
    }
    cursor = Math.max(cursor, busy.end.getTime());
  }

  if (cursor + durationMinutes * 60_000 <= endOfDay.getTime()) {
    freeSlots.push({ start: new Date(cursor), end: endOfDay });
  }

  return freeSlots;
}
