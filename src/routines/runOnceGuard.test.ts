/**
 * Tests for runOnceGuard — run-once-per-day guard for scheduled routines.
 *
 * Run: bun test src/routines/runOnceGuard.test.ts
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { shouldSkipToday, shouldSkipRecently, markRanToday } from "./runOnceGuard.ts";

// ============================================================
// Helpers
// ============================================================

// Use local timezone for date helpers — same approach as the fixed runOnceGuard.
// Do NOT use toISOString().slice(0,10) here: at 7 AM SGT that returns the previous
// UTC day, causing test helpers to disagree with the code under test.
const TZ = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const YESTERDAY = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
})();

let testDir: string;
let lastRunFile: string;

beforeEach(() => {
  testDir = join(tmpdir(), `run-once-guard-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  lastRunFile = join(testDir, "test-routine.lastrun");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ============================================================
// shouldSkipToday
// ============================================================

test("shouldSkipToday returns true (skip) when lastrun file matches today", () => {
  writeFileSync(lastRunFile, TODAY, "utf8");
  expect(shouldSkipToday(lastRunFile)).toBe(true);
});

test("shouldSkipToday returns false (proceed) when lastrun file is yesterday", () => {
  writeFileSync(lastRunFile, YESTERDAY, "utf8");
  expect(shouldSkipToday(lastRunFile)).toBe(false);
});

test("shouldSkipToday returns false (proceed) when lastrun file does not exist", () => {
  // lastRunFile was not created in this test
  expect(existsSync(lastRunFile)).toBe(false);
  expect(shouldSkipToday(lastRunFile)).toBe(false);
});

test("shouldSkipToday returns false when lastrun file contains whitespace around date", () => {
  writeFileSync(lastRunFile, `  ${YESTERDAY}\n`, "utf8");
  expect(shouldSkipToday(lastRunFile)).toBe(false);
});

test("shouldSkipToday trims whitespace — still returns true for today with surrounding whitespace", () => {
  writeFileSync(lastRunFile, `  ${TODAY}\n`, "utf8");
  expect(shouldSkipToday(lastRunFile)).toBe(true);
});

// ============================================================
// markRanToday
// ============================================================

test("markRanToday writes today's date to lastrun file", () => {
  markRanToday(lastRunFile);
  const contents = readFileSync(lastRunFile, "utf8").trim();
  expect(contents).toBe(TODAY);
});

test("markRanToday creates file if it does not exist", () => {
  expect(existsSync(lastRunFile)).toBe(false);
  markRanToday(lastRunFile);
  expect(existsSync(lastRunFile)).toBe(true);
});

test("markRanToday overwrites stale date", () => {
  writeFileSync(lastRunFile, YESTERDAY, "utf8");
  markRanToday(lastRunFile);
  const contents = readFileSync(lastRunFile, "utf8").trim();
  expect(contents).toBe(TODAY);
});

// ============================================================
// Round-trip: guard prevents duplicate runs
// ============================================================

test("after markRanToday, shouldSkipToday returns true", () => {
  expect(shouldSkipToday(lastRunFile)).toBe(false); // first call — no file
  markRanToday(lastRunFile);
  expect(shouldSkipToday(lastRunFile)).toBe(true);  // second call — skip
});

// ============================================================
// Regression: UTC vs local timezone (SGT morning bug)
// Bug: at 7 AM SGT (UTC+8), toISOString() returns the PREVIOUS UTC day.
// If markRanToday wrote "2026-02-26" yesterday and todayDate() returns
// "2026-02-26" at 7 AM SGT, the routine is falsely skipped.
// Fix: always use local timezone, not UTC.
// ============================================================

test("markRanToday writes a date in YYYY-MM-DD format (local timezone, not UTC)", () => {
  markRanToday(lastRunFile);
  const written = readFileSync(lastRunFile, "utf8").trim();
  // Must match YYYY-MM-DD
  expect(written).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // Must equal the local-timezone today (same value as our TZ-aware helper)
  expect(written).toBe(TODAY);
});

test("a lastrun file from yesterday (local time) is NOT skipped today", () => {
  // Simulates the morning-summary scenario: ran yesterday, should run today
  writeFileSync(lastRunFile, YESTERDAY, "utf8");
  expect(shouldSkipToday(lastRunFile)).toBe(false);
});

// ============================================================
// shouldSkipRecently — 2-hour cooldown guard
// ============================================================

test("shouldSkipRecently returns false when lastrun file does not exist", () => {
  expect(shouldSkipRecently(lastRunFile, 2)).toBe(false);
});

test("shouldSkipRecently returns true when file was modified 1 minute ago (within 2h cooldown)", () => {
  writeFileSync(lastRunFile, "touched", "utf8");
  // mtime is now — definitely within any cooldown
  expect(shouldSkipRecently(lastRunFile, 2)).toBe(true);
});

test("shouldSkipRecently returns false when file is older than cooldown", () => {
  // Write file then backdate its mtime to 3 hours ago
  writeFileSync(lastRunFile, "touched", "utf8");
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const { utimesSync } = require("fs");
  utimesSync(lastRunFile, threeHoursAgo, threeHoursAgo);
  expect(shouldSkipRecently(lastRunFile, 2)).toBe(false);
});

test("shouldSkipRecently with 0h cooldown always returns false (file older than 0 hours)", () => {
  writeFileSync(lastRunFile, "touched", "utf8");
  // Even a just-written file is >= 0ms old, so ageMs < 0 is false
  // This is an edge-case boundary — 0h cooldown means never skip
  expect(shouldSkipRecently(lastRunFile, 0)).toBe(false);
});

test("shouldSkipRecently: morning run at 15:00 does NOT block 23:00 scheduled run (2h cooldown)", () => {
  // Simulate: manual run at 15:00, check at 23:00 → 8 hours elapsed → not skipped
  writeFileSync(lastRunFile, "touched", "utf8");
  const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
  const { utimesSync } = require("fs");
  utimesSync(lastRunFile, eightHoursAgo, eightHoursAgo);
  expect(shouldSkipRecently(lastRunFile, 2)).toBe(false);
});

test("shouldSkipRecently: PM2 crash-restart 5 minutes after 23:00 run IS skipped (within 2h)", () => {
  // Simulate: ran at 23:00, PM2 restarts at 23:05 → 5 min elapsed → skipped
  writeFileSync(lastRunFile, "touched", "utf8");
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const { utimesSync } = require("fs");
  utimesSync(lastRunFile, fiveMinutesAgo, fiveMinutesAgo);
  expect(shouldSkipRecently(lastRunFile, 2)).toBe(true);
});

test("UTC-previous-day date does not cause false skip on local-today", () => {
  // Regression test: simulate what happened at 7 AM SGT on Feb 27.
  // The lastrun file contained "2026-02-26" (written at 20:50 SGT Feb 26).
  // At 7 AM SGT Feb 27, the broken code computed todayDate() = "2026-02-26" (UTC)
  // and falsely returned shouldSkipToday() = true.
  // The fixed code computes todayDate() in local TZ and returns "2026-02-27".
  //
  // We test this by writing YESTERDAY's date and confirming we do NOT skip:
  writeFileSync(lastRunFile, YESTERDAY, "utf8");
  expect(shouldSkipToday(lastRunFile)).toBe(false); // must NOT skip — different day
});
