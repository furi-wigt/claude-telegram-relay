import { describe, test, expect } from "bun:test";
import { classifyWithKeywords, detectCompound } from "../../src/orchestration/intentClassifier";

describe("intentClassifier — keyword fallback", () => {
  test("routes 'review EDEN security posture' to security-compliance", () => {
    const result = classifyWithKeywords("review EDEN security posture");
    expect(result.primaryAgent).toBe("security-compliance");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test("routes 'write CDK for S3 bucket' to cloud-architect", () => {
    const result = classifyWithKeywords("write CDK for S3 bucket");
    expect(result.primaryAgent).toBe("cloud-architect");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test("routes 'code review the relay module' to engineering", () => {
    const result = classifyWithKeywords("code review the relay module");
    expect(result.primaryAgent).toBe("engineering");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test("routes 'draft ADR for LTA integration' to strategy-comms", () => {
    const result = classifyWithKeywords("draft ADR for LTA integration");
    expect(result.primaryAgent).toBe("strategy-comms");
  });

  test("routes 'what is 2+2' to operations-hub (default) with high confidence", () => {
    // No domain keyword match → ops-hub is correct default; confidence should be HIGH
    // so the CC does NOT show the agent picker for general questions.
    const result = classifyWithKeywords("what is 2+2");
    expect(result.primaryAgent).toBe("operations-hub");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  test("routes 'good morning' to operations-hub (default) with high confidence", () => {
    // Small talk: no keyword match → ops-hub, high confidence, no picker shown.
    const result = classifyWithKeywords("good morning");
    expect(result.primaryAgent).toBe("operations-hub");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  test("routes 'AWS cost optimization for EDEN' to cloud-architect", () => {
    const result = classifyWithKeywords("AWS cost optimization for EDEN");
    expect(result.primaryAgent).toBe("cloud-architect");
  });

  test("routes 'IM8 compliance check' to security-compliance", () => {
    const result = classifyWithKeywords("IM8 compliance check");
    expect(result.primaryAgent).toBe("security-compliance");
  });

  test("routes 'implement TDD tests for the API' to engineering", () => {
    const result = classifyWithKeywords("implement TDD tests for the API");
    expect(result.primaryAgent).toBe("engineering");
  });

  test("routes 'schedule a meeting for tomorrow' to operations-hub", () => {
    const result = classifyWithKeywords("schedule a meeting for tomorrow");
    expect(result.primaryAgent).toBe("operations-hub");
  });

  test("detects compound task — multi-agent message", () => {
    const result = classifyWithKeywords("prep deck for CityWatch meeting and review security");
    expect(result.isCompound).toBe(true);
  });

  test("detects single task — simple message", () => {
    const result = classifyWithKeywords("what is 2+2");
    expect(result.isCompound).toBe(false);
  });

  test("detects compound — E2E test message", () => {
    const result = classifyWithKeywords(
      "Prepare for CityWatch meeting, write the proposal, and review the infra"
    );
    expect(result.isCompound).toBe(true);
  });

  test("result shape is complete", () => {
    const result = classifyWithKeywords("test message");
    expect(result).toHaveProperty("intent");
    expect(result).toHaveProperty("primaryAgent");
    expect(result).toHaveProperty("topicHint");
    expect(result).toHaveProperty("isCompound");
    expect(result).toHaveProperty("confidence");
    expect(result).toHaveProperty("reasoning");
    expect(typeof result.confidence).toBe("number");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

describe("detectCompound", () => {
  test("true: multiple verbs with conjunction", () => {
    expect(detectCompound("write the proposal and review the infra")).toBe(true);
  });

  test("true: 2+ conjunctions", () => {
    expect(detectCompound("prepare the deck and draft the ADR and review security")).toBe(true);
  });

  test("true: multi-agent capability match (security + cloud)", () => {
    expect(detectCompound("audit IM8 compliance and optimize AWS costs")).toBe(true);
  });

  test("true: E2E test message", () => {
    expect(
      detectCompound("Prepare for CityWatch meeting, write the proposal, and review the infra")
    ).toBe(true);
  });

  test("false: single action, no conjunction", () => {
    expect(detectCompound("what is the weather today")).toBe(false);
  });

  test("false: single verb, no conjunction", () => {
    expect(detectCompound("review the EDEN security posture")).toBe(false);
  });

  test("false: small talk", () => {
    expect(detectCompound("good morning")).toBe(false);
  });

  test("false: single domain question", () => {
    expect(detectCompound("how do I write CDK for an S3 bucket")).toBe(false);
  });
});
