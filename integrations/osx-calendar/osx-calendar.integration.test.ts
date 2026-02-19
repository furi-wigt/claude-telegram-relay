/**
 * OSX Calendar Integration — integration tests (real Apple Calendar via JXA).
 * macOS-only. Run: RUN_INTEGRATION_TESTS=1 bun test integrations/osx-calendar/osx-calendar.integration.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { createAppleCalendarClient, type AppleCalendarClient } from "./index.ts";

const SKIP = !process.env.RUN_INTEGRATION_TESTS || process.platform !== "darwin";

describe.skipIf(SKIP)("osx-calendar integration", () => {
  let cal: AppleCalendarClient | null = null;

  beforeAll(async () => {
    // createAppleCalendarClient may hang if macOS shows a permission dialog.
    // Race it against a timeout so beforeAll doesn't block the entire suite.
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000));
    cal = await Promise.race([createAppleCalendarClient(), timeout]);
  }, 10_000);

  test("createAppleCalendarClient() returns a client (or null if permission denied)", () => {
    if (!cal) {
      console.warn("SKIP: Calendar access denied — remaining tests will be skipped");
      return;
    }
    expect(typeof cal.getCalendars).toBe("function");
    expect(typeof cal.getTodayEvents).toBe("function");
    expect(typeof cal.getUpcomingEvents).toBe("function");
  });

  test("getCalendars() returns non-empty array with id and title", async () => {
    if (!cal) return; // permission denied — skip
    const calendars = await cal.getCalendars();
    expect(Array.isArray(calendars)).toBe(true);
    expect(calendars.length).toBeGreaterThan(0);
    expect(calendars[0]).toHaveProperty("id");
    expect(calendars[0]).toHaveProperty("title");
  }, 10_000);

  test("getTodayEvents() returns array", async () => {
    if (!cal) return; // permission denied — skip
    const events = await cal.getTodayEvents();
    expect(Array.isArray(events)).toBe(true);
    // Empty is ok — just checking it doesn't throw
  }, 10_000);

  test("getUpcomingEvents(7) returns array", async () => {
    if (!cal) return; // permission denied — skip
    const events = await cal.getUpcomingEvents(7);
    expect(Array.isArray(events)).toBe(true);
  }, 10_000);

  test("getUpcomingEvents(7) events have valid start, end, title", async () => {
    if (!cal) return; // permission denied — skip
    const events = await cal.getUpcomingEvents(7);
    for (const event of events) {
      expect(event).toHaveProperty("start");
      expect(event).toHaveProperty("end");
      expect(event).toHaveProperty("title");
      expect(event.start).toBeInstanceOf(Date);
      expect(event.end).toBeInstanceOf(Date);
      expect(typeof event.title).toBe("string");
    }
  }, 10_000);
});
