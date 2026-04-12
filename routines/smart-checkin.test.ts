/**
 * Unit tests for routines/handlers/smart-checkin.ts
 *
 * Tests the exported pure functions:
 *   - isWithinSchedule()      — depends on USER_TIMEZONE
 *   - detectMeetingContext()  — pure, given events + state
 *   - formatCalendarEvent()   — pure formatter
 *
 * Run: bun test routines/smart-checkin.test.ts
 */

import { describe, it, expect } from "bun:test";
import {
  isWithinSchedule,
  detectMeetingContext,
  formatCalendarEvent,
  type MeetingContext,
} from "./handlers/smart-checkin.ts";
import type { AppleCalendarEvent } from "../integrations/osx-calendar/index.ts";

// ============================================================
// Shared helpers
// ============================================================

function makeEvent(overrides: Partial<AppleCalendarEvent> = {}): AppleCalendarEvent {
  return {
    id: "event-1",
    title: "Test Meeting",
    start: new Date(Date.now() + 20 * 60 * 1000), // 20 min from now
    end: new Date(Date.now() + 50 * 60 * 1000),
    isAllDay: false,
    calendar: "Work",
    ...overrides,
  };
}

function makeState(overrides: Partial<{
  lastMessageTime: string;
  lastCheckinTime: string;
  lastMeetingPrepId: string | null;
  pendingItems: string[];
}> = {}) {
  return {
    lastMessageTime: new Date().toISOString(),
    lastCheckinTime: "",
    lastMeetingPrepId: null,
    pendingItems: [],
    ...overrides,
  };
}

// ============================================================
// isWithinSchedule() — schedule guard
// ============================================================

describe("isWithinSchedule()", () => {
  it("returns a boolean", () => {
    const result = isWithinSchedule();
    expect(typeof result).toBe("boolean");
  });
});

// ============================================================
// detectMeetingContext() — pure function
// ============================================================

describe("detectMeetingContext()", () => {
  it("returns no meetings when events is null", () => {
    const ctx = detectMeetingContext(null, makeState());
    expect(ctx.upcomingMeeting).toBeNull();
    expect(ctx.recentlyEndedMeeting).toBeNull();
  });

  it("returns no meetings when events array is empty", () => {
    const ctx = detectMeetingContext([], makeState());
    expect(ctx.upcomingMeeting).toBeNull();
    expect(ctx.recentlyEndedMeeting).toBeNull();
  });

  it("detects upcoming meeting within 30 min", () => {
    const event = makeEvent({
      title: "Team Standup",
      start: new Date(Date.now() + 15 * 60 * 1000), // 15 min from now
      end: new Date(Date.now() + 30 * 60 * 1000),
    });
    const ctx = detectMeetingContext([event], makeState());
    expect(ctx.upcomingMeeting).not.toBeNull();
    expect(ctx.upcomingMeeting?.title).toBe("Team Standup");
  });

  it("does not re-notify for the same meeting already prepped", () => {
    const event = makeEvent({
      title: "Design Review",
      start: new Date(Date.now() + 10 * 60 * 1000),
    });
    const state = makeState({ lastMeetingPrepId: "Design Review" });
    const ctx = detectMeetingContext([event], state);
    expect(ctx.upcomingMeeting).toBeNull();
  });

  it("does not flag meeting starting more than 30 min away as upcoming", () => {
    const event = makeEvent({
      start: new Date(Date.now() + 35 * 60 * 1000), // 35 min away
      end: new Date(Date.now() + 65 * 60 * 1000),
    });
    const ctx = detectMeetingContext([event], makeState());
    expect(ctx.upcomingMeeting).toBeNull();
  });

  it("does not flag already-started meeting as upcoming", () => {
    const event = makeEvent({
      start: new Date(Date.now() - 5 * 60 * 1000), // started 5 min ago
      end: new Date(Date.now() + 25 * 60 * 1000),
    });
    const ctx = detectMeetingContext([event], makeState());
    expect(ctx.upcomingMeeting).toBeNull();
  });

  it("detects recently ended meeting (within 30 min)", () => {
    const event = makeEvent({
      title: "Sprint Review",
      start: new Date(Date.now() - 60 * 60 * 1000), // started 60 min ago
      end: new Date(Date.now() - 10 * 60 * 1000),   // ended 10 min ago
    });
    const ctx = detectMeetingContext([event], makeState());
    expect(ctx.recentlyEndedMeeting).not.toBeNull();
    expect(ctx.recentlyEndedMeeting?.title).toBe("Sprint Review");
  });

  it("does not flag all-day events as meetings", () => {
    const event = makeEvent({ isAllDay: true });
    const ctx = detectMeetingContext([event], makeState());
    expect(ctx.upcomingMeeting).toBeNull();
    expect(ctx.recentlyEndedMeeting).toBeNull();
  });
});

// ============================================================
// formatCalendarEvent() — pure formatter
// ============================================================

describe("formatCalendarEvent()", () => {
  it("formats all-day event as 'All day — Title'", () => {
    const event = makeEvent({ title: "Public Holiday", isAllDay: true });
    const result = formatCalendarEvent(event);
    expect(result).toBe("All day \u2014 Public Holiday");
  });

  it("includes event title in formatted output", () => {
    const event = makeEvent({ title: "Unique Title XYZ" });
    const result = formatCalendarEvent(event);
    expect(result).toContain("Unique Title XYZ");
  });

  it("formats timed event with HH:MM times", () => {
    const event = makeEvent({
      title: "Sprint Planning",
      start: new Date("2025-02-25T01:00:00Z"), // 09:00 SGT
      end: new Date("2025-02-25T02:00:00Z"),   // 10:00 SGT
    });
    const result = formatCalendarEvent(event);
    expect(result).toMatch(/\d{2}:\d{2}/); // at least one time
    expect(result).toContain("Sprint Planning");
  });

  it("uses em dash separator", () => {
    const event = makeEvent({ title: "Meeting" });
    const result = formatCalendarEvent(event);
    expect(result).toContain("\u2014");
  });
});
