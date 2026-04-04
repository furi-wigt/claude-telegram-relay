import { describe, test, expect } from "bun:test";
import { parseTags } from "../../src/orchestration/tagParser";
import type { BoardTag, AskAgentTag, ConfidenceTag, DoneTaskTag, BoardSummaryTag } from "../../src/orchestration/tagParser";

describe("tagParser.parseTags", () => {
  test("parses [BOARD:] tag", () => {
    const { tags } = parseTags("[BOARD: finding] IM8 control AC-3 is not configured");
    expect(tags).toHaveLength(1);
    const tag = tags[0] as BoardTag;
    expect(tag.kind).toBe("board");
    expect(tag.recordType).toBe("finding");
    expect(tag.content).toBe("IM8 control AC-3 is not configured");
  });

  test("parses [ASK_AGENT:] tag", () => {
    const { tags } = parseTags("[ASK_AGENT: cloud-architect] What's the cost for this setup?");
    expect(tags).toHaveLength(1);
    const tag = tags[0] as AskAgentTag;
    expect(tag.kind).toBe("ask_agent");
    expect(tag.agentId).toBe("cloud-architect");
    expect(tag.message).toBe("What's the cost for this setup?");
  });

  test("parses [BOARD_SUMMARY:] tag", () => {
    const { tags } = parseTags("[BOARD_SUMMARY: Completed security audit for EDEN]");
    expect(tags).toHaveLength(1);
    const tag = tags[0] as BoardSummaryTag;
    expect(tag.kind).toBe("board_summary");
    expect(tag.text).toBe("Completed security audit for EDEN");
  });

  test("parses [CONFIDENCE:] tag", () => {
    const { tags } = parseTags("[CONFIDENCE: 0.85]");
    expect(tags).toHaveLength(1);
    const tag = tags[0] as ConfidenceTag;
    expect(tag.kind).toBe("confidence");
    expect(tag.value).toBe(0.85);
  });

  test("parses [DONE_TASK:] tag", () => {
    const { tags } = parseTags("[DONE_TASK: 3]");
    expect(tags).toHaveLength(1);
    const tag = tags[0] as DoneTaskTag;
    expect(tag.kind).toBe("done_task");
    expect(tag.seq).toBe(3);
  });

  test("parses multiple tags from a response", () => {
    const response = `Here is my analysis of the security posture.

[BOARD: finding] S3 bucket lacks encryption at rest
[BOARD: finding] IAM role has overly permissive policy
[CONFIDENCE: 0.78]
[DONE_TASK: 2]

Let me know if you need more details.`;

    const { tags, cleanText } = parseTags(response);
    expect(tags).toHaveLength(4);
    expect(tags[0].kind).toBe("board");
    expect(tags[1].kind).toBe("board");
    expect(tags[2].kind).toBe("confidence");
    expect(tags[3].kind).toBe("done_task");
    expect(cleanText).toContain("Here is my analysis");
    expect(cleanText).toContain("Let me know");
    expect(cleanText).not.toContain("[BOARD:");
  });

  test("strips tag lines from cleanText", () => {
    const { cleanText } = parseTags("Before\n[CONFIDENCE: 0.9]\nAfter");
    expect(cleanText).toBe("Before\nAfter");
  });

  test("ignores malformed confidence (out of range)", () => {
    const { tags } = parseTags("[CONFIDENCE: 1.5]");
    expect(tags).toHaveLength(0);
  });

  test("ignores malformed confidence (NaN)", () => {
    const { tags } = parseTags("[CONFIDENCE: abc]");
    expect(tags).toHaveLength(0);
  });

  test("ignores malformed DONE_TASK (NaN)", () => {
    const { tags } = parseTags("[DONE_TASK: abc]");
    expect(tags).toHaveLength(0);
  });

  test("returns empty tags for plain text", () => {
    const { tags, cleanText } = parseTags("Just a regular response with no tags.");
    expect(tags).toHaveLength(0);
    expect(cleanText).toBe("Just a regular response with no tags.");
  });

  test("BOARD record type is lowercased", () => {
    const { tags } = parseTags("[BOARD: ARTIFACT] Some code patch");
    expect((tags[0] as BoardTag).recordType).toBe("artifact");
  });
});
