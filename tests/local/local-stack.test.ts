/**
 * Integration tests for local storage stack: Ollama bge-m3 + Qdrant + SQLite.
 *
 * Prerequisites (must be running):
 * - Ollama with bge-m3 (`ollama serve`, `ollama pull bge-m3`)
 * - Qdrant on localhost:6333
 */
import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";

// Ollama first-call loads model — can take 30s+
setDefaultTimeout(30_000);
import { localEmbed, localEmbedBatch, checkEmbedHealth } from "../../src/local/embed";
import {
  initCollections,
  upsert,
  search,
  deletePoints,
  checkQdrantHealth,
} from "../../src/local/vectorStore";
import {
  getDb,
  closeDb,
  insertMemory,
  getMemoryById,
  getActiveMemories,
  updateMemoryStatus,
  insertMessage,
  insertDocument,
  insertSummary,
  getSummaries,
} from "../../src/local/db";
import { searchMemory, searchDocuments } from "../../src/local/searchService";
import { unlinkSync } from "fs";

// Use a test-specific SQLite DB
const TEST_DB_PATH = import.meta.dir + "/test-local.sqlite";
process.env.LOCAL_DB_PATH = TEST_DB_PATH;

// Check service availability before running tests that require them
let ollamaAvailable = false;
let qdrantAvailable = false;

try {
  const embedUrl = process.env.EMBED_URL ?? "http://localhost:11434";
  const res = await fetch(`${embedUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "bge-m3", input: "test" }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.ok) {
    const data = await res.json() as { embeddings?: number[][] };
    ollamaAvailable = (data.embeddings?.[0]?.length ?? 0) > 0;
  }
} catch {}

try {
  const { QdrantClient } = await import("@qdrant/js-client-rest");
  const client = new QdrantClient({ url: "http://localhost:6333", checkCompatibility: false });
  const result = await client.getCollections();
  qdrantAvailable = Array.isArray(result.collections);
} catch {}

const describeOllama = ollamaAvailable ? describe : describe.skip;
const describeQdrant = qdrantAvailable && ollamaAvailable ? describe : describe.skip;

describeOllama("Ollama BGE-M3 Embeddings", () => {
  it("should generate a 1024-dim vector", async () => {
    const vec = await localEmbed("hello world");
    expect(vec).toBeInstanceOf(Array);
    expect(vec.length).toBe(1024);
    expect(typeof vec[0]).toBe("number");
  });

  it("should batch embed multiple texts", async () => {
    const vecs = await localEmbedBatch(["hello", "world"]);
    expect(vecs.length).toBe(2);
    expect(vecs[0].length).toBe(1024);
    expect(vecs[1].length).toBe(1024);
  });

  it("should pass health check", async () => {
    const ok = await checkEmbedHealth();
    expect(ok).toBe(true);
  });
});

describeQdrant("Qdrant Vector Store", () => {
  beforeAll(async () => {
    // Fresh collection for isolation
    const { QdrantClient } = await import("@qdrant/js-client-rest");
    const client = new QdrantClient({ url: "http://localhost:6333", checkCompatibility: false });
    try { await client.deleteCollection("memory_test"); } catch {}
    await client.createCollection("memory_test", {
      vectors: { size: 1024, distance: "Cosine" },
    });
  });

  it("should pass health check", async () => {
    const ok = await checkQdrantHealth();
    expect(ok).toBe(true);
  });

  it("should upsert and search vectors", async () => {
    const testId = crypto.randomUUID();
    const vec = await localEmbed("IDE preference is VS Code");

    // Use test collection directly via client
    const { QdrantClient } = await import("@qdrant/js-client-rest");
    const client = new QdrantClient({ url: "http://localhost:6333", checkCompatibility: false });
    await client.upsert("memory_test", {
      wait: true,
      points: [{ id: testId, vector: vec, payload: {
        type: "fact", status: "active", content: "IDE preference is VS Code",
      }}],
    });

    const queryVec = await localEmbed("favourite IDE");
    const results = await client.search("memory_test", {
      vector: queryVec, limit: 5, score_threshold: 0.5, with_payload: true,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe(testId);
    expect(results[0].score).toBeGreaterThan(0.5);

    // Cleanup for delete test
    (globalThis as any).__qdrantTestId = testId;
  });

  it("should delete points", async () => {
    const testId = (globalThis as any).__qdrantTestId;
    const { QdrantClient } = await import("@qdrant/js-client-rest");
    const client = new QdrantClient({ url: "http://localhost:6333", checkCompatibility: false });
    await client.delete("memory_test", { wait: true, points: [testId] });

    const queryVec = await localEmbed("favourite IDE");
    const results = await client.search("memory_test", {
      vector: queryVec, limit: 5, score_threshold: 0.5,
    });
    const found = results.find((r) => r.id === testId);
    expect(found).toBeUndefined();
  });
});

describe("SQLite Database", () => {
  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB_PATH); } catch {}
    try { unlinkSync(TEST_DB_PATH + "-wal"); } catch {}
    try { unlinkSync(TEST_DB_PATH + "-shm"); } catch {}
  });

  it("should create tables and enable WAL", () => {
    const db = getDb();
    const mode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
  });

  it("should insert and retrieve memory", () => {
    const id = insertMemory({
      chat_id: "123",
      type: "fact",
      content: "IDE preference is Cursor",
      status: "active",
      source: "user",
      importance: 0.8,
      stability: 0.5,
    });
    const row = getMemoryById(id);
    expect(row).not.toBeNull();
    expect(row!.content).toBe("IDE preference is Cursor");
    expect(row!.type).toBe("fact");
  });

  it("should filter active memories by type", () => {
    insertMemory({
      chat_id: "123",
      type: "goal",
      content: "Learn Rust",
      status: "active",
      source: "user",
      importance: 0.6,
      stability: 0.5,
    });
    const goals = getActiveMemories({ type: "goal" });
    expect(goals.length).toBeGreaterThanOrEqual(1);
    expect(goals.every((m) => m.type === "goal")).toBe(true);
  });

  it("should update memory status", () => {
    const id = insertMemory({
      chat_id: "123",
      type: "fact",
      content: "temp fact",
      status: "active",
      source: "test",
      importance: 0.5,
      stability: 0.5,
    });
    updateMemoryStatus(id, "deleted");
    const row = getMemoryById(id);
    expect(row!.status).toBe("deleted");
  });

  it("should insert messages", () => {
    const id = insertMessage({
      chat_id: "123",
      thread_id: null,
      role: "user",
      content: "test message",
    });
    expect(id).toBeTruthy();
  });

  it("should insert documents", () => {
    const id = insertDocument({
      chat_id: "123",
      name: "test.pdf",
      content: "page 1 content",
      chunk_index: 0,
      content_hash: null,
      metadata: JSON.stringify({ pages: 5 }),
    });
    expect(id).toBeTruthy();
  });

  it("should insert and retrieve summaries", () => {
    const id = insertSummary({
      chat_id: "456",
      thread_id: null,
      summary: "discussed project architecture",
      message_range: JSON.stringify({ from: 1, to: 10 }),
    });
    expect(id).toBeTruthy();
    const summaries = getSummaries("456");
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(summaries[0].summary).toContain("architecture");
  });
});

describeQdrant("Search Service (end-to-end)", () => {
  beforeAll(async () => {
    await initCollections();

    // Seed test data: insert into SQLite + Qdrant
    const items = [
      { type: "fact", content: "IDE preference is Cursor" },
      { type: "fact", content: "Favourite color is blue" },
      { type: "fact", content: "Works as a Solution Architect" },
      { type: "goal", content: "Learn Rust by end of Q2" },
    ];

    for (const item of items) {
      const id = insertMemory({
        chat_id: "test",
        type: item.type,
        content: item.content,
        status: "active",
        source: "test",
        importance: 0.7,
        stability: 0.5,
      });
      const vec = await localEmbed(item.content);
      await upsert("memory", id, vec, {
        type: item.type,
        status: "active",
        content: item.content,
      });
    }
  });

  it("should find 'favourite IDE' via paraphrase search", async () => {
    const results = await searchMemory("favourite IDE", { threshold: 0.5 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const topContent = results[0].record.content;
    expect(topContent).toContain("IDE");
  });

  it("should filter by type", async () => {
    const results = await searchMemory("learn something new", {
      threshold: 0.3,
      type: "goal",
    });
    // Should return the goal about Rust, not facts
    const allGoals = results.every((r) => r.record.type === "goal");
    expect(allGoals).toBe(true);
  });

  it("should return full SQLite records with scores", async () => {
    const results = await searchMemory("solution architect", { threshold: 0.5 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].score).toBeGreaterThan(0.5);
    expect(results[0].record.created_at).toBeTruthy();
    expect(results[0].record.id).toBeTruthy();
  });
});
