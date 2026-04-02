/**
 * Tests for callMlxGenerate — streaming SSE mode with per-chunk timeout.
 *
 * Strategy: mock global.fetch to return controlled ReadableStream responses.
 * Each test constructs SSE byte sequences that exercise a specific path.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build an SSE data line from a delta content string. */
function sseChunk(content: string, finishReason: string | null = null): string {
  return (
    `data: ${JSON.stringify({
      id: "test-id",
      object: "chat.completion.chunk",
      model: "test-model",
      choices: [
        {
          index: 0,
          finish_reason: finishReason,
          delta: { role: "assistant", content, reasoning: "", tool_calls: [] },
        },
      ],
    })}\n\n`
  );
}

const SSE_DONE = "data: [DONE]\n\n";
const SSE_KEEPALIVE = ": keepalive 9/14\n\n";

/** Create a ReadableStream that yields chunks with optional delays. */
function makeStream(chunks: Array<{ data: string; delayMs?: number }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (chunk.delayMs) await new Promise((r) => setTimeout(r, chunk.delayMs));
        controller.enqueue(encoder.encode(chunk.data));
      }
      controller.close();
    },
  });
}

/** Create a mock Response with a streaming body. */
function mockResponse(stream: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// ── Test suite ───────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

describe("callMlxGenerate (streaming)", () => {
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    // Set required env vars for MLX client
    process.env.MLX_URL = "http://localhost:9999";
    process.env.MLX_MODEL = "test-model";
    fetchMock = mock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.MLX_URL;
    delete process.env.MLX_MODEL;
  });

  // Lazy import to pick up env overrides
  async function getCallMlxGenerate() {
    // Clear module cache to get fresh env reads
    const mod = await import("./client.ts");
    return mod.callMlxGenerate;
  }

  it("concatenates streamed SSE chunks into final content", async () => {
    const stream = makeStream([
      { data: SSE_KEEPALIVE },
      { data: sseChunk("Hello") },
      { data: sseChunk(" world") },
      { data: sseChunk("!", "stop") },
      { data: SSE_DONE },
    ]);
    fetchMock.mockResolvedValueOnce(mockResponse(stream));

    const callMlxGenerate = await getCallMlxGenerate();
    const result = await callMlxGenerate("test prompt", { timeoutMs: 5000 });

    expect(result).toBe("Hello world!");
  });

  it("strips Qwen thinking block from streamed content", async () => {
    const stream = makeStream([
      { data: sseChunk("Thinking about this...\n") },
      { data: sseChunk("</think>\n\n") },
      { data: sseChunk("The actual answer.") },
      { data: sseChunk("", "stop") },
      { data: SSE_DONE },
    ]);
    fetchMock.mockResolvedValueOnce(mockResponse(stream));

    const callMlxGenerate = await getCallMlxGenerate();
    const result = await callMlxGenerate("test prompt", { timeoutMs: 5000 });

    expect(result).toBe("The actual answer.");
  });

  it("throws on chunk inactivity timeout", async () => {
    // First chunk arrives, then silence — should trigger chunk timeout
    const stream = makeStream([
      { data: sseChunk("start") },
      { data: sseChunk(""), delayMs: 2000 }, // long delay exceeds chunkTimeoutMs
    ]);
    fetchMock.mockResolvedValueOnce(mockResponse(stream));

    const callMlxGenerate = await getCallMlxGenerate();
    await expect(
      callMlxGenerate("test prompt", { timeoutMs: 10_000, chunkTimeoutMs: 500 })
    ).rejects.toThrow(/chunk timeout|aborted/i);
  });

  it("throws immediately on HTTP error", async () => {
    const errorResponse = new Response("Internal Server Error", { status: 500 });
    fetchMock.mockResolvedValueOnce(errorResponse);

    const callMlxGenerate = await getCallMlxGenerate();
    await expect(
      callMlxGenerate("test prompt", { timeoutMs: 5000 })
    ).rejects.toThrow(/HTTP 500/);
  });

  it("throws on empty content after stripping think block", async () => {
    const stream = makeStream([
      { data: sseChunk("Just thinking...\n</think>") },
      { data: sseChunk("", "stop") },
      { data: SSE_DONE },
    ]);
    fetchMock.mockResolvedValueOnce(mockResponse(stream));

    const callMlxGenerate = await getCallMlxGenerate();
    await expect(
      callMlxGenerate("test prompt", { timeoutMs: 5000 })
    ).rejects.toThrow(/empty/i);
  });

  it("handles SSE chunks split across read boundaries", async () => {
    // A single SSE event split across two reads
    const encoder = new TextEncoder();
    const fullChunk = sseChunk("split content");
    const midpoint = Math.floor(fullChunk.length / 2);
    const part1 = fullChunk.slice(0, midpoint);
    const part2 = fullChunk.slice(midpoint);

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(part1));
        controller.enqueue(encoder.encode(part2));
        controller.enqueue(encoder.encode(sseChunk("", "stop")));
        controller.enqueue(encoder.encode(SSE_DONE));
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce(mockResponse(stream));

    const callMlxGenerate = await getCallMlxGenerate();
    const result = await callMlxGenerate("test prompt", { timeoutMs: 5000 });

    expect(result).toBe("split content");
  });

  it("terminates on [DONE] sentinel", async () => {
    const stream = makeStream([
      { data: sseChunk("done test") },
      { data: SSE_DONE },
      // Extra data after [DONE] should be ignored
      { data: sseChunk("should not appear") },
    ]);
    fetchMock.mockResolvedValueOnce(mockResponse(stream));

    const callMlxGenerate = await getCallMlxGenerate();
    const result = await callMlxGenerate("test prompt", { timeoutMs: 5000 });

    expect(result).toBe("done test");
  });

  it("respects overall timeout via AbortController", async () => {
    // Stream that never finishes — overall timeout should kill it
    const neverEndingStream = new ReadableStream({
      start() {
        // Never enqueue, never close — simulates hung server
      },
    });
    fetchMock.mockResolvedValueOnce(mockResponse(neverEndingStream));

    const callMlxGenerate = await getCallMlxGenerate();
    await expect(
      callMlxGenerate("test prompt", { timeoutMs: 500, chunkTimeoutMs: 200 })
    ).rejects.toThrow(/timeout|aborted/i);
  });

  it("sends stream: true in the request body", async () => {
    const stream = makeStream([
      { data: sseChunk("ok") },
      { data: sseChunk("", "stop") },
      { data: SSE_DONE },
    ]);
    fetchMock.mockResolvedValueOnce(mockResponse(stream));

    const callMlxGenerate = await getCallMlxGenerate();
    await callMlxGenerate("test prompt", { timeoutMs: 5000 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestInit.body);
    expect(body.stream).toBe(true);
  });

  it("handles keepalive comments without error", async () => {
    const stream = makeStream([
      { data: ": keepalive 1/10\n\n" },
      { data: ": keepalive 5/10\n\n" },
      { data: ": keepalive 9/10\n\n" },
      { data: sseChunk("after keepalives") },
      { data: sseChunk("", "stop") },
      { data: SSE_DONE },
    ]);
    fetchMock.mockResolvedValueOnce(mockResponse(stream));

    const callMlxGenerate = await getCallMlxGenerate();
    const result = await callMlxGenerate("test prompt", { timeoutMs: 5000 });

    expect(result).toBe("after keepalives");
  });

  it("resets chunk timeout on keepalive comments", async () => {
    // Keepalives arrive within chunk timeout, actual data comes later
    const stream = makeStream([
      { data: ": keepalive 1/5\n\n", delayMs: 100 },
      { data: ": keepalive 2/5\n\n", delayMs: 100 },
      { data: ": keepalive 3/5\n\n", delayMs: 100 },
      { data: sseChunk("delayed content") },
      { data: sseChunk("", "stop") },
      { data: SSE_DONE },
    ]);
    fetchMock.mockResolvedValueOnce(mockResponse(stream));

    const callMlxGenerate = await getCallMlxGenerate();
    // chunkTimeoutMs=300 but keepalives every 100ms keep it alive
    const result = await callMlxGenerate("test prompt", {
      timeoutMs: 5000,
      chunkTimeoutMs: 300,
    });

    expect(result).toBe("delayed content");
  });
});
