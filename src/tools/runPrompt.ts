/**
 * Tool: runPrompt
 *
 * Thin wrapper for use in generated prompt-based user routines.
 * Tries local Ollama first, falls back to Claude Haiku.
 */

import { claudeText } from "../claude-process.ts";
import { callOllamaGenerate } from "../ollama/index.ts";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run a prompt through local Ollama first, falling back to Claude CLI.
 * Used by generated user routine files.
 */
export async function runPrompt(
  prompt: string,
  options?: { model?: string; timeoutMs?: number }
): Promise<string> {
  try {
    const result = await callOllamaGenerate(prompt, {
      purpose: "routine-summary",
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    console.log("[runPrompt] Ollama succeeded");
    return result;
  } catch (ollamaErr) {
    console.warn("[runPrompt] Ollama failed, falling back to Haiku:", ollamaErr instanceof Error ? ollamaErr.message : ollamaErr);
    const result = await claudeText(prompt, {
      model: options?.model ?? DEFAULT_MODEL,
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    console.log("[runPrompt] Haiku fallback succeeded");
    return result;
  }
}
