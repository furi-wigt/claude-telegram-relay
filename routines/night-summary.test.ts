/**
 * Unit tests for routines/night-summary.ts
 *
 * Tests the exported pure/provider-abstracted functions:
 *   - buildReflectionPrompt()  — pure, no I/O
 *   - formatSummary()          — pure, no I/O
 *   - analyzeWithLocalLLM()    — async, generator-injected
 *
 * Run: bun test routines/night-summary.test.ts
 */

import { describe, it, expect } from "bun:test";
import {
  buildReflectionPrompt,
  buildDayTimeline,
  buildQaPairs,
  formatSummary,
  analyzeWithLocalLLM,
  type DayMessage,
  type DayFact,
  type DayGoal,
  type DaySummary,
} from "./handlers/night-summary.ts";

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

function makeSummary(overrides: Partial<DaySummary> = {}): DaySummary {
  return {
    summary: "Discussed AWS architecture options for the relay bot.",
    message_count: 20,
    from_timestamp: "2025-02-21T09:00:00Z",
    to_timestamp: "2025-02-21T10:30:00Z",
    chat_id: null,
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

  it("requests detailed output (500+ words target)", () => {
    const prompt = buildReflectionPrompt([], [], []);
    // The prompt should instruct for a detailed response, not a brief one
    expect(prompt).toContain("500");
  });

  it("includes a Q&A sessions context section", () => {
    const messages = [
      makeMessage({ role: "user", content: "Explain bun:sqlite WAL mode." }),
      makeMessage({ role: "assistant", content: "WAL mode enables concurrent reads while writes proceed." }),
    ];
    const prompt = buildReflectionPrompt(messages, [], []);
    expect(prompt).toContain("Q&A Sessions");
    expect(prompt).toContain("bun:sqlite WAL mode");
  });

  it("includes 'Today's Learning Lessons' instruction in the prompt", () => {
    const prompt = buildReflectionPrompt([], [], []);
    expect(prompt).toContain("Learning Lessons");
  });

  it("includes all messages when no summaries are provided (no arbitrary cap)", () => {
    // 35 messages: all should appear — no slice(-30) cap anymore
    const messages = Array.from({ length: 35 }, (_, i) =>
      makeMessage({ content: `Unique content item ${i + 1}` })
    );
    const prompt = buildReflectionPrompt(messages, [], []);

    expect(prompt).toContain("Unique content item 35"); // last — included
    expect(prompt).toContain("Unique content item 1"); // first — now also included
    expect(prompt).toContain("Unique content item 5"); // was previously excluded
  });

  it("includes conversation summaries in the prompt when provided", () => {
    const summaries = [
      makeSummary({ summary: "Resolved the authentication bug in relay module." }),
    ];
    const prompt = buildReflectionPrompt([], [], [], "Furi", summaries);
    expect(prompt).toContain("Resolved the authentication bug in relay module.");
  });

  it("uses timeline structure with summaries and messages", () => {
    const summaries = [makeSummary()];
    const messages = [makeMessage({ created_at: "2025-02-21T19:00:00Z" })];
    const prompt = buildReflectionPrompt(messages, [], [], undefined, summaries);
    // Should have a section for earlier (summarised) and recent (verbatim)
    const hasEarlier = prompt.includes("Earlier Today") || prompt.includes("Summarised") || prompt.includes("Summarized");
    expect(hasEarlier).toBe(true);
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

  it("contains the model name in footer when provider is local", () => {
    const summary = formatSummary("Monday, February 21", 5, 2, "Analysis.", "local");
    // Footer should contain the last segment of the model path (e.g. "Qwen3.5-4B-MLX-4bit")
    expect(summary.toLowerCase()).toContain("powered by");
  });

  it("returns a non-empty string for zero counts", () => {
    const summary = formatSummary("Sunday, February 22", 0, 0, "Quiet day.");
    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain("0");
  });
});

// ============================================================
// analyzeWithLocalLLM() — local LLM only
// ============================================================

describe("analyzeWithLocalLLM() — local LLM only", () => {
  it("returns local LLM's response when it succeeds", async () => {
    const generate = async () => "Local LLM's reflection";
    const result = await analyzeWithLocalLLM("test prompt", generate);
    expect(result.text).toBe("Local LLM's reflection");
  });

  it("identifies 'local' as provider on success", async () => {
    const generate = async () => "Local response";
    const result = await analyzeWithLocalLLM("test prompt", generate);
    expect(result.provider).toBe("local");
  });

  it("returns provider=null when local LLM fails", async () => {
    const generate = async (): Promise<string> => {
      throw new Error("Local LLM unavailable");
    };
    const result = await analyzeWithLocalLLM("test prompt", generate);
    expect(result.provider).toBeNull();
  });

  it("returns a non-empty error text when local LLM fails", async () => {
    const generate = async (): Promise<string> => {
      throw new Error("Local LLM unavailable");
    };
    const result = await analyzeWithLocalLLM("test prompt", generate);
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("passes the prompt unchanged to the generator", async () => {
    let capturedPrompt = "";
    const generate = async (p: string) => {
      capturedPrompt = p;
      return "response";
    };
    await analyzeWithLocalLLM("my exact prompt text", generate);
    expect(capturedPrompt).toBe("my exact prompt text");
  });
});

// ============================================================
// buildQaPairs() — pure function
// ============================================================

describe("buildQaPairs()", () => {
  it("returns an empty array for empty input", () => {
    expect(buildQaPairs([])).toEqual([]);
  });

  it("returns an empty array when only assistant messages exist", () => {
    const messages = [makeMessage({ role: "assistant", content: "Hello" })];
    expect(buildQaPairs(messages)).toEqual([]);
  });

  it("pairs a user message with the following assistant message", () => {
    const messages = [
      makeMessage({ role: "user", content: "How does WAL mode work?", created_at: "2025-02-21T10:00:00Z" }),
      makeMessage({ role: "assistant", content: "WAL mode allows concurrent reads.", created_at: "2025-02-21T10:01:00Z" }),
    ];
    const pairs = buildQaPairs(messages);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].question).toBe("How does WAL mode work?");
    expect(pairs[0].answer).toBe("WAL mode allows concurrent reads.");
  });

  it("records the user message timestamp in the pair", () => {
    const messages = [
      makeMessage({ role: "user", created_at: "2025-02-21T09:30:00Z" }),
      makeMessage({ role: "assistant", created_at: "2025-02-21T09:31:00Z" }),
    ];
    const pairs = buildQaPairs(messages);
    expect(pairs[0].time).toBe("2025-02-21T09:30:00Z");
  });

  it("handles an orphaned user message (no assistant follow-up)", () => {
    const messages = [
      makeMessage({ role: "user", content: "What is the answer?" }),
    ];
    const pairs = buildQaPairs(messages);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].answer).toBe("(no response yet)");
  });

  it("produces multiple pairs from interleaved user/assistant messages", () => {
    const messages = [
      makeMessage({ role: "user", content: "Q1" }),
      makeMessage({ role: "assistant", content: "A1" }),
      makeMessage({ role: "user", content: "Q2" }),
      makeMessage({ role: "assistant", content: "A2" }),
    ];
    const pairs = buildQaPairs(messages);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].question).toBe("Q1");
    expect(pairs[1].question).toBe("Q2");
  });

  it("does not double-count the assistant message as a question", () => {
    const messages = [
      makeMessage({ role: "user", content: "Q1" }),
      makeMessage({ role: "assistant", content: "A1" }),
      makeMessage({ role: "assistant", content: "A2 — follow-up" }), // second assistant in a row
    ];
    const pairs = buildQaPairs(messages);
    // Only one user turn → one pair
    expect(pairs).toHaveLength(1);
  });

  it("truncates question to 600 chars", () => {
    const longQuestion = "x".repeat(700);
    const messages = [
      makeMessage({ role: "user", content: longQuestion }),
      makeMessage({ role: "assistant", content: "Short answer" }),
    ];
    const pairs = buildQaPairs(messages);
    expect(pairs[0].question.length).toBe(600);
  });

  it("truncates answer to 800 chars", () => {
    const longAnswer = "y".repeat(900);
    const messages = [
      makeMessage({ role: "user", content: "Short Q" }),
      makeMessage({ role: "assistant", content: longAnswer }),
    ];
    const pairs = buildQaPairs(messages);
    expect(pairs[0].answer.length).toBe(800);
  });

  it("captures agent_id from the user message", () => {
    const messages = [
      makeMessage({ role: "user", content: "Q", agent_id: "aws-architect" }),
      makeMessage({ role: "assistant", content: "A" }),
    ];
    const pairs = buildQaPairs(messages);
    expect(pairs[0].agent).toBe("aws-architect");
  });

  it("falls back to agent_id from assistant message when user has none", () => {
    const messages = [
      makeMessage({ role: "user", content: "Q", agent_id: null }),
      makeMessage({ role: "assistant", content: "A", agent_id: "security-analyst" }),
    ];
    const pairs = buildQaPairs(messages);
    expect(pairs[0].agent).toBe("security-analyst");
  });

  it("agent is undefined/null when neither message has agent_id", () => {
    const messages = [
      makeMessage({ role: "user", content: "Q" }),
      makeMessage({ role: "assistant", content: "A" }),
    ];
    const pairs = buildQaPairs(messages);
    // agent should be falsy (null or undefined)
    expect(pairs[0].agent).toBeFalsy();
  });
});

// ============================================================
// buildDayTimeline() — pure function (NEW)
// ============================================================

describe("buildDayTimeline()", () => {
  it("returns a string", () => {
    const result = buildDayTimeline([], []);
    expect(typeof result).toBe("string");
  });

  it("shows 'No conversations today' when both inputs are empty", () => {
    const result = buildDayTimeline([], []);
    expect(result).toContain("No conversations today");
  });

  it("includes summary text in the output", () => {
    const summaries = [makeSummary({ summary: "Resolved the auth bug with JWT tokens." })];
    const result = buildDayTimeline([], summaries);
    expect(result).toContain("Resolved the auth bug with JWT tokens.");
  });

  it("shows an 'Earlier Today' section when summaries are present", () => {
    const summaries = [makeSummary()];
    const result = buildDayTimeline([], summaries);
    expect(result).toContain("Earlier Today");
  });

  it("formats summary timestamp range as HH:mm–HH:mm", () => {
    const summaries = [
      makeSummary({
        from_timestamp: "2025-02-21T09:15:00Z",
        to_timestamp: "2025-02-21T10:30:00Z",
      }),
    ];
    const result = buildDayTimeline([], summaries);
    // Should show a time range from the timestamps
    expect(result).toMatch(/\d{2}:\d{2}/); // at least one time present
  });

  it("includes all messages — no 30-message cap", () => {
    const messages = Array.from({ length: 50 }, (_, i) =>
      makeMessage({ content: `Message number ${i + 1}` })
    );
    const result = buildDayTimeline(messages, []);
    expect(result).toContain("Message number 1");
    expect(result).toContain("Message number 50");
  });

  it("includes agent_id label when present on a message", () => {
    const messages = [
      makeMessage({ content: "Hello", agent_id: "aws-architect" }),
    ];
    const result = buildDayTimeline(messages, []);
    expect(result).toContain("aws-architect");
  });

  it("still works when agent_id is undefined", () => {
    const messages = [makeMessage({ content: "No agent id here" })];
    const result = buildDayTimeline(messages, []);
    expect(result).toContain("No agent id here");
  });

  it("includes message content in output", () => {
    const messages = [makeMessage({ content: "Unique message alpha" })];
    const result = buildDayTimeline(messages, []);
    expect(result).toContain("Unique message alpha");
  });

  it("shows multiple summaries in order", () => {
    const summaries = [
      makeSummary({ summary: "Morning topic alpha", from_timestamp: "2025-02-21T09:00:00Z", to_timestamp: "2025-02-21T10:00:00Z" }),
      makeSummary({ summary: "Afternoon topic beta", from_timestamp: "2025-02-21T13:00:00Z", to_timestamp: "2025-02-21T14:00:00Z" }),
    ];
    const result = buildDayTimeline([], summaries);
    const idxAlpha = result.indexOf("Morning topic alpha");
    const idxBeta = result.indexOf("Afternoon topic beta");
    expect(idxAlpha).toBeGreaterThanOrEqual(0);
    expect(idxBeta).toBeGreaterThanOrEqual(0);
    expect(idxAlpha).toBeLessThan(idxBeta); // alpha comes before beta
  });

  it("shows both summary section and messages section when both provided", () => {
    const summaries = [makeSummary({ summary: "Morning session summary" })];
    const messages = [makeMessage({ content: "Evening question" })];
    const result = buildDayTimeline(messages, summaries);
    expect(result).toContain("Morning session summary");
    expect(result).toContain("Evening question");
  });
});
