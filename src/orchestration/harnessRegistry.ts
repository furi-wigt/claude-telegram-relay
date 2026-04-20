/**
 * harnessRegistry — in-memory tracker of in-flight NLAH harness runs.
 *
 * Provides three capabilities consumed by the harness, the cancel-dispatch
 * callback, and the `/cancel-dispatch` slash command:
 *
 * 1. **Cancellation flag** — `requestCancel(dispatchId)` flips a boolean;
 *    `runHarness` checks `cancelled(dispatchId)` between steps.
 *
 * 2. **Current agent stream key** — `setCurrentAgentKey(dispatchId, key)` is
 *    called by the harness immediately before each `executeSingleDispatch`.
 *    On cancel, the registry consumer (`abortStreamsForDispatch`) reads this
 *    key to abort exactly the in-flight `claudeStream` of the currently
 *    dispatched agent — and nothing else.
 *
 * 3. **Reverse lookup by CC chat** — `lookupByCcChat(chatId, threadId)`
 *    returns the active dispatchId for a given Command Center chat/thread,
 *    so `/cancel-dispatch` (and CC `/cancel` reroute) can resolve the target
 *    dispatch without the user typing an ID.
 *
 * Lifetime: entries created in `runHarness` entry, deleted in its `finally`.
 * Bounded by concurrent dispatch count (handful at most). No timer TTL.
 *
 * All operations are O(1) on the underlying Map.
 */

interface RegistryEntry {
  cancelled: boolean;
  ccChatId: number;
  ccThreadId: number | null;
  /** Stream key of the agent currently being awaited; null between steps. */
  currentAgentKey: string | null;
}

const registry = new Map<string, RegistryEntry>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register a new harness run. Idempotent — a second call with the same
 * dispatchId leaves the existing entry (and its cancelled flag) untouched.
 */
export function registerHarness(
  dispatchId: string,
  ctx: { ccChatId: number; ccThreadId: number | null },
): void {
  if (registry.has(dispatchId)) return;
  registry.set(dispatchId, {
    cancelled: false,
    ccChatId: ctx.ccChatId,
    ccThreadId: ctx.ccThreadId,
    currentAgentKey: null,
  });
}

/** Remove an entry. No-op if unknown. */
export function unregisterHarness(dispatchId: string): void {
  registry.delete(dispatchId);
}

/**
 * Flip the cancelled flag for an active dispatch.
 * @returns `true` if the entry existed (cancellation accepted),
 *          `false` if the dispatchId is unknown (already completed/expired).
 */
export function requestCancel(dispatchId: string): boolean {
  const entry = registry.get(dispatchId);
  if (!entry) return false;
  entry.cancelled = true;
  return true;
}

/**
 * Check whether cancellation has been requested. Returns false for unknown
 * dispatchIds (treats unknown as not-cancelled — safe default).
 */
export function cancelled(dispatchId: string): boolean {
  return registry.get(dispatchId)?.cancelled ?? false;
}

/**
 * Snapshot the stream key (`${chatId}:${threadId ?? ""}`) of the agent
 * currently being awaited. Called by `runHarness` immediately before each
 * `executeSingleDispatch` await; cleared (set to null) after that await
 * resolves so that a cancel between steps does not target a stale stream.
 *
 * No-op if dispatchId is unknown (defensive).
 */
export function setCurrentAgentKey(dispatchId: string, key: string | null): void {
  const entry = registry.get(dispatchId);
  if (!entry) return;
  entry.currentAgentKey = key;
}

/** Return the current agent stream key, or null if unknown / not set. */
export function currentAgentKey(dispatchId: string): string | null {
  return registry.get(dispatchId)?.currentAgentKey ?? null;
}

/**
 * Reverse-lookup: find the active dispatchId for a given CC chat/thread.
 * Returns null if no harness is active there.
 *
 * If multiple entries match (should not happen in practice — guarded at
 * harness entry), returns one of them deterministically (Map iteration order
 * = insertion order in V8 / JSC). Caller treats either as valid.
 */
export function lookupByCcChat(
  ccChatId: number,
  ccThreadId: number | null,
): string | null {
  for (const [dispatchId, entry] of registry) {
    if (entry.ccChatId === ccChatId && entry.ccThreadId === ccThreadId) {
      return dispatchId;
    }
  }
  return null;
}

// ── Test-only helper ──────────────────────────────────────────────────────────

/** Reset the entire registry. ONLY for use in tests. */
export function _resetRegistryForTests(): void {
  registry.clear();
}
