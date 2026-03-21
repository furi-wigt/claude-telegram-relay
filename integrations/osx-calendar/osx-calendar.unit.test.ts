/**
 * OSX Calendar Integration — unit tests for pure functions & factory.
 * Swift binary calls are mocked via _deps.runCalendarHelper.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createAppleCalendarClient,
  getUserTimezone,
  getFilteredCalendarNames,
  tzMidnight,
  startOfDay,
  endOfDay,
  rawToEvent,
  rawToCalendarInfo,
  _deps,
  type RawEvent,
} from "./index.ts";

// ── Mock helpers ────────────────────────────────────────────────────────────

type MockResponse = Record<string, unknown>;
let mockResponses: Map<string, MockResponse>;
let mockCallLog: string[][];

function setupMock(responses?: Record<string, MockResponse>) {
  mockResponses = new Map(Object.entries(responses ?? {}));
  mockCallLog = [];
  _deps.runCalendarHelper = async <T>(args: string[]): Promise<T> => {
    mockCallLog.push(args);
    const cmd = args[0];
    const resp = mockResponses.get(cmd);
    if (!resp) throw new Error(`Mock: no response for command "${cmd}"`);
    return resp as T;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getUserTimezone()
// ─────────────────────────────────────────────────────────────────────────────
describe("getUserTimezone()", () => {
  let savedTZ: string | undefined;

  beforeEach(() => {
    savedTZ = process.env.USER_TIMEZONE;
  });

  afterEach(() => {
    if (savedTZ === undefined) {
      delete process.env.USER_TIMEZONE;
    } else {
      process.env.USER_TIMEZONE = savedTZ;
    }
  });

  test("returns 'Asia/Singapore' when USER_TIMEZONE=Asia/Singapore", () => {
    process.env.USER_TIMEZONE = "Asia/Singapore";
    expect(getUserTimezone()).toBe("Asia/Singapore");
  });

  test("returns 'America/New_York' when USER_TIMEZONE=America/New_York", () => {
    process.env.USER_TIMEZONE = "America/New_York";
    expect(getUserTimezone()).toBe("America/New_York");
  });

  test("returns system timezone when USER_TIMEZONE not set", () => {
    delete process.env.USER_TIMEZONE;
    const systemTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(getUserTimezone()).toBe(systemTZ);
  });

  test("returns system timezone when USER_TIMEZONE is empty string", () => {
    process.env.USER_TIMEZONE = "";
    const systemTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(getUserTimezone()).toBe(systemTZ);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getFilteredCalendarNames()
// ─────────────────────────────────────────────────────────────────────────────
describe("getFilteredCalendarNames()", () => {
  let savedNames: string | undefined;

  beforeEach(() => {
    savedNames = process.env.APPLE_CALENDAR_NAMES;
  });

  afterEach(() => {
    if (savedNames === undefined) {
      delete process.env.APPLE_CALENDAR_NAMES;
    } else {
      process.env.APPLE_CALENDAR_NAMES = savedNames;
    }
  });

  test("returns undefined when APPLE_CALENDAR_NAMES not set", () => {
    delete process.env.APPLE_CALENDAR_NAMES;
    expect(getFilteredCalendarNames()).toBeUndefined();
  });

  test('returns ["Work"] for APPLE_CALENDAR_NAMES="Work"', () => {
    process.env.APPLE_CALENDAR_NAMES = "Work";
    expect(getFilteredCalendarNames()).toEqual(["Work"]);
  });

  test('returns ["Work","Personal","Family"] for comma-separated list', () => {
    process.env.APPLE_CALENDAR_NAMES = "Work,Personal,Family";
    expect(getFilteredCalendarNames()).toEqual(["Work", "Personal", "Family"]);
  });

  test("trims whitespace around entries", () => {
    process.env.APPLE_CALENDAR_NAMES = " Work , Personal ";
    expect(getFilteredCalendarNames()).toEqual(["Work", "Personal"]);
  });

  test("filters empty entries from double-comma", () => {
    process.env.APPLE_CALENDAR_NAMES = "Work,,Personal";
    expect(getFilteredCalendarNames()).toEqual(["Work", "Personal"]);
  });

  test("filters whitespace-only entries", () => {
    process.env.APPLE_CALENDAR_NAMES = "Work, ,Personal";
    expect(getFilteredCalendarNames()).toEqual(["Work", "Personal"]);
  });

  test("returns [] when all entries are whitespace", () => {
    process.env.APPLE_CALENDAR_NAMES = "  , , ";
    expect(getFilteredCalendarNames()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tzMidnight()
// ─────────────────────────────────────────────────────────────────────────────
describe("tzMidnight()", () => {
  describe("SGT (Asia/Singapore, UTC+8)", () => {
    let savedTZ: string | undefined;

    beforeEach(() => {
      savedTZ = process.env.USER_TIMEZONE;
      process.env.USER_TIMEZONE = "Asia/Singapore";
    });

    afterEach(() => {
      if (savedTZ === undefined) {
        delete process.env.USER_TIMEZONE;
      } else {
        process.env.USER_TIMEZONE = savedTZ;
      }
    });

    test("mid-day SGT returns midnight of that SGT day", () => {
      const input = new Date("2025-02-25T06:00:00Z");
      expect(tzMidnight(input).toISOString()).toBe("2025-02-24T16:00:00.000Z");
    });

    test("just before midnight SGT returns previous day midnight", () => {
      const input = new Date("2025-02-24T15:59:59Z");
      expect(tzMidnight(input).toISOString()).toBe("2025-02-23T16:00:00.000Z");
    });

    test("exactly at midnight SGT returns that midnight", () => {
      const input = new Date("2025-02-24T16:00:00Z");
      expect(tzMidnight(input).toISOString()).toBe("2025-02-24T16:00:00.000Z");
    });

    test("one second past midnight SGT returns that midnight", () => {
      const input = new Date("2025-02-24T16:00:01Z");
      expect(tzMidnight(input).toISOString()).toBe("2025-02-24T16:00:00.000Z");
    });

    test("month boundary (last moment Jan to Feb 1)", () => {
      const input = new Date("2025-01-31T16:00:00Z");
      expect(tzMidnight(input).toISOString()).toBe("2025-01-31T16:00:00.000Z");
    });

    test("year boundary", () => {
      const input = new Date("2024-12-31T20:00:00Z");
      expect(tzMidnight(input).toISOString()).toBe("2024-12-31T16:00:00.000Z");
    });

    test("returns instanceof Date", () => {
      const input = new Date("2025-02-25T06:00:00Z");
      expect(tzMidnight(input)).toBeInstanceOf(Date);
    });
  });

  describe("UTC", () => {
    let savedTZ: string | undefined;

    beforeEach(() => {
      savedTZ = process.env.USER_TIMEZONE;
      process.env.USER_TIMEZONE = "UTC";
    });

    afterEach(() => {
      if (savedTZ === undefined) {
        delete process.env.USER_TIMEZONE;
      } else {
        process.env.USER_TIMEZONE = savedTZ;
      }
    });

    test("mid-day UTC returns midnight of that UTC day", () => {
      const input = new Date("2025-02-25T10:00:00Z");
      expect(tzMidnight(input).toISOString()).toBe("2025-02-25T00:00:00.000Z");
    });

    test("late UTC returns midnight of that UTC day", () => {
      const input = new Date("2025-02-25T23:30:00Z");
      expect(tzMidnight(input).toISOString()).toBe("2025-02-25T00:00:00.000Z");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// startOfDay()
// ─────────────────────────────────────────────────────────────────────────────
describe("startOfDay()", () => {
  let savedTZ: string | undefined;

  beforeEach(() => {
    savedTZ = process.env.USER_TIMEZONE;
    process.env.USER_TIMEZONE = "Asia/Singapore";
  });

  afterEach(() => {
    if (savedTZ === undefined) {
      delete process.env.USER_TIMEZONE;
    } else {
      process.env.USER_TIMEZONE = savedTZ;
    }
  });

  test("returns same as tzMidnight", () => {
    const input = new Date("2025-02-25T06:00:00Z");
    expect(startOfDay(input).toISOString()).toBe("2025-02-24T16:00:00.000Z");
  });

  test("returns instanceof Date", () => {
    const input = new Date("2025-02-25T06:00:00Z");
    expect(startOfDay(input)).toBeInstanceOf(Date);
  });

  test("result has UTC seconds=0, minutes=0, milliseconds=0", () => {
    const input = new Date("2025-02-25T06:00:00Z");
    const result = startOfDay(input);
    expect(result.getUTCSeconds()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCMilliseconds()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// endOfDay()
// ─────────────────────────────────────────────────────────────────────────────
describe("endOfDay()", () => {
  let savedTZ: string | undefined;

  beforeEach(() => {
    savedTZ = process.env.USER_TIMEZONE;
    process.env.USER_TIMEZONE = "Asia/Singapore";
  });

  afterEach(() => {
    if (savedTZ === undefined) {
      delete process.env.USER_TIMEZONE;
    } else {
      process.env.USER_TIMEZONE = savedTZ;
    }
  });

  test("mid-day input returns 23:59:59.999 SGT", () => {
    const input = new Date("2025-02-25T06:00:00Z");
    expect(endOfDay(input).toISOString()).toBe("2025-02-25T15:59:59.999Z");
  });

  test("morning input same day", () => {
    const input = new Date("2025-02-25T00:00:00Z");
    expect(endOfDay(input).toISOString()).toBe("2025-02-25T15:59:59.999Z");
  });

  test("endOfDay > startOfDay for same input", () => {
    const input = new Date("2025-02-25T06:00:00Z");
    expect(endOfDay(input).getTime()).toBeGreaterThan(startOfDay(input).getTime());
  });

  test("endOfDay - startOfDay === 86_399_999 ms (no DST, exactly 24h - 1ms)", () => {
    const input = new Date("2025-02-25T06:00:00Z");
    const diff = endOfDay(input).getTime() - startOfDay(input).getTime();
    expect(diff).toBe(86_399_999);
  });

  test("month boundary", () => {
    const input = new Date("2025-01-31T05:00:00Z");
    expect(endOfDay(input).toISOString()).toBe("2025-01-31T15:59:59.999Z");
  });

  test("returns instanceof Date", () => {
    const input = new Date("2025-02-25T06:00:00Z");
    expect(endOfDay(input)).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rawToEvent() — backward compat
// ─────────────────────────────────────────────────────────────────────────────
describe("rawToEvent()", () => {
  const minimal: RawEvent = {
    id: "evt-001",
    title: "Team Meeting",
    start: "2025-02-25T01:00:00.000Z",
    end: "2025-02-25T02:00:00.000Z",
    isAllDay: false,
    calendar: "Work",
    location: null,
    notes: null,
  };

  test("maps id", () => {
    expect(rawToEvent(minimal).id).toBe("evt-001");
  });

  test("maps title", () => {
    expect(rawToEvent(minimal).title).toBe("Team Meeting");
  });

  test("parses start to Date", () => {
    const result = rawToEvent(minimal);
    expect(result.start).toBeInstanceOf(Date);
    expect(result.start.toISOString()).toBe("2025-02-25T01:00:00.000Z");
  });

  test("parses end to Date", () => {
    const result = rawToEvent(minimal);
    expect(result.end).toBeInstanceOf(Date);
    expect(result.end.toISOString()).toBe("2025-02-25T02:00:00.000Z");
  });

  test("maps isAllDay false", () => {
    expect(rawToEvent(minimal).isAllDay).toBe(false);
  });

  test("maps isAllDay true", () => {
    const allDay: RawEvent = { ...minimal, isAllDay: true };
    expect(rawToEvent(allDay).isAllDay).toBe(true);
  });

  test("maps calendar name", () => {
    expect(rawToEvent(minimal).calendar).toBe("Work");
  });

  test("null location becomes undefined", () => {
    expect(rawToEvent(minimal).location).toBeUndefined();
  });

  test("null notes becomes undefined", () => {
    expect(rawToEvent(minimal).notes).toBeUndefined();
  });

  test("non-null location is preserved", () => {
    const withLocation: RawEvent = { ...minimal, location: "Zoom" };
    expect(rawToEvent(withLocation).location).toBe("Zoom");
  });

  test("non-null notes is preserved", () => {
    const withNotes: RawEvent = { ...minimal, notes: "Bring slides" };
    expect(rawToEvent(withNotes).notes).toBe("Bring slides");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rawToCalendarInfo() — backward compat
// ─────────────────────────────────────────────────────────────────────────────
describe("rawToCalendarInfo()", () => {
  const minimal = { id: "cal-abc", title: "Work Calendar" };

  test("maps id", () => {
    expect(rawToCalendarInfo(minimal).id).toBe("cal-abc");
  });

  test("maps title", () => {
    expect(rawToCalendarInfo(minimal).title).toBe("Work Calendar");
  });

  test('always sets color to "#000000"', () => {
    expect(rawToCalendarInfo(minimal).color).toBe("#000000");
  });

  test('always sets type to "calDAV"', () => {
    expect(rawToCalendarInfo(minimal).type).toBe("calDAV");
  });

  test("result has exactly 4 keys", () => {
    expect(Object.keys(rawToCalendarInfo(minimal)).length).toBe(4);
  });

  test("two calls return independent objects (not same reference)", () => {
    const a = rawToCalendarInfo(minimal);
    const b = rawToCalendarInfo(minimal);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createAppleCalendarClient() factory — Swift binary
// ─────────────────────────────────────────────────────────────────────────────
describe("createAppleCalendarClient() factory", () => {
  beforeEach(() => {
    setupMock({
      "check-access": { status: "full_access", calendar_count: 2, has_real_calendars: true },
      "list-calendars": {
        calendars: [
          { id: "c1", title: "Work", type: "calDAV", source: "iCloud", editable: true, subscribed: false },
          { id: "c2", title: "Personal", type: "calDAV", source: "iCloud", editable: true, subscribed: false },
        ],
        count: 2,
      },
      "list-events": { events: [], count: 0 },
    });
  });

  test("returns null when check-access denies", async () => {
    setupMock({
      "check-access": { status: "denied", has_real_calendars: false },
    });
    const client = await createAppleCalendarClient();
    expect(client).toBeNull();
  });

  test("returns null when Swift binary throws", async () => {
    _deps.runCalendarHelper = async () => { throw new Error("binary not found"); };
    const client = await createAppleCalendarClient();
    expect(client).toBeNull();
  });

  test("returns client with all 6 methods when access granted", async () => {
    const client = await createAppleCalendarClient();
    expect(client).not.toBeNull();
    expect(typeof client!.getCalendars).toBe("function");
    expect(typeof client!.getTodayEvents).toBe("function");
    expect(typeof client!.getUpcomingEvents).toBe("function");
    expect(typeof client!.getEventsInRange).toBe("function");
    expect(typeof client!.createEvent).toBe("function");
    expect(typeof client!.deleteEvent).toBe("function");
  });

  test("calls check-access exactly once during construction", async () => {
    await createAppleCalendarClient();
    expect(mockCallLog.filter(c => c[0] === "check-access").length).toBe(1);
  });

  test("does NOT call list-calendars during factory construction", async () => {
    await createAppleCalendarClient();
    expect(mockCallLog.filter(c => c[0] === "list-calendars").length).toBe(0);
  });

  // ── getCalendars() ──────────────────────────────────────────────────────
  describe("getCalendars()", () => {
    let savedNames: string | undefined;

    beforeEach(() => {
      savedNames = process.env.APPLE_CALENDAR_NAMES;
      delete process.env.APPLE_CALENDAR_NAMES;
    });

    afterEach(() => {
      if (savedNames === undefined) {
        delete process.env.APPLE_CALENDAR_NAMES;
      } else {
        process.env.APPLE_CALENDAR_NAMES = savedNames;
      }
    });

    test("returns all calendars when APPLE_CALENDAR_NAMES not set", async () => {
      const client = await createAppleCalendarClient();
      const calendars = await client!.getCalendars();
      expect(calendars.length).toBe(2);
    });

    test("maps Swift calendar to CalendarInfo", async () => {
      const client = await createAppleCalendarClient();
      const calendars = await client!.getCalendars();
      expect(calendars[0].id).toBe("c1");
      expect(calendars[0].title).toBe("Work");
      expect(calendars[0].color).toBe("#000000");
      expect(calendars[0].type).toBe("calDAV");
    });

    test('filters by APPLE_CALENDAR_NAMES="Work"', async () => {
      process.env.APPLE_CALENDAR_NAMES = "Work";
      const client = await createAppleCalendarClient();
      const calendars = await client!.getCalendars();
      expect(calendars.length).toBe(1);
      expect(calendars[0].title).toBe("Work");
    });

    test("returns [] when filter matches none", async () => {
      process.env.APPLE_CALENDAR_NAMES = "Nonexistent";
      const client = await createAppleCalendarClient();
      const calendars = await client!.getCalendars();
      expect(calendars).toEqual([]);
    });

    test("filter is captured at factory construction time", async () => {
      process.env.APPLE_CALENDAR_NAMES = "Work";
      const client = await createAppleCalendarClient();

      // Change env AFTER factory construction
      process.env.APPLE_CALENDAR_NAMES = "Personal";

      const calendars = await client!.getCalendars();
      // Should still use "Work" (captured at construction), not "Personal"
      expect(calendars.length).toBe(1);
      expect(calendars[0].title).toBe("Work");
    });
  });

  // ── getTodayEvents() ────────────────────────────────────────────────────
  describe("getTodayEvents()", () => {
    let savedNames: string | undefined;
    beforeEach(() => {
      savedNames = process.env.APPLE_CALENDAR_NAMES;
      delete process.env.APPLE_CALENDAR_NAMES;
    });
    afterEach(() => {
      if (savedNames === undefined) delete process.env.APPLE_CALENDAR_NAMES;
      else process.env.APPLE_CALENDAR_NAMES = savedNames;
    });

    test("passes date-only strings to list-events", async () => {
      const client = await createAppleCalendarClient();
      await client!.getTodayEvents();
      const listCall = mockCallLog.find(c => c[0] === "list-events");
      expect(listCall).toBeDefined();
      expect(listCall![1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(listCall![2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test("converts Swift events to AppleCalendarEvent", async () => {
      // Override list-events mock for this test
      const origMock = _deps.runCalendarHelper;
      _deps.runCalendarHelper = async <T>(args: string[]): Promise<T> => {
        mockCallLog.push(args);
        if (args[0] === "check-access") return { status: "full_access", has_real_calendars: true } as T;
        if (args[0] === "list-events") return {
          events: [{
            id: "e1", title: "Team Standup",
            start: "2026-03-18T01:00:00Z", end: "2026-03-18T02:00:00Z",
            all_day: false, calendar_id: "c1", calendar_title: "Work", location: "Zoom",
          }], count: 1,
        } as T;
        return origMock(args);
      };
      const client = await createAppleCalendarClient();
      const events = await client!.getTodayEvents();
      expect(events.length).toBe(1);
      expect(events[0].id).toBe("e1");
      expect(events[0].title).toBe("Team Standup");
      expect(events[0].start).toBeInstanceOf(Date);
      expect(events[0].start.toISOString()).toBe("2026-03-18T01:00:00.000Z");
      expect(events[0].isAllDay).toBe(false);
      expect(events[0].calendar).toBe("Work");
      expect(events[0].location).toBe("Zoom");
    });

    test("filters by APPLE_CALENDAR_NAMES", async () => {
      process.env.APPLE_CALENDAR_NAMES = "Work";
      _deps.runCalendarHelper = async <T>(args: string[]): Promise<T> => {
        mockCallLog.push(args);
        if (args[0] === "check-access") return { status: "full_access", has_real_calendars: true } as T;
        if (args[0] === "list-events") return {
          events: [
            { id: "e1", title: "Work Meeting", start: "2026-03-18T01:00:00Z", end: "2026-03-18T02:00:00Z", all_day: false, calendar_id: "c1", calendar_title: "Work" },
            { id: "e2", title: "Gym", start: "2026-03-18T10:00:00Z", end: "2026-03-18T11:00:00Z", all_day: false, calendar_id: "c2", calendar_title: "Personal" },
          ], count: 2,
        } as T;
        throw new Error(`Mock: no handler for ${args[0]}`);
      };
      const client = await createAppleCalendarClient();
      const events = await client!.getTodayEvents();
      expect(events.length).toBe(1);
      expect(events[0].title).toBe("Work Meeting");
    });
  });

  // ── deleteEvent() ─────────────────────────────────────────────────────
  describe("deleteEvent()", () => {
    test("calls delete-event with event ID", async () => {
      setupMock({
        "check-access": { status: "full_access", has_real_calendars: true },
        "delete-event": { ok: true },
      });
      const client = await createAppleCalendarClient();
      await client!.deleteEvent("evt-123");
      const delCall = mockCallLog.find(c => c[0] === "delete-event");
      expect(delCall).toEqual(["delete-event", "evt-123"]);
    });
  });
});
