/**
 * Unit tests for embed.ts — retry-once logic and timeout handling.
 *
 * Uses a local HTTP server to simulate MLX /v1/embeddings responses.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { localEmbed, localEmbedBatch } from "./embed";

// ── Test server to simulate MLX embed server ────────────────────────────────

let server: ReturnType<typeof Bun.serve>;
let callCount = 0;
let delayMs = 0;
let failFirst = false;

function resetServer() {
  callCount = 0;
  delayMs = 0;
  failFirst = false;
}

beforeAll(() => {
  server = Bun.serve({
    port: 0, // random available port
    async fetch(req) {
      callCount++;
      const url = new URL(req.url);

      if (url.pathname === "/v1/embeddings") {
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }

        if (failFirst && callCount === 1) {
          return new Response("Server busy", { status: 503 });
        }

        const body = (await req.json()) as { input: string | string[]; model?: string };
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        const data = inputs.map((_, i) => ({
          object: "embedding" as const,
          index: i,
          embedding: Array.from({ length: 1024 }, () => Math.random()),
        }));
        return Response.json({ object: "list", data, model: body.model ?? "bge-m3" });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  // Point embed module at our test server
  process.env.EMBED_URL = `http://localhost:${server.port}`;
  // Use short timeouts for faster tests
  process.env.EMBED_TIMEOUT_MS = "500";
});

afterAll(() => {
  server.stop(true);
  delete process.env.EMBED_URL;
  delete process.env.EMBED_TIMEOUT_MS;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("localEmbed", () => {
  it("returns 1024-dim vector on success", async () => {
    resetServer();
    const vec = await localEmbed("hello world");
    expect(vec).toHaveLength(1024);
    expect(callCount).toBe(1);
  });

  it("retries once on AbortError (timeout)", async () => {
    resetServer();
    // First call will timeout (delay > EMBED_TIMEOUT_MS), retry should succeed
    // We need the first call to actually timeout, so set delay > 500ms
    delayMs = 800; // > 500ms timeout

    // The retry has 2x timeout (1000ms), so 800ms delay should succeed
    const vec = await localEmbed("retry test");
    expect(vec).toHaveLength(1024);
    // First attempt aborted, second succeeded
    expect(callCount).toBe(2);
  });

  it("throws after retry also times out", async () => {
    resetServer();
    delayMs = 2000; // exceeds both 500ms and 1000ms timeouts

    await expect(localEmbed("double timeout")).rejects.toThrow();
  });

  it("throws on HTTP error without retry", async () => {
    resetServer();
    failFirst = true;

    await expect(localEmbed("server error")).rejects.toThrow(/503/);
    expect(callCount).toBe(1); // no retry on HTTP error
  });
});

describe("localEmbedBatch", () => {
  it("returns vectors for all inputs", async () => {
    resetServer();
    const vecs = await localEmbedBatch(["a", "b", "c"]);
    expect(vecs).toHaveLength(3);
    expect(vecs[0]).toHaveLength(1024);
    expect(callCount).toBe(1);
  });

  it("returns empty array for empty input", async () => {
    resetServer();
    const vecs = await localEmbedBatch([]);
    expect(vecs).toHaveLength(0);
    expect(callCount).toBe(0);
  });

  it("retries once on batch timeout", async () => {
    resetServer();
    delayMs = 1200; // > batch timeout (500*2=1000ms), but < retry (1000*2=2000ms)

    const vecs = await localEmbedBatch(["x", "y"]);
    expect(vecs).toHaveLength(2);
    expect(callCount).toBe(2);
  });
});
