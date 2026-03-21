/**
 * TRO Monthly Update — Q&A Active State
 *
 * Cross-process file-based flag for the interactive Q&A phase of the
 * TRO monthly update routine.
 *
 * The routine (tro-monthly-update.ts) writes a flag file when it's
 * waiting for Furi's context answers. The relay reads this file and
 * routes incoming personal messages to the workspace context-qa.md
 * instead of forwarding them to Claude.
 *
 * Flag file location: logs/tro-qa-active.json (relative to project root)
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";

const PROJECT_ROOT = join(dirname(dirname(dirname(import.meta.path))));
const FLAG_FILE = join(PROJECT_ROOT, "logs", "tro-qa-active.json");

/**
 * Max age of a Q&A session before it's considered stale.
 * Must match QA_TIMEOUT_MS in tro-monthly-update.ts (15 minutes) so that
 * a crashed session's flag expires at exactly the same time the routine
 * would have timed out — not 5 minutes later.
 */
const MAX_AGE_MS = 15 * 60 * 1000;

export interface TROQAState {
  workspacePath: string;   // Absolute path to TRO_Mon[YYYY]/workspace/
  chatId: number;          // Telegram chat ID where questions were sent
  questions: string[];     // Questions sent to Furi (for context)
  startedAt: string;       // ISO timestamp
}

/**
 * Write the Q&A active flag.
 * Called by the routine after sending questions to Telegram.
 */
export function setTROQAActive(state: TROQAState): void {
  writeFileSync(FLAG_FILE, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Read the current Q&A active state.
 * Returns null if no Q&A is active or if the session is stale.
 */
export function getTROQAState(): TROQAState | null {
  if (!existsSync(FLAG_FILE)) return null;

  try {
    const raw = readFileSync(FLAG_FILE, "utf-8");
    const state = JSON.parse(raw) as TROQAState;

    // Expire stale sessions
    const age = Date.now() - new Date(state.startedAt).getTime();
    if (age > MAX_AGE_MS) {
      clearTROQAActive();
      return null;
    }

    return state;
  } catch {
    return null;
  }
}

/**
 * Append a user's reply to context-qa.md in the workspace.
 * Called by the relay when a message arrives during an active Q&A session.
 */
export function appendQAAnswer(state: TROQAState, text: string): void {
  const qaFile = join(state.workspacePath, "context-qa.md");
  const timestamp = new Date().toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore", hour12: false });
  const entry = `[${timestamp}] ${text}\n`;

  // Append or create
  try {
    const existing = existsSync(qaFile) ? readFileSync(qaFile, "utf-8") : "";
    writeFileSync(qaFile, existing + entry, "utf-8");
  } catch (err) {
    console.error("troQAState: failed to append answer:", err);
  }
}

/**
 * Remove the Q&A active flag.
 * Called by the routine when Q&A is complete (timeout or done signal).
 */
export function clearTROQAActive(): void {
  try {
    if (existsSync(FLAG_FILE)) unlinkSync(FLAG_FILE);
  } catch { /* ignore */ }
}

/**
 * Check if Q&A is currently active for the given chat.
 */
export function isTROQAActive(chatId?: number): boolean {
  const state = getTROQAState();
  if (!state) return false;
  if (chatId !== undefined && state.chatId !== chatId) return false;
  return true;
}
