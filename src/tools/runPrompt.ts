/**
 * Tool: runPrompt
 *
 * Thin wrapper around callClaudeText for use in generated prompt-based
 * user routines. Stored in src/tools/ as the designated tool location
 * for prompt-based routine execution.
 */

import { callClaudeText } from "../claude.ts";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run a prompt through the Claude CLI and return the text response.
 * Used by generated user routine files.
 */
export async function runPrompt(
  prompt: string,
  options?: { model?: string; timeoutMs?: number }
): Promise<string> {
  return callClaudeText(prompt, {
    model: options?.model ?? DEFAULT_MODEL,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}
