// src/jobs/jobTopicRegistry.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import {
  registerJobTopic,
  getJobTopic,
  isJobTopic,
  _clearRegistry,
} from "./jobTopicRegistry.ts";

describe("jobTopicRegistry", () => {
  beforeEach(() => _clearRegistry());

  test("isJobTopic returns false for unknown topicId", () => {
    expect(isJobTopic(9999)).toBe(false);
  });

  test("registerJobTopic makes isJobTopic return true", () => {
    registerJobTopic(101, { jobId: "j1", prompt: "hello", agentId: "ops" });
    expect(isJobTopic(101)).toBe(true);
  });

  test("getJobTopic returns the registered entry", () => {
    const entry = { jobId: "j1", prompt: "hello", agentId: "ops" };
    registerJobTopic(202, entry);
    expect(getJobTopic(202)).toEqual(entry);
  });

  test("getJobTopic returns undefined for unknown topicId", () => {
    expect(getJobTopic(9999)).toBeUndefined();
  });

  test("registering a second entry does not affect the first", () => {
    registerJobTopic(300, { jobId: "a", prompt: "first", agentId: "cloud" });
    registerJobTopic(301, { jobId: "b", prompt: "second", agentId: "ops" });
    expect(getJobTopic(300)?.prompt).toBe("first");
    expect(getJobTopic(301)?.prompt).toBe("second");
  });
});
