import { describe, test, expect, afterEach } from "bun:test";
import {
  startCountdown,
  handleInterrupt,
  parseOrchCallback,
  buildPlanKeyboard,
  buildPausedKeyboard,
  clearCountdown,
  ORCH_CB_PREFIX,
} from "../../src/orchestration/interruptProtocol";

describe("interruptProtocol", () => {
  const testDispatchId = "test-dispatch-123";

  afterEach(() => {
    clearCountdown(testDispatchId);
  });

  describe("parseOrchCallback", () => {
    test("parses pause callback", () => {
      const result = parseOrchCallback(`${ORCH_CB_PREFIX}pause:abc-123`);
      expect(result).toEqual({ action: "pause", dispatchId: "abc-123" });
    });

    test("parses edit callback", () => {
      const result = parseOrchCallback(`${ORCH_CB_PREFIX}edit:abc-123`);
      expect(result).toEqual({ action: "edit", dispatchId: "abc-123" });
    });

    test("parses cancel callback", () => {
      const result = parseOrchCallback(`${ORCH_CB_PREFIX}cancel:abc-123`);
      expect(result).toEqual({ action: "cancel", dispatchId: "abc-123" });
    });

    test("parses resume callback", () => {
      const result = parseOrchCallback(`${ORCH_CB_PREFIX}resume:abc-123`);
      expect(result).toEqual({ action: "resume", dispatchId: "abc-123" });
    });

    test("returns null for non-orchestration callbacks", () => {
      expect(parseOrchCallback("other:data")).toBeNull();
      expect(parseOrchCallback("reboot:confirm")).toBeNull();
    });

    test("returns null for invalid action", () => {
      expect(parseOrchCallback(`${ORCH_CB_PREFIX}invalid:abc`)).toBeNull();
    });
  });

  describe("startCountdown + handleInterrupt", () => {
    test("countdown completes after duration → dispatched", async () => {
      const ticks: number[] = [];
      const result = await startCountdown(
        testDispatchId, 123, null, 456, 1,
        (s) => ticks.push(s),
      );
      expect(result).toBe("dispatched");
    });

    test("pause interrupts countdown", async () => {
      const promise = startCountdown(
        testDispatchId, 123, null, 456, 10,
        () => {},
      );

      // Interrupt immediately
      const status = handleInterrupt(testDispatchId, "pause");
      expect(status).toBe("paused");

      const result = await promise;
      expect(result).toBe("paused");
    });

    test("cancel interrupts countdown", async () => {
      const promise = startCountdown(
        testDispatchId, 123, null, 456, 10,
        () => {},
      );

      const status = handleInterrupt(testDispatchId, "cancel");
      expect(status).toBe("cancelled");

      const result = await promise;
      expect(result).toBe("cancelled");
    });

    test("edit interrupts countdown", async () => {
      const promise = startCountdown(
        testDispatchId, 123, null, 456, 10,
        () => {},
      );

      const status = handleInterrupt(testDispatchId, "edit");
      expect(status).toBe("edit");

      const result = await promise;
      expect(result).toBe("edit");
    });

    test("handleInterrupt returns null for unknown dispatchId", () => {
      const result = handleInterrupt("nonexistent", "cancel");
      expect(result).toBeNull();
    });
  });

  describe("keyboard builders", () => {
    test("buildPlanKeyboard returns InlineKeyboard", () => {
      const kb = buildPlanKeyboard("test-id", 5);
      expect(kb).toBeDefined();
    });

    test("buildPausedKeyboard returns InlineKeyboard", () => {
      const kb = buildPausedKeyboard("test-id");
      expect(kb).toBeDefined();
    });
  });
});
