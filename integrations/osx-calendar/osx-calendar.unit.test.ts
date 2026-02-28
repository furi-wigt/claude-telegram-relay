/**
 * OSX Calendar Integration — unit tests for pure functions & factory.
 * All JXA calls are mocked; no real osascript or Calendar.app access needed.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { RawEvent } from "./jxa.ts";

// ── Mock JXA layer (before any import of index.ts) ──────────────────────────
// bun's mock.module uses the factory-returned functions directly, so we use
// mutable handler closures that tests can swap per-test.
let checkCalendarAccessHandler: () => Promise<boolean> = () => Promise.resolve(true);
let listCalendarsJXAHandler: () => Promise<{ id: string; title: string }[]> = () => Promise.resolve([]);
let getEventsInRangeJXAHandler: (...args: any[]) => Promise<RawEvent[]> = () => Promise.resolve([]);
let createEventJXAHandler: (...args: any[]) => Promise<{ ok: boolean }> = () => Promise.resolve({ ok: true });
let deleteEventJXAHandler: (...args: any[]) => Promise<{ ok: boolean }> = () => Promise.resolve({ ok: true });

// Track call counts manually since mock.module uses the factory functions directly
let checkCalendarAccessCallCount = 0;
let listCalendarsJXACallCount = 0;

mock.module("./jxa.ts", () => ({
  checkCalendarAccess: () => { checkCalendarAccessCallCount++; return checkCalendarAccessHandler(); },
  listCalendarsJXA: () => { listCalendarsJXACallCount++; return listCalendarsJXAHandler(); },
  getEventsInRangeJXA: (...args: any[]) => getEventsInRangeJXAHandler(...args),
  createEventJXA: (...args: any[]) => createEventJXAHandler(...args),
  deleteEventJXA: (...args: any[]) => deleteEventJXAHandler(...args),
}));

const {
  createAppleCalendarClient,
  getUserTimezone,
  getFilteredCalendarNames,
  tzMidnight,
  startOfDay,
  endOfDay,
  rawToEvent,
  rawToCalendarInfo,
} = await import("./index.ts");

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
      // 2025-02-25T06:00:00Z = 2025-02-25T14:00:00 SGT → midnight SGT = 2025-02-24T16:00:00Z
      const input = new Date("2025-02-25T06:00:00Z");
      expect(tzMidnight(input).toISOString()).toBe("2025-02-24T16:00:00.000Z");
    });

    test("just before midnight SGT returns previous day midnight", () => {
      // 2025-02-24T15:59:59Z = 2025-02-24T23:59:59 SGT → midnight SGT = 2025-02-23T16:00:00Z
      const input = new Date("2025-02-24T15:59:59Z");
      expect(tzMidnight(input).toISOString()).toBe("2025-02-23T16:00:00.000Z");
    });

    test("exactly at midnight SGT returns that midnight", () => {
      // 2025-02-24T16:00:00Z = 2025-02-25T00:00:00 SGT → midnight = same
      const input = new Date("2025-02-24T16:00:00Z");
      expect(tzMidnight(input).toISOString()).toBe("2025-02-24T16:00:00.000Z");
    });

    test("one second past midnight SGT returns that midnight", () => {
      const input = new Date("2025-02-24T16:00:01Z");
      expect(tzMidnight(input).toISOString()).toBe("2025-02-24T16:00:00.000Z");
    });

    test("month boundary (last moment Jan to Feb 1)", () => {
      // 2025-01-31T16:00:00Z = 2025-02-01T00:00:00 SGT → midnight = 2025-01-31T16:00:00Z
      const input = new Date("2025-01-31T16:00:00Z");
      expect(tzMidnight(input).toISOString()).toBe("2025-01-31T16:00:00.000Z");
    });

    test("year boundary", () => {
      // 2024-12-31T20:00:00Z = 2025-01-01T04:00:00 SGT → midnight SGT = 2024-12-31T16:00:00Z
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
    // 14:00 SGT on 2025-02-25 → end of day = 23:59:59.999 SGT = 15:59:59.999Z
    expect(endOfDay(input).toISOString()).toBe("2025-02-25T15:59:59.999Z");
  });

  test("morning input same day", () => {
    // 2025-02-25T00:00:00Z = 2025-02-25T08:00:00 SGT → end of day = 23:59:59.999 SGT = 15:59:59.999Z
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
    // 2025-01-31T05:00:00Z = 2025-01-31T13:00:00 SGT → end of day = 23:59:59.999 SGT = 15:59:59.999Z
    const input = new Date("2025-01-31T05:00:00Z");
    expect(endOfDay(input).toISOString()).toBe("2025-01-31T15:59:59.999Z");
  });

  test("returns instanceof Date", () => {
    const input = new Date("2025-02-25T06:00:00Z");
    expect(endOfDay(input)).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rawToEvent()
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
// rawToCalendarInfo()
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
// createAppleCalendarClient() factory
// ─────────────────────────────────────────────────────────────────────────────
describe("createAppleCalendarClient() factory", () => {
  beforeEach(() => {
    checkCalendarAccessHandler = () => Promise.resolve(true);
    listCalendarsJXAHandler = () => Promise.resolve([]);
    checkCalendarAccessCallCount = 0;
    listCalendarsJXACallCount = 0;
  });

  test("returns null when checkCalendarAccess returns false", async () => {
    checkCalendarAccessHandler = () => Promise.resolve(false);
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

  test("calls checkCalendarAccess exactly once", async () => {
    await createAppleCalendarClient();
    expect(checkCalendarAccessCallCount).toBe(1);
  });

  test("does NOT call listCalendarsJXA during factory construction", async () => {
    await createAppleCalendarClient();
    expect(listCalendarsJXACallCount).toBe(0);
  });

  test("throws when checkCalendarAccess rejects", () => {
    checkCalendarAccessHandler = () => Promise.reject(new Error("access error"));
    expect(createAppleCalendarClient()).rejects.toThrow();
  });

  // ── getCalendars() ──────────────────────────────────────────────────────
  describe("getCalendars()", () => {
    let savedNames: string | undefined;

    beforeEach(() => {
      savedNames = process.env.APPLE_CALENDAR_NAMES;
      // Clear to avoid host env pollution (e.g. user has APPLE_CALENDAR_NAMES set)
      delete process.env.APPLE_CALENDAR_NAMES;
    });

    afterEach(() => {
      if (savedNames === undefined) {
        delete process.env.APPLE_CALENDAR_NAMES;
      } else {
        process.env.APPLE_CALENDAR_NAMES = savedNames;
      }
    });

    test("returns [] when listCalendarsJXA returns []", async () => {
      const client = await createAppleCalendarClient();
      const calendars = await client!.getCalendars();
      expect(calendars).toEqual([]);
    });

    test("maps raw calendar correctly", async () => {
      listCalendarsJXAHandler = () =>
        Promise.resolve([{ id: "c1", title: "Work" }]);
      const client = await createAppleCalendarClient();
      const calendars = await client!.getCalendars();
      expect(calendars.length).toBe(1);
      expect(calendars[0].id).toBe("c1");
      expect(calendars[0].title).toBe("Work");
      expect(calendars[0].color).toBe("#000000");
      expect(calendars[0].type).toBe("calDAV");
    });

    test("returns all calendars when APPLE_CALENDAR_NAMES not set", async () => {
      listCalendarsJXAHandler = () =>
        Promise.resolve([
          { id: "c1", title: "Work" },
          { id: "c2", title: "Personal" },
          { id: "c3", title: "Family" },
        ]);
      const client = await createAppleCalendarClient();
      const calendars = await client!.getCalendars();
      expect(calendars.length).toBe(3);
    });

    test('filters by APPLE_CALENDAR_NAMES="Work"', async () => {
      process.env.APPLE_CALENDAR_NAMES = "Work";
      listCalendarsJXAHandler = () =>
        Promise.resolve([
          { id: "c1", title: "Work" },
          { id: "c2", title: "Personal" },
        ]);
      const client = await createAppleCalendarClient();
      const calendars = await client!.getCalendars();
      expect(calendars.length).toBe(1);
      expect(calendars[0].title).toBe("Work");
    });

    test("returns [] when filter matches none", async () => {
      process.env.APPLE_CALENDAR_NAMES = "Nonexistent";
      listCalendarsJXAHandler = () =>
        Promise.resolve([
          { id: "c1", title: "Work" },
          { id: "c2", title: "Personal" },
        ]);
      const client = await createAppleCalendarClient();
      const calendars = await client!.getCalendars();
      expect(calendars).toEqual([]);
    });

    test("filter is captured at factory construction time", async () => {
      process.env.APPLE_CALENDAR_NAMES = "Work";
      listCalendarsJXAHandler = () =>
        Promise.resolve([
          { id: "c1", title: "Work" },
          { id: "c2", title: "Personal" },
        ]);
      const client = await createAppleCalendarClient();

      // Change env AFTER factory construction
      process.env.APPLE_CALENDAR_NAMES = "Personal";

      const calendars = await client!.getCalendars();
      // Should still use "Work" (captured at construction), not "Personal"
      expect(calendars.length).toBe(1);
      expect(calendars[0].title).toBe("Work");
    });
  });
});
