import { describe, test, expect } from "bun:test";
import { buildReflectLearning } from "../../src/callbacks/reflectCommandHandler";

describe("buildReflectLearning", () => {
  test("builds learning with explicit feedback confidence", () => {
    const learning = buildReflectLearning(
      "Always use TDD even for small utilities",
      -100123,
      456,
      "code-quality-coach",
    );
    expect(learning.confidence).toBe(0.85);
    expect(learning.type).toBe("learning");
    expect(learning.category).toBe("user_preference");

    const evidence = JSON.parse(learning.evidence);
    expect(evidence.source_trigger).toBe("explicit_feedback");
    expect(evidence.agent_id).toBe("code-quality-coach");
  });
});
