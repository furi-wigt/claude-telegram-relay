/**
 * Consolidated Ollama HTTP client.
 *
 * Merges the former src/ollama.ts and src/fallback.ts into a single module.
 * All env reads happen per-call (not at module level) for testability.
 */

import { getModel, type OllamaPurpose } from "./models.ts";

const OLLAMA_TIMEOUT_MS = 10_000;

export function getBaseUrl(): string {
  return process.env.OLLAMA_URL ?? process.env.OLLAMA_API_URL ?? "http://localhost:11434";
}

/**
 * Send a prompt to Ollama's /api/generate endpoint.
 *
 * Model resolution:
 *   - options.model (explicit override) > purpose-based lookup > global default
 */
export async function callOllamaGenerate(
  prompt: string,
  options?: {
    model?: string;
    purpose?: OllamaPurpose;
    baseUrl?: string;
    timeoutMs?: number;
  }
): Promise<string> {
  const model =
    options?.model ??
    (options?.purpose ? getModel(options.purpose) : getModel("chat-fallback"));
  const baseUrl = options?.baseUrl ?? getBaseUrl();
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

    const data = (await response.json()) as { response?: unknown };

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
      `Summarize this in 15 words or less, preserving key facts. No punctuation at end. Original: ${text}`,
      { purpose: "memory-summary" }
    );
    return summary.length > 0 ? summary : text;
  } catch {
    return text;
  }
}

// ── Availability & Model Management ─────────────────────────────────────────

/**
 * Check if Ollama is available and the given model is installed.
 * Defaults to the chat-fallback model.
 */
export async function checkOllamaAvailable(
  modelOverride?: string
): Promise<boolean> {
  const model = modelOverride ?? getModel("chat-fallback");
  try {
    const response = await fetch(`${getBaseUrl()}/api/tags`);
    if (!response.ok) return false;

    const data = (await response.json()) as {
      models?: Array<{ name: string }>;
    };
    const models = data.models ?? [];

    const modelInstalled = models.some((m) => m.name === model);

    if (!modelInstalled) {
      console.warn(
        `Ollama model ${model} not found. Available:`,
        models.map((m) => m.name).join(", ")
      );
    }

    return modelInstalled;
  } catch (error) {
    console.error("Ollama availability check failed:", error);
    return false;
  }
}

/**
 * Pull a model if not already available.
 * Defaults to the chat-fallback model.
 */
export async function ensureModel(modelOverride?: string): Promise<boolean> {
  const model = modelOverride ?? getModel("chat-fallback");
  try {
    console.log(`Ensuring Ollama model ${model} is available...`);

    const response = await fetch(`${getBaseUrl()}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
    });

    if (!response.ok) {
      console.error(`Failed to pull model: ${response.status}`);
      return false;
    }

    // Stream response to completion
    const reader = response.body?.getReader();
    if (!reader) return false;

    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      reader.cancel();
    }

    console.log(`Model ${model} is ready`);
    return true;
  } catch (error) {
    console.error("Error ensuring model:", error);
    return false;
  }
}
