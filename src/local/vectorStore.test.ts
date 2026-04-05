/**
 * Unit tests for vectorStore.ts
 *
 * Regression: BLACKBOARD_BLACKBOARD_VECTOR_DIM was the declared constant name
 * but BLACKBOARD_VECTOR_DIM was referenced — causing a ReferenceError crash loop
 * (13 PM2 restarts on 2026-04-05) whenever the blackboard collection did not exist.
 *
 * The fix replaces the single ambiguous constant with a per-collection dimension map
 * (COLLECTION_DIMENSIONS) so any future CollectionName addition must declare its size.
 *
 * Qdrant is mocked via a local Bun HTTP server. `process.env.QDRANT_URL` is set
 * BEFORE the module is dynamically imported so that the module-level `QDRANT_URL`
 * constant captures the mock address.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { CollectionName } from "./vectorStore.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

type QdrantCall = { method: string; path: string; body?: unknown };

// ── State shared between mock server and tests ────────────────────────────────

let calls: QdrantCall[] = [];
let collectionExists = true;

// ── Module under test (loaded after env var is set) ───────────────────────────

let ensureCollection: (name: CollectionName) => Promise<void>;

// ── Mock Qdrant HTTP server ────────────────────────────────────────────────────

let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  server = Bun.serve({
    port: 0, // random available port
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.headers.get("content-type")?.includes("json")
        ? await req.json()
        : undefined;
      calls.push({ method: req.method, path: url.pathname, body });

      // GET /collections/:name
      if (req.method === "GET" && url.pathname.startsWith("/collections/")) {
        if (collectionExists) {
          return Response.json({ result: { status: "green" }, status: "ok" });
        }
        return Response.json({ status: "error", error: "Not found" }, { status: 404 });
      }

      // PUT /collections/:name — createCollection
      if (req.method === "PUT" && url.pathname.startsWith("/collections/")) {
        return Response.json({ result: true, status: "ok" });
      }

      // PUT /collections/:name/index — payload index
      if (req.method === "PUT" && url.pathname.includes("/index")) {
        return Response.json({ result: true, status: "ok" });
      }

      return Response.json({ status: "error", error: "Unmatched" }, { status: 404 });
    },
  });

  // Set BEFORE import — vectorStore.ts captures QDRANT_URL at module init time
  process.env.QDRANT_URL = `http://localhost:${server.port}`;

  // Dynamic import ensures the module reads the env var above
  const mod = await import("./vectorStore.ts");
  ensureCollection = mod.ensureCollection;
});

afterAll(() => {
  server.stop(true);
  delete process.env.QDRANT_URL;
});

beforeEach(() => {
  calls = [];
  collectionExists = true;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ensureCollection", () => {
  it("skips createCollection when collection already exists", async () => {
    collectionExists = true;
    await ensureCollection("blackboard");

    const createCalls = calls.filter(
      c => c.method === "PUT" && !c.path.includes("/index")
    );
    expect(createCalls).toHaveLength(0);
  });

  it("REGRESSION: does not throw ReferenceError when blackboard collection is missing", async () => {
    // Pre-fix: entering the catch branch evaluated `BLACKBOARD_VECTOR_DIM` → undefined → ReferenceError
    // Post-fix: `COLLECTION_DIMENSIONS["blackboard"]` → 1024 (always defined for valid CollectionName)
    collectionExists = false;
    await expect(ensureCollection("blackboard")).resolves.toBeUndefined();
  });

  it("creates blackboard collection with 1024 dimensions and Cosine distance", async () => {
    collectionExists = false;
    await ensureCollection("blackboard");

    const createCall = calls.find(
      c => c.method === "PUT" && c.path === "/collections/blackboard"
    );
    expect(createCall).toBeDefined();
    expect((createCall!.body as any)?.vectors?.size).toBe(1024);
    expect((createCall!.body as any)?.vectors?.distance).toBe("Cosine");
  });

  it.each(["memory", "messages", "documents", "summaries"] as const)(
    "creates %s with 1024 dimensions when missing",
    async (name) => {
      collectionExists = false;
      await ensureCollection(name);

      const createCall = calls.find(
        c => c.method === "PUT" && c.path === `/collections/${name}`
      );
      expect(createCall).toBeDefined();
      expect((createCall!.body as any)?.vectors?.size).toBe(1024);
    }
  );
});
