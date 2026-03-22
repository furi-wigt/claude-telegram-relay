/**
 * Unified routine model caller — MLX-first with Ollama fallback.
 *
 * All routine code should call `callRoutineModel()` instead of
 * `callOllamaGenerate()` or `callMlxGenerate()` directly. This provides
 * a single place to control the provider cascade for scheduled routines.
 *
 * Provider order:
 *   1. MLX (mlx-qwen CLI, Qwen3.5 9B 4-bit, Apple Silicon native)
 *   2. Ollama (HTTP, OLLAMA_ROUTINE_MODEL or fallback)
 */

import { callMlxGenerate, isMlxAvailable } from "../mlx/index.ts";
import { callOllamaGenerate } from "../ollama/index.ts";

export interface RoutineModelOptions {
  timeoutMs?: number;
  maxTokens?: number;
  /** Label for log messages (e.g. "morning-summary:recap"). */
  label?: string;
}

/**
 * Call the best available local model for routine tasks.
 *
 * Tries MLX first (faster, better reasoning on 9B), falls back to Ollama
 * (qwen3.5:4b or configured OLLAMA_ROUTINE_MODEL).
 */
export async function callRoutineModel(
  prompt: string,
  options?: RoutineModelOptions
): Promise<string> {
  const label = options?.label ?? "routine";
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const maxTokens = options?.maxTokens ?? 2048;

  // Try MLX first
  if (isMlxAvailable()) {
    try {
      const result = await callMlxGenerate(prompt, { timeoutMs, maxTokens });
      console.log(`[${label}] MLX succeeded`);
      return result;
    } catch (mlxErr) {
      console.warn(
        `[${label}] MLX failed, falling back to Ollama:`,
        mlxErr instanceof Error ? mlxErr.message : mlxErr
      );
    }
  }

  // Fallback to Ollama
  const result = await callOllamaGenerate(prompt, {
    purpose: "routine-summary",
    timeoutMs,
    think: false,
  });
  console.log(`[${label}] Ollama succeeded`);
  return result;
}
