/**
 * Local LLM client — HTTP client for mlx serve (OpenAI-compatible).
 *
 * Calls /v1/chat/completions on the mlx PM2 service (default localhost:8800).
 * Model: Qwen3.5 9B (mlx-community/Qwen3.5-9B-MLX-4bit) on Apple Silicon.
 *
 * Uses streaming mode (stream: true) with per-chunk inactivity timeout.
 * This ensures the AbortController actually terminates the connection —
 * non-streaming HTTP/1.0 responses leave the TCP connection idle and
 * bun's fetch ignores abort() until the server finishes generating.
 *
 * The `mlx` PM2 service runs `mlx serve -m mlx-community/Qwen3.5-9B-MLX-4bit`.
 * Override with MLX_URL env var if running on a different port.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_CHUNK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCAL_MODEL = "mlx-community/Qwen3.5-9B-MLX-4bit";

export function getMlxBaseUrl(): string {
  return process.env.MLX_URL ?? "http://localhost:8800";
}

export function getMlxModel(): string {
  return process.env.MLX_MODEL ?? DEFAULT_LOCAL_MODEL;
}

/** Check if the local MLX server is reachable. */
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
 * Parse SSE lines from a buffer, returning extracted lines and any leftover.
 * Handles partial lines split across read boundaries.
 */
function parseSSELines(buffer: string): { lines: string[]; remainder: string } {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === "\n") {
      const line = buffer.slice(start, i);
      if (line.length > 0) lines.push(line);
      start = i + 1;
    }
  }
  return { lines, remainder: buffer.slice(start) };
}

/**
 * Generate text using local MLX server (Apple Silicon) via streaming SSE.
 *
 * Calls /v1/chat/completions with stream: true. Reads SSE chunks incrementally
 * and enforces a per-chunk inactivity timeout — if no data arrives within
 * chunkTimeoutMs, the connection is aborted. This prevents the 60+ minute
 * hangs caused by non-streaming HTTP/1.0 responses.
 *
 * @throws Error on timeout, HTTP error, or empty response
 */
export async function callMlxGenerate(
  prompt: string,
  options?: {
    maxTokens?: number;
    timeoutMs?: number;
    /** Per-chunk inactivity timeout. Aborts if no data for this long. Default 30s. */
    chunkTimeoutMs?: number;
  }
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const chunkTimeoutMs = options?.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;
  const baseUrl = getMlxBaseUrl();

  const controller = new AbortController();
  const overallTimer = setTimeout(() => controller.abort(), timeoutMs);

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let chunkTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: getMlxModel(),
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Local LLM API error: HTTP ${response.status} — ${body}`);
    }

    if (!response.body) {
      throw new Error("Local LLM returned no response body");
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    let sseBuffer = "";

    while (true) {
      // Race reader.read() against a per-chunk inactivity timeout.
      // This works regardless of underlying transport (real HTTP or mock).
      const readResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          chunkTimer = setTimeout(
            () => reject(new Error(`MLX chunk timeout: no data for ${chunkTimeoutMs}ms`)),
            chunkTimeoutMs
          );
        }),
      ]);
      if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null; }

      const { done, value } = readResult;
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const { lines, remainder } = parseSSELines(sseBuffer);
      sseBuffer = remainder;

      for (const line of lines) {
        // SSE comments (keepalives) — skip but they already reset the timer
        if (line.startsWith(":")) continue;

        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6); // strip "data: "

        // [DONE] sentinel — stream complete
        if (payload === "[DONE]") {
          reader.cancel().catch(() => {});
          return finalizeContent(accumulated);
        }

        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{
              delta?: { content?: string };
              finish_reason?: string | null;
            }>;
          };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) accumulated += delta;
        } catch {
          // Malformed JSON chunk — skip, continue reading
        }
      }
    }

    return finalizeContent(accumulated);
  } finally {
    clearTimeout(overallTimer);
    if (chunkTimer) clearTimeout(chunkTimer);
    if (reader) {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }
}

/**
 * Strip Qwen thinking block and validate non-empty content.
 * Qwen3.5 emits a thinking block even with enable_thinking:false.
 */
function finalizeContent(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Local LLM returned empty response");
  }
  const thinkEnd = trimmed.indexOf("</think>");
  const content = thinkEnd >= 0
    ? trimmed.substring(thinkEnd + "</think>".length).trim()
    : trimmed;
  if (!content) {
    throw new Error("Local LLM response was empty after stripping think block");
  }
  return content;
}
