/**
 * Unit tests for routines/night-summary.ts
 *
 * Tests the three exported pure/provider-abstracted functions:
 *   - buildReflectionPrompt()  — pure, no I/O
 *   - formatSummary()          — pure, no I/O
 *   - analyzeWithProviders()   — async, provider-injected
 *
 * Run: bun test routines/night-summary.test.ts
 */

import { describe, it, expect } from "bun:test";
import {
  buildReflectionPrompt,
  formatSummary,
  analyzeWithProviders,
  type DayMessage,
  type DayFact,
  type DayGoal,
} from "./night-summary.ts";

// ============================================================
// Shared test data helpers
// ============================================================

function makeMessage(overrides: Partial<DayMessage> = {}): DayMessage {
  return {
    content: "What is the best way to structure a TypeScript project?",
    role: "user",
    created_at: "2025-02-21T10:00:00Z",
    ...overrides,
  };
}

function makeFact(overrides: Partial<DayFact> = {}): DayFact {
  return {
    content: "User prefers Bun over Node.js for TypeScript projects",
    created_at: "2025-02-21T11:00:00Z",
    ...overrides,
  };
}

function makeGoal(overrides: Partial<DayGoal> = {}): DayGoal {
  return {
    content: "Launch MVP by end of Q1",
    deadline: "2025-03-31",
    completed: false,
    ...overrides,
  };
}

// ============================================================
// buildReflectionPrompt() — pure function
// ============================================================

describe("buildReflectionPrompt()", () => {
  it("returns a non-empty string", () => {
    const prompt = buildReflectionPrompt([], [], []);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(50);
  });

  it("includes the user name when provided", () => {
    const prompt = buildReflectionPrompt([], [], [], "Alice");
    expect(prompt).toContain("Alice");
  });

  it("still returns a valid prompt when no name is provided", () => {
    const prompt = buildReflectionPrompt([], [], []);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(50);
  });

  it("includes message content in the prompt", () => {
    const messages = [makeMessage({ content: "How do I use Docker Compose?" })];
    const prompt = buildReflectionPrompt(messages, [], []);
    expect(prompt).toContain("Docker Compose");
  });

  it("shows 'No messages today' when messages array is empty", () => {
    const prompt = buildReflectionPrompt([], [], []);
    expect(prompt).toContain("No messages today");
  });

  it("includes fact content in the prompt", () => {
    const facts = [makeFact({ content: "User enjoys morning runs" })];
    const prompt = buildReflectionPrompt([], facts, []);
    expect(prompt).toContain("morning runs");
  });

  it("includes active goal content in the prompt", () => {
    const goals = [makeGoal({ content: "Ship feature X by Friday", completed: false })];
    const prompt = buildReflectionPrompt([], [], goals);
    expect(prompt).toContain("Ship feature X by Friday");
  });

  it("includes completed goal content in the prompt", () => {
    const goals = [
      makeGoal({
        content: "Write unit tests for auth module",
        completed: true,
        completed_at: new Date().toISOString(),
      }),
    ];
    const prompt = buildReflectionPrompt([], [], goals);
    expect(prompt).toContain("Write unit tests for auth module");
  });

  it("instructs markdown-formatted output", () => {
    const prompt = buildReflectionPrompt([], [], []);
    expect(prompt.toLowerCase()).toContain("markdown");
  });

  it("requests a motivational tone", () => {
    const prompt = buildReflectionPrompt([], [], []);
    const lower = prompt.toLowerCase();
    const hasMotivation =
      lower.includes("motivat") || lower.includes("encourage") || lower.includes("coach");
    expect(hasMotivation).toBe(true);
  });

  it("requests detailed output (400+ words target)", () => {
    const prompt = buildReflectionPrompt([], [], []);
    // The prompt should instruct for a detailed response, not a brief one
    expect(prompt).toContain("400");
  });

  it("truncates to last 30 messages when more are provided", () => {
    // 35 messages: slice(-30) includes items 6–35, excludes items 1–5
    const messages = Array.from({ length: 35 }, (_, i) =>
      makeMessage({ content: `Unique content item ${i + 1}` })
    );
    const prompt = buildReflectionPrompt(messages, [], []);

    expect(prompt).toContain("Unique content item 35"); // last — always included
    expect(prompt).toContain("Unique content item 6"); // first of last-30 window
    expect(prompt).not.toContain("Unique content item 5"); // outside window
  });

  it("shows message count in the prompt context", () => {
    const messages = [makeMessage(), makeMessage()];
    const prompt = buildReflectionPrompt(messages, [], []);
    expect(prompt).toContain("2");
  });
});

// ============================================================
// formatSummary() — pure function
// ============================================================

describe("formatSummary()", () => {
  it("contains the date string", () => {
    const summary = formatSummary("Monday, February 21", 5, 2, "Great day overall.");
    expect(summary).toContain("Monday, February 21");
  });

  it("contains the message count", () => {
    const summary = formatSummary("Monday, February 21", 7, 2, "Analysis here.");
    expect(summary).toContain("7");
  });

  it("contains the fact count", () => {
    const summary = formatSummary("Monday, February 21", 5, 3, "Analysis here.");
    expect(summary).toContain("3");
  });

  it("contains the analysis text", () => {
    const analysis = "## Key Accomplishments\n- Finished TDD implementation";
    const summary = formatSummary("Monday, February 21", 5, 2, analysis);
    expect(summary).toContain("Key Accomplishments");
    expect(summary).toContain("Finished TDD implementation");
  });

  it("has a night review header", () => {
    const summary = formatSummary("Monday, February 21", 5, 2, "Analysis.");
    expect(summary.toLowerCase()).toContain("night");
  });

  it("contains a footer mentioning Claude", () => {
    const summary = formatSummary("Monday, February 21", 5, 2, "Analysis.");
    expect(summary.toLowerCase()).toContain("claude");
  });

  it("returns a non-empty string for zero counts", () => {
    const summary = formatSummary("Sunday, February 22", 0, 0, "Quiet day.");
    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain("0");
  });
});

// ============================================================
// analyzeWithProviders() — provider abstraction
// ============================================================

describe("analyzeWithProviders()", () => {
  it("returns Claude's response when Claude succeeds", async () => {
    const claudeFn = async () => "Claude's detailed reflection";
    const ollamaFn = async () => "Ollama's reflection";

    const result = await analyzeWithProviders("test prompt", {
      claude: claudeFn,
      ollama: ollamaFn,
    });

    expect(result.text).toBe("Claude's detailed reflection");
  });

  it("identifies 'claude' as provider on success", async () => {
    const claudeFn = async () => "Claude response";
    const ollamaFn = async () => "Ollama response";

    const result = await analyzeWithProviders("test prompt", {
      claude: claudeFn,
      ollama: ollamaFn,
    });

    expect(result.provider).toBe("claude");
  });

  it("falls back to Ollama when Claude throws", async () => {
    const claudeFn = async (): Promise<string> => {
      throw new Error("Claude unavailable");
    };
    const ollamaFn = async () => "Ollama's reflection instead";

    const result = await analyzeWithProviders("test prompt", {
      claude: claudeFn,
      ollama: ollamaFn,
    });

    expect(result.text).toBe("Ollama's reflection instead");
  });

  it("identifies 'ollama' as provider when falling back", async () => {
    const claudeFn = async (): Promise<string> => {
      throw new Error("Claude unavailable");
    };
    const ollamaFn = async () => "Ollama fallback";

    const result = await analyzeWithProviders("test prompt", {
      claude: claudeFn,
      ollama: ollamaFn,
    });

    expect(result.provider).toBe("ollama");
  });

  it("returns provider=null when both Claude and Ollama fail", async () => {
    const claudeFn = async (): Promise<string> => {
      throw new Error("Claude unavailable");
    };
    const ollamaFn = async (): Promise<string> => {
      throw new Error("Ollama unavailable");
    };

    const result = await analyzeWithProviders("test prompt", {
      claude: claudeFn,
      ollama: ollamaFn,
    });

    expect(result.provider).toBeNull();
  });

  it("returns a non-empty error text when both providers fail", async () => {
    const claudeFn = async (): Promise<string> => {
      throw new Error("Claude unavailable");
    };
    const ollamaFn = async (): Promise<string> => {
      throw new Error("Ollama unavailable");
    };

    const result = await analyzeWithProviders("test prompt", {
      claude: claudeFn,
      ollama: ollamaFn,
    });

    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("does not call Ollama when Claude succeeds", async () => {
    let ollamaCalled = false;
    const claudeFn = async () => "Claude OK";
    const ollamaFn = async () => {
      ollamaCalled = true;
      return "Ollama";
    };

    await analyzeWithProviders("test prompt", { claude: claudeFn, ollama: ollamaFn });

    expect(ollamaCalled).toBe(false);
  });

  it("passes the prompt unchanged to the provider", async () => {
    let capturedPrompt = "";
    const claudeFn = async (p: string) => {
      capturedPrompt = p;
      return "response";
    };
    const ollamaFn = async () => "Ollama";

    await analyzeWithProviders("my exact prompt text", {
      claude: claudeFn,
      ollama: ollamaFn,
    });

    expect(capturedPrompt).toBe("my exact prompt text");
  });
});
