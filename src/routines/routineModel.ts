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
 *
 * Concurrency: MLX calls are serialized via a mutex — only one mlx-qwen
 * process can run at a time (5.6GB model can't share GPU memory).
 */

import { callMlxGenerate, isMlxAvailable } from "../mlx/index.ts";
import { callOllamaGenerate } from "../ollama/index.ts";

export interface RoutineModelOptions {
  timeoutMs?: number;
  maxTokens?: number;
  /** Label for log messages (e.g. "morning-summary:recap"). */
  label?: string;
}

// Simple mutex: serializes MLX calls to prevent concurrent GPU access
let _mlxLock: Promise<void> = Promise.resolve();

function withMlxLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _mlxLock;
  let release: () => void;
  _mlxLock = new Promise<void>((r) => { release = r; });
  return prev.then(fn).finally(() => release!());
}

/** Which provider actually handled the last call (for display labels). */
export type RoutineModelProvider = "mlx" | "ollama";
let _lastProvider: RoutineModelProvider = "mlx";
export function getLastProvider(): RoutineModelProvider { return _lastProvider; }

/** Minimum timeout to attempt MLX — cold start needs ~8-15s to load 5.6GB model. */
const MLX_MIN_TIMEOUT_MS = 10_000;

/**
 * Call the best available local model for routine tasks.
 *
 * Tries MLX first (faster, better reasoning on 9B), falls back to Ollama.
 * MLX calls are serialized — concurrent callers wait in queue.
 * Callers with timeoutMs < 10s skip MLX entirely (cold start too slow).
 */
export async function callRoutineModel(
  prompt: string,
  options?: RoutineModelOptions
): Promise<string> {
  const label = options?.label ?? "routine";
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const maxTokens = options?.maxTokens ?? 2048;

  // Skip MLX for tight timeouts — cold start needs ~8-15s to load model
  if (isMlxAvailable() && timeoutMs >= MLX_MIN_TIMEOUT_MS) {
    try {
      const result = await withMlxLock(() =>
        callMlxGenerate(prompt, { timeoutMs, maxTokens })
      );
      _lastProvider = "mlx";
      console.log(`[${label}] MLX succeeded`);
      return result;
    } catch (mlxErr) {
      console.warn(
        `[${label}] MLX failed, falling back to Ollama:`,
        mlxErr instanceof Error ? mlxErr.message : mlxErr
      );
    }
  } else if (isMlxAvailable()) {
    console.log(`[${label}] Skipping MLX (timeout ${timeoutMs}ms < ${MLX_MIN_TIMEOUT_MS}ms min)`);
  }

  // Fallback to Ollama
  const result = await callOllamaGenerate(prompt, {
    purpose: "routine-summary",
    timeoutMs,
    think: false,
  });
  _lastProvider = "ollama";
  console.log(`[${label}] Ollama succeeded`);
  return result;
}
