import { describe, test, expect } from "bun:test";
import { buildProgressFooter, buildContextSwitchPrompt } from "./botCommands.ts";

// We test the pure functions only (no bot instance needed)
describe("buildProgressFooter", () => {
  test("returns null for fast responses", () => {
    const result = buildProgressFooter(999, 5000);
    // null because session doesn't exist for chatId 999
    expect(result).toBeNull();
  });

  test("returns null when under threshold", () => {
    // Even if session exists, under threshold returns null
    const result = buildProgressFooter(123, 20000, 30000);
    expect(result).toBeNull();
  });

  test("returns null for unknown chatId even when over threshold", () => {
    const footer = buildProgressFooter(999, 45000);
    expect(footer).toBeNull(); // no session for 999
  });
});

describe("buildContextSwitchPrompt", () => {
  test("includes topic in message", () => {
    const result = buildContextSwitchPrompt(["aws", "lambda", "deploy"]);
    expect(result).toContain("aws");
    expect(result).toContain("/new");
  });

  test("handles empty topics", () => {
    const result = buildContextSwitchPrompt([]);
    expect(result).toContain("/new");
    expect(result).toContain("Current session is active");
  });

  test("limits topics shown to 3", () => {
    const result = buildContextSwitchPrompt(["a", "b", "c", "d", "e"]);
    // Should only show 3
    expect(result).not.toContain("d,");
    expect(result).not.toContain("e,");
  });

  test("provides clear user choices", () => {
    const result = buildContextSwitchPrompt(["cooking"]);
    expect(result).toContain("Start fresh");
    expect(result).toContain("/new");
  });
});
