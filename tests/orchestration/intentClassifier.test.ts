import { describe, test, expect, beforeAll } from "bun:test";
import { classifyWithKeywords } from "../../src/orchestration/intentClassifier";

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

  test("routes 'what is 2+2' to operations-hub (default)", () => {
    const result = classifyWithKeywords("what is 2+2");
    expect(result.primaryAgent).toBe("operations-hub");
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });

  test("routes 'good morning' to operations-hub (default)", () => {
    const result = classifyWithKeywords("good morning");
    expect(result.primaryAgent).toBe("operations-hub");
    expect(result.confidence).toBeLessThanOrEqual(0.5);
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

  test("always returns isCompound=false (keyword fallback cannot detect compound)", () => {
    const result = classifyWithKeywords("prep deck for CityWatch meeting and review security");
    expect(result.isCompound).toBe(false);
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
