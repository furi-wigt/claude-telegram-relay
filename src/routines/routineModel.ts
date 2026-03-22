/**
 * Unified routine model caller — MLX only.
 *
 * All routine code should call `callRoutineModel()` instead of
 * `callMlxGenerate()` directly. This provides a single place to
 * control generation for scheduled routines.
 *
 * Provider: MLX server (Qwen3.5 9B 4-bit, Apple Silicon native via mlx serve)
 *
 * Concurrency: MLX calls are serialized via a mutex — only one
 * generation can run at a time (GPU memory is shared).
 */

import { callMlxGenerate } from "../mlx/index.ts";

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
export type RoutineModelProvider = "mlx";
let _lastProvider: RoutineModelProvider = "mlx";
export function getLastProvider(): RoutineModelProvider { return _lastProvider; }

/**
 * Call the MLX local model for routine tasks.
 *
 * MLX calls are serialized — concurrent callers wait in queue.
 */
export async function callRoutineModel(
  prompt: string,
  options?: RoutineModelOptions
): Promise<string> {
  const label = options?.label ?? "routine";
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const maxTokens = options?.maxTokens ?? 2048;

  const result = await withMlxLock(() =>
    callMlxGenerate(prompt, { timeoutMs, maxTokens })
  );
  _lastProvider = "mlx";
  console.log(`[${label}] MLX succeeded`);
  return result;
}
