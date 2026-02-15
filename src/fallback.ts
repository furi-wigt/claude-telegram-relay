/**
 * Fallback AI using Ollama for when Claude is unavailable
 *
 * Provides graceful degradation by using a local Ollama model
 * when Claude API is down or rate-limited.
 */

const OLLAMA_API_URL = process.env.OLLAMA_API_URL || "http://localhost:11434";
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "gemma3-4b";

interface OllamaResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
}

/**
 * Call Ollama API with streaming disabled for simplicity
 */
export async function callOllama(prompt: string): Promise<string> {
  try {
    console.log(`Calling Ollama (${FALLBACK_MODEL})...`);

    const response = await fetch(`${OLLAMA_API_URL}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: FALLBACK_MODEL,
        prompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as OllamaResponse;
    return data.response.trim();
  } catch (error) {
    console.error("Ollama error:", error);
    throw error;
  }
}

/**
 * Check if Ollama is available and the model is installed
 */
export async function checkOllamaAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_API_URL}/api/tags`);
    if (!response.ok) return false;

    const data = await response.json();
    const models = data.models || [];

    // Check if the fallback model is installed
    const modelInstalled = models.some((m: any) => m.name === FALLBACK_MODEL);

    if (!modelInstalled) {
      console.warn(`Fallback model ${FALLBACK_MODEL} not found in Ollama. Available models:`,
        models.map((m: any) => m.name).join(", "));
    }

    return modelInstalled;
  } catch (error) {
    console.error("Ollama availability check failed:", error);
    return false;
  }
}

/**
 * Ensure the fallback model is pulled/available
 */
export async function ensureFallbackModel(): Promise<boolean> {
  try {
    console.log(`Ensuring fallback model ${FALLBACK_MODEL} is available...`);

    const response = await fetch(`${OLLAMA_API_URL}/api/pull`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: FALLBACK_MODEL,
      }),
    });

    if (!response.ok) {
      console.error(`Failed to pull model: ${response.status}`);
      return false;
    }

    // Stream response to completion
    const reader = response.body?.getReader();
    if (!reader) return false;

    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    console.log(`Model ${FALLBACK_MODEL} is ready`);
    return true;
  } catch (error) {
    console.error("Error ensuring fallback model:", error);
    return false;
  }
}
