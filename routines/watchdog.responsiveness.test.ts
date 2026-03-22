/**
 * Unit tests for watchdog heartbeat responsiveness probe.
 *
 * Tests checkBotResponsiveness() and buildResponsivenessAlert() with injectable mock db.
 *
 * Run: bun test routines/watchdog.responsiveness.test.ts
 */

import { describe, test, expect } from "bun:test";
import { checkBotResponsiveness, buildResponsivenessAlert } from "./watchdog.ts";
import type { ResponsivenessResult } from "./watchdog.ts";

// ── Mock DB factory ──────────────────────────────────────────────────────────

function mockDb(rows: {
  lastUser: Record<string, unknown> | undefined;
  lastBot: Record<string, unknown> | undefined;
  pending: Record<string, unknown> | undefined;
}) {
  return {
    prepare: (sql: string) => ({
      get: () => {
        // COUNT(*) first — the pending query's COALESCE subquery contains both
        // "role = 'assistant'" and "MAX(created_at)", so it would match lastBot if checked first
        if (sql.includes("COUNT(*)")) {
          return rows.pending;
        }
        if (sql.includes("role = 'user'") && sql.includes("MAX(created_at)")) {
          return rows.lastUser;
        }
        if (sql.includes("role = 'assistant'") && sql.includes("MAX(created_at)")) {
          return rows.lastBot;
        }
        return undefined;
      },
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkBotResponsiveness", () => {
  test("returns ok when bot responded after user", () => {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60_000).toISOString();
    const threeMinAgo = new Date(now.getTime() - 3 * 60_000).toISOString();

    const db = mockDb({
      lastUser: { ts: fiveMinAgo },
      lastBot: { ts: threeMinAgo },
      pending: { cnt: 0 },
    });

    const result = checkBotResponsiveness(db);
    expect(result.ok).toBe(true);
    expect(result.pendingCount).toBe(0);
  });

  test("returns ok when no messages exist (fresh install)", () => {
    const db = mockDb({
      lastUser: { ts: null },
      lastBot: { ts: null },
      pending: { cnt: 0 },
    });

    const result = checkBotResponsiveness(db);
    expect(result.ok).toBe(true);
    expect(result.gapMinutes).toBe(0);
    expect(result.pendingCount).toBe(0);
  });

  test("returns alert when gap exceeds threshold with pending messages", () => {
    const now = new Date();
    const twentyMinAgo = new Date(now.getTime() - 20 * 60_000).toISOString();
    const fifteenMinAgo = new Date(now.getTime() - 15 * 60_000).toISOString();

    const db = mockDb({
      lastUser: { ts: fifteenMinAgo },
      lastBot: { ts: twentyMinAgo },
      pending: { cnt: 3 },
    });

    const result = checkBotResponsiveness(db, 10);
    expect(result.ok).toBe(false);
    expect(result.pendingCount).toBe(3);
  });

  test("returns ok when gap exceeds threshold but no pending messages", () => {
    const now = new Date();
    const twentyMinAgo = new Date(now.getTime() - 20 * 60_000).toISOString();
    const fifteenMinAgo = new Date(now.getTime() - 15 * 60_000).toISOString();

    const db = mockDb({
      lastUser: { ts: fifteenMinAgo },
      lastBot: { ts: twentyMinAgo },
      pending: { cnt: 0 },
    });

    const result = checkBotResponsiveness(db, 10);
    expect(result.ok).toBe(true);
  });

  test("handles no bot responses (fresh user, bot never replied)", () => {
    const now = new Date();
    const fifteenMinAgo = new Date(now.getTime() - 15 * 60_000).toISOString();

    const db = mockDb({
      lastUser: { ts: fifteenMinAgo },
      lastBot: { ts: null },
      pending: { cnt: 2 },
    });

    const result = checkBotResponsiveness(db, 10);
    expect(result.ok).toBe(false);
    expect(result.lastBotAt).toBeNull();
    expect(result.pendingCount).toBe(2);
  });

  test("uses custom threshold", () => {
    const now = new Date();
    const sevenMinAgo = new Date(now.getTime() - 7 * 60_000).toISOString();
    const eightMinAgo = new Date(now.getTime() - 8 * 60_000).toISOString();

    const db = mockDb({
      lastUser: { ts: sevenMinAgo },
      lastBot: { ts: eightMinAgo },
      pending: { cnt: 1 },
    });

    // Default threshold (10 min) → ok (gap is only 1 min)
    expect(checkBotResponsiveness(db, 10).ok).toBe(true);
    // Tight threshold (0 min) → alert
    expect(checkBotResponsiveness(db, 0).ok).toBe(false);
  });
});

describe("buildResponsivenessAlert", () => {
  test("formats alert message", () => {
    const result: ResponsivenessResult = {
      ok: false,
      lastUserAt: "2026-03-22T10:00:00Z",
      lastBotAt: "2026-03-22T09:45:00Z",
      gapMinutes: 15,
      pendingCount: 3,
    };

    const alert = buildResponsivenessAlert(result);
    expect(alert).toContain("Bot Responsiveness Alert");
    expect(alert).toContain("Gap: 15 minutes");
    expect(alert).toContain("Pending messages: 3");
    expect(alert).toContain("/cancel");
  });

  test("handles null timestamps", () => {
    const result: ResponsivenessResult = {
      ok: false,
      lastUserAt: null,
      lastBotAt: null,
      gapMinutes: 0,
      pendingCount: 0,
    };

    const alert = buildResponsivenessAlert(result);
    expect(alert).toContain("none");
  });
});
