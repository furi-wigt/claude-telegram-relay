/**
 * Local embedding via Ollama (bge-m3).
 * Returns 1024-dim dense vectors.
 *
 * Uses Ollama's /api/embed endpoint (default port 11434).
 *
 * Resilience: retries once with 2x timeout for transient errors.
 */

const EMBED_MODEL = process.env.EMBED_MODEL || "bge-m3";

/**
 * Base URL for the Ollama embedding server.
 * Defaults to http://localhost:11434.
 */
export function getEmbedBaseUrl(): string {
  return process.env.EMBED_URL ?? "http://localhost:11434";
}

/** Read timeout at call time so tests can override via process.env */
function getTimeoutMs(): number {
  return parseInt(process.env.EMBED_TIMEOUT_MS || "15000", 10);
}

export interface EmbedResult {
  vector: number[];
  model: string;
  durationMs: number;
}

/**
 * Single fetch to Ollama /api/embed endpoint with abort timeout.
 */
async function fetchEmbed(input: string | string[], timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(`${getEmbedBaseUrl()}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

/**
 * Embed a single text string using Ollama bge-m3.
 * Retries once with 2x timeout if first attempt is aborted.
 */
export async function localEmbed(text: string): Promise<number[]> {
  const timeout = getTimeoutMs();
  let res: Response;
  try {
    res = await fetchEmbed(text, timeout);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      console.warn(`[embed] Timeout after ${timeout}ms, retrying with ${timeout * 2}ms`);
      res = await fetchEmbed(text, timeout * 2);
    } else {
      throw err;
    }
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embed failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    embeddings?: number[][];
  };
  if (!data.embeddings?.[0]?.length) {
    throw new Error("Ollama returned empty embedding");
  }
  return data.embeddings[0];
}

/**
 * Embed multiple texts in a single batch call.
 * Retries once with 2x timeout on abort.
 */
export async function localEmbedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const batchTimeout = getTimeoutMs() * 2;
  let res: Response;
  try {
    res = await fetchEmbed(texts, batchTimeout);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      console.warn(`[embed] Batch timeout after ${batchTimeout}ms, retrying with ${batchTimeout * 2}ms`);
      res = await fetchEmbed(texts, batchTimeout * 2);
    } else {
      throw err;
    }
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama batch embed failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    embeddings?: number[][];
  };
  if (!data.embeddings || data.embeddings.length !== texts.length) {
    throw new Error(
      `Ollama returned ${data.embeddings?.length ?? 0} embeddings for ${texts.length} inputs`
    );
  }
  return data.embeddings;
}

/**
 * Health check — verifies Ollama is running and bge-m3 is loaded.
 */
export async function checkEmbedHealth(): Promise<boolean> {
  try {
    const vec = await localEmbed("health check");
    return vec.length === 1024;
  } catch {
    return false;
  }
}
