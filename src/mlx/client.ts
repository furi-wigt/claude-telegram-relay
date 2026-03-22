/**
 * MLX local LLM client — HTTP client for the `mlx serve` server.
 *
 * Calls the unified MLX server (text generation + embeddings) via
 * OpenAI-compatible /v1/chat/completions endpoint on localhost:8800.
 *
 * Install: `uv tool install --editable tools/mlx-local --python python3.12`
 * Serve:   `mlx serve` (or via PM2)
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_MLX_MODEL = "mlx-community/Qwen3.5-9B-MLX-4bit";

export function getMlxBaseUrl(): string {
  return process.env.MLX_URL ?? "http://localhost:8800";
}

export function getMlxModel(): string {
  return process.env.MLX_MODEL ?? DEFAULT_MLX_MODEL;
}

/** Check if the MLX server is reachable. */
export async function isMlxAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${getMlxBaseUrl()}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Generate text using MLX server (Apple Silicon native inference).
 *
 * Calls /v1/chat/completions on the unified MLX server.
 * Model weights stay warm in the server process.
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
      throw new Error(`MLX API error: HTTP ${response.status} — ${body}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("MLX returned empty response");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}
