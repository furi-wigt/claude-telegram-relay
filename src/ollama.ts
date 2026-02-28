/**
 * Ollama integration for local LLM summarization.
 * Connects to Ollama at http://localhost:11434 (default).
 */

// Note: OLLAMA_TIMEOUT_MS is a compile-time constant (no env var) — kept at module level.
const OLLAMA_TIMEOUT_MS = 10_000;

/**
 * Low-level helper: send a prompt to Ollama's /api/generate endpoint.
 *
 * @param prompt   The prompt text to send.
 * @param options  Optional overrides for model, base URL, and timeout.
 * @returns        The raw text from Ollama's `response` field.
 * @throws         On network error, non-2xx status, or abort (timeout).
 *
 * Implementation note: OLLAMA_URL and OLLAMA_MODEL are read inside this function
 * (not at module level) so that tests can set process.env before calling and
 * get the correct value without module caching causing stale reads.
 */
export async function callOllamaGenerate(
  prompt: string,
  options?: {
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
  }
): Promise<string> {
  // Read env vars per-call so process.env overrides set in tests take effect.
  const OLLAMA_BASE_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
  const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "gemma3:4b";

  const model = options?.model ?? OLLAMA_MODEL;
  const baseUrl = options?.baseUrl ?? OLLAMA_BASE_URL;
  const timeoutMs = options?.timeoutMs ?? OLLAMA_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: HTTP ${response.status}`);
    }

    const data = await response.json() as { response?: unknown };

    if (typeof data.response !== "string") {
      throw new Error("Ollama API: unexpected response shape");
    }

    return data.response.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Summarize a single memory item to ≤15 words using local Ollama.
 * Returns the original text if Ollama is unavailable or times out.
 */
export async function summarizeMemoryItem(text: string): Promise<string> {
  try {
    const summary = await callOllamaGenerate(
      `Summarize this in 15 words or less, preserving key facts. No punctuation at end. Original: ${text}`
    );
    return summary.length > 0 ? summary : text;
  } catch {
    return text;
  }
}
