/**
 * Tool: runPrompt
 *
 * Thin wrapper for use in generated prompt-based user routines.
 * Tries local MLX first, falls back to Claude Haiku.
 */

import { claudeText } from "../claude-process.ts";
import { callRoutineModel } from "../routines/routineModel.ts";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run a prompt through local MLX model, falling back to Claude CLI.
 * Used by generated user routine files.
 */
export async function runPrompt(
  prompt: string,
  options?: { model?: string; timeoutMs?: number }
): Promise<string> {
  try {
    const result = await callRoutineModel(prompt, {
      label: "runPrompt",
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    return result;
  } catch (localErr) {
    console.warn("[runPrompt] Local model failed, falling back to Haiku:", localErr instanceof Error ? localErr.message : localErr);
    const result = await claudeText(prompt, {
      model: options?.model ?? DEFAULT_MODEL,
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    console.log("[runPrompt] Haiku fallback succeeded");
    return result;
  }
}
