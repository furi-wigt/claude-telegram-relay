/**
 * Unit tests for routines/log-cleanup.ts
 *
 * Tests exported pure/provider-abstracted functions:
 *   - parseConfig()          — pure, reads env
 *   - scanFiles()            — async, fs-injected
 *   - filterStale()          — pure, age-based filter
 *   - deleteFiles()          — async, fs-injected + dry-run
 *   - buildReport()          — pure, formats result
 *   - buildTelegramMessage() — pure, formats result
 *
 * Run: bun test routines/log-cleanup.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { getPm2LogsDir } from "../config/observability.ts";
import {
  parseConfig,
  filterStale,
  buildReport,
  buildTelegramMessage,
  scanFiles,
  deleteFiles,
  type CleanupConfig,
  type FileEntry,
  type CleanupResult,
} from "./log-cleanup.ts";

// ============================================================
// Helpers
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(n: number): number {
  return Date.now() - n * DAY_MS;
}

function makeEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/tmp/logs/test.log",
    mtimeMs: daysAgo(3),
    ...overrides,
  };
}

// ============================================================
// getPm2LogsDir() — from config/observability.ts
// ============================================================

describe("getPm2LogsDir()", () => {
  const originalPm2LogDir = process.env.PM2_LOG_DIR;

  afterEach(() => {
    if (originalPm2LogDir !== undefined) {
      process.env.PM2_LOG_DIR = originalPm2LogDir;
    } else {
      delete process.env.PM2_LOG_DIR;
    }
  });

  it("returns {projectRoot}/logs by default", () => {
    delete process.env.PM2_LOG_DIR;
    expect(getPm2LogsDir("/project")).toBe(join("/project", "logs"));
  });

  it("respects PM2_LOG_DIR env override", () => {
    process.env.PM2_LOG_DIR = "/custom/pm2/logs";
    expect(getPm2LogsDir("/project")).toBe("/custom/pm2/logs");
  });
});

// ============================================================
// parseConfig()
// ============================================================

describe("parseConfig()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const key of ["LOG_CLEANUP_RETAIN_DAYS", "LOG_CLEANUP_PM2_DIR", "LOG_CLEANUP_OBS_DIR", "LOG_DIR", "DRY_RUN", "PM2_LOG_DIR"]) {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("returns default retain days of 7", () => {
    delete process.env.LOG_CLEANUP_RETAIN_DAYS;
    const cfg = parseConfig("/project");
    expect(cfg.retainDays).toBe(7);
  });

  it("reads LOG_CLEANUP_RETAIN_DAYS from env", () => {
    process.env.LOG_CLEANUP_RETAIN_DAYS = "14";
    const cfg = parseConfig("/project");
    expect(cfg.retainDays).toBe(14);
  });

  it("delegates pm2LogDir to getPm2LogsDir from config/observability", () => {
    delete process.env.LOG_CLEANUP_PM2_DIR;
    delete process.env.PM2_LOG_DIR;
    const cfg = parseConfig("/project");
    // Must match what getPm2LogsDir resolves — not hardcoded here
    expect(cfg.pm2LogDir).toBe(getPm2LogsDir("/project"));
  });

  it("LOG_CLEANUP_PM2_DIR overrides getPm2LogsDir", () => {
    process.env.LOG_CLEANUP_PM2_DIR = "/custom/logs";
    const cfg = parseConfig("/project");
    expect(cfg.pm2LogDir).toBe("/custom/logs");
  });

  it("defaults obsLogDir to LOG_DIR env or ~/.claude-relay/logs", () => {
    delete process.env.LOG_CLEANUP_OBS_DIR;
    delete process.env.LOG_DIR;
    const cfg = parseConfig("/project");
    expect(cfg.obsLogDir).toContain(".claude-relay");
    expect(cfg.obsLogDir).toContain("logs");
  });

  it("reads LOG_CLEANUP_OBS_DIR override from env", () => {
    process.env.LOG_CLEANUP_OBS_DIR = "/obs/logs";
    const cfg = parseConfig("/project");
    expect(cfg.obsLogDir).toBe("/obs/logs");
  });

  it("defaults dryRun to false", () => {
    delete process.env.DRY_RUN;
    const cfg = parseConfig("/project");
    expect(cfg.dryRun).toBe(false);
  });

  it("sets dryRun=true when DRY_RUN=true", () => {
    process.env.DRY_RUN = "true";
    const cfg = parseConfig("/project");
    expect(cfg.dryRun).toBe(true);
  });
});

// ============================================================
// filterStale()
// ============================================================

describe("filterStale()", () => {
  it("returns empty array for empty input", () => {
    expect(filterStale([], 7)).toEqual([]);
  });

  it("keeps file newer than retain days", () => {
    const fresh = makeEntry({ mtimeMs: daysAgo(2) });
    expect(filterStale([fresh], 7)).toEqual([]);
  });

  it("flags file older than retain days", () => {
    const stale = makeEntry({ mtimeMs: daysAgo(8) });
    expect(filterStale([stale], 7)).toEqual([stale]);
  });

  it("flags file exactly at retain threshold (boundary: exclusive)", () => {
    // File is exactly `retainDays` old — should be deleted
    const boundary = makeEntry({ mtimeMs: daysAgo(7) });
    expect(filterStale([boundary], 7)).toEqual([boundary]);
  });

  it("returns only stale files from mixed list", () => {
    const fresh = makeEntry({ path: "/tmp/fresh.log", mtimeMs: daysAgo(1) });
    const stale = makeEntry({ path: "/tmp/stale.log", mtimeMs: daysAgo(10) });
    const result = filterStale([fresh, stale], 7);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/tmp/stale.log");
  });

  it("handles multiple stale files", () => {
    const entries = [
      makeEntry({ path: "/a.log", mtimeMs: daysAgo(8) }),
      makeEntry({ path: "/b.log", mtimeMs: daysAgo(15) }),
      makeEntry({ path: "/c.log", mtimeMs: daysAgo(3) }),
    ];
    const result = filterStale(entries, 7);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.path)).toContain("/a.log");
    expect(result.map((e) => e.path)).toContain("/b.log");
  });
});

// ============================================================
// scanFiles()
// ============================================================

describe("scanFiles()", () => {
  it("returns empty array when directory does not exist", async () => {
    const result = await scanFiles("/nonexistent/path/that/does/not/exist", [".log"]);
    expect(result).toEqual([]);
  });

  it("returns empty array when no files match extensions", async () => {
    // Use a real temp dir with no .log files
    const tmpDir = "/tmp";
    const result = await scanFiles(tmpDir, [".nonexistent-ext-xyz"]);
    expect(result).toEqual([]);
  });

  it("returns FileEntry objects with path and mtimeMs", async () => {
    // Create a temp file
    const tmpFile = `/tmp/log-cleanup-test-${Date.now()}.log`;
    await Bun.write(tmpFile, "test");
    try {
      const result = await scanFiles("/tmp", [".log"], (f) => f === `log-cleanup-test-${Date.now() - 5000}.log` || f.startsWith("log-cleanup-test-"));
      const found = result.find((e) => e.path === tmpFile);
      expect(found).toBeDefined();
      expect(found?.mtimeMs).toBeGreaterThan(0);
      expect(found?.path).toBe(tmpFile);
    } finally {
      await Bun.file(tmpFile).exists() && Bun.file(tmpFile).writer().end();
      const { unlink } = await import("fs/promises");
      await unlink(tmpFile).catch(() => {});
    }
  });
});

// ============================================================
// deleteFiles()
// ============================================================

describe("deleteFiles()", () => {
  it("returns 0 for empty list", async () => {
    expect(await deleteFiles([], false)).toBe(0);
  });

  it("dry run returns count without deleting", async () => {
    const tmpFile = `/tmp/log-cleanup-dryrun-${Date.now()}.log`;
    await Bun.write(tmpFile, "test");
    const entry: FileEntry = { path: tmpFile, mtimeMs: daysAgo(10) };
    try {
      const deleted = await deleteFiles([entry], true);
      expect(deleted).toBe(1);
      // File still exists
      expect(await Bun.file(tmpFile).exists()).toBe(true);
    } finally {
      const { unlink } = await import("fs/promises");
      await unlink(tmpFile).catch(() => {});
    }
  });

  it("actually deletes files when dryRun=false", async () => {
    const tmpFile = `/tmp/log-cleanup-realdelete-${Date.now()}.log`;
    await Bun.write(tmpFile, "test");
    const entry: FileEntry = { path: tmpFile, mtimeMs: daysAgo(10) };

    const deleted = await deleteFiles([entry], false);
    expect(deleted).toBe(1);
    expect(await Bun.file(tmpFile).exists()).toBe(false);
  });

  it("continues deleting remaining files if one fails", async () => {
    const tmpFile = `/tmp/log-cleanup-partial-${Date.now()}.log`;
    await Bun.write(tmpFile, "test");
    const entries: FileEntry[] = [
      { path: "/nonexistent/file/that/will/fail.log", mtimeMs: daysAgo(10) },
      { path: tmpFile, mtimeMs: daysAgo(10) },
    ];
    try {
      const deleted = await deleteFiles(entries, false);
      // At least the real file should be deleted
      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(await Bun.file(tmpFile).exists()).toBe(false);
    } finally {
      const { unlink } = await import("fs/promises");
      await unlink(tmpFile).catch(() => {});
    }
  });
});

// ============================================================
// buildReport()
// ============================================================

describe("buildReport()", () => {
  const baseResult: CleanupResult = {
    pm2Deleted: 3,
    obsDeleted: 2,
    pm2Total: 10,
    obsTotal: 8,
    dryRun: false,
    retainDays: 7,
    errors: [],
  };

  it("returns a non-empty string", () => {
    const report = buildReport(baseResult);
    expect(typeof report).toBe("string");
    expect(report.length).toBeGreaterThan(20);
  });

  it("includes PM2 deleted count", () => {
    const report = buildReport(baseResult);
    expect(report).toContain("3");
  });

  it("includes observability deleted count", () => {
    const report = buildReport(baseResult);
    expect(report).toContain("2");
  });

  it("includes [DRY RUN] label when dryRun=true", () => {
    const report = buildReport({ ...baseResult, dryRun: true });
    expect(report).toContain("DRY RUN");
  });

  it("does not include [DRY RUN] when dryRun=false", () => {
    const report = buildReport({ ...baseResult, dryRun: false });
    expect(report).not.toContain("DRY RUN");
  });

  it("mentions retain days", () => {
    const report = buildReport(baseResult);
    expect(report).toContain("7");
  });

  it("includes error count when errors present", () => {
    const report = buildReport({ ...baseResult, errors: ["file1.log: ENOENT", "file2.log: permission denied"] });
    expect(report).toContain("2");
  });
});

// ============================================================
// buildTelegramMessage()
// ============================================================

describe("buildTelegramMessage()", () => {
  it("returns clean string when nothing deleted", () => {
    const result: CleanupResult = {
      pm2Deleted: 0,
      obsDeleted: 0,
      pm2Total: 5,
      obsTotal: 3,
      dryRun: false,
      retainDays: 7,
      errors: [],
    };
    const msg = buildTelegramMessage(result);
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(10);
  });

  it("includes totals when files were deleted", () => {
    const result: CleanupResult = {
      pm2Deleted: 12,
      obsDeleted: 5,
      pm2Total: 20,
      obsTotal: 8,
      dryRun: false,
      retainDays: 7,
      errors: [],
    };
    const msg = buildTelegramMessage(result);
    expect(msg).toContain("12");
    expect(msg).toContain("5");
  });

  it("includes dry run notice", () => {
    const result: CleanupResult = {
      pm2Deleted: 3,
      obsDeleted: 1,
      pm2Total: 5,
      obsTotal: 2,
      dryRun: true,
      retainDays: 7,
      errors: [],
    };
    const msg = buildTelegramMessage(result);
    expect(msg).toContain("dry run");
  });
});
