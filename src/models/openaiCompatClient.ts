// src/models/openaiCompatClient.ts
// Stateless OpenAI-compatible HTTP client.
// Ports streaming logic from src/mlx/client.ts — see that file for comments on
// why we use stream:true + per-chunk timeout instead of non-streaming.

import type { ChatMessage, ChatOptions } from "./types.ts";

/** Parse SSE lines from buffer, return extracted lines and leftover. */
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

/** Strip Qwen thinking block if present (model emits it even with enable_thinking:false). */
function stripThinkBlock(raw: string): string {
  const trimmed = raw.trim();
  const thinkEnd = trimmed.indexOf("</think>");
  return thinkEnd >= 0 ? trimmed.substring(thinkEnd + "</think>".length).trim() : trimmed;
}

/**
 * Stream chat completion from OpenAI-compat endpoint.
 * Yields text chunks as they arrive. Caller is responsible for buffering if needed.
 * Throws on HTTP error, overall timeout, or per-chunk inactivity timeout.
 */
export async function* chatStream(
  url: string,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions = {}
): AsyncGenerator<string> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxTokens = opts.maxTokens ?? 4096;
  const chunkTimeoutMs = opts.chunkTimeoutMs ?? 30_000;

  const controller = new AbortController();
  const overallTimer = setTimeout(() => controller.abort(), timeoutMs);
  let chunkTimer: ReturnType<typeof setTimeout> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0, stream: true }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${body}`);
    }
    if (!response.body) throw new Error("No response body");

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let accumulated = "";

    while (true) {
      const readResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          chunkTimer = setTimeout(
            () => reject(new Error(`chunk timeout: no data for ${chunkTimeoutMs}ms`)),
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
        if (line.startsWith(":")) continue;
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") {
          reader.cancel().catch(() => {});
          const final = stripThinkBlock(accumulated);
          if (!final) throw new Error("Empty response after stripping think block");
          yield final;
          return;
        }
        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
          };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) accumulated += delta;
        } catch { /* malformed JSON chunk — skip */ }
      }
    }

    const final = stripThinkBlock(accumulated);
    if (!final) throw new Error("Empty response");
    yield final;
  } finally {
    clearTimeout(overallTimer);
    if (chunkTimer) clearTimeout(chunkTimer);
    if (reader) { try { reader.releaseLock(); } catch { /* already released */ } }
  }
}

/**
 * Embed texts via OpenAI-compat /v1/embeddings endpoint.
 * Returns one float32 vector per input text.
 */
export async function embed(
  url: string,
  model: string,
  texts: string[],
  timeoutMs = 15_000
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${url}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embed HTTP ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
  if (!data.data || data.data.length !== texts.length) {
    throw new Error(`Expected ${texts.length} embeddings, got ${data.data?.length ?? 0}`);
  }
  return data.data.map(d => d.embedding);
}

/**
 * Health check via GET /health or GET /v1/models — races both, returns true if either succeeds.
 */
export async function health(url: string): Promise<boolean> {
  const tryEndpoint = async (path: string): Promise<boolean> => {
    const r = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(3_000) });
    if (!r.ok) throw new Error(`${r.status}`);
    return true;
  };
  try {
    return await Promise.any([tryEndpoint("/health"), tryEndpoint("/v1/models")]);
  } catch {
    return false;
  }
}
