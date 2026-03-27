import { describe, test, expect } from "bun:test";
import {
  storeLearningSession,
  buildRetroKeyboard,
  type RetroCandidate,
} from "../../src/callbacks/learningRetroCallbackHandler";

describe("storeLearningSession", () => {
  test("stores candidates and returns a session ID", () => {
    const candidates: RetroCandidate[] = [
      { memoryId: "mem-1", content: "Always TDD", category: "user_preference", confidence: 0.75, evidenceSummary: "User said: 'I want TDD'" },
    ];
    const sessionId = storeLearningSession(candidates);
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(4);
  });
});

describe("buildRetroKeyboard", () => {
  test("produces 3 buttons for a candidate", () => {
    const kb = buildRetroKeyboard("sess-1", 0);
    expect(kb.inline_keyboard).toHaveLength(1);
    expect(kb.inline_keyboard[0]).toHaveLength(3);
    expect(kb.inline_keyboard[0][0].callback_data).toContain("lr:promote");
    expect(kb.inline_keyboard[0][1].callback_data).toContain("lr:reject");
    expect(kb.inline_keyboard[0][2].callback_data).toContain("lr:later");
  });
});
