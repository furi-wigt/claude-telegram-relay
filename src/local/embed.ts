// src/local/embed.ts

import { getRegistry } from "../models/index.ts";

/** Single text embedding via configured embed provider. */
export async function localEmbed(text: string): Promise<number[]> {
  return getRegistry().embed(text);
}

/** Batch text embedding via configured embed provider. */
export async function localEmbedBatch(texts: string[]): Promise<number[][]> {
  return getRegistry().embedBatch(texts);
}

/** Health check for embed provider. */
export async function checkEmbedHealth(): Promise<boolean> {
  try {
    const vec = await localEmbed("health check");
    return vec.length > 0;
  } catch {
    return false;
  }
}
