import { describe, test, expect } from "bun:test";
import {
  buildLearningFromCorrection,
  buildExtractionPrompt,
  parseLLMExtractions,
  type LearningCandidate,
} from "../../src/memory/learningExtractor";
import type { CorrectionPair } from "../../src/memory/correctionDetector";
import type { SessionInfo } from "../../src/memory/sessionGrouper";

describe("buildLearningFromCorrection", () => {
  const pair: CorrectionPair = {
    assistant_message_id: "msg-1",
    user_correction_id: "msg-2",
    assistant_snippet: "I'll mock the database for testing",
    correction_snippet: "No, don't mock the DB — use the real one",
    pattern: "negation",
  };

  const session: SessionInfo = {
    chatId: -100123,
    threadId: 456,
    agentId: "code-quality-coach",
    sessionId: "uuid-1",
    startedAt: "2026-03-28T09:00:00Z",
    lastActivity: "2026-03-28T10:30:00Z",
    messageCount: 8,
    cwd: "/project/a",
  };

  test("builds learning with correct confidence", () => {
    const learning = buildLearningFromCorrection(pair, session);
    expect(learning.confidence).toBe(0.70);
    expect(learning.type).toBe("learning");
    expect(learning.status).toBe("active");
  });

  test("includes evidence with correction pair and session context", () => {
    const learning = buildLearningFromCorrection(pair, session);
    const evidence = JSON.parse(learning.evidence);
    expect(evidence.source_trigger).toBe("inline_correction");
    expect(evidence.correction_pair.assistant_msg_id).toBe("msg-1");
    expect(evidence.correction_pair.user_correction_id).toBe("msg-2");
    expect(evidence.agent_id).toBe("code-quality-coach");
    expect(evidence.chat_id).toBe("-100123");
  });

  test("content includes correction snippet", () => {
    const learning = buildLearningFromCorrection(pair, session);
    expect(learning.content).toContain("don't mock the DB");
  });
});

describe("buildExtractionPrompt", () => {
  test("includes correction pairs in prompt", () => {
    const pairs: CorrectionPair[] = [
      {
        assistant_message_id: "1",
        user_correction_id: "2",
        assistant_snippet: "I'll restart all PM2",
        correction_snippet: "No, only restart the specific service",
        pattern: "negation",
      },
    ];
    const prompt = buildExtractionPrompt(pairs, "code-quality-coach");
    expect(prompt).toContain("restart all PM2");
    expect(prompt).toContain("only restart the specific service");
    expect(prompt).toContain("code-quality-coach");
  });
});

describe("parseLLMExtractions", () => {
  test("parses valid JSON array from LLM output", () => {
    const raw = `Here are the learnings:
\`\`\`json
[
  {"content": "Always use named PM2 restart", "category": "anti_pattern"},
  {"content": "TDD for all utilities", "category": "user_preference"}
]
\`\`\``;
    const result = parseLLMExtractions(raw);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("Always use named PM2 restart");
    expect(result[0].category).toBe("anti_pattern");
  });

  test("returns empty array for unparseable output", () => {
    const result = parseLLMExtractions("I couldn't find any patterns");
    expect(result).toEqual([]);
  });

  test("handles JSON without code fence", () => {
    const raw = `[{"content": "test first", "category": "user_preference"}]`;
    const result = parseLLMExtractions(raw);
    expect(result).toHaveLength(1);
  });
});
