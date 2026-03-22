/**
 * Local embedding via MLX server (bge-m3).
 * Returns 1024-dim dense vectors.
 */

import { getMlxBaseUrl } from "../mlx/index.ts";

const EMBED_MODEL = process.env.EMBED_MODEL || "bge-m3";
const EMBED_TIMEOUT_MS = 30_000;

export interface EmbedResult {
  vector: number[];
  model: string;
  durationMs: number;
}

/**
 * Embed a single text string using MLX bge-m3.
 * Returns a 1024-dimensional dense vector.
 */
export async function localEmbed(text: string): Promise<number[]> {
  const baseUrl = getMlxBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MLX embed failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    data?: Array<{ embedding: number[] }>;
  };
  if (!data.data?.[0]?.embedding?.length) {
    throw new Error("MLX returned empty embedding");
  }
  return data.data[0].embedding;
}

/**
 * Embed multiple texts in a single batch call.
 * More efficient than calling localEmbed() in a loop.
 */
export async function localEmbedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const baseUrl = getMlxBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS * 2);
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MLX batch embed failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    data?: Array<{ embedding: number[] }>;
  };
  if (!data.data || data.data.length !== texts.length) {
    throw new Error(
      `MLX returned ${data.data?.length ?? 0} embeddings for ${texts.length} inputs`
    );
  }
  return data.data.map((d) => d.embedding);
}

/**
 * Health check — verifies MLX server is running and bge-m3 is loaded.
 */
export async function checkEmbedHealth(): Promise<boolean> {
  try {
    const vec = await localEmbed("health check");
    return vec.length === 1024;
  } catch {
    return false;
  }
}
