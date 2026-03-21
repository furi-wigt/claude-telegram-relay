/**
 * Local embedding via Ollama BGE-M3.
 * Returns 1024-dim dense vectors. ~10-50ms per call.
 */

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "bge-m3";
const EMBED_TIMEOUT_MS = 30_000;

export interface EmbedResult {
  vector: number[];
  model: string;
  durationMs: number;
}

/**
 * Embed a single text string using Ollama BGE-M3.
 * Returns a 1024-dimensional dense vector.
 */
export async function localEmbed(text: string): Promise<number[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embed failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { embeddings: number[][] };
  if (!data.embeddings?.[0]?.length) {
    throw new Error("Ollama returned empty embedding");
  }
  return data.embeddings[0];
}

/**
 * Embed multiple texts in a single batch call.
 * More efficient than calling localEmbed() in a loop.
 */
export async function localEmbedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS * 2); // longer for batches
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama batch embed failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { embeddings: number[][] };
  if (!data.embeddings || data.embeddings.length !== texts.length) {
    throw new Error(
      `Ollama returned ${data.embeddings?.length ?? 0} embeddings for ${texts.length} inputs`
    );
  }
  return data.embeddings;
}

/**
 * Health check — verifies Ollama is running and BGE-M3 is loaded.
 */
export async function checkEmbedHealth(): Promise<boolean> {
  try {
    const vec = await localEmbed("health check");
    return vec.length === 1024;
  } catch {
    return false;
  }
}
