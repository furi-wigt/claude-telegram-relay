/**
 * Tests for didResumeFail()
 *
 * Detects when a --resume attempt silently produced a new Claude session
 * instead of continuing the old one. Used to reset messageCount and offer
 * the user an inline keyboard to re-inject short-term context.
 */
import { describe, test, expect } from "bun:test";
import { didResumeFail } from "./groupSessions.ts";

// ─── Core behaviour ──────────────────────────────────────────────────────────

describe("didResumeFail — resume was attempted and session changed", () => {
  test("returns true when triedResume=true and sessionId changed", () => {
    expect(didResumeFail(true, "old-uuid-1111", "new-uuid-2222")).toBe(true);
  });

  test("returns true with different UUIDs (real claude IDs)", () => {
    expect(
      didResumeFail(
        true,
        "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "11112222-3333-4444-5555-666677778888"
      )
    ).toBe(true);
  });
});

describe("didResumeFail — resume was attempted and session is same (success)", () => {
  test("returns false when triedResume=true and sessionId unchanged", () => {
    expect(didResumeFail(true, "same-uuid", "same-uuid")).toBe(false);
  });
});

describe("didResumeFail — resume was NOT attempted", () => {
  test("returns false when triedResume=false even if ids differ", () => {
    // Session was cold/new — the new id is expected, not a failure
    expect(didResumeFail(false, "old-uuid", "new-uuid")).toBe(false);
  });

  test("returns false when triedResume=false and prevId was null", () => {
    expect(didResumeFail(false, null, "new-uuid")).toBe(false);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe("didResumeFail — edge cases", () => {
  test("returns false when prevSessionId was null (no session to resume)", () => {
    // triedResume should never be true when prevId is null, but guard anyway
    expect(didResumeFail(true, null, "new-uuid")).toBe(false);
  });

  test("returns false when Claude returned no new sessionId", () => {
    // Claude CLI didn't emit a session line — can't conclude failure
    expect(didResumeFail(true, "old-uuid", null)).toBe(false);
  });

  test("returns false when both ids are null", () => {
    expect(didResumeFail(true, null, null)).toBe(false);
  });

  test("returns false when triedResume=false and no ids", () => {
    expect(didResumeFail(false, null, null)).toBe(false);
  });
});
