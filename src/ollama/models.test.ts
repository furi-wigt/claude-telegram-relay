import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getModel, getEnvVar, ALL_PURPOSES, type OllamaPurpose } from "./models.ts";

describe("getModel", () => {
  const saved: Record<string, string | undefined> = {};
  const envKeys = [
    "OLLAMA_MODEL",
    "OLLAMA_CHAT_MODEL",
    "OLLAMA_MEMORY_MODEL",
    "OLLAMA_CONFLICT_MODEL",
    "OLLAMA_RELEVANCE_MODEL",
    "OLLAMA_STM_MODEL",
    "OLLAMA_ANALYSIS_MODEL",
    "OLLAMA_ROUTINE_MODEL",
    "OLLAMA_LTM_MODEL",
  ];

  beforeEach(() => {
    for (const k of envKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  test("returns compiled default when no env vars set", () => {
    expect(getModel("chat-fallback")).toBe("qwen2.5:7b-instruct-Q6_K");
    expect(getModel("memory-summary")).toBe("qwen2.5:7b-instruct-Q6_K");
  });

  test("OLLAMA_MODEL overrides compiled default", () => {
    process.env.OLLAMA_MODEL = "llama3.2:3b";
    expect(getModel("chat-fallback")).toBe("llama3.2:3b");
    expect(getModel("team-analysis")).toBe("llama3.2:3b");
  });

  test("purpose-specific env var overrides OLLAMA_MODEL", () => {
    process.env.OLLAMA_MODEL = "llama3.2:3b";
    process.env.OLLAMA_CHAT_MODEL = "mistral:7b";
    expect(getModel("chat-fallback")).toBe("mistral:7b");
    // Other purposes still use global
    expect(getModel("memory-summary")).toBe("llama3.2:3b");
  });

  test("all purposes resolve without error", () => {
    for (const purpose of ALL_PURPOSES) {
      expect(typeof getModel(purpose)).toBe("string");
      expect(getModel(purpose).length).toBeGreaterThan(0);
    }
  });
});

describe("getEnvVar", () => {
  test("returns correct env var name for each purpose", () => {
    expect(getEnvVar("chat-fallback")).toBe("OLLAMA_CHAT_MODEL");
    expect(getEnvVar("memory-summary")).toBe("OLLAMA_MEMORY_MODEL");
    expect(getEnvVar("ltm-extraction")).toBe("OLLAMA_LTM_MODEL");
  });
});

describe("ALL_PURPOSES", () => {
  test("contains all 9 purposes", () => {
    expect(ALL_PURPOSES.length).toBe(9);
    expect(ALL_PURPOSES).toContain("chat-fallback");
    expect(ALL_PURPOSES).toContain("ltm-extraction");
    expect(ALL_PURPOSES).toContain("topic-generation");
  });
});
