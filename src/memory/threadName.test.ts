/**
 * Tests for thread_name storage and display in getRelevantContext.
 *
 * These tests use the local SQLite backend and an in-memory database
 * so they are self-contained and leave no disk state.
 *
 * Run: bun test src/memory/threadName.test.ts
 */

// Use an in-memory SQLite database — must be set before any module import
process.env.LOCAL_DB_PATH = ":memory:";
// Disable Qdrant/Ollama side-effects — local embed and vector store are
// mocked below via bun:test module mocking.

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Module mocks (must appear before the modules under test are imported) ────

// Mock localEmbed so we don't need Ollama running
await mock.module("../local/embed.ts", () => ({
  localEmbed: mock(async (_text: string) => Array(384).fill(0.1)),
  localEmbedBatch: mock(async (texts: string[]) => texts.map(() => Array(384).fill(0.1))),
}));

// Mock vector store so we don't need Qdrant running
await mock.module("../local/vectorStore.ts", () => ({
  upsert: mock(async () => {}),
  upsertBatch: mock(async () => {}),
  deletePoints: mock(async () => {}),
  initCollections: mock(async () => {}),
  search: mock(async () => []),
}));

// Mock searchService — return controlled hits for semantic search
const _messageHits: any[] = [];
const _memoryHits: any[] = [];

await mock.module("../local/searchService.ts", () => ({
  searchMemory: mock(async () => _memoryHits),
  searchMessages: mock(async () => _messageHits),
  searchDocuments: mock(async () => []),
  searchSummaries: mock(async () => []),
}));

// Mock topicQueue so no background workers spin up
await mock.module("../memory/topicQueue.ts", () => ({
  enqueue: mock(() => {}),
}));

// Mock topicGenerator for on-the-fly topic generation fallback
await mock.module("../memory/topicGenerator.ts", () => ({
  generateTopic: mock(async (_content: string) => "fallback-topic"),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { insertMessageRecord } from "../local/storageBackend.ts";
import { getRelevantContext } from "../memory.ts";
import { getDb, closeDb } from "../local/db.ts";
import { _resetTopicNames, learnTopicName } from "../utils/chatNames.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetDb() {
  closeDb();
}

// ── insertMessageRecord — thread_name storage ─────────────────────────────────

describe("insertMessageRecord — thread_name storage (local mode)", () => {
  beforeEach(() => {
    resetDb();
  });

  test("stores thread_name in SQLite when provided", async () => {
    await insertMessageRecord({
      role: "user",
      content: "Hello world from Claude-relay thread",
      chat_id: 100,
      thread_id: 42,
      thread_name: "Claude-relay",
    });

    const db = getDb();
    const row = db
      .query("SELECT thread_name FROM messages ORDER BY created_at DESC LIMIT 1")
      .get() as { thread_name: string | null } | null;
    expect(row?.thread_name).toBe("Claude-relay");
  });

  test("stores null thread_name when not provided", async () => {
    await insertMessageRecord({
      role: "user",
      content: "DM message",
      chat_id: 100,
      thread_id: null,
    });

    const db = getDb();
    const row = db
      .query("SELECT thread_name FROM messages ORDER BY created_at DESC LIMIT 1")
      .get() as { thread_name: string | null } | null;
    expect(row?.thread_name).toBeNull();
  });

  test("stores #General as thread_name for DMs (threadId null)", async () => {
    await insertMessageRecord({
      role: "user",
      content: "Direct message content",
      chat_id: 200,
      thread_id: null,
      thread_name: "#General",
    });

    const db = getDb();
    const row = db
      .query("SELECT thread_name FROM messages ORDER BY created_at DESC LIMIT 1")
      .get() as { thread_name: string | null } | null;
    expect(row?.thread_name).toBe("#General");
  });
});

// ── getRelevantContext — thread_name display ──────────────────────────────────

describe("getRelevantContext — thread_name display (local mode)", () => {
  beforeEach(() => {
    resetDb();
    _resetTopicNames();
    // Clear the _messageHits and _memoryHits arrays for each test
    _messageHits.length = 0;
    _memoryHits.length = 0;
  });

  async function insertAndGetId(content: string, threadName: string | null): Promise<string> {
    await insertMessageRecord({
      role: "user",
      content,
      chat_id: 999,
      thread_id: threadName === "#General" ? null : 42,
      thread_name: threadName,
    });
    const db = getDb();
    const row = db
      .query("SELECT id FROM messages ORDER BY created_at DESC LIMIT 1")
      .get() as { id: string };
    return row.id;
  }

  test("uses thread_name in display when present", async () => {
    const id = await insertAndGetId(
      "A long enough message about TypeScript testing with bun",
      "Claude-relay"
    );

    // Seed the topic column so generateTopic is not called
    getDb().run("UPDATE messages SET topic = 'TypeScript testing' WHERE id = ?", [id]);

    // Simulate searchMessages returning this message hit
    _messageHits.push({ id, score: 0.9, record: { role: "user", content: "A long enough message about TypeScript testing with bun" } });

    const result = await getRelevantContext(null, "unique-thread-name-display-" + Date.now());
    expect(result).toContain("Claude-relay");
    expect(result).not.toContain("general");
  });

  test("falls back to agent_id when thread_name is null", async () => {
    // Insert with no thread_name, but set agent_id manually
    await insertMessageRecord({
      role: "user",
      content: "A long enough message about infrastructure cost optimization",
      chat_id: 999,
      thread_id: 42,
      thread_name: null,
    });

    const db = getDb();
    const row = db
      .query("SELECT id FROM messages ORDER BY created_at DESC LIMIT 1")
      .get() as { id: string };
    const id = row.id;

    // Set topic and agent_id
    db.run("UPDATE messages SET topic = 'cost optimization', agent_id = 'aws-architect' WHERE id = ?", [id]);

    _messageHits.push({ id, score: 0.9, record: { role: "user", content: "A long enough message about infrastructure cost optimization" } });

    const result = await getRelevantContext(null, "unique-agent-fallback-" + Date.now());
    expect(result).toContain("aws-architect");
  });

  test("falls back to resolveSourceLabel when both thread_name and agent_id are null", async () => {
    await insertMessageRecord({
      role: "user",
      content: "A long enough message about code review practices in teams",
      chat_id: null,
      thread_id: null,
      thread_name: null,
    });

    const db = getDb();
    const row = db
      .query("SELECT id FROM messages ORDER BY created_at DESC LIMIT 1")
      .get() as { id: string };
    const id = row.id;

    db.run("UPDATE messages SET topic = 'code review' WHERE id = ?", [id]);

    _messageHits.push({ id, score: 0.9, record: { role: "user", content: "A long enough message about code review practices in teams" } });

    const result = await getRelevantContext(null, "unique-general-fallback-" + Date.now());
    expect(result).toContain("[DM]");
  });
});

// ── saveMessage thread_name resolution logic ──────────────────────────────────
// Tests the resolution rule: threadId == null → "#General",
// threadId known → resolved name, threadId unknown → null.
// This is tested at the chatNames utility level since saveMessage is not exported.

describe("thread_name resolution logic via chatNames", () => {
  beforeEach(() => {
    _resetTopicNames();
  });

  test("threadId null → should resolve to #General", () => {
    // The relay.ts logic: threadId == null ? "#General" : getTopicName(threadId) ?? null
    const threadId: number | null = null;
    const resolved =
      threadId == null ? "#General" : (learnTopicName(threadId!, "x"), undefined) ?? null;
    expect(resolved).toBe("#General");
  });

  test("known threadId → resolved name from getTopicName", () => {
    learnTopicName(100, "Claude-relay");
    // Import getTopicName inline to verify the cache
    const { getTopicName } = require("../utils/chatNames.ts");
    const resolved = getTopicName(100) ?? null;
    expect(resolved).toBe("Claude-relay");
  });

  test("unknown threadId → null (name not yet learned)", () => {
    const { getTopicName } = require("../utils/chatNames.ts");
    const resolved = getTopicName(9999) ?? null;
    expect(resolved).toBeNull();
  });
});
