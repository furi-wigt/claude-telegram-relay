/**
 * Tests for OpenAICompatClient — SSE chat streaming, embed, health.
 *
 * Strategy: mock global.fetch to return controlled responses.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// ── Helpers ──────────────────────────────────────────────────────────────

function sseChunk(content: string, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "test-id",
    object: "chat.completion.chunk",
    model: "test-model",
    choices: [{
      index: 0,
      finish_reason: finishReason,
      delta: { role: "assistant", content },
    }],
  })}\n\n`;
}

const SSE_DONE = "data: [DONE]\n\n";

function makeStream(chunks: Array<{ data: string; delayMs?: number }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (chunk.delayMs) await new Promise(r => setTimeout(r, chunk.delayMs));
        controller.enqueue(encoder.encode(chunk.data));
      }
      controller.close();
    },
  });
}

function mockResponse(stream: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(stream, { status, headers: { "Content-Type": "text/event-stream" } });
}

// ── Tests ────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

describe("openaiCompatClient", () => {
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function getClient() {
    return await import("../../src/models/openaiCompatClient.ts");
  }

  // ── chatStream ───────────────────────────────────────────────────────

  describe("chatStream", () => {
    it("concatenates SSE chunks into final content", async () => {
      const stream = makeStream([
        { data: sseChunk("Hello") },
        { data: sseChunk(" world!") },
        { data: sseChunk("", "stop") },
        { data: SSE_DONE },
      ]);
      fetchMock.mockResolvedValueOnce(mockResponse(stream));

      const client = await getClient();
      let result = "";
      for await (const chunk of client.chatStream("http://test:1234", "m", [{ role: "user", content: "hi" }], { timeoutMs: 5000 })) {
        result += chunk;
      }
      expect(result).toBe("Hello world!");
    });

    it("strips Qwen thinking block", async () => {
      const stream = makeStream([
        { data: sseChunk("Thinking...\n</think>\nThe answer.") },
        { data: sseChunk("", "stop") },
        { data: SSE_DONE },
      ]);
      fetchMock.mockResolvedValueOnce(mockResponse(stream));

      const client = await getClient();
      let result = "";
      for await (const chunk of client.chatStream("http://test:1234", "m", [{ role: "user", content: "q" }], { timeoutMs: 5000 })) {
        result += chunk;
      }
      expect(result).toBe("The answer.");
    });

    it("throws on HTTP error", async () => {
      fetchMock.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));

      const client = await getClient();
      const gen = client.chatStream("http://test:1234", "m", [{ role: "user", content: "hi" }], { timeoutMs: 5000 });
      await expect(gen.next()).rejects.toThrow(/HTTP 500/);
    });

    it("throws on chunk inactivity timeout", async () => {
      const stream = makeStream([
        { data: sseChunk("start") },
        { data: sseChunk(""), delayMs: 2000 },
      ]);
      fetchMock.mockResolvedValueOnce(mockResponse(stream));

      const client = await getClient();
      const gen = client.chatStream("http://test:1234", "m", [{ role: "user", content: "hi" }], { timeoutMs: 10_000, chunkTimeoutMs: 500 });
      await expect(gen.next()).rejects.toThrow(/chunk timeout|aborted/i);
    });

    it("handles [DONE] sentinel", async () => {
      const stream = makeStream([
        { data: sseChunk("done test") },
        { data: SSE_DONE },
        { data: sseChunk("should not appear") },
      ]);
      fetchMock.mockResolvedValueOnce(mockResponse(stream));

      const client = await getClient();
      let result = "";
      for await (const chunk of client.chatStream("http://test:1234", "m", [{ role: "user", content: "hi" }], { timeoutMs: 5000 })) {
        result += chunk;
      }
      expect(result).toBe("done test");
    });

    it("sends stream:true in request body", async () => {
      const stream = makeStream([
        { data: sseChunk("ok") },
        { data: sseChunk("", "stop") },
        { data: SSE_DONE },
      ]);
      fetchMock.mockResolvedValueOnce(mockResponse(stream));

      const client = await getClient();
      for await (const _ of client.chatStream("http://test:1234", "m", [{ role: "user", content: "hi" }], { timeoutMs: 5000 })) {}

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.stream).toBe(true);
    });
  });

  // ── embed ────────────────────────────────────────────────────────────

  describe("embed", () => {
    it("returns embedding vectors", async () => {
      const mockData = { data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] };
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(mockData), { status: 200 }));

      const client = await getClient();
      const result = await client.embed("http://test:8801", "bge-m3", ["a", "b"]);
      expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    });

    it("returns empty array for empty input", async () => {
      const client = await getClient();
      const result = await client.embed("http://test:8801", "bge-m3", []);
      expect(result).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("throws on HTTP error", async () => {
      fetchMock.mockResolvedValueOnce(new Response("Bad Request", { status: 400 }));

      const client = await getClient();
      await expect(client.embed("http://test:8801", "m", ["a"])).rejects.toThrow(/Embed HTTP 400/);
    });

    it("throws on dimension mismatch", async () => {
      const mockData = { data: [{ embedding: [0.1] }] };
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(mockData), { status: 200 }));

      const client = await getClient();
      await expect(client.embed("http://test:8801", "m", ["a", "b"])).rejects.toThrow(/Expected 2.*got 1/);
    });
  });

  // ── health ───────────────────────────────────────────────────────────

  describe("health", () => {
    it("returns true on /health 200", async () => {
      fetchMock.mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));

      const client = await getClient();
      expect(await client.health("http://test:1234")).toBe(true);
    });

    it("falls back to /v1/models on /health failure", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      fetchMock.mockResolvedValueOnce(new Response('[]', { status: 200 }));

      const client = await getClient();
      expect(await client.health("http://test:1234")).toBe(true);
    });

    it("returns false if both endpoints fail", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const client = await getClient();
      expect(await client.health("http://test:1234")).toBe(false);
    });
  });
});
