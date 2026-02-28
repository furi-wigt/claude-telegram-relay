/**
 * E2E test for the macOS Calendar integration — NO mocking.
 * Calls the real JXA pipeline: createAppleCalendarClient() → getTodayEvents().
 *
 * Why not test getTodayCalendarEvents() directly?
 * That wrapper has an 8s shared budget across two JXA calls — in the test
 * runner, checkCalendarAccess() alone takes ~3-4s, leaving too little time
 * for getTodayEvents(). Here we call the client directly with a generous
 * per-call budget and require real events (not null).
 *
 * Prerequisites:
 *   bun run integrations/osx-calendar/grant-permission.ts
 *
 * Run:
 *   RUN_INTEGRATION_TESTS=1 bun test routines/morning-summary.calendar.e2e.test.ts
 */

import { describe, test, expect } from "bun:test";
import { createAppleCalendarClient } from "../integrations/osx-calendar/index.ts";

const SKIP = !process.env.RUN_INTEGRATION_TESTS || process.platform !== "darwin";

describe.skipIf(SKIP)("Calendar.app e2e (no mocks)", () => {
  test(
    "createAppleCalendarClient() connects and getTodayEvents() returns a valid array",
    async () => {
      // Scope to GovTech calendar — small, work events, no massive recurring sets.
      // Override env so createAppleCalendarClient honours the filter.
      process.env.APPLE_CALENDAR_NAMES = process.env.APPLE_CALENDAR_NAMES ?? "GovTech";

      const cal = await createAppleCalendarClient();
      expect(cal).not.toBeNull(); // fail fast if Calendar access was not granted

      const events = await cal!.getTodayEvents();
      expect(Array.isArray(events)).toBe(true);

      console.log(`Calendar.app: ${events.length} event(s) today`);

      for (const event of events) {
        expect(typeof event.id).toBe("string");
        expect(event.id.length).toBeGreaterThan(0);
        expect(typeof event.title).toBe("string");
        expect(event.start).toBeInstanceOf(Date);
        expect(event.end).toBeInstanceOf(Date);
        expect(event.start.getTime()).toBeLessThanOrEqual(event.end.getTime());
        expect(typeof event.isAllDay).toBe("boolean");
        expect(typeof event.calendar).toBe("string");
        expect(event.calendar.length).toBeGreaterThan(0);
        if (event.location !== undefined) expect(typeof event.location).toBe("string");
        if (event.notes !== undefined) expect(typeof event.notes).toBe("string");
      }
    },
    30_000 // 30s — two JXA calls in series on a cold run
  );
});
