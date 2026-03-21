/**
 * Pure state machine logic for doc ingest and Save-to-KB flows.
 *
 * Extracted from relay.ts so the state transitions can be unit-tested
 * without Grammy or the full relay module.
 *
 * These functions contain NO side effects — they return outcome objects
 * that the relay uses to decide what to reply and what state to set.
 */

// ─── Shared TTL ───────────────────────────────────────────────────────────────

/** TTL for both pendingIngestStates and pendingSaveStates entries. */
export const INGEST_STATE_TTL_MS = 2 * 60 * 1000; // 2 minutes

// ─── Pending Ingest State ─────────────────────────────────────────────────────

export interface PendingIngestState {
  stage: "await-content" | "await-title" | "await-title-text" | "await-dedup-resolution";
  title?: string;
  body?: string;
  expiresAt: number;
}

/** Create a fresh await-content state for /doc ingest. */
export function makeIngestState(title?: string, ttlMs = INGEST_STATE_TTL_MS): PendingIngestState {
  return {
    stage: "await-content",
    title: title || undefined,
    expiresAt: Date.now() + ttlMs,
  };
}

// ─── Flush outcome (Task 1 — text-paste path) ─────────────────────────────────

export type FlushOutcome =
  | { type: "expired" }
  | { type: "fast-path"; title: string }        // title known → collision check then save
  | { type: "suggest-title"; suggested: string }; // no title → show title keyboard

/**
 * Determine what should happen after TextBurstAccumulator flushes during
 * an await-content state. Pure — no side effects.
 *
 * @param state       Entry from pendingIngestStates (undefined = not found).
 * @param content     Assembled text from the debouncer.
 * @param suggestTitle  Function that derives a title from content (e.g. extractDocTitle).
 * @param now         Inject for testability; defaults to Date.now().
 */
export function determineFlushOutcome(
  state: PendingIngestState | undefined,
  content: string,
  suggestTitle: (text: string) => string,
  now = Date.now()
): FlushOutcome {
  if (!state || state.stage !== "await-content") return { type: "expired" };
  if (now > state.expiresAt) return { type: "expired" };
  if (state.title) return { type: "fast-path", title: state.title };
  return { type: "suggest-title", suggested: suggestTitle(content) };
}

// ─── Pending Save State (Task 2 — 💾 Save to KB) ─────────────────────────────

export interface PendingSaveState {
  stage: "await-title" | "await-title-text" | "await-dedup-resolution";
  body: string;
  suggestedTitle: string;
  expiresAt: number;
}

/**
 * Build a PendingSaveState from the last assistant response parts.
 * Stitches the string[] into one body, derives a suggested title.
 *
 * Pure — no side effects.
 *
 * @param parts       Message parts from lastAssistantResponses (ordered).
 * @param suggestTitle  Function that derives a title from body text.
 * @param ttlMs       TTL override for testing; defaults to INGEST_STATE_TTL_MS.
 */
export function buildSaveState(
  parts: string[],
  suggestTitle: (text: string) => string,
  ttlMs = INGEST_STATE_TTL_MS
): PendingSaveState {
  const body = parts.join("\n\n");
  return {
    stage: "await-title",
    body,
    suggestedTitle: suggestTitle(body),
    expiresAt: Date.now() + ttlMs,
  };
}

// ─── lastAssistantResponses management (Task 2) ───────────────────────────────

/**
 * Append a bot reply part to the accumulator for a chat context.
 * The array is reset to [part] if the key was empty.
 */
export function appendAssistantPart(
  map: Map<string, string[]>,
  key: string,
  part: string
): void {
  const existing = map.get(key) ?? [];
  existing.push(part);
  // M-LEAK: Cap per-entry total text to 10KB — drop oldest parts if exceeded
  const MAX_ENTRY_BYTES = 10 * 1024;
  while (existing.length > 1 && existing.reduce((sum, s) => sum + s.length, 0) > MAX_ENTRY_BYTES) {
    existing.shift();
  }
  map.set(key, existing);
}

/**
 * Reset the accumulator for a chat context on each new incoming user message.
 * Should be called before routing any message to Claude.
 */
export function resetAssistantParts(map: Map<string, string[]>, key: string): void {
  map.delete(key);
}
