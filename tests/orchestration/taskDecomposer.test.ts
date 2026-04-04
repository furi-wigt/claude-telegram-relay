import { describe, test, expect } from "bun:test";
import { decomposeTask } from "../../src/orchestration/taskDecomposer";
import type { ClassificationResult } from "../../src/orchestration/types";

describe("taskDecomposer", () => {
  const baseClassification: ClassificationResult = {
    intent: "compound-task",
    primaryAgent: "operations-hub",
    topicHint: null,
    isCompound: true,
    confidence: 0.85,
    reasoning: "Multiple agents needed",
  };

  test("decomposes a compound task into sub-tasks", async () => {
    const haikuResponse = JSON.stringify([
      { seq: 1, agentId: "security-compliance", taskDescription: "Review EKS security", dependsOn: [], topicHint: null },
      { seq: 2, agentId: "cloud-architect", taskDescription: "Estimate EKS cost", dependsOn: [], topicHint: null },
    ]);
    const tasks = await decomposeTask(
      "Review EKS security and estimate cost",
      baseClassification,
      async () => haikuResponse,
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0].agentId).toBe("security-compliance");
    expect(tasks[1].agentId).toBe("cloud-architect");
    expect(tasks[0].seq).toBe(1);
    expect(tasks[1].dependsOn).toEqual([]);
  });

  test("returns single-task fallback when Haiku returns invalid JSON", async () => {
    const tasks = await decomposeTask(
      "Do something complex",
      baseClassification,
      async () => "This is not JSON",
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].agentId).toBe("operations-hub");
    expect(tasks[0].taskDescription).toBe("Do something complex");
  });

  test("returns single-task fallback when Haiku call throws", async () => {
    const tasks = await decomposeTask(
      "Do something",
      baseClassification,
      async () => { throw new Error("Haiku down"); },
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].agentId).toBe("operations-hub");
  });

  test("returns single-task fallback when Haiku returns empty array", async () => {
    const tasks = await decomposeTask(
      "Something empty",
      baseClassification,
      async () => "[]",
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].agentId).toBe("operations-hub");
  });

  test("validates agent IDs — filters out unknown agents", async () => {
    const haikuResponse = JSON.stringify([
      { seq: 1, agentId: "security-compliance", taskDescription: "Valid task", dependsOn: [], topicHint: null },
      { seq: 2, agentId: "nonexistent-agent", taskDescription: "Invalid agent", dependsOn: [], topicHint: null },
    ]);
    const tasks = await decomposeTask(
      "Mixed valid/invalid",
      baseClassification,
      async () => haikuResponse,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].agentId).toBe("security-compliance");
  });
});
