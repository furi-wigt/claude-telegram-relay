/**
 * Unified routine model caller — MLX serve (local LLM).
 *
 * All routine code should call `callRoutineModel()` instead of
 * `callMlxGenerate()` directly. This provides a single place to
 * control generation for scheduled routines.
 *
 * Provider: MLX serve (Qwen3.5 9B, Apple Silicon native, port 8800)
 *
 * Concurrency: calls are serialized via a mutex — only one
 * generation can run at a time (GPU memory is shared).
 */

import { callMlxGenerate } from "../mlx/index.ts";

export interface RoutineModelOptions {
  timeoutMs?: number;
  maxTokens?: number;
  /** Label for log messages (e.g. "morning-summary:recap"). */
  label?: string;
  /**
   * Max ms of silence between SSE chunks before aborting.
   * Defaults to 30 000ms. Increase for heavy prompts that may queue
   * behind another in-flight MLX request (e.g. night-summary analyzeDay).
   */
  chunkTimeoutMs?: number;
}

// Simple mutex: serializes LLM calls to prevent concurrent GPU access
let _llmLock: Promise<void> = Promise.resolve();

function withLlmLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _llmLock;
  let release: () => void;
  _llmLock = new Promise<void>((r) => { release = r; });
  return prev.then(fn).finally(() => release!());
}

/** Which provider actually handled the last call (for display labels). */
export type RoutineModelProvider = "local";
let _lastProvider: RoutineModelProvider = "local";
export function getLastProvider(): RoutineModelProvider { return _lastProvider; }

/**
 * Call the local MLX server for routine tasks.
 *
 * Calls are serialized — concurrent callers wait in queue.
 */
export async function callRoutineModel(
  prompt: string,
  options?: RoutineModelOptions
): Promise<string> {
  const label = options?.label ?? "routine";
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const maxTokens = options?.maxTokens ?? 2048;

  const chunkTimeoutMs = options?.chunkTimeoutMs;
  const result = await withLlmLock(() =>
    callMlxGenerate(prompt, { timeoutMs, maxTokens, ...(chunkTimeoutMs !== undefined && { chunkTimeoutMs }) })
  );
  _lastProvider = "local";
  console.log(`[${label}] Local LLM succeeded`);
  return result;
}
