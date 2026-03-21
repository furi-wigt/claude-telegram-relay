/**
 * Doc ingest callback handlers — extracted from relay.ts for testability.
 *
 * Extracted from relay.ts so they can be imported in unit tests without
 * triggering relay.ts side effects (bot.start(), process listeners, etc.).
 *
 * Usage in relay.ts:
 *   import { handleIngestTitleConfirmed, handleDocOverwrite }
 *     from "./documents/docIngestCallbacks.ts";
 *
 * Pattern: same injectable-deps approach as cancel.ts.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type { PendingIngestState as IngestCallbackState } from "./ingestFlow.ts";
import type { PendingIngestState } from "./ingestFlow.ts";

// ── handleIngestTitleConfirmed ─────────────────────────────────────────────

export interface IngestTitleConfirmedDeps {
  /** The shared pending-ingest state map (relay.ts passes its own). */
  pendingIngestStates: Map<string, PendingIngestState>;
  /** Calls DB to check if a document with this title already exists. */
  checkTitleCollision: (title: string) => Promise<{ exists: boolean }>;
  /** Shows the overwrite / cancel inline keyboard for a title collision. */
  showCollisionKeyboard: (title: string, overwriteKey: string, cancelKey: string) => Promise<void>;
  /** Performs the actual ingest save and replies with confirmation. */
  performSave: (chatId: number, threadId: number | null, body: string, title: string) => Promise<void>;
}

/**
 * Handle free-text title capture for /doc ingest flow.
 *
 * Called when the user is in `await-title-text` stage and sends a message.
 * Reads state, checks for title collision, and either shows collision keyboard
 * or triggers the actual save.
 *
 * @param chatId  - Telegram chat ID
 * @param threadId - Forum topic thread ID, or null
 * @param key     - pendingIngestStates map key (`streamKey(chatId, threadId)`)
 * @param newTitle - The user-supplied title text
 * @param deps    - Injectable dependencies for testing
 */
export async function handleIngestTitleConfirmed(
  chatId: number,
  threadId: number | null,
  key: string,
  newTitle: string,
  deps: IngestTitleConfirmedDeps,
): Promise<void> {
  const { pendingIngestStates, checkTitleCollision, showCollisionKeyboard, performSave } = deps;

  const state = pendingIngestStates.get(key);
  if (!state || !state.body || Date.now() > state.expiresAt) {
    pendingIngestStates.delete(key);
    return;
  }

  const collision = await checkTitleCollision(newTitle);
  if (collision.exists) {
    state.stage = "await-dedup-resolution";
    state.title = newTitle;
    pendingIngestStates.set(key, state);
    await showCollisionKeyboard(newTitle, `di_overwrite:${key}`, `di_cancel:${key}`);
  } else {
    pendingIngestStates.delete(key);
    await performSave(chatId, threadId, state.body, newTitle);
  }
}

// ── handleDocOverwrite ────────────────────────────────────────────────────────

export interface DocOverwriteDeps {
  /** The shared pending-ingest state map (relay.ts passes its own). */
  pendingIngestStates: Map<string, PendingIngestState>;
  /** Reply to the callback query with "Session expired." and return early. */
  answerExpired: () => Promise<void>;
  /** Acknowledge the callback query (no toast). */
  answerOk: () => Promise<void>;
  /** Remove the inline keyboard from the callback message. */
  removeKeyboard: () => Promise<void>;
  /** Delete all existing document chunks for the given title. */
  deleteExistingDoc: (title: string) => Promise<void>;
  /** Ingest the document body under the given title and return chunk count. */
  saveDoc: (body: string, title: string) => Promise<{ chunksInserted: number }>;
  /** Reply with the success confirmation message. */
  replySuccess: (title: string, bodyLength: number) => Promise<void>;
  /** Schedule embedding verification (non-blocking, fires ~6s later). */
  scheduleVerification: (chatId: number, threadId: number | null, title: string, chunks: number) => void;
}

/**
 * Handle `di_overwrite:` callback — user confirmed overwriting an existing doc.
 *
 * Deletes the existing document chunks, re-ingests the new content,
 * replies with a success message, and schedules embedding verification.
 *
 * @param key      - pendingIngestStates map key
 * @param chatId   - Telegram chat ID
 * @param threadId - Forum topic thread ID, or null
 * @param deps     - Injectable dependencies for testing
 */
export async function handleDocOverwrite(
  key: string,
  chatId: number,
  threadId: number | null,
  deps: DocOverwriteDeps,
): Promise<void> {
  const { pendingIngestStates, answerExpired, answerOk, removeKeyboard, deleteExistingDoc, saveDoc, replySuccess, scheduleVerification } = deps;

  const state = pendingIngestStates.get(key);
  if (!state || !state.body || !state.title) {
    await answerExpired();
    return;
  }

  pendingIngestStates.delete(key);
  await answerOk();
  await removeKeyboard();

  await deleteExistingDoc(state.title);
  const result = await saveDoc(state.body, state.title);
  await replySuccess(state.title, state.body.length);
  scheduleVerification(chatId, threadId, state.title, result.chunksInserted);
}
