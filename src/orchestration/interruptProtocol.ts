/**
 * Interrupt Protocol
 *
 * Manages the 5-second auto-dispatch countdown with Pause/Edit/Cancel inline buttons.
 * User can interrupt before dispatch begins.
 *
 * Lifecycle:
 *   plan posted → countdown (5s) → auto-dispatch
 *                ↓ user taps
 *          Pause → paused (awaits further instruction)
 *          Edit  → cancelled (re-prompts user)
 *          Cancel → cancelled (dispatch aborted)
 */

import { InlineKeyboard } from "grammy";
import type { CountdownState, InterruptAction } from "./types.ts";

/** Active countdowns keyed by dispatchId — includes resolve callback for promise settlement */
const activeCountdowns = new Map<string, CountdownState & { resolve?: (v: string) => void }>();

/** Callback data prefix for orchestration buttons */
export const ORCH_CB_PREFIX = "orch:";

/**
 * Build the inline keyboard for a dispatch plan.
 */
export function buildPlanKeyboard(dispatchId: string, secondsLeft: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(`\u23F8 Pause (${secondsLeft}s)`, `${ORCH_CB_PREFIX}pause:${dispatchId}`)
    .text("\u270F\uFE0F Edit", `${ORCH_CB_PREFIX}edit:${dispatchId}`)
    .text("\u274C Cancel", `${ORCH_CB_PREFIX}cancel:${dispatchId}`);
}

/**
 * Build the paused-state keyboard (resume or cancel).
 */
export function buildPausedKeyboard(dispatchId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("\u25B6\uFE0F Resume", `${ORCH_CB_PREFIX}resume:${dispatchId}`)
    .text("\u274C Cancel", `${ORCH_CB_PREFIX}cancel:${dispatchId}`);
}

/**
 * Parse a callback query data string into an interrupt action + dispatchId.
 * Returns null if the callback is not an orchestration callback.
 */
export function parseOrchCallback(data: string): { action: InterruptAction; dispatchId: string } | null {
  if (!data.startsWith(ORCH_CB_PREFIX)) return null;
  const rest = data.slice(ORCH_CB_PREFIX.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx < 0) return null;
  const action = rest.slice(0, colonIdx) as InterruptAction;
  const dispatchId = rest.slice(colonIdx + 1);
  if (!["pause", "edit", "cancel", "resume"].includes(action)) return null;
  return { action, dispatchId };
}

/**
 * Start a countdown for a dispatch plan.
 *
 * Returns a Promise that resolves with:
 *   - "dispatched" if countdown completes without interruption
 *   - "paused" if user paused
 *   - "edit" if user wants to edit
 *   - "cancelled" if user cancelled
 */
export function startCountdown(
  dispatchId: string,
  chatId: number,
  threadId: number | null,
  planMessageId: number,
  durationSeconds: number,
  onTick: (secondsLeft: number) => void,
): Promise<"dispatched" | "paused" | "edit" | "cancelled"> {
  return new Promise((resolve) => {
    const state: CountdownState & { resolve?: (v: string) => void } = {
      dispatchId,
      secondsLeft: durationSeconds,
      timer: null,
      status: "counting",
      planMessageId,
      chatId,
      threadId,
      resolve: resolve as (v: string) => void,
    };

    activeCountdowns.set(dispatchId, state);

    const tick = () => {
      if (state.status !== "counting") return; // interrupted — resolve already called by handleInterrupt

      state.secondsLeft--;
      if (state.secondsLeft <= 0) {
        state.status = "dispatched";
        state.resolve = undefined;
        activeCountdowns.delete(dispatchId);
        resolve("dispatched");
        return;
      }

      onTick(state.secondsLeft);
      state.timer = setTimeout(tick, 1000);
    };

    state.timer = setTimeout(tick, 1000);
  });
}

/**
 * Handle an interrupt action on an active countdown.
 * Returns the new status, or null if no active countdown found.
 */
export function handleInterrupt(dispatchId: string, action: InterruptAction): string | null {
  const state = activeCountdowns.get(dispatchId);
  if (!state) return null;

  // Clear the timer
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  const settlePromise = (outcome: string) => {
    if (state.resolve) {
      state.resolve(outcome);
      state.resolve = undefined;
    }
  };

  switch (action) {
    case "pause":
      state.status = "paused";
      activeCountdowns.set(dispatchId, state); // keep in map for resume
      settlePromise("paused");
      return "paused";

    case "resume":
      activeCountdowns.delete(dispatchId);
      settlePromise("resumed");
      return "resumed";

    case "edit":
      state.status = "cancelled";
      activeCountdowns.delete(dispatchId);
      settlePromise("edit");
      return "edit";

    case "cancel":
      state.status = "cancelled";
      activeCountdowns.delete(dispatchId);
      settlePromise("cancelled");
      return "cancelled";

    default:
      return null;
  }
}

/**
 * Get the current countdown state for a dispatch.
 */
export function getCountdownState(dispatchId: string): CountdownState | undefined {
  return activeCountdowns.get(dispatchId);
}

/**
 * Clean up any active countdown (e.g. on error).
 */
export function clearCountdown(dispatchId: string): void {
  const state = activeCountdowns.get(dispatchId);
  if (state?.timer) clearTimeout(state.timer);
  if (state?.resolve) {
    state.resolve("cancelled");
    state.resolve = undefined;
  }
  activeCountdowns.delete(dispatchId);
}
