/**
 * Claude Integration — integration tests (real Claude CLI).
 * Run: RUN_INTEGRATION_TESTS=1 bun test integrations/claude/claude.integration.test.ts
 */

import { describe, test, expect } from "bun:test";
import { claudeText } from "./index.ts";
import { runPrompt } from "../../src/tools/runPrompt.ts";
import { readFileSync } from "fs";
import { join } from "path";

// Load .env
try {
  const envFile = readFileSync(join(import.meta.dirname, "../../.env"), "utf-8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = value;
  }
} catch { /* .env not found, rely on process.env */ }

// Also skip when running inside a Claude Code session — nested claude subprocesses hang.
const SKIP = !process.env.RUN_INTEGRATION_TESTS || !!process.env.CLAUDECODE;

describe.skipIf(SKIP)("claude integration", () => {
  test("claudeText returns a non-empty string", async () => {
    const result = await claudeText('Say "OK" and nothing else', {
      model: "claude-haiku-4-5-20251001",
      timeoutMs: 30_000,
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  }, 60_000);

  test("runPrompt returns a non-empty string", async () => {
    const result = await runPrompt("Say hello in one word");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  }, 60_000);
});
