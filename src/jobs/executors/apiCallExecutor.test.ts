// src/jobs/executors/apiCallExecutor.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ApiCallExecutor } from "./apiCallExecutor.ts";
import type { Job } from "../types.ts";

function makeJob(payload: Record<string, unknown>): Job {
  return {
    id: "test-api-job",
    dedup_key: null,
    source: "webhook",
    type: "api-call",
    priority: "normal",
    executor: "api-call",
    title: "API Call",
    payload,
    status: "running",
    intervention_type: null,
    intervention_prompt: null,
    intervention_due_at: null,
    auto_resolve_policy: null,
    auto_resolve_timeout_ms: null,
    retry_count: 0,
    timeout_ms: 120000,
    created_at: "2026-04-12T00:00:00Z",
    started_at: "2026-04-12T00:01:00Z",
    completed_at: null,
    error: null,
    metadata: null,
  };
}

describe("ApiCallExecutor", () => {
  let executor: ApiCallExecutor;

  beforeEach(() => {
    executor = new ApiCallExecutor();
  });

  test("has correct type and maxConcurrent", () => {
    expect(executor.type).toBe("api-call");
    expect(executor.maxConcurrent).toBe(5);
  });

  test("returns failed when URL is missing from payload", async () => {
    const result = await executor.execute(makeJob({}));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("url");
  });

  test("returns failed for unreachable URL", async () => {
    const result = await executor.execute(
      makeJob({ url: "http://localhost:1/nonexistent", method: "GET", retries: 0 })
    );
    expect(result.status).toBe("failed");
  });

  test("successfully executes GET request", async () => {
    // Mock server on a free port that returns 200
    const httpServer = Bun.serve({
      port: 0,
      async fetch(req) {
        return new Response("OK", { status: 200 });
      },
    });

    const port = (httpServer.port as unknown as number) || 8765;
    const result = await executor.execute(
      makeJob({ url: `http://localhost:${port}/`, method: "GET" })
    );

    httpServer.stop();

    expect(result.status).toBe("done");
    expect(result.summary).toContain("GET");
    expect(result.summary).toContain("200");
  });

  test("handles POST request with body", async () => {
    const httpServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.text();
        return new Response(`Received: ${body}`, { status: 200 });
      },
    });

    const port = (httpServer.port as unknown as number) || 8766;
    const result = await executor.execute(
      makeJob({
        url: `http://localhost:${port}/api`,
        method: "POST",
        body: { message: "test" },
      })
    );

    httpServer.stop();

    expect(result.status).toBe("done");
    expect(result.summary).toContain("POST");
    expect(result.summary).toContain("200");
  });

  test("retries on network failure with backoff", async () => {
    let attempts = 0;
    const httpServer = Bun.serve({
      port: 0,
      async fetch(req) {
        attempts++;
        if (attempts < 2) {
          // Fail first attempt by returning 500
          return new Response("Server Error", { status: 500 });
        }
        return new Response("OK", { status: 200 });
      },
    });

    const port = (httpServer.port as unknown as number) || 8767;
    const result = await executor.execute(
      makeJob({ url: `http://localhost:${port}/`, retries: 2 })
    );

    httpServer.stop();

    expect(result.status).toBe("done");
    expect(attempts).toBe(2);
  });

  test("awaits intervention on HTTP 429 (rate limit)", async () => {
    const httpServer = Bun.serve({
      port: 0,
      async fetch(req) {
        return new Response("Too Many Requests", { status: 429 });
      },
    });

    const port = (httpServer.port as unknown as number) || 8768;
    const result = await executor.execute(
      makeJob({ url: `http://localhost:${port}/` })
    );

    httpServer.stop();

    expect(result.status).toBe("awaiting-intervention");
    expect(result.intervention).toBeDefined();
    expect(result.intervention?.type).toBe("budget");
    expect(result.intervention?.prompt).toContain("429");
  });

  test("awaits intervention on HTTP 402 (payment required)", async () => {
    const httpServer = Bun.serve({
      port: 0,
      async fetch(req) {
        return new Response("Payment Required", { status: 402 });
      },
    });

    const port = (httpServer.port as unknown as number) || 8769;
    const result = await executor.execute(
      makeJob({ url: `http://localhost:${port}/` })
    );

    httpServer.stop();

    expect(result.status).toBe("awaiting-intervention");
    expect(result.intervention?.type).toBe("budget");
  });

  test("fails on non-OK status after retries", async () => {
    const httpServer = Bun.serve({
      port: 0,
      async fetch(req) {
        return new Response("Internal Server Error", { status: 500 });
      },
    });

    const port = (httpServer.port as unknown as number) || 8770;
    const result = await executor.execute(
      makeJob({ url: `http://localhost:${port}/`, retries: 1 })
    );

    httpServer.stop();

    expect(result.status).toBe("failed");
    expect(result.error).toContain("attempts failed");
  });

  test("respects custom headers", async () => {
    let headerReceived = false;
    const httpServer = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.headers.get("X-Custom") === "my-value") {
          headerReceived = true;
        }
        return new Response("OK", { status: 200 });
      },
    });

    const port = (httpServer.port as unknown as number) || 8771;
    const result = await executor.execute(
      makeJob({
        url: `http://localhost:${port}/`,
        headers: { "X-Custom": "my-value" },
      })
    );

    httpServer.stop();

    expect(result.status).toBe("done");
    expect(headerReceived).toBe(true);
  });

  test("returns summary with response byte count", async () => {
    const httpServer = Bun.serve({
      port: 0,
      async fetch(req) {
        return new Response("Hello World!", { status: 200 });
      },
    });

    const port = (httpServer.port as unknown as number) || 8772;
    const result = await executor.execute(
      makeJob({ url: `http://localhost:${port}/` })
    );

    httpServer.stop();

    expect(result.status).toBe("done");
    expect(result.summary).toContain("bytes");
  });

  test("defaults method to GET", async () => {
    let methodReceived = "";
    const httpServer = Bun.serve({
      port: 0,
      async fetch(req) {
        methodReceived = req.method;
        return new Response("OK", { status: 200 });
      },
    });

    const port = (httpServer.port as unknown as number) || 8773;
    const result = await executor.execute(makeJob({ url: `http://localhost:${port}/` }));

    httpServer.stop();

    expect(methodReceived).toBe("GET");
    expect(result.status).toBe("done");
  });

  test("defaults retries to 2", async () => {
    let attempts = 0;
    const httpServer = Bun.serve({
      port: 0,
      async fetch(req) {
        attempts++;
        if (attempts <= 2) {
          // Fail on server side (non-OK status)
          return new Response("Server Error", { status: 500 });
        }
        return new Response("OK", { status: 200 });
      },
    });

    const port = (httpServer.port as unknown as number) || 8774;
    const result = await executor.execute(
      makeJob({ url: `http://localhost:${port}/` })
    );

    httpServer.stop();

    expect(result.status).toBe("done");
    expect(attempts).toBe(3); // 1 initial + 2 retries
  });
});
