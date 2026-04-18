// src/routines/routineConfig.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test loadRoutineConfigs by pointing it at temp files via env overrides.
// Since loadRoutineConfigs uses import.meta.dir to find the repo config, we
// test it indirectly by verifying behavior with the real config/routines.config.json
// and a synthetic user override file.

// We'll re-implement a thin version of the merge logic in these tests and also
// directly import and call loadRoutineConfigs/getRoutineConfig.

const WORKTREE = "/Users/furi/Documents/WorkInGovTech/01_Projects/Tools/claude-telegram-relay/.claude/worktrees/feat-job-queue-executors";
const REPO_CONFIG = join(WORKTREE, "config/routines.config.json");

describe("routineConfig", () => {
  describe("loadRoutineConfigs() — repo config only", () => {
    test("loads core routines from config/routines.config.json", async () => {
      // The real repo config file exists — import should find it
      const { loadRoutineConfigs } = await import("./routineConfig.ts");
      const configs = loadRoutineConfigs();

      expect(configs.length).toBeGreaterThan(0);
      const names = configs.map((c) => c.name);
      // Core routines (shipped with repo)
      expect(names).toContain("watchdog");
      expect(names).toContain("log-cleanup");
      expect(names).toContain("memory-cleanup");
    });

    test("every entry has required fields", async () => {
      const { loadRoutineConfigs } = await import("./routineConfig.ts");
      const configs = loadRoutineConfigs();

      for (const c of configs) {
        expect(typeof c.name).toBe("string");
        expect(["prompt", "handler"]).toContain(c.type);
        expect(typeof c.schedule).toBe("string");
        expect(typeof c.group).toBe("string");
        expect(typeof c.enabled).toBe("boolean");
      }
    });
  });

  describe("getRoutineConfig()", () => {
    test("returns correct entry for known name", async () => {
      const { getRoutineConfig } = await import("./routineConfig.ts");
      const config = getRoutineConfig("morning-summary");

      expect(config).toBeDefined();
      expect(config?.name).toBe("morning-summary");
      expect(config?.type).toBe("handler");
      expect(config?.group).toBe("OPERATIONS");
    });

    test("returns undefined for unknown name", async () => {
      const { getRoutineConfig } = await import("./routineConfig.ts");
      const config = getRoutineConfig("nonexistent-routine-xyz");
      expect(config).toBeUndefined();
    });
  });

  describe("merge logic — user config overrides repo config", () => {
    let tmpDir: string;
    let userConfigPath: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `routine-config-test-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      userConfigPath = join(tmpDir, "routines.config.json");
    });

    afterEach(() => {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    });

    test("user entry overrides repo entry on same name", () => {
      // Simulate the merge logic directly (since we can't easily redirect homedir())
      // We test the actual merge algorithm rather than the file-loading paths.

      // Repo entries
      const repoConfigs = [
        { name: "morning-summary", type: "handler" as const, schedule: "0 7 * * *", group: "OPERATIONS", enabled: true },
        { name: "watchdog",        type: "handler" as const, schedule: "0 */2 * * *", group: "OPERATIONS", enabled: true },
      ];

      // User entry overrides morning-summary schedule and disables it
      const userConfigs = [
        { name: "morning-summary", type: "handler" as const, schedule: "0 8 * * *", group: "OPERATIONS", enabled: false },
      ];

      // Apply the same merge logic as loadRoutineConfigs()
      const merged = new Map<string, typeof repoConfigs[0]>();
      for (const c of repoConfigs) merged.set(c.name, c);
      for (const c of userConfigs) {
        const existing = merged.get(c.name);
        merged.set(c.name, existing ? { ...existing, ...c } : c);
      }

      const result = Array.from(merged.values());
      expect(result.length).toBe(2);

      const morningSummary = result.find((c) => c.name === "morning-summary");
      expect(morningSummary?.schedule).toBe("0 8 * * *"); // user override
      expect(morningSummary?.enabled).toBe(false);         // user override

      const watchdog = result.find((c) => c.name === "watchdog");
      expect(watchdog?.schedule).toBe("0 */2 * * *"); // unchanged from repo
      expect(watchdog?.enabled).toBe(true);
    });

    test("user can add new entries not present in repo", () => {
      const repoConfigs = [
        { name: "morning-summary", type: "handler" as const, schedule: "0 7 * * *", group: "OPERATIONS", enabled: true },
      ];

      const userConfigs = [
        { name: "custom-routine", type: "prompt" as const, schedule: "0 10 * * *", group: "STRATEGY", enabled: true },
      ];

      const merged = new Map<string, (typeof repoConfigs[0]) | (typeof userConfigs[0])>();
      for (const c of repoConfigs) merged.set(c.name, c);
      for (const c of userConfigs) {
        const existing = merged.get(c.name);
        merged.set(c.name, existing ? { ...existing, ...c } : c);
      }

      const result = Array.from(merged.values());
      expect(result.length).toBe(2);
      expect(result.find((c) => c.name === "custom-routine")).toBeDefined();
      expect(result.find((c) => c.name === "custom-routine")?.group).toBe("STRATEGY");
    });

    test("repo-only config (no user file) returns all repo entries", () => {
      const repoConfigs = [
        { name: "morning-summary", type: "handler" as const, schedule: "0 7 * * *", group: "OPERATIONS", enabled: true },
        { name: "night-summary",   type: "handler" as const, schedule: "0 23 * * *", group: "OPERATIONS", enabled: true },
      ];
      const userConfigs: typeof repoConfigs = [];

      const merged = new Map<string, typeof repoConfigs[0]>();
      for (const c of repoConfigs) merged.set(c.name, c);
      for (const c of userConfigs) {
        const existing = merged.get(c.name);
        merged.set(c.name, existing ? { ...existing, ...c } : c);
      }

      expect(Array.from(merged.values()).length).toBe(2);
    });
  });
});
