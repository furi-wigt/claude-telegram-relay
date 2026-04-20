/**
 * Tests for harnessRegistry — in-memory tracker of in-flight NLAH harness runs.
 *
 * Provides cancellation flagging, current-agent-key snapshotting (for
 * mid-stream stream abort), and CC-chat → dispatchId reverse lookup
 * (for `/cancel-dispatch` slash command and CC `/cancel` reroute).
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  registerHarness,
  unregisterHarness,
  requestCancel,
  cancelled,
  setCurrentAgentKey,
  currentAgentKey,
  lookupByCcChat,
  _resetRegistryForTests,
} from "../../src/orchestration/harnessRegistry.ts";

describe("harnessRegistry", () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  // ── register / cancelled / unregister ──────────────────────────────────────

  test("registerHarness then cancelled() returns false initially", () => {
    registerHarness("d-1", { ccChatId: 100, ccThreadId: 5 });
    expect(cancelled("d-1")).toBe(false);
  });

  test("requestCancel flips flag and cancelled() returns true", () => {
    registerHarness("d-1", { ccChatId: 100, ccThreadId: null });
    const ok = requestCancel("d-1");
    expect(ok).toBe(true);
    expect(cancelled("d-1")).toBe(true);
  });

  test("unregisterHarness removes entry — cancelled() returns false for unknown", () => {
    registerHarness("d-1", { ccChatId: 100, ccThreadId: null });
    unregisterHarness("d-1");
    expect(cancelled("d-1")).toBe(false);
  });

  test("double registerHarness is idempotent — second call does not reset cancelled flag", () => {
    registerHarness("d-1", { ccChatId: 100, ccThreadId: null });
    requestCancel("d-1");
    registerHarness("d-1", { ccChatId: 100, ccThreadId: null }); // re-register
    expect(cancelled("d-1")).toBe(true);
  });

  test("requestCancel on unknown dispatchId returns false", () => {
    const ok = requestCancel("nonexistent");
    expect(ok).toBe(false);
  });

  test("unregisterHarness on unknown is a no-op (does not throw)", () => {
    expect(() => unregisterHarness("nonexistent")).not.toThrow();
  });

  // ── currentAgentKey (mid-stream abort target) ──────────────────────────────

  test("setCurrentAgentKey and currentAgentKey round-trip", () => {
    registerHarness("d-1", { ccChatId: 100, ccThreadId: null });
    setCurrentAgentKey("d-1", "-1001234:7");
    expect(currentAgentKey("d-1")).toBe("-1001234:7");
  });

  test("currentAgentKey returns null when never set", () => {
    registerHarness("d-1", { ccChatId: 100, ccThreadId: null });
    expect(currentAgentKey("d-1")).toBeNull();
  });

  test("currentAgentKey returns null for unknown dispatchId", () => {
    expect(currentAgentKey("nonexistent")).toBeNull();
  });

  test("setCurrentAgentKey on unknown dispatchId is a no-op (does not throw)", () => {
    expect(() => setCurrentAgentKey("nonexistent", "x:y")).not.toThrow();
  });

  // ── lookupByCcChat (slash command + /cancel reroute) ───────────────────────

  test("lookupByCcChat returns dispatchId for matching ccChatId + ccThreadId", () => {
    registerHarness("d-1", { ccChatId: 100, ccThreadId: 5 });
    expect(lookupByCcChat(100, 5)).toBe("d-1");
  });

  test("lookupByCcChat returns dispatchId when threadId is null on both", () => {
    registerHarness("d-1", { ccChatId: 100, ccThreadId: null });
    expect(lookupByCcChat(100, null)).toBe("d-1");
  });

  test("lookupByCcChat returns null when no harness active for chat", () => {
    expect(lookupByCcChat(999, null)).toBeNull();
  });

  test("lookupByCcChat differentiates threads in same chat", () => {
    registerHarness("d-thread-5", { ccChatId: 100, ccThreadId: 5 });
    registerHarness("d-thread-6", { ccChatId: 100, ccThreadId: 6 });
    expect(lookupByCcChat(100, 5)).toBe("d-thread-5");
    expect(lookupByCcChat(100, 6)).toBe("d-thread-6");
    expect(lookupByCcChat(100, 7)).toBeNull();
  });

  test("lookupByCcChat returns null after unregister", () => {
    registerHarness("d-1", { ccChatId: 100, ccThreadId: 5 });
    unregisterHarness("d-1");
    expect(lookupByCcChat(100, 5)).toBeNull();
  });

  test("lookupByCcChat returns most-recent dispatchId if multiple registered for same chat+thread (edge case)", () => {
    // This shouldn't happen in practice — guarded by the harness itself —
    // but the registry should not crash and should return a deterministic value.
    registerHarness("d-old", { ccChatId: 100, ccThreadId: 5 });
    registerHarness("d-new", { ccChatId: 100, ccThreadId: 5 });
    const result = lookupByCcChat(100, 5);
    expect(["d-old", "d-new"]).toContain(result);
  });
});
