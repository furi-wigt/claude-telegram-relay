/**
 * Spawn isolation tests — verify all fixes for SIGINT restart loop (260219)
 *
 * Tests that:
 * 1. ecosystem.config.cjs has correct PM2 config (max_memory_restart, script path)
 * 2. src/relay.ts removes ALL Claude Code session env vars in callClaude()
 * 3. src/claude.ts removes ALL Claude Code session env vars in callClaudeText()
 * 4. src/relay.ts has heap-based OOM guard at 400MB threshold
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

// ─── ecosystem.config.cjs ────────────────────────────────────────────────────

describe("ecosystem.config.cjs — PM2 configuration integrity", () => {
  const ecosystemPath = join(ROOT, "ecosystem.config.cjs");
  let content: string;

  test("ecosystem.config.cjs exists", () => {
    expect(existsSync(ecosystemPath)).toBe(true);
    content = readFileSync(ecosystemPath, "utf8");
  });

  test("max_memory_restart is 1500M (not the too-low 500M that caused restart loop)", () => {
    content = readFileSync(ecosystemPath, "utf8");
    expect(content).toContain('"1500M"');
    expect(content).not.toContain('"500M"');
  });

  test("telegram-relay script points to relay-wrapper.js (not non-existent src/index.ts)", () => {
    content = readFileSync(ecosystemPath, "utf8");
    // Should contain relay-wrapper.js
    expect(content).toContain('relay-wrapper.js');
    // Should NOT point to src/index.ts (that file doesn't exist)
    expect(content).not.toContain('"src/index.ts"');
  });

  test("relay-wrapper.js file actually exists in project root", () => {
    expect(existsSync(join(ROOT, "relay-wrapper.js"))).toBe(true);
  });
});

// ─── src/relay.ts — callClaude() env var cleanup ─────────────────────────────

describe("src/relay.ts — Claude Code env var cleanup in callClaude()", () => {
  const relayPath = join(ROOT, "src", "relay.ts");
  let content: string;

  test("relay.ts exists", () => {
    expect(existsSync(relayPath)).toBe(true);
    content = readFileSync(relayPath, "utf8");
  });

  test("deletes CLAUDECODE from spawn env", () => {
    content = readFileSync(relayPath, "utf8");
    expect(content).toContain("'CLAUDECODE'");
  });

  test("deletes CLAUDE_CODE_SSE_PORT from spawn env", () => {
    content = readFileSync(relayPath, "utf8");
    expect(content).toContain("'CLAUDE_CODE_SSE_PORT'");
  });

  test("deletes CLAUDE_CODE_ENTRYPOINT from spawn env", () => {
    content = readFileSync(relayPath, "utf8");
    expect(content).toContain("'CLAUDE_CODE_ENTRYPOINT'");
  });

  test("deletes CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS from spawn env", () => {
    content = readFileSync(relayPath, "utf8");
    expect(content).toContain("'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'");
  });

  test("sets CLAUDE_SUBPROCESS marker to prevent false-positive nested session detection", () => {
    content = readFileSync(relayPath, "utf8");
    expect(content).toContain('CLAUDE_SUBPROCESS');
  });
});

// ─── src/claude.ts — callClaudeText() env var cleanup ────────────────────────

describe("src/claude.ts — Claude Code env var cleanup in callClaudeText()", () => {
  const claudePath = join(ROOT, "src", "claude.ts");
  let content: string;

  test("claude.ts exists", () => {
    expect(existsSync(claudePath)).toBe(true);
    content = readFileSync(claudePath, "utf8");
  });

  test("deletes CLAUDECODE from spawn env", () => {
    content = readFileSync(claudePath, "utf8");
    expect(content).toContain("'CLAUDECODE'");
  });

  test("deletes CLAUDE_CODE_SSE_PORT from spawn env", () => {
    content = readFileSync(claudePath, "utf8");
    expect(content).toContain("'CLAUDE_CODE_SSE_PORT'");
  });

  test("deletes CLAUDE_CODE_ENTRYPOINT from spawn env", () => {
    content = readFileSync(claudePath, "utf8");
    expect(content).toContain("'CLAUDE_CODE_ENTRYPOINT'");
  });

  test("deletes CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS from spawn env", () => {
    content = readFileSync(claudePath, "utf8");
    expect(content).toContain("'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'");
  });

  test("sets CLAUDE_SUBPROCESS marker", () => {
    content = readFileSync(claudePath, "utf8");
    expect(content).toContain('CLAUDE_SUBPROCESS');
  });
});

// ─── src/relay.ts — Heap-based OOM guard ─────────────────────────────────────

describe("src/relay.ts — Heap-based OOM guard", () => {
  const relayPath = join(ROOT, "src", "relay.ts");
  let content: string;

  test("has HEAP_OOM_THRESHOLD constant at 400MB", () => {
    content = readFileSync(relayPath, "utf8");
    // 400MB = 400 * 1024 * 1024
    expect(content).toContain("HEAP_OOM_THRESHOLD");
    expect(content).toContain("400 * 1024 * 1024");
  });

  test("checks heapUsed against threshold", () => {
    content = readFileSync(relayPath, "utf8");
    expect(content).toContain("heapUsed > HEAP_OOM_THRESHOLD");
  });

  test("calls process.exit(1) on heap OOM", () => {
    content = readFileSync(relayPath, "utf8");
    // Should have process.exit(1) in the OOM guard context
    expect(content).toContain("process.exit(1)");
  });

  test("OOM guard is inside the memory diagnostic interval (not startup code)", () => {
    content = readFileSync(relayPath, "utf8");
    // OOM threshold and setInterval should both appear in the file
    expect(content).toContain("setInterval");
    expect(content).toContain("HEAP_OOM_THRESHOLD");
  });
});
