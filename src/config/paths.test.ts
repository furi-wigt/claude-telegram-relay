import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { homedir } from "os";
import { join } from "path";

// We need to re-import after env changes, so use dynamic imports
async function loadPaths() {
  // Bust the module cache so env changes take effect
  const mod = await import("./paths.ts?" + Date.now());
  return mod;
}

describe("src/config/paths", () => {
  const originalEnv = process.env.RELAY_USER_DIR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.RELAY_USER_DIR;
    } else {
      process.env.RELAY_USER_DIR = originalEnv;
    }
  });

  describe("getUserDir()", () => {
    it("returns ~/.claude-relay by default", async () => {
      delete process.env.RELAY_USER_DIR;
      const { getUserDir } = await loadPaths();
      expect(getUserDir()).toBe(join(homedir(), ".claude-relay"));
    });

    it("respects RELAY_USER_DIR override", async () => {
      process.env.RELAY_USER_DIR = "/tmp/test-relay-dir";
      const { getUserDir } = await loadPaths();
      expect(getUserDir()).toBe("/tmp/test-relay-dir");
    });
  });

  describe("getUserPromptsDir()", () => {
    it("returns correct path under user dir", async () => {
      delete process.env.RELAY_USER_DIR;
      const { getUserPromptsDir } = await loadPaths();
      expect(getUserPromptsDir()).toBe(join(homedir(), ".claude-relay", "prompts"));
    });

    it("respects RELAY_USER_DIR override", async () => {
      process.env.RELAY_USER_DIR = "/tmp/custom-relay";
      const { getUserPromptsDir } = await loadPaths();
      expect(getUserPromptsDir()).toBe("/tmp/custom-relay/prompts");
    });
  });

  describe("getUserDataDir()", () => {
    it("returns correct path under user dir", async () => {
      delete process.env.RELAY_USER_DIR;
      const { getUserDataDir } = await loadPaths();
      expect(getUserDataDir()).toBe(join(homedir(), ".claude-relay", "data"));
    });
  });

  describe("getUserResearchDir()", () => {
    it("returns correct path under user dir", async () => {
      delete process.env.RELAY_USER_DIR;
      const { getUserResearchDir } = await loadPaths();
      expect(getUserResearchDir()).toBe(join(homedir(), ".claude-relay", "research"));
    });
  });

  describe("getUserLogsDir()", () => {
    it("returns correct path under user dir", async () => {
      delete process.env.RELAY_USER_DIR;
      const { getUserLogsDir } = await loadPaths();
      expect(getUserLogsDir()).toBe(join(homedir(), ".claude-relay", "logs"));
    });
  });

  describe("getRepoPromptsDir()", () => {
    it("returns a string ending with config/prompts", async () => {
      const { getRepoPromptsDir } = await loadPaths();
      const result = getRepoPromptsDir();
      expect(result).toBeTypeOf("string");
      expect(result.endsWith(join("config", "prompts"))).toBe(true);
    });
  });

  describe("all path functions", () => {
    it("return absolute paths (starting with /)", async () => {
      delete process.env.RELAY_USER_DIR;
      const paths = await loadPaths();
      const fns = [
        paths.getUserDir,
        paths.getUserPromptsDir,
        paths.getUserDataDir,
        paths.getUserResearchDir,
        paths.getUserLogsDir,
        paths.getRepoPromptsDir,
      ];
      for (const fn of fns) {
        expect(fn()).toMatch(/^\//);
      }
    });
  });
});
