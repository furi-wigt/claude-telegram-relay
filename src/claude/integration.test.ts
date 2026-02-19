/**
 * Integration tests — verify all spawn sites use the unified claude-process module.
 *
 * These tests read source files and assert that:
 * 1. claudeRunner.ts has been deleted (consolidated into claude-process.ts)
 * 2. teamAnalyzer.ts imports claudeText from ../claude-process.ts
 * 3. All spawn sites import from claude-process.ts
 * 4. SessionRunner.buildEnv delegates to buildClaudeEnv
 *
 * Run: bun test src/claude/integration.test.ts
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");

// ============================================================
// claudeRunner.ts deleted, teamAnalyzer migrated
// ============================================================

describe("claudeRunner.ts consolidation", () => {
  test("src/coding/claudeRunner.ts does NOT exist (deleted)", () => {
    expect(existsSync(join(ROOT, "src", "coding", "claudeRunner.ts"))).toBe(false);
  });

  test("src/claude.ts does NOT exist (replaced by claude-process.ts)", () => {
    expect(existsSync(join(ROOT, "src", "claude.ts"))).toBe(false);
  });

  test("teamAnalyzer.ts imports from ../claude-process.ts (not claudeRunner)", () => {
    const content = readFileSync(
      join(ROOT, "src", "coding", "teamAnalyzer.ts"),
      "utf8"
    );
    expect(content).toMatch(/from\s+["']\.\.\/claude-process(\.ts)?["']/);
    expect(content).not.toContain("claudeRunner");
  });
});

// ============================================================
// All callers import from claude-process.ts
// ============================================================

describe("All callers import from claude-process.ts", () => {
  test("src/relay.ts imports claudeStream and claudeText from claude-process", () => {
    const content = readFileSync(join(ROOT, "src", "relay.ts"), "utf8");
    expect(content).toMatch(/from\s+["']\.\/claude-process(\.ts)?["']/);
    expect(content).toContain("claudeStream");
    expect(content).toContain("claudeText");
  });

  test("src/tools/runPrompt.ts imports from claude-process", () => {
    const content = readFileSync(join(ROOT, "src", "tools", "runPrompt.ts"), "utf8");
    expect(content).toMatch(/from\s+["']\.\.\/claude-process(\.ts)?["']/);
  });

  test("src/memory/longTermExtractor.ts imports from claude-process", () => {
    const content = readFileSync(
      join(ROOT, "src", "memory", "longTermExtractor.ts"),
      "utf8"
    );
    expect(content).toMatch(/from\s+["']\.\.\/claude-process(\.ts)?["']/);
  });

  test("src/coding/sessionRunner.ts imports buildClaudeEnv from claude-process", () => {
    const content = readFileSync(
      join(ROOT, "src", "coding", "sessionRunner.ts"),
      "utf8"
    );
    expect(content).toContain("buildClaudeEnv");
    expect(content).toMatch(/from\s+["']\.\.\/claude-process(\.ts)?["']/);
  });
});

// ============================================================
// SessionRunner.buildEnv delegates to buildClaudeEnv
// ============================================================

describe("SessionRunner.buildEnv — delegates to buildClaudeEnv", () => {
  test("SessionRunner.buildEnv removes all 4 session vars", () => {
    const { SessionRunner } = require("../coding/sessionRunner.ts");

    const fakeBase: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      CLAUDECODE: "1",
      CLAUDE_CODE_SSE_PORT: "3000",
      CLAUDE_CODE_ENTRYPOINT: "/path",
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    };

    const env = SessionRunner.buildEnv(fakeBase);

    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env).not.toHaveProperty("CLAUDE_CODE_SSE_PORT");
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(env).not.toHaveProperty("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS");
    expect(env.CLAUDE_SUBPROCESS).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
  });

  test("SessionRunner.buildEnv with useAgentTeam sets AGENT_TEAMS=1", () => {
    const { SessionRunner } = require("../coding/sessionRunner.ts");

    const fakeBase: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      CLAUDECODE: "1",
    };

    const env = SessionRunner.buildEnv(fakeBase, { useAgentTeam: true });

    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
    expect(env.CLAUDE_SUBPROCESS).toBe("1");
  });

  test("SessionRunner.buildEnv does not mutate original env", () => {
    const { SessionRunner } = require("../coding/sessionRunner.ts");

    const original: NodeJS.ProcessEnv = {
      CLAUDECODE: "1",
      FOO: "bar",
    };

    SessionRunner.buildEnv(original);

    expect(original.CLAUDECODE).toBe("1");
    expect(original.FOO).toBe("bar");
  });
});

// ============================================================
// Binary path — no leftover references to old inconsistent env var
// ============================================================

describe("Binary path — no references to CLAUDE_BINARY (old inconsistent name)", () => {
  test("teamAnalyzer.ts does not use CLAUDE_BINARY env var", () => {
    const content = readFileSync(
      join(ROOT, "src", "coding", "teamAnalyzer.ts"),
      "utf8"
    );
    expect(content).not.toContain("CLAUDE_BINARY");
  });
});
