/**
 * End-to-end tests for LTM (Long-Term Memory) extraction.
 *
 * Covers:
 *   1. Happy path — Claude Haiku extracts memories (provider="claude")
 *   2. Fallback — Claude times out, Ollama handles extraction (provider="ollama")
 *   3. Both fail — graceful degradation returns empty result (provider="none")
 *   4. JSON parsing edge cases — malformed/wrapped responses
 *   5. Timeout values — verifies the 60s/30s timeout configuration
 *
 * Strategy: mock `claudeText` (claude-process) and `callOllamaGenerate` (ollama)
 * via `mock.module` to simulate LLM behavior without requiring real CLI or API.
 *
 * Run: bun test src/memory/longTermExtractor.e2e.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { tmpdir } from "os";

// ── Mock infrastructure ──────────────────────────────────────────────────────

const claudeTextMock = mock(async (_prompt: string, _options?: unknown) => "{}");
const callOllamaGenerateMock = mock(async (_prompt: string, _options?: unknown) => "{}");

mock.module("../claude-process.ts", () => ({
  claudeText: claudeTextMock,
}));

mock.module("../ollama.ts", () => ({
  callOllamaGenerate: callOllamaGenerateMock,
}));


// Import AFTER mocking so the module picks up our mocks
const { extractMemoriesFromExchange } = await import("./longTermExtractor.ts");

beforeEach(() => {
  claudeTextMock.mockReset();
  callOllamaGenerateMock.mockReset();
});

// ============================================================
// 1. Happy path — Claude Haiku succeeds
// ============================================================

describe("LTM extraction — happy path (Claude Haiku)", () => {
  test("extracts certain and uncertain memories from valid JSON", async () => {
    const llmResponse = JSON.stringify({
      certain: {
        facts: ["User is a solution architect in Singapore"],
        preferences: ["Prefers TDD approach"],
      },
      uncertain: {
        goals: ["Might be learning Rust"],
      },
    });

    claudeTextMock.mockImplementation(async () => llmResponse);

    const result = await extractMemoriesFromExchange(
      "I'm a solution architect in Singapore. I always write tests first.",
      "That's great! TDD is a solid approach.",
      12345,
      "trace-001"
    );

    expect(result.certain.facts).toEqual(["User is a solution architect in Singapore"]);
    expect(result.certain.preferences).toEqual(["Prefers TDD approach"]);
    expect(result.uncertain.goals).toEqual(["Might be learning Rust"]);

    // Claude was called, Ollama was not
    expect(claudeTextMock).toHaveBeenCalledTimes(1);
    expect(callOllamaGenerateMock).not.toHaveBeenCalled();
  });

  test("returns empty result when Claude returns empty JSON", async () => {
    claudeTextMock.mockImplementation(async () => "{}");

    const result = await extractMemoriesFromExchange("Hello", undefined, 12345);

    expect(result.certain).toEqual({});
    expect(result.uncertain).toEqual({});
  });

  test("returns empty result when Claude returns no extractable info", async () => {
    claudeTextMock.mockImplementation(async () =>
      JSON.stringify({ certain: {}, uncertain: {} })
    );

    const result = await extractMemoriesFromExchange("What's the weather?");

    expect(result.certain).toEqual({});
    expect(result.uncertain).toEqual({});
  });

  test("handles all memory types (facts, preferences, goals, dates)", async () => {
    const llmResponse = JSON.stringify({
      certain: {
        facts: ["Lives in Tokyo"],
        preferences: ["Uses Vim"],
        goals: ["Launch SaaS product by Q3"],
        dates: ["Birthday is March 15"],
      },
      uncertain: {},
    });

    claudeTextMock.mockImplementation(async () => llmResponse);

    const result = await extractMemoriesFromExchange(
      "I live in Tokyo, use Vim, my birthday is March 15, and I want to launch my SaaS by Q3."
    );

    expect(result.certain.facts).toEqual(["Lives in Tokyo"]);
    expect(result.certain.preferences).toEqual(["Uses Vim"]);
    expect(result.certain.goals).toEqual(["Launch SaaS product by Q3"]);
    expect(result.certain.dates).toEqual(["Birthday is March 15"]);
  });
});

// ============================================================
// 2. Fallback — Claude fails, Ollama succeeds
// ============================================================

describe("LTM extraction — Ollama fallback", () => {
  test("falls back to Ollama when Claude times out", async () => {
    claudeTextMock.mockImplementation(async () => {
      throw new Error("claudeText: timeout after 60000ms");
    });

    const ollamaResponse = JSON.stringify({
      certain: {
        facts: ["User works in government tech"],
      },
      uncertain: {},
    });
    callOllamaGenerateMock.mockImplementation(async () => ollamaResponse);

    const result = await extractMemoriesFromExchange(
      "I work in government tech",
      undefined,
      12345,
      "trace-fallback"
    );

    expect(result.certain.facts).toEqual(["User works in government tech"]);
    expect(claudeTextMock).toHaveBeenCalledTimes(1);
    expect(callOllamaGenerateMock).toHaveBeenCalledTimes(1);
  });

  test("falls back to Ollama when Claude spawn fails", async () => {
    claudeTextMock.mockImplementation(async () => {
      throw new Error("claudeText: failed to spawn 'claude' — ENOENT");
    });

    callOllamaGenerateMock.mockImplementation(async () =>
      JSON.stringify({
        certain: { preferences: ["Likes coffee"] },
        uncertain: {},
      })
    );

    const result = await extractMemoriesFromExchange("I love coffee");

    expect(result.certain.preferences).toEqual(["Likes coffee"]);
    expect(callOllamaGenerateMock).toHaveBeenCalledTimes(1);
  });

  test("falls back to Ollama when Claude returns non-zero exit", async () => {
    claudeTextMock.mockImplementation(async () => {
      throw new Error("claudeText: exit 1 — API key expired");
    });

    callOllamaGenerateMock.mockImplementation(async () =>
      JSON.stringify({ certain: { goals: ["Learn Kubernetes"] }, uncertain: {} })
    );

    const result = await extractMemoriesFromExchange("I want to learn Kubernetes");

    expect(result.certain.goals).toEqual(["Learn Kubernetes"]);
  });
});

// ============================================================
// 3. Both fail — graceful degradation
// ============================================================

describe("LTM extraction — both providers fail", () => {
  test("returns empty result when both Claude and Ollama fail", async () => {
    claudeTextMock.mockImplementation(async () => {
      throw new Error("claudeText: timeout after 60000ms");
    });

    callOllamaGenerateMock.mockImplementation(async () => {
      throw new Error("Ollama API error: HTTP 503");
    });

    const result = await extractMemoriesFromExchange(
      "Important message",
      "Important response",
      12345,
      "trace-both-fail"
    );

    expect(result.certain).toEqual({});
    expect(result.uncertain).toEqual({});
  });

  test("does not throw when both providers fail", async () => {
    claudeTextMock.mockImplementation(async () => {
      throw new Error("spawn failure");
    });

    callOllamaGenerateMock.mockImplementation(async () => {
      throw new Error("connection refused");
    });

    // Should not throw — just return empty
    const result = await extractMemoriesFromExchange("test message");
    expect(result).toEqual({ certain: {}, uncertain: {} });
  });
});

// ============================================================
// 4. JSON parsing edge cases
// ============================================================

describe("LTM extraction — JSON parsing edge cases", () => {
  test("extracts JSON wrapped in markdown code block", async () => {
    claudeTextMock.mockImplementation(async () =>
      '```json\n{"certain": {"facts": ["Has a dog named Rex"]}, "uncertain": {}}\n```'
    );

    const result = await extractMemoriesFromExchange("My dog Rex loves walks");

    expect(result.certain.facts).toEqual(["Has a dog named Rex"]);
  });

  test("extracts JSON with surrounding text", async () => {
    claudeTextMock.mockImplementation(async () =>
      'Here is the extraction:\n{"certain": {"facts": ["Born in 1990"]}, "uncertain": {}}\nDone.'
    );

    const result = await extractMemoriesFromExchange("I was born in 1990");

    expect(result.certain.facts).toEqual(["Born in 1990"]);
  });

  test("handles non-string array items gracefully (sanitizeMemories)", async () => {
    // LLM returns objects instead of strings in an array
    claudeTextMock.mockImplementation(async () =>
      JSON.stringify({
        certain: {
          facts: ["Valid fact", 123, { nested: true }, "Another valid fact"],
        },
        uncertain: {},
      })
    );

    const result = await extractMemoriesFromExchange("Some message");

    // Only string items should survive sanitization
    expect(result.certain.facts).toEqual(["Valid fact", "Another valid fact"]);
  });

  test("returns empty on completely invalid JSON", async () => {
    claudeTextMock.mockImplementation(async () => "This is not JSON at all");

    const result = await extractMemoriesFromExchange("test");

    expect(result.certain).toEqual({});
    expect(result.uncertain).toEqual({});
  });
});

// ============================================================
// 5. Timeout configuration verification
// ============================================================

describe("LTM extraction — timeout configuration", () => {
  test("passes 60s timeout to claudeText", async () => {
    claudeTextMock.mockImplementation(async () => "{}");

    await extractMemoriesFromExchange("test");

    expect(claudeTextMock).toHaveBeenCalledTimes(1);
    const [, options] = claudeTextMock.mock.calls[0] as [string, { timeoutMs: number }];
    expect(options.timeoutMs).toBe(60_000);
  });

  test("passes 30s timeout to Ollama fallback", async () => {
    claudeTextMock.mockImplementation(async () => {
      throw new Error("timeout");
    });
    callOllamaGenerateMock.mockImplementation(async () => "{}");

    await extractMemoriesFromExchange("test");

    expect(callOllamaGenerateMock).toHaveBeenCalledTimes(1);
    const [, options] = callOllamaGenerateMock.mock.calls[0] as [string, { timeoutMs: number }];
    expect(options.timeoutMs).toBe(30_000);
  });
});

// ============================================================
// 6. Input handling
// ============================================================

describe("LTM extraction — input handling", () => {
  test("works with user message only (no assistant response)", async () => {
    claudeTextMock.mockImplementation(async () =>
      JSON.stringify({ certain: { facts: ["Likes hiking"] }, uncertain: {} })
    );

    const result = await extractMemoriesFromExchange("I enjoy hiking on weekends");

    expect(result.certain.facts).toEqual(["Likes hiking"]);

    // Verify prompt contains user turn tag but no assistant turn block.
    // RULES text mentions "<assistant_turn>" by name — the actual block uses "<assistant_turn>\n".
    const [prompt] = claudeTextMock.mock.calls[0] as [string];
    expect(prompt).toContain("<user_turn>\n");
    expect(prompt).not.toContain("<assistant_turn>\n");
  });

  test("includes both user and assistant text in prompt under <exchange> XML tags", async () => {
    claudeTextMock.mockImplementation(async () => "{}");

    await extractMemoriesFromExchange(
      "I'm moving to Berlin",
      "That's exciting! Berlin is a great city."
    );

    const [prompt] = claudeTextMock.mock.calls[0] as [string];
    expect(prompt).toContain("I'm moving to Berlin");
    expect(prompt).toContain("That's exciting!");
    expect(prompt).toContain("<exchange>");
    expect(prompt).toContain("<user_turn>");
    expect(prompt).toContain("<assistant_turn>");
  });

  test("truncates long messages to prevent prompt explosion", async () => {
    claudeTextMock.mockImplementation(async () => "{}");

    const longMessage = "x".repeat(5000);
    await extractMemoriesFromExchange(longMessage, longMessage);

    const [prompt] = claudeTextMock.mock.calls[0] as [string];
    // Both turns present inside <exchange> XML tags
    expect(prompt).toContain("<user_turn>");
    expect(prompt).toContain("<assistant_turn>");
    // Total prompt should be much shorter than 10000 chars (truncation works)
    expect(prompt.length).toBeLessThan(5000);
  });
});

// ============================================================
// 7. Hallucination prevention — cwd isolation (Root Cause 2)
// ============================================================

describe("LTM extraction — cwd isolation prevents CLAUDE.md poisoning", () => {
  test("passes cwd=tmpdir() to claudeText for project context isolation", async () => {
    claudeTextMock.mockImplementation(async () => "{}");

    await extractMemoriesFromExchange("I work at GovTech");

    expect(claudeTextMock).toHaveBeenCalledTimes(1);
    const [, options] = claudeTextMock.mock.calls[0] as [string, { timeoutMs: number; cwd?: string }];
    expect(options.cwd).toBe(tmpdir());
  });

  test("cwd option is passed alongside 60s timeout", async () => {
    claudeTextMock.mockImplementation(async () => "{}");

    await extractMemoriesFromExchange("test message");

    const [, options] = claudeTextMock.mock.calls[0] as [string, { timeoutMs: number; cwd?: string }];
    expect(options.timeoutMs).toBe(60_000);
    expect(options.cwd).toBe(tmpdir());
  });
});

// ============================================================
// 8. Hallucination prevention — injectedContext (Root Cause 4)
// ============================================================

describe("LTM extraction — injectedContext prevents circular re-extraction", () => {
  test("injectedContext appears in prompt inside <known_context> XML tags", async () => {
    claudeTextMock.mockImplementation(async () => "{}");

    const systemContext = "User is a software engineer at GovTech.\nGoal: Ship API by Q3.";
    await extractMemoriesFromExchange(
      "What should I do next?",
      "Based on your profile, you should focus on the API.",
      12345,
      "trace-001",
      systemContext
    );

    const [prompt] = claudeTextMock.mock.calls[0] as [string];
    expect(prompt).toContain("<known_context>");
    expect(prompt).toContain(systemContext);
    expect(prompt).toContain("</known_context>");
  });

  test("prompt without injectedContext has no <known_context> block (RULES text still references the tag)", async () => {
    claudeTextMock.mockImplementation(async () => "{}");

    await extractMemoriesFromExchange("I enjoy cooking", "Great hobby!");

    const [prompt] = claudeTextMock.mock.calls[0] as [string];
    // The RULES section mentions "<known_context>" by name — that's fine and expected.
    // The actual content block only appears when injectedContext is provided.
    // Distinguish by checking for the newline that immediately follows the opening tag.
    expect(prompt).not.toContain("<known_context>\n");
    expect(prompt).not.toContain("</known_context>");
  });

  test("injectedContext is truncated to prevent token explosion", async () => {
    claudeTextMock.mockImplementation(async () => "{}");

    const hugeContext = "A".repeat(10_000);
    await extractMemoriesFromExchange("Hello", undefined, undefined, undefined, hugeContext);

    const [prompt] = claudeTextMock.mock.calls[0] as [string];
    // injectedContext is capped at 2000 chars
    expect(prompt.length).toBeLessThan(10_000);
  });

  test("new facts are still extracted when injectedContext is provided", async () => {
    const llmResponse = JSON.stringify({
      certain: { facts: ["User just got promoted to Director"] },
      uncertain: {},
    });
    claudeTextMock.mockImplementation(async () => llmResponse);

    const result = await extractMemoriesFromExchange(
      "I just got promoted to Director!",
      "Congratulations!",
      12345,
      undefined,
      "User is a senior engineer at GovTech."  // known context
    );

    // New fact (promotion) should still be extracted
    expect(result.certain.facts).toEqual(["User just got promoted to Director"]);
  });
});

// ============================================================
// 9. Hallucination prevention — memory query skip (Root Cause 4)
// ============================================================

describe("LTM extraction — memory query skip", () => {
  test("returns empty without calling LLM when user asks about their goals", async () => {
    await extractMemoriesFromExchange("what's in my goals", "Here are your goals: ...");

    expect(claudeTextMock).not.toHaveBeenCalled();
    expect(callOllamaGenerateMock).not.toHaveBeenCalled();
  });

  test("returns empty without calling LLM when user asks what assistant knows about them", async () => {
    await extractMemoriesFromExchange("what do you know about me", "Here is what I know: ...");

    expect(claudeTextMock).not.toHaveBeenCalled();
    expect(callOllamaGenerateMock).not.toHaveBeenCalled();
  });

  test("returns empty without calling LLM when user asks to show their memory", async () => {
    await extractMemoriesFromExchange("show me my memory", "Your stored facts: ...");

    expect(claudeTextMock).not.toHaveBeenCalled();
    expect(callOllamaGenerateMock).not.toHaveBeenCalled();
  });

  test("normal messages still proceed to LLM extraction", async () => {
    claudeTextMock.mockImplementation(async () =>
      JSON.stringify({ certain: { facts: ["Enjoys cooking"] }, uncertain: {} })
    );

    const result = await extractMemoriesFromExchange(
      "I enjoy cooking Italian food on weekends.",
      "That's a great hobby!"
    );

    expect(claudeTextMock).toHaveBeenCalledTimes(1);
    expect(result.certain.facts).toEqual(["Enjoys cooking"]);
  });
});

// ============================================================
// 10. Hallucination prevention — prompt rules (Root Causes 1, 3)
// ============================================================

describe("LTM extraction — prompt includes anti-hallucination rules", () => {
  test("prompt contains rule about not re-extracting <known_context>", async () => {
    claudeTextMock.mockImplementation(async () => "{}");

    await extractMemoriesFromExchange("I live in Singapore");

    const [prompt] = claudeTextMock.mock.calls[0] as [string];
    expect(prompt).toContain("<known_context>");
    expect(prompt).toContain("do NOT re-extract it");
  });

  test("prompt contains rule about ignoring {placeholder} text", async () => {
    claudeTextMock.mockImplementation(async () => "{}");

    await extractMemoriesFromExchange("I live in Singapore");

    const [prompt] = claudeTextMock.mock.calls[0] as [string];
    expect(prompt).toContain("Ignore {placeholder} text");
  });

  test("prompt contains rule about negation and dismissal", async () => {
    claudeTextMock.mockImplementation(async () => "{}");

    await extractMemoriesFromExchange("forget about my old goal");

    const [prompt] = claudeTextMock.mock.calls[0] as [string];
    expect(prompt).toContain("dismissing or negating");
  });

  test("prompt contains rule about not extracting assistant technical content", async () => {
    claudeTextMock.mockImplementation(async () => "{}");

    await extractMemoriesFromExchange("how does the auth flow work?");

    const [prompt] = claudeTextMock.mock.calls[0] as [string];
    expect(prompt).toContain("Do NOT extract assistant explanations");
  });
});
