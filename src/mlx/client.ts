/**
 * Local LLM client — HTTP client for Osaurus (or any OpenAI-compatible server).
 *
 * Calls /v1/chat/completions on Osaurus (default localhost:1337).
 * Model: Qwen3.5 4B via Osaurus on Apple Silicon.
 *
 * Install: `brew install --cask osaurus`
 * Serve:   `osaurus serve` (or launch Osaurus.app)
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_LOCAL_MODEL = "mlx-community/Qwen3.5-4B-MLX-4bit";

export function getMlxBaseUrl(): string {
  return process.env.LOCAL_LLM_URL ?? "http://localhost:1337";
}

export function getMlxModel(): string {
  return process.env.LOCAL_LLM_MODEL ?? DEFAULT_LOCAL_MODEL;
}

/** Check if the local LLM server (Osaurus) is reachable. */
export async function isMlxAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${getMlxBaseUrl()}/v1/models`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Generate text using local LLM server (Osaurus on Apple Silicon).
 *
 * Calls /v1/chat/completions — OpenAI-compatible endpoint.
 *
 * @throws Error on timeout, HTTP error, or empty response
 */
export async function callMlxGenerate(
  prompt: string,
  options?: {
    maxTokens?: number;
    timeoutMs?: number;
  }
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const baseUrl = getMlxBaseUrl();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: getMlxModel(),
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Local LLM API error: HTTP ${response.status} — ${body}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) {
      throw new Error("Local LLM returned empty response");
    }
    // Qwen3.5 always emits a thinking block ("Thinking Process:...\n</think>\n\nActual answer")
    // even when enable_thinking:false is set. Strip it to get only the actual content.
    const thinkEnd = raw.indexOf("</think>");
    const content = thinkEnd >= 0 ? raw.substring(thinkEnd + "</think>".length).trim() : raw;
    if (!content) {
      throw new Error("Local LLM response was empty after stripping think block");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}
