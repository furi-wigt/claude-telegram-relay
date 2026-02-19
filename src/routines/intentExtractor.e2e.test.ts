/**
 * E2E tests for intentExtractor — process-based claudeText edition
 *
 * Verifies that extractRoutineConfig uses claudeText (unified spawner)
 * and correctly parses, validates, and returns PendingRoutine configs.
 *
 * Run: bun test src/routines/intentExtractor.e2e.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ============================================================
// Mock claudeText before importing intentExtractor
// ============================================================

const mockCallClaudeText = mock(
  async (_prompt: string, _options?: { model?: string; timeoutMs?: number }) => "{}"
);

mock.module("../claude-process.ts", () => ({
  claudeText: mockCallClaudeText,
}));

const { detectRoutineIntent, extractRoutineConfig } = await import(
  "./intentExtractor.ts"
);

// ============================================================
// Helpers
// ============================================================

function makeValidJson(overrides?: object): string {
  return JSON.stringify({
    name: "daily-aws-cost",
    cron: "0 9 * * *",
    scheduleDescription: "Daily at 9am",
    prompt: "Summarize my AWS costs for today",
    ...overrides,
  });
}

// ============================================================
// Reset mocks before each test
// ============================================================

beforeEach(() => {
  mockCallClaudeText.mockReset();
});

// ============================================================
// detectRoutineIntent — pure regex, no mock needed
// ============================================================

describe("detectRoutineIntent", () => {
  test("matches routine creation phrases", () => {
    const positives = [
      "create a routine that checks my AWS costs daily",
      "schedule a routine for morning briefing",
      "set up a daily summary at 9am",
      "remind me every Sunday to review goals",
      "add a weekly ETF report",
      "run every Monday at 8am and send a status update",
      "new routine for night review",
    ];
    for (const msg of positives) {
      expect(detectRoutineIntent(msg)).toBe(true);
    }
  });

  test("does not trigger on normal messages", () => {
    const negatives = [
      "what is the weather today",
      "show me my AWS costs",
      "hello how are you",
      "what are my goals",
      "explain quantum computing",
    ];
    for (const msg of negatives) {
      expect(detectRoutineIntent(msg)).toBe(false);
    }
  });
});

// ============================================================
// extractRoutineConfig — uses mocked callClaudeText
// ============================================================

describe("extractRoutineConfig", () => {
  // ---- Happy path ----

  test("returns PendingRoutine for valid JSON response", async () => {
    mockCallClaudeText.mockResolvedValue(makeValidJson());

    const result = await extractRoutineConfig(
      "create a daily routine at 9am to summarize AWS costs"
    );

    expect(result).not.toBeNull();
    expect(result?.config.name).toBe("daily-aws-cost");
    expect(result?.config.cron).toBe("0 9 * * *");
    expect(result?.config.scheduleDescription).toBe("Daily at 9am");
    expect(result?.config.prompt).toBe("Summarize my AWS costs for today");
    expect(typeof result?.createdAt).toBe("number");
  });

  test("claudeText is called with the user message embedded in prompt", async () => {
    mockCallClaudeText.mockResolvedValue(makeValidJson());

    const userMsg = "create a routine that checks AWS costs daily";
    await extractRoutineConfig(userMsg);

    expect(mockCallClaudeText).toHaveBeenCalledTimes(1);
    const [calledPrompt] = mockCallClaudeText.mock.calls[0];
    expect(calledPrompt).toContain(userMsg);
    expect(calledPrompt).toContain("JSON");
  });

  test("claudeText is called with haiku model", async () => {
    mockCallClaudeText.mockResolvedValue(makeValidJson());

    await extractRoutineConfig("create a daily routine");

    const [, options] = mockCallClaudeText.mock.calls[0];
    expect(options?.model).toBe("claude-haiku-4-5-20251001");
  });

  test("claudeText is called with 30s timeout", async () => {
    mockCallClaudeText.mockResolvedValue(makeValidJson());

    await extractRoutineConfig("create a daily routine");

    const [, options] = mockCallClaudeText.mock.calls[0];
    expect(options?.timeoutMs).toBe(30_000);
  });

  // ---- Name sanitization ----

  test("name is sanitized to kebab-case and truncated to 30 chars", async () => {
    mockCallClaudeText.mockResolvedValue(
      makeValidJson({ name: "My DAILY AWS Cost Check!!! With Extra Text That Is Too Long" })
    );

    const result = await extractRoutineConfig("create a daily routine");

    expect(result?.config.name).toMatch(/^[a-z0-9-]+$/);
    expect(result!.config.name.length).toBeLessThanOrEqual(30);
  });

  // ---- Error cases ----

  test("returns null when Claude returns error JSON", async () => {
    mockCallClaudeText.mockResolvedValue(
      JSON.stringify({ error: "Cannot determine schedule from this message" })
    );

    const result = await extractRoutineConfig("hello world");

    expect(result).toBeNull();
  });

  test("returns null when required fields are missing", async () => {
    mockCallClaudeText.mockResolvedValue(
      JSON.stringify({ name: "incomplete-routine" }) // missing cron and prompt
    );

    const result = await extractRoutineConfig("create a routine");

    expect(result).toBeNull();
  });

  test("returns null when cron has wrong number of fields", async () => {
    mockCallClaudeText.mockResolvedValue(
      makeValidJson({ cron: "0 9 *" }) // only 3 fields instead of 5
    );

    const result = await extractRoutineConfig("create a daily routine");

    expect(result).toBeNull();
  });

  test("returns null when claudeText throws (timeout/exit)", async () => {
    mockCallClaudeText.mockRejectedValue(
      new Error("claudeText: timeout after 30000ms")
    );

    const result = await extractRoutineConfig("create a daily routine");

    expect(result).toBeNull();
  });

  test("returns null when response is not valid JSON", async () => {
    mockCallClaudeText.mockResolvedValue("Sorry, I cannot help with that.");

    const result = await extractRoutineConfig("create a daily routine");

    expect(result).toBeNull();
  });

  test("returns null when response is empty string", async () => {
    mockCallClaudeText.mockResolvedValue("");

    const result = await extractRoutineConfig("create a daily routine");

    expect(result).toBeNull();
  });

  // ---- scheduleDescription fallback ----

  test("uses cron as scheduleDescription when missing from response", async () => {
    mockCallClaudeText.mockResolvedValue(
      JSON.stringify({
        name: "aws-check",
        cron: "0 9 * * *",
        prompt: "Check AWS costs",
        // no scheduleDescription
      })
    );

    const result = await extractRoutineConfig("create a routine");

    expect(result?.config.scheduleDescription).toBe("0 9 * * *");
  });

  // ---- createdAt ----

  test("createdAt is a recent timestamp", async () => {
    const before = Date.now();
    mockCallClaudeText.mockResolvedValue(makeValidJson());

    const result = await extractRoutineConfig("create a routine");

    const after = Date.now();
    expect(result?.createdAt).toBeGreaterThanOrEqual(before);
    expect(result?.createdAt).toBeLessThanOrEqual(after);
  });
});

// ============================================================
// Integration: no Anthropic SDK import
// ============================================================

describe("SDK independence", () => {
  test("extractRoutineConfig does not import Anthropic SDK", async () => {
    // If the SDK is not imported, this won't throw even without credentials
    // The mock intercepts claudeText before any subprocess is spawned
    mockCallClaudeText.mockResolvedValue(makeValidJson());

    // Should work without ANTHROPIC_API_KEY in env
    const oldKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const result = await extractRoutineConfig("create a daily routine");
      expect(result).not.toBeNull();
    } finally {
      if (oldKey !== undefined) process.env.ANTHROPIC_API_KEY = oldKey;
    }
  });
});
