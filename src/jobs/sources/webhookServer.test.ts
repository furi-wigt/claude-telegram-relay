// src/jobs/sources/webhookServer.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initJobSchema } from "../jobSchema.ts";
import { JobStore } from "../jobStore.ts";
import { createSubmitJob } from "../submitJob.ts";
import { createWebhookServer, type WebhookACL } from "./webhookServer.ts";

describe("webhookServer", () => {
  let db: Database;
  let store: JobStore;
  let server: ReturnType<typeof Bun.serve>;
  let port: number;

  beforeEach(async () => {
    db = new Database(":memory:");
    initJobSchema(db);
    store = new JobStore(db);
    const submitJob = createSubmitJob(store, () => {});

    // Find a free port
    port = 19000 + Math.floor(Math.random() * 1000);
    server = createWebhookServer(submitJob, {
      port,
      secret: "test-secret",
    });
  });

  afterEach(() => {
    server.stop(true);
    db.close();
  });

  test("rejects request without auth header", async () => {
    const res = await fetch(`http://localhost:${port}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "routine", executor: "test", title: "Test" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects request with wrong secret", async () => {
    const res = await fetch(`http://localhost:${port}/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-secret",
      },
      body: JSON.stringify({ type: "routine", executor: "test", title: "Test" }),
    });
    expect(res.status).toBe(401);
  });

  test("accepts valid job submission", async () => {
    const res = await fetch(`http://localhost:${port}/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret",
      },
      body: JSON.stringify({ type: "routine", executor: "test", title: "Test Job" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.title).toBe("Test Job");
  });

  test("rejects invalid payload (missing required fields)", async () => {
    const res = await fetch(`http://localhost:${port}/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret",
      },
      body: JSON.stringify({ type: "routine" }), // missing executor and title
    });
    expect(res.status).toBe(400);
  });

  test("GET /health returns ok", async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
