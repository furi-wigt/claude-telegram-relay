/**
 * Local embedding via MLX embed server (bge-m3).
 * Returns 1024-dim dense vectors.
 *
 * Targets the dedicated embed server (EMBED_URL, default port 8801) which
 * runs independently from the generation server (MLX_URL, port 8800).
 * Embeddings no longer queue behind long-running text generation calls.
 *
 * Resilience: still retries once with 2x timeout for transient errors.
 */

const EMBED_MODEL = process.env.EMBED_MODEL || "bge-m3";

/**
 * Base URL for the dedicated embedding server.
 * Defaults to port 8801 (embed-only); falls back to MLX_URL for backward
 * compatibility if EMBED_URL is not set.
 */
export function getEmbedBaseUrl(): string {
  return process.env.EMBED_URL ?? "http://localhost:8801";
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
 * Single fetch to MLX embedding endpoint with abort timeout.
 */
async function fetchEmbed(input: string | string[], timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(`${getEmbedBaseUrl()}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

/**
 * Embed a single text string using MLX bge-m3.
 * Retries once with 2x timeout if first attempt is aborted (MLX busy with text gen).
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
