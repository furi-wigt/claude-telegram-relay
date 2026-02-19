/**
 * Things 3 Integration — integration tests (real Things app via URL scheme + clings CLI).
 * macOS-only. Run: RUN_INTEGRATION_TESTS=1 bun test integrations/things/things.integration.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { createThingsClient, type ThingsClient } from "./index.ts";

const SKIP = !process.env.RUN_INTEGRATION_TESTS || process.platform !== "darwin";

describe.skipIf(SKIP)("things integration", () => {
  let things: ThingsClient;

  beforeAll(() => {
    things = createThingsClient();
  });

  test("createThingsClient() returns a client", () => {
    expect(things).not.toBeNull();
    expect(things).toBeDefined();
    expect(typeof things.addTask).toBe("function");
    expect(typeof things.getTodayTasks).toBe("function");
  });

  test("addTask() does not throw", async () => {
    // URL scheme tasks are permanent — use [TEST] prefix for identification
    await things.addTask({
      title: "[TEST] Integration test task",
      when: "today",
    });
    // If it doesn't throw, it succeeded
  }, 10_000);

  test("canRead reflects clings availability", () => {
    // After any read call, canRead is resolved. We check the type here.
    expect(typeof things.canRead).toBe("boolean");
  });

  test("getTodayTasks() returns array (if clings available)", async () => {
    try {
      const tasks = await things.getTodayTasks();
      expect(Array.isArray(tasks)).toBe(true);
    } catch (err) {
      // UnavailableError is acceptable — clings not installed
      expect((err as Error).name).toBe("UnavailableError");
    }
  }, 10_000);

  test("searchTasks() returns array (if clings available)", async () => {
    try {
      const tasks = await things.searchTasks("[TEST]");
      expect(Array.isArray(tasks)).toBe(true);
    } catch (err) {
      // UnavailableError is acceptable — clings not installed
      expect((err as Error).name).toBe("UnavailableError");
    }
  }, 10_000);
});
