// src/routines/routineModel.ts

import { getRegistry } from "../models/index.ts";
import type { ChatMessage } from "../models/types.ts";

export interface RoutineModelOptions {
  timeoutMs?: number;
  maxTokens?: number;
  label?: string;
  chunkTimeoutMs?: number;
}

/**
 * Call the configured routine model slot.
 * Cascades through providers in models.json slots.routine order.
 * Replaces the old MLX-mutex approach — concurrency is handled per-provider
 * via maxConcurrent in config (LM Studio/Ollama queue HTTP requests natively).
 */
export async function callRoutineModel(
  prompt: string,
  options?: RoutineModelOptions
): Promise<string> {
  const label = options?.label ?? "routine";
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  const result = await getRegistry().chat("routine", messages, {
    timeoutMs: options?.timeoutMs,
    maxTokens: options?.maxTokens,
    chunkTimeoutMs: options?.chunkTimeoutMs,
    label,
  });
  console.log(`[${label}] routine model succeeded`);
  return result;
}
