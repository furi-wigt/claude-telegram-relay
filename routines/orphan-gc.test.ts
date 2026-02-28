/**
 * Unit tests for routines/orphan-gc.ts
 *
 * Tests exported pure/provider-abstracted functions:
 *   - parseConfig()          — pure, reads env
 *   - parseElapsedMs()       — pure, parses ps elapsed format
 *   - parsePsLine()          — pure, parses one ps output line
 *   - detectOrphans()        — pure, cross-references PIDs
 *   - loadActivePids()       — async, reads sessions JSON
 *   - reapOrphans()          — async, kill-provider injected
 *   - buildReport()          — pure, formats result
 *   - buildTelegramMessage() — pure, formats result
 *
 * Run: bun test routines/orphan-gc.test.ts
 */

import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { homedir } from "os";
import {
  parseConfig,
  parseElapsedMs,
  parsePsLine,
  detectOrphans,
  loadActivePids,
  reapOrphans,
  buildReport,
  buildTelegramMessage,
  type ProcessEntry,
  type GCResult,
} from "./orphan-gc.ts";

// ============================================================
// Helpers
// ============================================================

function makeProcess(overrides: Partial<ProcessEntry> = {}): ProcessEntry {
  return {
    pid: 12345,
    command: "claude -p --output-format stream-json --dangerously-skip-permissions",
    elapsedMs: 60 * 60 * 1000, // 1 hour old by default
    ...overrides,
  };
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;
const THIRTY_MIN_MS = 30 * 60 * 1000;

// ============================================================
// parseConfig()
// ============================================================

describe("parseConfig()", () => {
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of ["ORPHAN_GC_MIN_AGE_MINUTES", "DRY_RUN", "RELAY_DIR"]) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("returns default minAgeMs of 30 minutes", () => {
    delete process.env.ORPHAN_GC_MIN_AGE_MINUTES;
    const cfg = parseConfig();
    expect(cfg.minAgeMs).toBe(THIRTY_MIN_MS);
  });

  it("reads ORPHAN_GC_MIN_AGE_MINUTES from env", () => {
    process.env.ORPHAN_GC_MIN_AGE_MINUTES = "60";
    const cfg = parseConfig();
    expect(cfg.minAgeMs).toBe(ONE_HOUR_MS);
  });

  it("defaults dryRun to false", () => {
    delete process.env.DRY_RUN;
    const cfg = parseConfig();
    expect(cfg.dryRun).toBe(false);
  });

  it("sets dryRun=true when DRY_RUN=true", () => {
    process.env.DRY_RUN = "true";
    const cfg = parseConfig();
    expect(cfg.dryRun).toBe(true);
  });

  it("defaults sessionsFile to ~/.claude-relay/coding-sessions.json", () => {
    delete process.env.RELAY_DIR;
    const cfg = parseConfig();
    expect(cfg.sessionsFile).toContain(".claude-relay");
    expect(cfg.sessionsFile).toContain("coding-sessions.json");
  });

  it("respects RELAY_DIR override for sessionsFile", () => {
    process.env.RELAY_DIR = "/custom/relay";
    const cfg = parseConfig();
    expect(cfg.sessionsFile).toBe(join("/custom/relay", "coding-sessions.json"));
  });
});

// ============================================================
// parseElapsedMs()
// ============================================================

describe("parseElapsedMs()", () => {
  it("parses MM:SS format", () => {
    // 1:30 = 90 seconds = 90_000 ms
    expect(parseElapsedMs("01:30")).toBe(90_000);
  });

  it("parses HH:MM:SS format", () => {
    // 1:30:45 = 3600 + 1800 + 45 = 5445 seconds
    expect(parseElapsedMs("01:30:45")).toBe(5_445_000);
  });

  it("parses DD-HH:MM:SS format", () => {
    // 1-02:30:45 = 86400 + 7200 + 1800 + 45 = 95445 seconds
    expect(parseElapsedMs("1-02:30:45")).toBe(95_445_000);
  });

  it("returns 0 for zero elapsed", () => {
    expect(parseElapsedMs("00:00")).toBe(0);
  });

  it("returns 0 for unrecognised format", () => {
    expect(parseElapsedMs("not-a-time")).toBe(0);
  });

  it("handles single-digit minutes (macOS short format)", () => {
    // 5:30 = 5 minutes 30 seconds
    expect(parseElapsedMs("5:30")).toBe(330_000);
  });
});

// ============================================================
// parsePsLine()
// ============================================================

describe("parsePsLine()", () => {
  it("returns null for header line", () => {
    expect(parsePsLine("  PID     ELAPSED COMMAND")).toBeNull();
  });

  it("returns null for empty line", () => {
    expect(parsePsLine("")).toBeNull();
    expect(parsePsLine("   ")).toBeNull();
  });

  it("parses a valid line with MM:SS elapsed", () => {
    const line = "12345   05:30 /path/to/claude -p --output-format stream-json";
    const entry = parsePsLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.pid).toBe(12345);
    expect(entry!.elapsedMs).toBe(330_000);
    expect(entry!.command).toContain("claude");
  });

  it("parses a valid line with HH:MM:SS elapsed", () => {
    const line = "  999 01:30:45 /usr/bin/claude --dangerously-skip-permissions";
    const entry = parsePsLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.pid).toBe(999);
    expect(entry!.elapsedMs).toBe(5_445_000);
  });

  it("parses a valid line with DD-HH:MM:SS elapsed", () => {
    const line = " 7777 1-02:30:45 /usr/local/bin/claude --dangerously-skip-permissions";
    const entry = parsePsLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.pid).toBe(7777);
    expect(entry!.elapsedMs).toBe(95_445_000);
  });

  it("returns null if PID is not a number", () => {
    expect(parsePsLine("abc  01:00 some command")).toBeNull();
  });

  it("preserves full command including flags", () => {
    const line = "12345 01:00 /usr/bin/claude -p --output-format stream-json --dangerously-skip-permissions";
    const entry = parsePsLine(line);
    expect(entry!.command).toContain("--dangerously-skip-permissions");
    expect(entry!.command).toContain("--output-format");
  });
});

// ============================================================
// detectOrphans()
// ============================================================

describe("detectOrphans()", () => {
  it("returns empty array for empty input", () => {
    expect(detectOrphans([], new Set(), THIRTY_MIN_MS)).toEqual([]);
  });

  it("excludes process whose PID is in activePids", () => {
    const proc = makeProcess({ pid: 100, elapsedMs: ONE_HOUR_MS });
    const result = detectOrphans([proc], new Set([100]), THIRTY_MIN_MS);
    expect(result).toEqual([]);
  });

  it("includes process not in activePids that is old enough", () => {
    const proc = makeProcess({ pid: 200, elapsedMs: ONE_HOUR_MS });
    const result = detectOrphans([proc], new Set(), THIRTY_MIN_MS);
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(200);
  });

  it("excludes process not in activePids that is too young", () => {
    const proc = makeProcess({ pid: 300, elapsedMs: TEN_MIN_MS }); // only 10 min old
    const result = detectOrphans([proc], new Set(), THIRTY_MIN_MS);
    expect(result).toEqual([]);
  });

  it("excludes process exactly at the age boundary (boundary: exclusive)", () => {
    // Exactly 30 minutes — should NOT be killed (must be strictly older)
    const proc = makeProcess({ pid: 400, elapsedMs: THIRTY_MIN_MS });
    const result = detectOrphans([proc], new Set(), THIRTY_MIN_MS);
    expect(result).toEqual([]);
  });

  it("includes process strictly older than boundary", () => {
    const proc = makeProcess({ pid: 500, elapsedMs: THIRTY_MIN_MS + 1 });
    const result = detectOrphans([proc], new Set(), THIRTY_MIN_MS);
    expect(result).toHaveLength(1);
  });

  it("returns only orphans from a mixed list", () => {
    const active = makeProcess({ pid: 100, elapsedMs: ONE_HOUR_MS });
    const tooYoung = makeProcess({ pid: 200, elapsedMs: TEN_MIN_MS });
    const orphan = makeProcess({ pid: 300, elapsedMs: ONE_HOUR_MS });

    const result = detectOrphans([active, tooYoung, orphan], new Set([100]), THIRTY_MIN_MS);
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(300);
  });
});

// ============================================================
// loadActivePids()
// ============================================================

describe("loadActivePids()", () => {
  it("returns empty Set for non-existent file", async () => {
    const result = await loadActivePids("/nonexistent/path/coding-sessions.json");
    expect(result.size).toBe(0);
  });

  it("returns empty Set when sessions array is empty", async () => {
    const tmpFile = `/tmp/orphan-gc-test-empty-${Date.now()}.json`;
    await Bun.write(tmpFile, JSON.stringify({ sessions: [] }));
    try {
      const result = await loadActivePids(tmpFile);
      expect(result.size).toBe(0);
    } finally {
      const { unlink } = await import("fs/promises");
      await unlink(tmpFile).catch(() => {});
    }
  });

  it("includes PIDs from active sessions (running, starting, waiting_for_input, waiting_for_plan)", async () => {
    const tmpFile = `/tmp/orphan-gc-test-active-${Date.now()}.json`;
    const sessions = [
      { id: "s1", pid: 1001, status: "running" },
      { id: "s2", pid: 1002, status: "starting" },
      { id: "s3", pid: 1003, status: "waiting_for_input" },
      { id: "s4", pid: 1004, status: "waiting_for_plan" },
    ];
    await Bun.write(tmpFile, JSON.stringify({ sessions }));
    try {
      const result = await loadActivePids(tmpFile);
      expect(result.size).toBe(4);
      expect(result.has(1001)).toBe(true);
      expect(result.has(1002)).toBe(true);
      expect(result.has(1003)).toBe(true);
      expect(result.has(1004)).toBe(true);
    } finally {
      const { unlink } = await import("fs/promises");
      await unlink(tmpFile).catch(() => {});
    }
  });

  it("excludes PIDs from inactive sessions (completed, failed, killed, paused)", async () => {
    const tmpFile = `/tmp/orphan-gc-test-inactive-${Date.now()}.json`;
    const sessions = [
      { id: "s1", pid: 2001, status: "completed" },
      { id: "s2", pid: 2002, status: "failed" },
      { id: "s3", pid: 2003, status: "killed" },
      { id: "s4", pid: 2004, status: "paused" },
    ];
    await Bun.write(tmpFile, JSON.stringify({ sessions }));
    try {
      const result = await loadActivePids(tmpFile);
      expect(result.size).toBe(0);
    } finally {
      const { unlink } = await import("fs/promises");
      await unlink(tmpFile).catch(() => {});
    }
  });

  it("skips sessions without a pid field", async () => {
    const tmpFile = `/tmp/orphan-gc-test-nopid-${Date.now()}.json`;
    const sessions = [
      { id: "s1", status: "running" }, // no pid
      { id: "s2", pid: 3001, status: "running" },
    ];
    await Bun.write(tmpFile, JSON.stringify({ sessions }));
    try {
      const result = await loadActivePids(tmpFile);
      expect(result.size).toBe(1);
      expect(result.has(3001)).toBe(true);
    } finally {
      const { unlink } = await import("fs/promises");
      await unlink(tmpFile).catch(() => {});
    }
  });
});

// ============================================================
// reapOrphans()
// ============================================================

describe("reapOrphans()", () => {
  it("returns zero killed for empty list", async () => {
    const result = await reapOrphans([], false);
    expect(result.killed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("dry run returns count without calling kill", async () => {
    let killCalled = false;
    const mockKill = (_pid: number, _signal: string | number) => {
      killCalled = true;
    };

    const orphans = [makeProcess({ pid: 1 }), makeProcess({ pid: 2 })];
    const result = await reapOrphans(orphans, true, mockKill);

    expect(result.killed).toBe(2);
    expect(killCalled).toBe(false);
    expect(result.errors).toHaveLength(0);
  });

  it("calls kill for each orphan in non-dry-run mode", async () => {
    const killedPids: number[] = [];
    const mockKill = (pid: number, signal: string | number) => {
      if (signal === "SIGTERM") killedPids.push(pid);
    };

    const orphans = [makeProcess({ pid: 101 }), makeProcess({ pid: 202 })];
    const result = await reapOrphans(orphans, false, mockKill, 0);

    expect(killedPids).toContain(101);
    expect(killedPids).toContain(202);
    expect(result.killed).toBe(2);
  });

  it("records error when kill throws ESRCH (process not found)", async () => {
    const mockKill = (_pid: number, _signal: string | number) => {
      const err = new Error("No such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    };

    const orphans = [makeProcess({ pid: 999 })];
    const result = await reapOrphans(orphans, false, mockKill);

    expect(result.killed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("999");
  });

  it("continues killing remaining orphans after one fails", async () => {
    const killedPids: number[] = [];
    const mockKill = (pid: number, signal: string | number) => {
      if (pid === 111 && signal === "SIGTERM") {
        // First process fails
        const err = new Error("EPERM") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      if (signal === "SIGTERM") killedPids.push(pid);
    };

    const orphans = [makeProcess({ pid: 111 }), makeProcess({ pid: 222 })];
    const result = await reapOrphans(orphans, false, mockKill, 0);

    expect(killedPids).toContain(222);
    expect(result.killed).toBe(1);
    expect(result.errors).toHaveLength(1);
  });
});

// ============================================================
// buildReport()
// ============================================================

describe("buildReport()", () => {
  const baseResult: GCResult = {
    processesFound: 5,
    activePids: 3,
    orphansFound: 2,
    killed: 2,
    errors: [],
    dryRun: false,
  };

  it("returns a non-empty string", () => {
    const report = buildReport(baseResult);
    expect(typeof report).toBe("string");
    expect(report.length).toBeGreaterThan(20);
  });

  it("includes process counts", () => {
    const report = buildReport(baseResult);
    expect(report).toContain("5"); // processesFound
    expect(report).toContain("2"); // orphansFound / killed
  });

  it("includes [DRY RUN] label when dryRun=true", () => {
    const report = buildReport({ ...baseResult, dryRun: true });
    expect(report).toContain("DRY RUN");
  });

  it("does not include [DRY RUN] when dryRun=false", () => {
    const report = buildReport({ ...baseResult, dryRun: false });
    expect(report).not.toContain("DRY RUN");
  });

  it("includes error count when errors present", () => {
    const report = buildReport({ ...baseResult, errors: ["pid 999: EPERM", "pid 888: timeout"] });
    expect(report).toContain("2");
  });

  it("mentions 'no orphans' when orphansFound is 0", () => {
    const report = buildReport({ ...baseResult, orphansFound: 0, killed: 0 });
    expect(report.toLowerCase()).toContain("no orphan");
  });
});

// ============================================================
// buildTelegramMessage()
// ============================================================

describe("buildTelegramMessage()", () => {
  it("returns short message when no orphans found", () => {
    const result: GCResult = {
      processesFound: 3,
      activePids: 3,
      orphansFound: 0,
      killed: 0,
      errors: [],
      dryRun: false,
    };
    const msg = buildTelegramMessage(result);
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(10);
  });

  it("includes killed count when orphans were cleaned up", () => {
    const result: GCResult = {
      processesFound: 5,
      activePids: 2,
      orphansFound: 3,
      killed: 3,
      errors: [],
      dryRun: false,
    };
    const msg = buildTelegramMessage(result);
    expect(msg).toContain("3");
  });

  it("includes dry run notice when dryRun=true", () => {
    const result: GCResult = {
      processesFound: 4,
      activePids: 1,
      orphansFound: 3,
      killed: 3,
      errors: [],
      dryRun: true,
    };
    const msg = buildTelegramMessage(result);
    expect(msg.toLowerCase()).toContain("dry run");
  });

  it("includes error count when errors present", () => {
    const result: GCResult = {
      processesFound: 4,
      activePids: 2,
      orphansFound: 2,
      killed: 1,
      errors: ["pid 100: EPERM"],
      dryRun: false,
    };
    const msg = buildTelegramMessage(result);
    expect(msg).toContain("1"); // 1 error
  });
});
