/**
 * Outlook Integration — integration tests (scaffold only — no AZURE_CLIENT_ID).
 * Run: RUN_INTEGRATION_TESTS=1 bun test integrations/outlook/outlook.integration.test.ts
 */

import { describe, test, expect } from "bun:test";
import { createOutlookClient, type OutlookClient } from "./index.ts";

const SKIP = !process.env.RUN_INTEGRATION_TESTS;

describe.skipIf(SKIP)("outlook integration", () => {
  test("createOutlookClient() returns null when AZURE_CLIENT_ID is not set", () => {
    // Ensure the env var is not set for this test
    const original = process.env.AZURE_CLIENT_ID;
    delete process.env.AZURE_CLIENT_ID;

    const client = createOutlookClient();
    expect(client).toBeNull();

    // Restore
    if (original !== undefined) {
      process.env.AZURE_CLIENT_ID = original;
    }
  });

  test("return type is null | OutlookClient", () => {
    const client: OutlookClient | null = createOutlookClient();
    // Type assertion validates at compile time; runtime check:
    if (client !== null) {
      expect(typeof client.getTodayEvents).toBe("function");
      expect(typeof client.getUpcomingEvents).toBe("function");
      expect(typeof client.createEvent).toBe("function");
      expect(typeof client.deleteEvent).toBe("function");
    } else {
      expect(client).toBeNull();
    }
  });
});
