/**
 * Unit tests for the calendar path in routines/morning-summary.ts
 *
 * Tests three aspects of the calendar integration:
 *   1. formatCalendarEvent()     — pure formatter, no I/O
 *   2. getTodayCalendarEvents()  — mocked calendar client
 *   3. buildEnhancedBriefing()   — calendar section presence/absence
 *
 * All Apple Calendar calls are mocked — no macOS dependency required.
 *
 * Run: bun test routines/morning-summary.calendar.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { AppleCalendarEvent } from "../integrations/osx-calendar/index.ts";

// ============================================================
// Mock declarations — BEFORE importing morning-summary.ts
// ============================================================

// -- Calendar client mock --
const mockGetTodayEvents = mock(() => Promise.resolve([] as AppleCalendarEvent[]));
const mockCreateAppleCalendarClient = mock(() =>
  Promise.resolve({
    getTodayEvents: mockGetTodayEvents,
    getCalendars: mock(() => Promise.resolve([])),
    getUpcomingEvents: mock(() => Promise.resolve([])),
    getEventsInRange: mock(() => Promise.resolve([])),
    createEvent: mock(() => Promise.resolve()),
    deleteEvent: mock(() => Promise.resolve()),
  })
);

mock.module("../integrations/osx-calendar/index.ts", () => ({
  createAppleCalendarClient: mockCreateAppleCalendarClient,
}));

// -- User config mock (deterministic timezone for formatting tests) --
mock.module("../src/config/userConfig.ts", () => ({
  USER_NAME: "TestUser",
  USER_TIMEZONE: "Asia/Singapore",
}));

// -- Weather mock (return sensible defaults so buildEnhancedBriefing doesn't crash) --
mock.module("../integrations/weather/index.ts", () => ({
  createWeatherClient: () => ({
    getMorningSummary: async () => ({
      forecast24h: "Partly Cloudy (25-33C)",
      airQuality: "PSI 42 (Good)",
      uvIndex: 5,
    }),
    get2HourForecast: async () => [],
  }),
}));

// -- Supabase mock (return empty results for activity/goals) --
// Fluent-chainable query builder: every method returns itself, await resolves to empty.
const emptyResult = { data: [], count: 0, error: null };

mock.module("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      const q: any = (..._a: any[]) => q;
      q.then = (resolve: any) => resolve(emptyResult);
      q.select = (..._a: any[]) => q;
      q.eq = (..._a: any[]) => q;
      q.gte = (..._a: any[]) => q;
      q.lt = (..._a: any[]) => q;
      q.is = (..._a: any[]) => q;
      q.order = (..._a: any[]) => q;
      q.limit = (..._a: any[]) => q;
      return q;
    },
  }),
}));

// -- Claude process mock (return simple strings for recap/tasks) --
mock.module("../src/claude-process.ts", () => ({
  claudeText: async () => "[]",
}));

// -- Groups mock (not used directly by buildEnhancedBriefing but imported at module level) --
mock.module("../src/config/groups.ts", () => ({
  GROUPS: {
    GENERAL: { chatId: 12345, topicId: null },
  },
  validateGroup: () => true,
}));

// -- Routine message mock (imported at module level) --
mock.module("../src/utils/routineMessage.ts", () => ({
  sendAndRecord: async () => {},
}));

// ============================================================
// Dynamic import AFTER all mocks are registered
// ============================================================

const {
  formatCalendarEvent,
  getTodayCalendarEvents,
  buildEnhancedBriefing,
} = await import("./morning-summary.ts");

// ============================================================
// Test data helpers
// ============================================================

function makeTimedEvent(overrides: Partial<AppleCalendarEvent> = {}): AppleCalendarEvent {
  return {
    id: "event-1",
    title: "Team Standup",
    start: new Date("2025-02-25T01:00:00Z"), // 09:00 SGT (UTC+8)
    end: new Date("2025-02-25T01:30:00Z"),   // 09:30 SGT
    isAllDay: false,
    calendar: "Work",
    ...overrides,
  };
}

function makeAllDayEvent(overrides: Partial<AppleCalendarEvent> = {}): AppleCalendarEvent {
  return {
    id: "event-allday",
    title: "Public Holiday",
    start: new Date("2025-02-25T00:00:00Z"),
    end: new Date("2025-02-25T23:59:59Z"),
    isAllDay: true,
    calendar: "Holidays",
    ...overrides,
  };
}

// ============================================================
// Reset mocks before each test
// ============================================================

beforeEach(() => {
  mockCreateAppleCalendarClient.mockReset();
  mockGetTodayEvents.mockReset();

  // Default: calendar client exists with empty events
  mockGetTodayEvents.mockImplementation(() => Promise.resolve([]));
  mockCreateAppleCalendarClient.mockImplementation(() =>
    Promise.resolve({
      getTodayEvents: mockGetTodayEvents,
      getCalendars: mock(() => Promise.resolve([])),
      getUpcomingEvents: mock(() => Promise.resolve([])),
      getEventsInRange: mock(() => Promise.resolve([])),
      createEvent: mock(() => Promise.resolve()),
      deleteEvent: mock(() => Promise.resolve()),
    })
  );
});

// ============================================================
// formatCalendarEvent() — pure function
// ============================================================

describe("formatCalendarEvent()", () => {
  test("formats an all-day event as 'All day -- title'", () => {
    const event = makeAllDayEvent({ title: "National Day" });
    const result = formatCalendarEvent(event);
    expect(result).toBe("All day \u2014 National Day");
  });

  test("formats a timed event with start-end in HH:MM 24h format", () => {
    // 2025-02-25T01:00:00Z = 09:00 SGT, 01:30Z = 09:30 SGT
    const event = makeTimedEvent({
      title: "Sprint Planning",
      start: new Date("2025-02-25T01:00:00Z"),
      end: new Date("2025-02-25T02:00:00Z"),
    });
    const result = formatCalendarEvent(event);
    // Should be "09:00-10:00 -- Sprint Planning" in Asia/Singapore
    expect(result).toContain("09:00");
    expect(result).toContain("10:00");
    expect(result).toContain("Sprint Planning");
    expect(result).toContain("\u2014"); // em dash
  });

  test("formats afternoon event times correctly in SGT", () => {
    // 2025-02-25T06:00:00Z = 14:00 SGT, 07:00Z = 15:00 SGT
    const event = makeTimedEvent({
      title: "Client Call",
      start: new Date("2025-02-25T06:00:00Z"),
      end: new Date("2025-02-25T07:00:00Z"),
    });
    const result = formatCalendarEvent(event);
    expect(result).toContain("14:00");
    expect(result).toContain("15:00");
    expect(result).toContain("Client Call");
  });

  test("does not include time for all-day events", () => {
    const event = makeAllDayEvent({ title: "Leave Day" });
    const result = formatCalendarEvent(event);
    expect(result).toBe("All day \u2014 Leave Day");
    // Should NOT contain colon-separated time
    expect(result).not.toMatch(/\d{2}:\d{2}/);
  });

  test("preserves special characters in event title", () => {
    const event = makeTimedEvent({ title: "Q&A Session (Team #3)" });
    const result = formatCalendarEvent(event);
    expect(result).toContain("Q&A Session (Team #3)");
  });

  test("handles event with empty title", () => {
    const event = makeTimedEvent({ title: "" });
    const result = formatCalendarEvent(event);
    // Should still format without crashing, ending with em dash and empty title
    expect(result).toContain("\u2014");
  });
});

// ============================================================
// getTodayCalendarEvents() — mocked calendar client
// ============================================================

describe("getTodayCalendarEvents()", () => {
  test("returns null when createAppleCalendarClient returns null (permission denied)", async () => {
    mockCreateAppleCalendarClient.mockImplementation(() => Promise.resolve(null));

    const result = await getTodayCalendarEvents();
    expect(result).toBeNull();
  });

  test("returns events when calendar client succeeds", async () => {
    const events: AppleCalendarEvent[] = [
      makeTimedEvent({ title: "Morning Meeting" }),
      makeAllDayEvent({ title: "Company Holiday" }),
    ];
    mockGetTodayEvents.mockImplementation(() => Promise.resolve(events));

    const result = await getTodayCalendarEvents();
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0].title).toBe("Morning Meeting");
    expect(result![1].title).toBe("Company Holiday");
  });

  test("returns empty array when no events today", async () => {
    mockGetTodayEvents.mockImplementation(() => Promise.resolve([]));

    const result = await getTodayCalendarEvents();
    expect(result).not.toBeNull();
    expect(result).toHaveLength(0);
  });

  test("returns null when createAppleCalendarClient throws", async () => {
    mockCreateAppleCalendarClient.mockImplementation(() =>
      Promise.reject(new Error("JXA subprocess crashed"))
    );

    const result = await getTodayCalendarEvents();
    expect(result).toBeNull();
  });

  test("returns null when getTodayEvents throws", async () => {
    mockGetTodayEvents.mockImplementation(() =>
      Promise.reject(new Error("osascript timeout"))
    );

    const result = await getTodayCalendarEvents();
    expect(result).toBeNull();
  });

  test("calls createAppleCalendarClient exactly once", async () => {
    await getTodayCalendarEvents();
    expect(mockCreateAppleCalendarClient).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// buildEnhancedBriefing() — calendar section integration
// ============================================================

describe("buildEnhancedBriefing() calendar section", () => {
  test("includes calendar section when events are present", async () => {
    const events: AppleCalendarEvent[] = [
      makeTimedEvent({ title: "Design Review" }),
      makeAllDayEvent({ title: "Team Offsite" }),
    ];
    mockGetTodayEvents.mockImplementation(() => Promise.resolve(events));

    const { message } = await buildEnhancedBriefing();

    expect(message).toContain("Today's Calendar");
    expect(message).toContain("Design Review");
    expect(message).toContain("Team Offsite");
  });

  test("omits calendar section when calendar client returns null", async () => {
    mockCreateAppleCalendarClient.mockImplementation(() => Promise.resolve(null));

    const { message } = await buildEnhancedBriefing();

    expect(message).not.toContain("Today's Calendar");
    // Rest of briefing should still work
    expect(message).toContain("Good morning");
    expect(message).toContain("Weather");
  });

  test("omits calendar section when events array is empty", async () => {
    mockGetTodayEvents.mockImplementation(() => Promise.resolve([]));

    const { message } = await buildEnhancedBriefing();

    expect(message).not.toContain("Today's Calendar");
    // Rest of briefing should still work
    expect(message).toContain("Good morning");
  });

  test("omits calendar section when calendar throws error", async () => {
    mockCreateAppleCalendarClient.mockImplementation(() =>
      Promise.reject(new Error("Calendar access revoked"))
    );

    const { message } = await buildEnhancedBriefing();

    expect(message).not.toContain("Today's Calendar");
    // Briefing should still render other sections
    expect(message).toContain("Good morning");
    expect(message).toContain("Weather");
  });

  test("preserves event order from calendar client", async () => {
    const events: AppleCalendarEvent[] = [
      makeTimedEvent({ id: "e1", title: "First: 08:00 standup", start: new Date("2025-02-25T00:00:00Z"), end: new Date("2025-02-25T00:30:00Z") }),
      makeTimedEvent({ id: "e2", title: "Second: 10:00 review", start: new Date("2025-02-25T02:00:00Z"), end: new Date("2025-02-25T03:00:00Z") }),
      makeTimedEvent({ id: "e3", title: "Third: 14:00 call", start: new Date("2025-02-25T06:00:00Z"), end: new Date("2025-02-25T07:00:00Z") }),
    ];
    mockGetTodayEvents.mockImplementation(() => Promise.resolve(events));

    const { message } = await buildEnhancedBriefing();

    const firstIdx = message.indexOf("First: 08:00 standup");
    const secondIdx = message.indexOf("Second: 10:00 review");
    const thirdIdx = message.indexOf("Third: 14:00 call");

    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(thirdIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  test("renders each event as a bullet point", async () => {
    const events: AppleCalendarEvent[] = [
      makeTimedEvent({ title: "Alpha Meeting" }),
      makeAllDayEvent({ title: "Beta Holiday" }),
    ];
    mockGetTodayEvents.mockImplementation(() => Promise.resolve(events));

    const { message } = await buildEnhancedBriefing();
    const lines = message.split("\n");

    const calendarLines = lines.filter(
      (l) => l.includes("Alpha Meeting") || l.includes("Beta Holiday")
    );
    // Each should be a bullet point
    for (const line of calendarLines) {
      expect(line.trimStart().startsWith("\u2022")).toBe(true);
    }
  });

  test("all-day events in briefing show 'All day' prefix", async () => {
    const events: AppleCalendarEvent[] = [
      makeAllDayEvent({ title: "Company Retreat" }),
    ];
    mockGetTodayEvents.mockImplementation(() => Promise.resolve(events));

    const { message } = await buildEnhancedBriefing();

    expect(message).toContain("All day");
    expect(message).toContain("Company Retreat");
  });

  test("timed events in briefing show time range", async () => {
    // 01:00Z = 09:00 SGT, 02:00Z = 10:00 SGT
    const events: AppleCalendarEvent[] = [
      makeTimedEvent({
        title: "Sprint Demo",
        start: new Date("2025-02-25T01:00:00Z"),
        end: new Date("2025-02-25T02:00:00Z"),
      }),
    ];
    mockGetTodayEvents.mockImplementation(() => Promise.resolve(events));

    const { message } = await buildEnhancedBriefing();

    expect(message).toContain("09:00");
    expect(message).toContain("10:00");
    expect(message).toContain("Sprint Demo");
  });

  test("briefing still includes greeting and weather when calendar is unavailable", async () => {
    mockCreateAppleCalendarClient.mockImplementation(() => Promise.resolve(null));

    const { message } = await buildEnhancedBriefing();

    // Header
    expect(message).toContain("Good morning TestUser");
    // Weather section
    expect(message).toContain("Weather Update");
    // Suggested tasks section (fallback tasks should appear)
    expect(message).toContain("Suggested Tasks");
  });

  test("single event renders correctly in briefing", async () => {
    const events: AppleCalendarEvent[] = [
      makeTimedEvent({
        title: "One-on-One with Manager",
        start: new Date("2025-02-25T03:00:00Z"), // 11:00 SGT
        end: new Date("2025-02-25T03:30:00Z"),   // 11:30 SGT
      }),
    ];
    mockGetTodayEvents.mockImplementation(() => Promise.resolve(events));

    const { message } = await buildEnhancedBriefing();

    expect(message).toContain("Today's Calendar");
    expect(message).toContain("One-on-One with Manager");
    expect(message).toContain("11:00");
    expect(message).toContain("11:30");
  });
});
