import { describe, test, expect } from "bun:test";
import { buildRetroMessage, formatEvidenceSummary } from "../../routines/handlers/weekly-retro.ts";

describe("formatEvidenceSummary", () => {
  test("formats inline_correction evidence", () => {
    const evidence = JSON.stringify({
      source_trigger: "inline_correction",
      correction_pair: {
        assistant_msg_id: "msg-1",
        user_correction_id: "msg-2",
      },
      agent_id: "code-quality-coach",
    });
    const result = formatEvidenceSummary(evidence);
    expect(result).toContain("inline_correction");
    expect(result).toContain("code-quality-coach");
  });

  test("handles malformed evidence gracefully", () => {
    const result = formatEvidenceSummary("not json");
    expect(result).toBe("No evidence details");
  });
});

describe("buildRetroMessage", () => {
  test("builds message with candidate details", () => {
    const msg = buildRetroMessage(
      "Always use TDD for utilities",
      "user_preference",
      0.75,
      "Source: inline_correction in code-quality-coach",
      1,
      5,
    );
    expect(msg).toContain("Always use TDD");
    expect(msg).toContain("user_preference");
    expect(msg).toContain("0.75");
    expect(msg).toContain("1 of 5");
  });
});
