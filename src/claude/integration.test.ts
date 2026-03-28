/**
 * Integration tests — verify all spawn sites use the unified claude-process module.
 *
 * Run: bun test src/claude/integration.test.ts
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");

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

  test("src/memory/longTermExtractor.ts imports from routineModel (refactored from claude-process)", () => {
    const content = readFileSync(
      join(ROOT, "src", "memory", "longTermExtractor.ts"),
      "utf8"
    );
    // After ltm_overhaul refactor, longTermExtractor uses routineModel instead of claude-process
    expect(content).toMatch(/from\s+["']\.\.\/routines\/routineModel(\.ts)?["']/);
  });
});
