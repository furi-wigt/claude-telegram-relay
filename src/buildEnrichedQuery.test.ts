/**
 * Tests for buildEnrichedQuery — query enrichment for relevant context search.
 *
 * Run: bun test src/buildEnrichedQuery.test.ts
 */

import { describe, test, expect } from "bun:test";
import { buildEnrichedQuery } from "./relay.ts";
import { GENERIC_COMMAND_RE } from "./memory.ts";

describe("buildEnrichedQuery", () => {
  test("returns current text when verbatimMessages is empty", () => {
    expect(buildEnrichedQuery([], "hello")).toBe("hello");
  });

  test("returns current text when verbatimMessages is undefined", () => {
    expect(buildEnrichedQuery(undefined, "hello")).toBe("hello");
  });

  test("prepends last 2 user messages, skipping assistant messages", () => {
    const msgs = [
      { role: "user", content: "auth setup" },
      { role: "assistant", content: "here is auth" },
      { role: "user", content: "add JWT" },
      { role: "assistant", content: "JWT added" },
      { role: "user", content: "make it secure" },
    ];
    const result = buildEnrichedQuery(msgs, "implement this");
    expect(result).toContain("add JWT");
    expect(result).toContain("make it secure");
    expect(result).toContain("implement this");
    // Only last 2 user messages, not the first
    expect(result).not.toContain("auth setup");
  });

  test("truncates to 512 chars", () => {
    const longMsg = "x".repeat(300);
    const msgs = [
      { role: "user", content: longMsg },
      { role: "user", content: longMsg },
    ];
    const result = buildEnrichedQuery(msgs, "test");
    expect(result.length).toBeLessThanOrEqual(512);
  });

  test("does not truncate short enriched queries", () => {
    const msgs = [
      { role: "user", content: "short context" },
    ];
    const result = buildEnrichedQuery(msgs, "query");
    expect(result).toBe("short context query");
  });

  test("handles messages with only assistant messages (no user messages)", () => {
    const msgs = [
      { role: "assistant", content: "some response" },
      { role: "assistant", content: "another response" },
    ];
    // No user messages to prepend, but verbatimMessages is non-empty
    // recentUserMsgs will be empty string, so result is " query" trimmed to "query"
    const result = buildEnrichedQuery(msgs, "query");
    expect(result).toBe("query");
  });
});

describe("GENERIC_COMMAND_RE quality gate", () => {
  test("matches generic commands", () => {
    expect(GENERIC_COMMAND_RE.test("ok")).toBe(true);
    expect(GENERIC_COMMAND_RE.test("yes")).toBe(true);
    expect(GENERIC_COMMAND_RE.test("do it")).toBe(true);
    expect(GENERIC_COMMAND_RE.test("implement this")).toBe(true);
    expect(GENERIC_COMMAND_RE.test("lgtm")).toBe(true);
    expect(GENERIC_COMMAND_RE.test("sounds good")).toBe(true);
  });

  test("does NOT match domain-rich messages", () => {
    expect(GENERIC_COMMAND_RE.test("fix the JWT bug")).toBe(false);
    expect(GENERIC_COMMAND_RE.test("how does the dedup callback work?")).toBe(false);
    expect(GENERIC_COMMAND_RE.test("add error handling to auth middleware")).toBe(false);
  });

  test("is case-insensitive", () => {
    expect(GENERIC_COMMAND_RE.test("OK")).toBe(true);
    expect(GENERIC_COMMAND_RE.test("LGTM")).toBe(true);
    expect(GENERIC_COMMAND_RE.test("Sure")).toBe(true);
  });

  test("skip logic: no enrichment + generic = skip", () => {
    const rawText = "ok";
    const enriched = rawText.trim(); // buildEnrichedQuery returns same when no context
    const shouldSkip = enriched === rawText.trim() && GENERIC_COMMAND_RE.test(rawText.trim());
    expect(shouldSkip).toBe(true);
  });

  test("skip logic: enrichment happened = do not skip even if message is generic", () => {
    const rawText = "ok";
    const enriched = "JWT auth middleware ok"; // enrichment added context
    const shouldSkip = enriched === rawText.trim() && GENERIC_COMMAND_RE.test(rawText.trim());
    expect(shouldSkip).toBe(false);
  });
});
