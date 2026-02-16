import { describe, test, expect } from "bun:test";
import {
  extractKeywords,
  computeOverlapScore,
  checkContextRelevance,
  updateTopicKeywords,
  buildRelevancePrompt,
  checkContextRelevanceSmart,
} from "./contextRelevance.ts";

describe("extractKeywords", () => {
  test("extracts meaningful words", () => {
    const result = extractKeywords("Deploy Lambda function to AWS");
    expect(result).toContain("deploy");
    expect(result).toContain("lambda");
    expect(result).toContain("function");
    expect(result).toContain("aws");
  });

  test("filters stop words", () => {
    const result = extractKeywords("How do I fix this error?");
    expect(result).not.toContain("how");
    expect(result).not.toContain("do");
    expect(result).not.toContain("this");
    expect(result).toContain("fix");
    expect(result).toContain("error");
  });

  test("deduplicates keywords", () => {
    const result = extractKeywords("aws aws aws lambda");
    expect(result.filter(k => k === "aws").length).toBe(1);
  });

  test("handles empty string", () => {
    expect(extractKeywords("")).toEqual([]);
  });

  test("filters short words", () => {
    const result = extractKeywords("I go to my car");
    expect(result.every(w => w.length >= 3)).toBe(true);
  });
});

describe("computeOverlapScore", () => {
  test("returns 1.0 for identical sets", () => {
    expect(computeOverlapScore(["aws", "lambda"], ["aws", "lambda"])).toBe(1.0);
  });

  test("returns 0.0 for no overlap", () => {
    expect(computeOverlapScore(["aws", "lambda"], ["cooking", "recipe"])).toBe(0.0);
  });

  test("returns partial for some overlap", () => {
    const score = computeOverlapScore(["aws", "lambda", "deploy"], ["aws", "s3", "bucket"]);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  test("handles empty arrays", () => {
    expect(computeOverlapScore([], ["aws"])).toBe(0);
    expect(computeOverlapScore(["aws"], [])).toBe(0);
  });
});

describe("checkContextRelevance", () => {
  const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
  const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5 hours ago
  const midTime = new Date(Date.now() - 45 * 60 * 1000).toISOString(); // 45 min ago

  test("returns relevant for same topic (recent)", () => {
    const context = {
      topicKeywords: ["aws", "lambda", "deploy", "function"],
      lastUserMessages: ["How do I deploy my Lambda function?"],
      lastActivity: recentTime,
    };
    const result = checkContextRelevance("What timeout should I set for my Lambda?", context);
    expect(result.isRelevant).toBe(true);
    expect(result.score).toBeGreaterThan(0.25);
  });

  test("returns not relevant for different topic", () => {
    const context = {
      topicKeywords: ["aws", "lambda", "deploy", "function", "timeout", "memory"],
      lastUserMessages: ["How do I configure Lambda memory?"],
      lastActivity: midTime,
    };
    const result = checkContextRelevance("What's a good chocolate cake recipe?", context);
    expect(result.isRelevant).toBe(false);
    expect(result.score).toBeLessThan(0.25);
  });

  test("stale session always returns not relevant", () => {
    const context = {
      topicKeywords: ["aws", "lambda"],
      lastUserMessages: ["Deploy Lambda"],
      lastActivity: staleTime,
    };
    const result = checkContextRelevance("Deploy another Lambda", context);
    expect(result.isRelevant).toBe(false);
    expect(result.reason).toContain("inactive");
  });

  test("no context always returns relevant", () => {
    const result = checkContextRelevance("Hello", {
      topicKeywords: [],
      lastUserMessages: [],
      lastActivity: recentTime,
    });
    expect(result.isRelevant).toBe(true);
    expect(result.score).toBe(1.0);
  });

  test("provides human-readable reason", () => {
    const context = {
      topicKeywords: ["aws", "lambda"],
      lastUserMessages: ["Lambda function"],
      lastActivity: recentTime,
    };
    const result = checkContextRelevance("Lambda configuration", context);
    expect(result.reason).toBeTruthy();
    expect(typeof result.reason).toBe("string");
  });
});

describe("updateTopicKeywords", () => {
  test("merges new keywords", () => {
    const result = updateTopicKeywords(["aws", "lambda"], "Deploy S3 bucket");
    expect(result).toContain("aws");
    expect(result).toContain("lambda");
    expect(result).toContain("deploy");
    expect(result).toContain("bucket");
  });

  test("deduplicates", () => {
    const result = updateTopicKeywords(["aws", "lambda"], "AWS Lambda configuration");
    expect(result.filter(k => k === "aws").length).toBe(1);
    expect(result.filter(k => k === "lambda").length).toBe(1);
  });

  test("respects maxKeywords limit", () => {
    const existing = Array.from({ length: 25 }, (_, i) => `keyword${i}`);
    const result = updateTopicKeywords(existing, "ten new unique words here about stuff things objects data", 30);
    expect(result.length).toBeLessThanOrEqual(30);
  });
});

describe("buildRelevancePrompt", () => {
  test("uses last user message when available", () => {
    const context = {
      topicKeywords: ["aws", "lambda"],
      lastUserMessages: ["How do I deploy a Lambda function?"],
      lastActivity: new Date().toISOString(),
    };
    const prompt = buildRelevancePrompt("What about S3?", context);
    expect(prompt).toContain("Same topic");
    expect(prompt).toContain("Lambda function");
    expect(prompt).toContain("S3");
    expect(prompt).toContain("YES or NO");
  });

  test("falls back to keywords when no messages", () => {
    const context = {
      topicKeywords: ["aws", "lambda", "deploy"],
      lastUserMessages: [],
      lastActivity: new Date().toISOString(),
    };
    const prompt = buildRelevancePrompt("New question", context);
    expect(prompt).toContain("aws");
    expect(prompt).toContain("lambda");
  });

  test("truncates long messages to 120 chars", () => {
    const longMessage = "a".repeat(200);
    const context = {
      topicKeywords: [],
      lastUserMessages: [longMessage],
      lastActivity: new Date().toISOString(),
    };
    const prompt = buildRelevancePrompt("short", context);
    // Prev section should be truncated
    expect(prompt.length).toBeLessThan(400);
  });
});

describe("checkContextRelevanceSmart", () => {
  const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

  test("returns time method for no context", async () => {
    const result = await checkContextRelevanceSmart("Hello", {
      topicKeywords: [],
      lastUserMessages: [],
      lastActivity: recentTime,
    });
    expect(result.method).toBe("time");
    expect(result.isRelevant).toBe(true);
  });

  test("returns time method for stale session", async () => {
    const result = await checkContextRelevanceSmart("AWS Lambda", {
      topicKeywords: ["aws", "lambda"],
      lastUserMessages: ["Deploy Lambda"],
      lastActivity: staleTime,
    });
    expect(result.method).toBe("time");
    expect(result.isRelevant).toBe(false);
  });

  test("falls back to jaccard when ollama unavailable (no local server)", async () => {
    // Ollama won't be running in test env — should fall back to Jaccard gracefully
    const result = await checkContextRelevanceSmart("AWS Lambda timeout config", {
      topicKeywords: ["aws", "lambda", "deploy", "function"],
      lastUserMessages: ["How do I deploy Lambda?"],
      lastActivity: recentTime,
    });
    // Either ollama or jaccard method — both acceptable
    expect(["ollama", "jaccard"]).toContain(result.method);
    expect(typeof result.isRelevant).toBe("boolean");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  test("result always has required fields", async () => {
    const result = await checkContextRelevanceSmart("test message", {
      topicKeywords: ["topic"],
      lastUserMessages: ["previous message"],
      lastActivity: recentTime,
    });
    expect(result).toHaveProperty("isRelevant");
    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("reason");
    expect(result).toHaveProperty("method");
  });
});
