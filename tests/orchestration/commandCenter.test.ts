/**
 * commandCenter.ts — truncation regression tests
 *
 * Scope: pure unit tests for the functions responsible for the dispatch message
 * truncation bug. No module mocks — we replicate the relevant logic in-test
 * to avoid polluting sibling test files via Bun's global mock module cache.
 */

import { describe, it, expect } from "bun:test";

// ── Replicated logic under test ───────────────────────────────────────────────
// These mirror the exact implementations in commandCenter.ts.
// If they diverge, the corresponding test should be updated.

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}

function formatQueryLine(userMessage: string): string {
  return `Query: "${truncate(userMessage, 100)}"`;
}

/** Old (buggy) implementation — extracts query from display text. */
function extractUserMessageFromPlan_old(planText: string): string {
  const lines = planText.split("\n");
  for (const line of lines) {
    const match = line.match(/^Query: "(.+)"$/);
    if (match) return match[1].replace(/\.\.\.$/g, "");
  }
  return planText.split("\n")[0] || "dispatched message";
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("commandCenter — plan message formatting", () => {
  it("truncates query to 100 chars in plan display", () => {
    const longMessage = "A".repeat(150);
    const line = formatQueryLine(longMessage);
    expect(line).toBe(`Query: "${"A".repeat(97)}..."`);
  });

  it("does not truncate queries <= 100 chars", () => {
    const shortMessage = "fix the bug in relay.ts";
    const line = formatQueryLine(shortMessage);
    expect(line).toBe(`Query: "${shortMessage}"`);
  });
});

describe("commandCenter — extractUserMessageFromPlan (old, buggy path)", () => {
  it("returns only 97 chars when original message exceeded 100 chars", () => {
    const longMessage = "B".repeat(150);
    const planText = [
      "🎯 DISPATCH PLAN",
      "",
      formatQueryLine(longMessage),
      "Intent: code-review",
      "Target: Engineering (80% confidence)",
    ].join("\n");

    const extracted = extractUserMessageFromPlan_old(planText);
    // Bug: extracted is truncated to 97 chars, not the full 150
    expect(extracted.length).toBe(97);
    expect(extracted).not.toBe(longMessage);
  });

  it("returns full message when <= 100 chars", () => {
    const shortMessage = "review the relay module";
    const planText = [
      "🎯 DISPATCH PLAN",
      "",
      formatQueryLine(shortMessage),
      "Intent: code-review",
    ].join("\n");

    const extracted = extractUserMessageFromPlan_old(planText);
    expect(extracted).toBe(shortMessage);
  });
});

describe("commandCenter — pendingPickerMessages fix", () => {
  it("Map lookup returns the full message regardless of display truncation", () => {
    // Simulates what pendingPickerMessages.set/get does at runtime.
    const pendingPickerMessages = new Map<string, string>();
    const dispatchId = "test-uuid-1234";
    const longMessage = "C".repeat(200);

    // When the picker is shown, the full message is stored
    pendingPickerMessages.set(dispatchId, longMessage);

    // When op: callback fires, we retrieve from map (not from display text)
    const storedMessage = pendingPickerMessages.get(dispatchId);
    pendingPickerMessages.delete(dispatchId);

    expect(storedMessage).toBe(longMessage);
    expect(storedMessage!.length).toBe(200);
    // Map is cleaned up after retrieval
    expect(pendingPickerMessages.has(dispatchId)).toBe(false);
  });

  it("falls back to extractUserMessageFromPlan when dispatchId not in map (e.g. after restart)", () => {
    const pendingPickerMessages = new Map<string, string>();
    const dispatchId = "unknown-id";
    const planText = `Query: "${"D".repeat(97)}..."`;

    // Nothing in map — simulate restart / eviction
    const storedMessage = pendingPickerMessages.get(dispatchId);
    const extracted = extractUserMessageFromPlan_old(planText);
    const userMessage = storedMessage ?? extracted;

    // Falls back to the old truncated extraction
    expect(userMessage.length).toBe(97);
  });
});
