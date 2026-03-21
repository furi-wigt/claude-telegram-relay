/**
 * Unit tests for the unified Claude environment helpers.
 *
 * Tests buildClaudeEnv() and getClaudePath() — the single source of truth
 * for Claude CLI subprocess environment construction and binary resolution.
 *
 * Run: bun test src/claude/env.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { buildClaudeEnv, getClaudePath } from "../claude-process.ts";

/** The 4 session detection vars that buildClaudeEnv strips. */
const CLAUDE_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
] as const;

// ============================================================
// buildClaudeEnv — environment construction
// ============================================================

describe("buildClaudeEnv — environment construction", () => {
  test("removes CLAUDECODE from the returned env", () => {
    const env = buildClaudeEnv({ CLAUDECODE: "1", PATH: "/usr/bin" });
    expect(env).not.toHaveProperty("CLAUDECODE");
  });

  test("removes CLAUDE_CODE_SSE_PORT from the returned env", () => {
    const env = buildClaudeEnv({ CLAUDE_CODE_SSE_PORT: "3000", PATH: "/usr/bin" });
    expect(env).not.toHaveProperty("CLAUDE_CODE_SSE_PORT");
  });

  test("removes CLAUDE_CODE_ENTRYPOINT from the returned env", () => {
    const env = buildClaudeEnv({ CLAUDE_CODE_ENTRYPOINT: "/path", PATH: "/usr/bin" });
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
  });

  test("removes CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS from the returned env", () => {
    const env = buildClaudeEnv({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", PATH: "/usr/bin" });
    expect(env).not.toHaveProperty("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS");
  });

  test("removes ALL session vars simultaneously", () => {
    const base: NodeJS.ProcessEnv = {
      CLAUDECODE: "1",
      CLAUDE_CODE_SSE_PORT: "3000",
      CLAUDE_CODE_ENTRYPOINT: "/path",
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      PATH: "/usr/bin",
      HOME: "/home/user",
    };
    const env = buildClaudeEnv(base);

    for (const key of CLAUDE_SESSION_VARS) {
      expect(env).not.toHaveProperty(key);
    }
  });

  test("sets CLAUDE_SUBPROCESS=1", () => {
    const env = buildClaudeEnv({ PATH: "/usr/bin" });
    expect(env.CLAUDE_SUBPROCESS).toBe("1");
  });

  test("preserves other env vars (PATH, HOME, etc.)", () => {
    const env = buildClaudeEnv({
      PATH: "/usr/bin:/usr/local/bin",
      HOME: "/home/user",
      NODE_ENV: "test",
      CLAUDECODE: "1",
    });

    expect(env.PATH).toBe("/usr/bin:/usr/local/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.NODE_ENV).toBe("test");
  });

  test("does NOT mutate the input env object", () => {
    const original: NodeJS.ProcessEnv = {
      CLAUDECODE: "1",
      PATH: "/usr/bin",
      FOO: "bar",
    };
    buildClaudeEnv(original);

    // Original must still have CLAUDECODE
    expect(original.CLAUDECODE).toBe("1");
    expect(original.FOO).toBe("bar");
  });

  test("works safely when no session vars are present in base env", () => {
    const env = buildClaudeEnv({ PATH: "/usr/bin" });
    expect(env.CLAUDE_SUBPROCESS).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("defaults to process.env when no baseEnv is provided", () => {
    const env = buildClaudeEnv();
    // Should have CLAUDE_SUBPROCESS set regardless
    expect(env.CLAUDE_SUBPROCESS).toBe("1");
    // Should not have any Claude session vars
    for (const key of CLAUDE_SESSION_VARS) {
      expect(env[key]).toBeUndefined();
    }
  });
});

// ============================================================
// buildClaudeEnv — useAgentTeam option
// ============================================================

describe("buildClaudeEnv — useAgentTeam option", () => {
  test("sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 when useAgentTeam is true", () => {
    const env = buildClaudeEnv({ PATH: "/usr/bin" }, { useAgentTeam: true });
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
  });

  test("does NOT set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS when useAgentTeam is false", () => {
    const env = buildClaudeEnv(
      { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", PATH: "/usr/bin" },
      { useAgentTeam: false }
    );
    expect(env).not.toHaveProperty("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS");
  });

  test("does NOT set CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS when useAgentTeam is undefined", () => {
    const env = buildClaudeEnv(
      { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", PATH: "/usr/bin" }
    );
    expect(env).not.toHaveProperty("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS");
  });

  test("still removes all other session vars when useAgentTeam is true", () => {
    const base: NodeJS.ProcessEnv = {
      CLAUDECODE: "1",
      CLAUDE_CODE_SSE_PORT: "3000",
      CLAUDE_CODE_ENTRYPOINT: "/path",
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "old-value",
      PATH: "/usr/bin",
    };
    const env = buildClaudeEnv(base, { useAgentTeam: true });

    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env).not.toHaveProperty("CLAUDE_CODE_SSE_PORT");
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    // AGENT_TEAMS should be set to "1" (not the old value)
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
    expect(env.CLAUDE_SUBPROCESS).toBe("1");
  });
});

// ============================================================
// getClaudePath — binary path resolution
// ============================================================

describe("getClaudePath — binary path resolution", () => {
  let originalClaudePath: string | undefined;
  let originalClaudeBinary: string | undefined;

  beforeEach(() => {
    originalClaudePath = process.env.CLAUDE_PATH;
    originalClaudeBinary = process.env.CLAUDE_BINARY;
  });

  afterEach(() => {
    if (originalClaudePath !== undefined) {
      process.env.CLAUDE_PATH = originalClaudePath;
    } else {
      delete process.env.CLAUDE_PATH;
    }
    if (originalClaudeBinary !== undefined) {
      process.env.CLAUDE_BINARY = originalClaudeBinary;
    } else {
      delete process.env.CLAUDE_BINARY;
    }
  });

  test("returns explicit override when provided", () => {
    expect(getClaudePath("/custom/claude")).toBe("/custom/claude");
  });

  test("returns CLAUDE_PATH env var when set", () => {
    process.env.CLAUDE_PATH = "/usr/local/bin/claude";
    delete process.env.CLAUDE_BINARY;
    expect(getClaudePath()).toBe("/usr/local/bin/claude");
  });

  test("returns CLAUDE_BINARY env var as fallback when CLAUDE_PATH is not set", () => {
    delete process.env.CLAUDE_PATH;
    process.env.CLAUDE_BINARY = "/opt/claude";
    expect(getClaudePath()).toBe("/opt/claude");
  });

  test("returns 'claude' when no env vars are set", () => {
    delete process.env.CLAUDE_PATH;
    delete process.env.CLAUDE_BINARY;
    expect(getClaudePath()).toBe("claude");
  });
});
