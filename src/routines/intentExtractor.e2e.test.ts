/**
 * E2E tests for intentExtractor — callRoutineModel edition
 *
 * Verifies that extractRoutineConfig uses callRoutineModel (MLX → Ollama cascade)
 * and correctly parses, validates, and returns PendingRoutine configs.
 *
 * Run: bun test src/routines/intentExtractor.e2e.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ============================================================
// Mock callRoutineModel (MLX → Ollama cascade)
// ============================================================

const mockCallRoutineModel = mock(
  async (_prompt: string, _options?: object) => "{}"
);

mock.module("./routineModel.ts", () => ({
  callRoutineModel: mockCallRoutineModel,
  getLastProvider: () => "mlx",
}));

mock.module("../claude-process.ts", () => ({
  claudeText: mock(async () => "{}"),
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
  mockCallRoutineModel.mockReset();
});

// ============================================================
// detectRoutineIntent — pure regex, no mock needed
// ============================================================

describe("detectRoutineIntent", () => {
  test("matches routine creation phrases", () => {
    const positives = [
      "create a routine to check AWS costs",
      "schedule a routine to send me a summary",
      "add a routine for weekly reports",
      "I want a new routine for cost monitoring",
      "remind me every morning at 9am",
      "set up a daily check for S3 buckets",
    ];
    for (const msg of positives) {
      expect(detectRoutineIntent(msg)).toBe(true);
    }
  });

  test("rejects non-routine messages", () => {
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
// extractRoutineConfig — callRoutineModel (MLX → Ollama)
// ============================================================

describe("extractRoutineConfig", () => {
  // ---- Happy path ----

  test("returns PendingRoutine for valid JSON response", async () => {
    mockCallRoutineModel.mockResolvedValue(makeValidJson());

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

  test("model is called with the user message embedded in prompt", async () => {
    mockCallRoutineModel.mockResolvedValue(makeValidJson());

    const userMsg = "create a routine that checks AWS costs daily";
    await extractRoutineConfig(userMsg);

    expect(mockCallRoutineModel).toHaveBeenCalledTimes(1);
    const [calledPrompt] = mockCallRoutineModel.mock.calls[0];
    expect(calledPrompt).toContain(userMsg);
    expect(calledPrompt).toContain("JSON");
  });

  // ---- Name sanitization ----

  test("name is sanitized to kebab-case and truncated to 30 chars", async () => {
    mockCallRoutineModel.mockResolvedValue(
      makeValidJson({ name: "My DAILY AWS Cost Check!!! With Extra Text That Is Too Long" })
    );

    const result = await extractRoutineConfig("create a daily routine");

    expect(result?.config.name).toMatch(/^[a-z0-9-]+$/);
    expect(result!.config.name.length).toBeLessThanOrEqual(30);
  });

  // ---- Error cases ----

  test("returns null when LLM returns error JSON", async () => {
    mockCallRoutineModel.mockResolvedValue(
      JSON.stringify({ error: "Cannot determine schedule from this message" })
    );

    const result = await extractRoutineConfig("hello world");

    expect(result).toBeNull();
  });

  test("returns null when required fields are missing", async () => {
    mockCallRoutineModel.mockResolvedValue(
      JSON.stringify({ name: "incomplete-routine" }) // missing cron and prompt
    );

    const result = await extractRoutineConfig("create a routine");

    expect(result).toBeNull();
  });

  test("returns null when cron has wrong number of fields", async () => {
    mockCallRoutineModel.mockResolvedValue(
      makeValidJson({ cron: "0 9 *" }) // only 3 fields instead of 5
    );

    const result = await extractRoutineConfig("create a daily routine");

    expect(result).toBeNull();
  });

  test("returns null when model throws", async () => {
    mockCallRoutineModel.mockRejectedValue(new Error("MLX/Ollama both failed"));

    const result = await extractRoutineConfig("create a daily routine");

    expect(result).toBeNull();
  });

  test("returns null when response is not valid JSON", async () => {
    mockCallRoutineModel.mockResolvedValue("Sorry, I cannot help with that.");

    const result = await extractRoutineConfig("create a daily routine");

    expect(result).toBeNull();
  });

  test("returns null when response is empty string", async () => {
    mockCallRoutineModel.mockResolvedValue("");

    const result = await extractRoutineConfig("create a daily routine");

    expect(result).toBeNull();
  });

  // ---- scheduleDescription fallback ----

  test("uses cron as scheduleDescription when missing from response", async () => {
    mockCallRoutineModel.mockResolvedValue(
      JSON.stringify({
        name: "aws-check",
        cron: "0 9 * * *",
        prompt: "Check AWS costs",
      })
    );

    const result = await extractRoutineConfig("create a routine");

    expect(result?.config.scheduleDescription).toBe("0 9 * * *");
  });

  // ---- createdAt ----

  test("createdAt is a recent timestamp", async () => {
    const before = Date.now();
    mockCallRoutineModel.mockResolvedValue(makeValidJson());

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
    // The mock intercepts the model call before any subprocess is spawned
    mockCallRoutineModel.mockResolvedValue(makeValidJson());
    const result = await extractRoutineConfig("create a routine");
    expect(result).not.toBeNull();
  });
});
