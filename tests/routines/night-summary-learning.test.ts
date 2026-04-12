import { describe, test, expect } from "bun:test";
import { buildLearningsSummarySection } from "../../routines/handlers/night-summary.ts";

describe("buildLearningsSummarySection", () => {
  test("formats learnings into summary section", () => {
    const learnings = [
      { content: "Don't mock DB in integration tests", category: "anti_pattern", confidence: 0.70 },
      { content: "Always TDD for utilities", category: "user_preference", confidence: 0.70 },
    ];
    const section = buildLearningsSummarySection(learnings);
    expect(section).toContain("Don't mock DB");
    expect(section).toContain("Always TDD");
    expect(section).toContain("0.70");
  });

  test("returns empty string when no learnings", () => {
    const section = buildLearningsSummarySection([]);
    expect(section).toBe("");
  });
});
