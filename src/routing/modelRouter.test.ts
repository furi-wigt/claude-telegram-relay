/**
 * Unit tests for src/routing/modelRouter.ts
 *
 * All claudeText calls are mocked — no real API calls.
 * Run: bun test src/routing/modelRouter.test.ts
 */

import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";

// ── Mock claude-process BEFORE importing modelRouter ─────────────────────────
// bun:test requires mock.module to be called before the module under test is
// imported so the mock is in place when modelRouter.ts resolves its dependency.

const mockClaudeText = mock(() => Promise.resolve("sonnet"));

mock.module("../claude-process", () => ({
  claudeText: mockClaudeText,
  claudeStream: mock(() => Promise.resolve("")),
  buildClaudeEnv: mock(() => ({})),
  getClaudePath: mock(() => "claude"),
}));

// Import AFTER mocking
const { classify, resolveModel, modelDisplayName } = await import("./modelRouter");
import type { ModelRouterConfig } from "./modelRouter";

// ── Shared test config ────────────────────────────────────────────────────────

const testConfig: ModelRouterConfig = {
  enabled: true,
  classifierTimeoutMs: 8000,
  logTierDecisions: false,
  firstPassModel: "claude-haiku-4-5-20251001",
  firstPassFallback: "gemma3:4b",
  secondPassModel: "claude-sonnet-4-6",
  secondPassFallback: "gemma3:4b",
  thirdPassModel: "claude-opus-4-6",
  thirdPassFallback: "gemma3:4b",
  opusEnabled: false,
};

beforeEach(() => {
  mockClaudeText.mockReset();
  mockClaudeText.mockResolvedValue("sonnet");
});

// ═════════════════════════════════════════════════════════════════════════════
// Suite A: modelDisplayName
// ═════════════════════════════════════════════════════════════════════════════

describe("modelDisplayName", () => {
  test("haiku model → Haiku", () => {
    expect(modelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku");
  });

  test("sonnet model → Sonnet", () => {
    expect(modelDisplayName("claude-sonnet-4-6")).toBe("Sonnet");
  });

  test("opus model → Opus", () => {
    expect(modelDisplayName("claude-opus-4-6")).toBe("Opus");
  });

  test("gemma3:4b → gemma3", () => {
    expect(modelDisplayName("gemma3:4b")).toBe("gemma3");
  });

  test("unknown model → segment before first dash", () => {
    expect(modelDisplayName("mistral-7b")).toBe("mistral");
  });

  test("bare model name with no separators → full name", () => {
    expect(modelDisplayName("llama3")).toBe("llama3");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Suite B: resolveModel
// ═════════════════════════════════════════════════════════════════════════════

describe("resolveModel", () => {
  test("classifier returns 'handle' → Haiku model + displayName", async () => {
    mockClaudeText.mockResolvedValue("handle");
    const result = await resolveModel("What time is it?", testConfig);
    expect(result.model).toBe(testConfig.firstPassModel);
    expect(result.displayName).toBe("Haiku");
    expect(result.decision).toBe("handle");
  });

  test("classifier returns 'sonnet' → Sonnet model + displayName", async () => {
    mockClaudeText.mockResolvedValue("sonnet");
    const result = await resolveModel("Write a Python function to sort a list", testConfig);
    expect(result.model).toBe(testConfig.secondPassModel);
    expect(result.displayName).toBe("Sonnet");
    expect(result.decision).toBe("sonnet");
  });

  test("classifier returns 'opus' with opusEnabled=true → Opus model + displayName", async () => {
    mockClaudeText.mockResolvedValue("opus");
    const config = { ...testConfig, opusEnabled: true };
    const result = await resolveModel("Design a multi-region resilient architecture", config);
    expect(result.model).toBe(testConfig.thirdPassModel);
    expect(result.displayName).toBe("Opus");
    expect(result.decision).toBe("opus");
  });

  test("classifier returns 'opus' with opusEnabled=false → Sonnet model used", async () => {
    mockClaudeText.mockResolvedValue("opus");
    const config = { ...testConfig, opusEnabled: false };
    const result = await resolveModel("Design a multi-region resilient architecture", config);
    expect(result.model).toBe(testConfig.secondPassModel);
    expect(result.displayName).toBe("Sonnet");
    // decision still reflects what the classifier said
    expect(result.decision).toBe("opus");
  });

  test("unexpected classifier output → defaults to secondPassModel", async () => {
    mockClaudeText.mockResolvedValue("maybe");
    const result = await resolveModel("some message", testConfig);
    expect(result.model).toBe(testConfig.secondPassModel);
    expect(result.displayName).toBe("Sonnet");
  });

  test("classifier throws → defaults to secondPassModel", async () => {
    mockClaudeText.mockRejectedValue(new Error("Request timeout"));
    const result = await resolveModel("some message", testConfig);
    expect(result.model).toBe(testConfig.secondPassModel);
    expect(result.displayName).toBe("Sonnet");
  });

  test("routing disabled → always returns secondPassModel without calling classifier", async () => {
    const config = { ...testConfig, enabled: false };
    const result = await resolveModel("What is the weather?", config);
    expect(result.model).toBe(testConfig.secondPassModel);
    expect(result.displayName).toBe("Sonnet");
    // claudeText should NOT have been called — routing skipped
    expect(mockClaudeText.mock.calls.length).toBe(0);
  });

  test("logs tier decision when logTierDecisions=true", async () => {
    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      mockClaudeText.mockResolvedValue("sonnet");
      const config = { ...testConfig, logTierDecisions: true };
      await resolveModel("Write a regex to validate email", config);
      const loggedMessages = consoleSpy.mock.calls.map((args) => String(args[0]));
      const routerLog = loggedMessages.find((m) => m.includes("[Router]"));
      expect(routerLog).toBeDefined();
      expect(routerLog).toContain("sonnet");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  test("does NOT log when logTierDecisions=false", async () => {
    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      mockClaudeText.mockResolvedValue("sonnet");
      const config = { ...testConfig, logTierDecisions: false };
      await resolveModel("some message", config);
      const loggedMessages = consoleSpy.mock.calls.map((args) => String(args[0]));
      const routerLog = loggedMessages.find((m) => m.includes("[Router]"));
      expect(routerLog).toBeUndefined();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Suite C: classify (internal, exported for testing)
// ═════════════════════════════════════════════════════════════════════════════

describe("classify", () => {
  test("passes user message to claudeText", async () => {
    mockClaudeText.mockResolvedValue("handle");
    await classify("hello world", testConfig);
    expect(mockClaudeText.mock.calls.length).toBe(1);
    const promptArg = mockClaudeText.mock.calls[0][0] as string;
    expect(promptArg).toContain("hello world");
  });

  test("trims and lowercases classifier output", async () => {
    mockClaudeText.mockResolvedValue("  HANDLE  ");
    const result = await classify("hi", testConfig);
    expect(result).toBe("handle");
  });

  test("unknown output → sonnet", async () => {
    mockClaudeText.mockResolvedValue("unclear");
    expect(await classify("hi", testConfig)).toBe("sonnet");
  });

  test("claudeText throw → sonnet", async () => {
    mockClaudeText.mockRejectedValue(new Error("timeout"));
    expect(await classify("hi", testConfig)).toBe("sonnet");
  });
});
