/**
 * commandCenter.ts — model prefix routing + picker message preservation tests
 *
 * Scope: pure unit tests for plan formatting and picker message preservation.
 * No module mocks — logic is replicated in-test to avoid Bun global mock cache issues.
 */

import { describe, it, expect } from "bun:test";

// ── Replicated logic under test ───────────────────────────────────────────────
// These mirror the exact implementations in commandCenter.ts.
// If they diverge, update the corresponding test.

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}

function formatQueryLine(userMessage: string): string {
  return `Query: "${truncate(userMessage, 100)}"`;
}

/** Mirrors extractUserMessageFromPlan in commandCenter.ts */
function extractUserMessageFromPlan(planText: string): string {
  const lines = planText.split("\n");
  for (const line of lines) {
    const match = line.match(/^Query: "(.+)"$/);
    if (match) return match[1].replace(/\.\.\.$/g, "");
  }
  return planText.split("\n")[0] || "dispatched message";
}

// ── Plan message formatting ───────────────────────────────────────────────────

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

  it("[o] prefix is preserved when message is short", () => {
    const msg = "[o] review this PR";
    const line = formatQueryLine(msg);
    expect(line).toBe(`Query: "${msg}"`);
    // Extraction round-trip preserves prefix
    const planText = ["🎯 DISPATCH PLAN", "", line].join("\n");
    expect(extractUserMessageFromPlan(planText)).toBe(msg);
  });

  it("[o] prefix is preserved when message is long (prefix not truncated)", () => {
    // [o] is 3 chars; total must exceed 100 to trigger truncation
    const msg = "[o] " + "x".repeat(100); // 104 chars
    const line = formatQueryLine(msg);
    // Verify prefix is still at the start of the truncated line
    expect(line.startsWith(`Query: "[o] `)).toBe(true);
    // Extraction round-trip also preserves prefix
    const planText = ["🎯 DISPATCH PLAN", "", line].join("\n");
    const extracted = extractUserMessageFromPlan(planText);
    expect(extracted.startsWith("[o] ")).toBe(true);
  });
});

// ── extractUserMessageFromPlan fallback behaviour ─────────────────────────────

describe("commandCenter — extractUserMessageFromPlan (fallback after restart)", () => {
  it("returns full short message", () => {
    const msg = "review the relay module";
    const planText = [
      "🎯 DISPATCH PLAN",
      "",
      formatQueryLine(msg),
      "Intent: code-review",
    ].join("\n");
    expect(extractUserMessageFromPlan(planText)).toBe(msg);
  });

  it("returns truncated content for long messages (known limitation of fallback)", () => {
    const longMessage = "B".repeat(150);
    const planText = [
      "🎯 DISPATCH PLAN",
      "",
      formatQueryLine(longMessage),
      "Intent: code-review",
    ].join("\n");
    const extracted = extractUserMessageFromPlan(planText);
    // Fallback path is truncated — this is why pendingPickerMessages exists
    expect(extracted.length).toBe(97);
    expect(extracted).not.toBe(longMessage);
  });
});

// ── pendingPickerMessages — full message preservation ─────────────────────────

describe("commandCenter — pendingPickerMessages (primary picker path)", () => {
  it("Map lookup returns full message regardless of display truncation", () => {
    const pendingPickerMessages = new Map<string, string>();
    const dispatchId = "test-uuid-1234";
    const longMessage = "C".repeat(200);

    pendingPickerMessages.set(dispatchId, longMessage);

    const storedMessage = pendingPickerMessages.get(dispatchId);
    pendingPickerMessages.delete(dispatchId);

    expect(storedMessage).toBe(longMessage);
    expect(storedMessage!.length).toBe(200);
    expect(pendingPickerMessages.has(dispatchId)).toBe(false);
  });

  it("Map preserves [o] prefix for model selection regardless of message length", () => {
    const pendingPickerMessages = new Map<string, string>();
    const dispatchId = "model-prefix-test";
    // Long enough to be truncated in the plan display
    const message = "[o] " + "x".repeat(200);

    pendingPickerMessages.set(dispatchId, message);

    const retrieved = pendingPickerMessages.get(dispatchId);
    pendingPickerMessages.delete(dispatchId);

    // Full message retrieved — [o] prefix intact for resolveModelPrefix()
    expect(retrieved).toBe(message);
    expect(retrieved!.startsWith("[o] ")).toBe(true);
  });

  it("falls back to extractUserMessageFromPlan when dispatchId not in map (e.g. after restart)", () => {
    const pendingPickerMessages = new Map<string, string>();
    const dispatchId = "unknown-id";
    const planText = `Query: "${"D".repeat(97)}..."`;

    const storedMessage = pendingPickerMessages.get(dispatchId);
    const extracted = extractUserMessageFromPlan(planText);
    const userMessage = storedMessage ?? extracted;

    // Falls back to truncated extraction — content may be incomplete but functional
    expect(userMessage.length).toBe(97);
  });

  it("cancelled dispatch removes message from map", () => {
    const pendingPickerMessages = new Map<string, string>();
    const dispatchId = "cancel-test";
    pendingPickerMessages.set(dispatchId, "some message");

    // Simulate cancelled callback
    pendingPickerMessages.delete(dispatchId);

    expect(pendingPickerMessages.has(dispatchId)).toBe(false);
  });
});

// ── inferAgentFromText — post-restart reply routing ───────────────────────────

/** Mirrors inferAgentFromText in commandCenter.ts. */
function inferAgentFromText(
  text: string,
  agents: Record<string, { name: string }>,
): string | null {
  for (const [id, agent] of Object.entries(agents)) {
    if (id === "command-center") continue;
    const name = agent.name;
    if (
      text.includes(`${name} — completed`) ||
      text.includes(`${name} — failed`) ||
      text.includes(`Target: ${name}`)
    ) {
      return id;
    }
  }
  return null;
}

const TEST_AGENTS = {
  "command-center":    { name: "Jarvis Command Center" },
  "engineering":       { name: "Engineering & Quality Lead" },
  "cloud-architect":   { name: "Cloud & Infrastructure" },
  "security-compliance": { name: "Security & Compliance" },
  "operations-hub":    { name: "Operations Hub" },
};

describe("commandCenter — inferAgentFromText (post-restart reply routing)", () => {
  it("matches success header from postResult", () => {
    const text = "✅ Engineering & Quality Lead — completed (5.2s)\n\nHere is the review.";
    expect(inferAgentFromText(text, TEST_AGENTS)).toBe("engineering");
  });

  it("matches failure header from postResult", () => {
    const text = "❌ Cloud & Infrastructure — failed (3.1s)";
    expect(inferAgentFromText(text, TEST_AGENTS)).toBe("cloud-architect");
  });

  it("matches Target line from dispatch plan card", () => {
    const text = "🎯 DISPATCH PLAN\n\nQuery: \"fix bug\"\nTarget: Engineering & Quality Lead (88% confidence)";
    expect(inferAgentFromText(text, TEST_AGENTS)).toBe("engineering");
  });

  it("returns null for unrecognised text", () => {
    expect(inferAgentFromText("some random message", TEST_AGENTS)).toBeNull();
  });

  it("skips command-center agent", () => {
    const text = "✅ Jarvis Command Center — completed (1s)";
    expect(inferAgentFromText(text, TEST_AGENTS)).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(inferAgentFromText("", TEST_AGENTS)).toBeNull();
  });
});
