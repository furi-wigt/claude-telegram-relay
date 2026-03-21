/**
 * E2E tests for /goals *goal mark-as-done feature
 *
 * Tests the full command flow backed by in-memory SQLite:
 *   - Mark active goal done by index (*1)
 *   - Mark active goal done by text (*goal text)
 *   - Reactivate a completed goal via dmem_done callback
 *   - Not found scenario
 *   - List completed goals (/goals *)
 *   - Disambiguation when multiple goals match
 *   - Backward compatibility of + and - syntax
 *
 * Run: bun test src/commands/goalsMarkDone.e2e.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";

// ============================================================
// In-memory SQLite — shared test DB
// ============================================================

let testDb: Database;

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      chat_id TEXT,
      thread_id TEXT,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'fact',
      category TEXT,
      status TEXT DEFAULT 'active',
      importance REAL DEFAULT 0.7,
      stability REAL DEFAULT 0.7,
      access_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      deadline TEXT,
      completed_at TEXT,
      extracted_from_exchange INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0.9,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      chat_id TEXT,
      thread_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      topic TEXT,
      agent_id TEXT,
      thread_name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      chat_id TEXT,
      thread_id TEXT,
      summary TEXT NOT NULL,
      message_count INTEGER DEFAULT 0,
      period_start TEXT,
      period_end TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      title TEXT NOT NULL,
      source TEXT,
      content TEXT NOT NULL,
      content_hash TEXT,
      chunk_index INTEGER DEFAULT 0,
      total_chunks INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS user_profile (
      id INTEGER PRIMARY KEY DEFAULT 1,
      summary TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function seedGoal(db: Database, goal: {
  id: string;
  content: string;
  type?: string;
  completed_at?: string | null;
  created_at?: string;
}) {
  db.prepare(`
    INSERT INTO memory (id, content, type, status, completed_at, created_at, importance, stability)
    VALUES (?, ?, ?, 'active', ?, ?, 0.8, 0.6)
  `).run(
    goal.id,
    goal.content,
    goal.type ?? "goal",
    goal.completed_at ?? null,
    goal.created_at ?? new Date().toISOString()
  );
}

// ============================================================
// Mock db.ts to return in-memory DB
// ============================================================

mock.module("../local/db.ts", () => ({
  getDb: () => testDb,
  insertMemory: (record: any) => {
    const id = record.id ?? crypto.randomUUID().replace(/-/g, "");
    testDb.prepare(`
      INSERT INTO memory (id, content, type, category, status, importance, stability, chat_id, thread_id, deadline)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).run(id, record.content, record.type ?? "fact", record.category ?? null,
      record.importance ?? 0.7, record.stability ?? 0.7, record.chat_id ?? null,
      record.thread_id ?? null, record.deadline ?? null);
    return id;
  },
  getMemoryById: (id: string) => testDb.prepare("SELECT * FROM memory WHERE id = ?").get(id),
  getActiveMemories: (opts?: any) => {
    const type = opts?.type ?? "fact";
    const limit = opts?.limit ?? 100;
    return testDb.prepare(
      `SELECT id, content, importance, stability, category, deadline, access_count, last_used_at, created_at
       FROM memory WHERE type = ? AND status = 'active' ORDER BY importance DESC, stability DESC LIMIT ?`
    ).all(type, limit);
  },
  updateMemoryStatus: (id: string, status: string) => {
    testDb.prepare("UPDATE memory SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  },
  incrementAccessCount: (id: string) => {
    testDb.prepare("UPDATE memory SET access_count = access_count + 1, last_used_at = datetime('now') WHERE id = ?").run(id);
  },
  insertMessage: () => crypto.randomUUID().replace(/-/g, ""),
  insertDocument: () => crypto.randomUUID().replace(/-/g, ""),
  insertSummary: () => crypto.randomUUID().replace(/-/g, ""),
  getSummaries: () => [],
  closeDb: () => {},
}));

// Mock embed/vectorStore to avoid Ollama/Qdrant
mock.module("../local/embed", () => ({
  localEmbed: async () => new Array(1024).fill(0),
  localEmbedBatch: async (texts: string[]) => texts.map(() => new Array(1024).fill(0)),
}));
mock.module("../local/vectorStore", () => ({
  upsert: async () => {},
  upsertBatch: async () => {},
  deletePoints: async () => {},
  initCollections: async () => {},
  search: async () => [],
}));
mock.module("../local/searchService", () => ({
  searchMemory: async () => [],
  searchMessages: async () => [],
  searchDocuments: async () => [],
  searchSummaries: async () => [],
}));
mock.module("../memory/topicQueue.ts", () => ({
  enqueue: () => {},
}));
mock.module("../utils/semanticDuplicateChecker", () => ({
  checkSemanticDuplicate: async () => ({ isDuplicate: false, match: null }),
}));
mock.module("../utils/goalDuplicateChecker", () => ({
  isTextDuplicateGoal: () => false,
  isTextDuplicate: () => false,
}));
mock.module("../claude-process.ts", () => ({
  claudeText: async () => { throw new Error("Claude unavailable in tests"); },
}));

const { registerDirectMemoryCommands } = await import("./directMemoryCommands.ts");

// ============================================================
// Mock helpers
// ============================================================

function mockBot() {
  const handlers: Record<string, Function> = {};
  const callbackHandlers: Array<{ pattern: RegExp | string; handler: Function }> = [];

  return {
    command: mock((name: string, handler: Function) => {
      handlers[name] = handler;
    }),
    callbackQuery: mock((pattern: RegExp | string, handler: Function) => {
      callbackHandlers.push({ pattern, handler });
    }),
    _handlers: handlers,
    _callbackHandlers: callbackHandlers,
    async _triggerCommand(name: string, ctx: any) {
      if (handlers[name]) await handlers[name](ctx);
    },
    async _triggerCallback(data: string, ctx: any) {
      for (const { pattern, handler } of callbackHandlers) {
        const re = typeof pattern === "string" ? new RegExp(`^${pattern}$`) : pattern;
        if (re.test(data)) {
          await handler(ctx);
          return;
        }
      }
    },
  };
}

function mockCtx(overrides?: { chatId?: number; match?: string; callbackData?: string }) {
  const { chatId = 99999, match = "", callbackData = "" } = overrides ?? {};
  return {
    chat: chatId ? { id: chatId } : null,
    match,
    reply: mock(() => Promise.resolve()),
    editMessageText: mock(() => Promise.resolve()),
    answerCallbackQuery: mock(() => Promise.resolve()),
    callbackQuery: { data: callbackData },
  };
}

// ============================================================
// Reset before each test
// ============================================================

beforeEach(() => {
  testDb = createTestDb();
});

// ============================================================
// /goals *1 — Mark active goal done by index
// ============================================================

describe("/goals *N — mark goal done by index", () => {
  test("marks first active goal done when *1 is used", async () => {
    const bot = mockBot();
    seedGoal(testDb, { id: "g1", content: "Ship v2 by March" });
    seedGoal(testDb, { id: "g2", content: "Learn Rust" });
    registerDirectMemoryCommands(bot as any, {});

    const ctx = mockCtx({ match: "*1" });
    await bot._triggerCommand("goals", ctx);

    // Check DB: g1 should be completed_goal
    const row = testDb.prepare("SELECT type, completed_at FROM memory WHERE id = 'g1'").get() as any;
    expect(row.type).toBe("completed_goal");
    expect(row.completed_at).toBeDefined();

    expect(ctx.reply).toHaveBeenCalled();
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Ship v2 by March");
    expect(text.toLowerCase()).toContain("done");
  });

  test("marks second goal done when *2 is used", async () => {
    const bot = mockBot();
    seedGoal(testDb, { id: "g1", content: "Ship v2 by March" });
    seedGoal(testDb, { id: "g2", content: "Learn Rust" });
    registerDirectMemoryCommands(bot as any, {});

    const ctx = mockCtx({ match: "*2" });
    await bot._triggerCommand("goals", ctx);

    expect(ctx.reply).toHaveBeenCalled();
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Learn Rust");
  });

  test("shows not found when index is out of range", async () => {
    const bot = mockBot();
    seedGoal(testDb, { id: "g1", content: "Only goal" });
    registerDirectMemoryCommands(bot as any, {});

    const ctx = mockCtx({ match: "*99" });
    await bot._triggerCommand("goals", ctx);

    // g1 should remain active
    const row = testDb.prepare("SELECT type FROM memory WHERE id = 'g1'").get() as any;
    expect(row.type).toBe("goal");

    expect(ctx.reply).toHaveBeenCalled();
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text.toLowerCase()).toContain("not found");
  });
});

// ============================================================
// /goals *text — Mark active goal done by text match
// ============================================================

describe("/goals *text — mark goal done by text match", () => {
  test("marks goal done when text matches a single goal", async () => {
    const bot = mockBot();
    seedGoal(testDb, { id: "g1", content: "Ship v2 by March" });
    seedGoal(testDb, { id: "g2", content: "Learn Rust programming" });
    registerDirectMemoryCommands(bot as any, {});

    const ctx = mockCtx({ match: "*Rust" });
    await bot._triggerCommand("goals", ctx);

    const row = testDb.prepare("SELECT type FROM memory WHERE id = 'g2'").get() as any;
    expect(row.type).toBe("completed_goal");

    expect(ctx.reply).toHaveBeenCalled();
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Rust");
  });
});

// ============================================================
// /goals *nonexistent — Not found
// ============================================================

describe("/goals *text — not found", () => {
  test("replies 'Not found' when no goals match the query", async () => {
    const bot = mockBot();
    registerDirectMemoryCommands(bot as any, {});

    const ctx = mockCtx({ match: "*xyzzy nonexistent" });
    await bot._triggerCommand("goals", ctx);

    expect(ctx.reply).toHaveBeenCalled();
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text.toLowerCase()).toContain("not found");
  });
});

// ============================================================
// /goals * — List completed goals
// ============================================================

describe("/goals * — list completed goals", () => {
  test("lists completed goals with Done and Archived sections", async () => {
    const now = new Date();
    const recentDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const oldDate = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString();

    const bot = mockBot();
    seedGoal(testDb, { id: "g1", content: "Ship v2 by March", type: "completed_goal", completed_at: recentDate });
    seedGoal(testDb, { id: "g2", content: "Old project cleanup", type: "completed_goal", completed_at: oldDate });
    registerDirectMemoryCommands(bot as any, {});

    const ctx = mockCtx({ match: "*" });
    await bot._triggerCommand("goals", ctx);

    expect(ctx.reply).toHaveBeenCalled();
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Ship v2 by March");
    expect(text).toContain("Old project cleanup");
    expect(text).toContain("Done");
    expect(text).toContain("Archived");
  });

  test("shows only Done section when all goals are recent", async () => {
    const recentDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const bot = mockBot();
    seedGoal(testDb, { id: "g1", content: "Recent goal", type: "completed_goal", completed_at: recentDate });
    registerDirectMemoryCommands(bot as any, {});

    const ctx = mockCtx({ match: "*" });
    await bot._triggerCommand("goals", ctx);

    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Done");
    expect(text).toContain("Recent goal");
    expect(text).not.toContain("Archived");
  });

  test("shows empty message when no completed goals exist", async () => {
    const bot = mockBot();
    registerDirectMemoryCommands(bot as any, {});

    const ctx = mockCtx({ match: "*" });
    await bot._triggerCommand("goals", ctx);

    expect(ctx.reply).toHaveBeenCalled();
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text.toLowerCase()).toContain("no completed");
  });
});

// ============================================================
// Disambiguation — multiple matches show InlineKeyboard
// ============================================================

describe("/goals *text — disambiguation", () => {
  test("shows InlineKeyboard when multiple goals match the query", async () => {
    const bot = mockBot();
    seedGoal(testDb, { id: "g1", content: "Ship API v2" });
    seedGoal(testDb, { id: "g2", content: "Ship mobile app" });
    seedGoal(testDb, { id: "g3", content: "Learn Rust" });
    registerDirectMemoryCommands(bot as any, {});

    const ctx = mockCtx({ match: "*Ship" });
    await bot._triggerCommand("goals", ctx);

    expect(ctx.reply).toHaveBeenCalled();
    const opts = ctx.reply.mock.calls[0][1] as any;
    expect(opts?.reply_markup).toBeDefined();

    const questionText = ctx.reply.mock.calls[0][0] as string;
    expect(questionText.toLowerCase()).toContain("match");

    const allButtons: Array<{ text: string; callback_data: string }> =
      opts.reply_markup.inline_keyboard.flat();
    const buttonIds = allButtons.map((b) => b.callback_data);
    expect(buttonIds).toContain("dmem_done:g1");
    expect(buttonIds).toContain("dmem_done:g2");
    expect(buttonIds).not.toContain("dmem_done:g3");
  });
});

// ============================================================
// dmem_done callback handler
// ============================================================

describe("dmem_done callback handler", () => {
  test("dmem_done: callback is registered", () => {
    const bot = mockBot();
    registerDirectMemoryCommands(bot as any, {});

    const hasDoneCallback = bot._callbackHandlers.some(({ pattern }) => {
      const re = typeof pattern === "string" ? new RegExp(pattern) : pattern;
      return re.test("dmem_done:some-id");
    });
    expect(hasDoneCallback).toBe(true);
  });

  test("dmem_done: marks active goal as done and edits message", async () => {
    const bot = mockBot();
    seedGoal(testDb, { id: "g1", content: "Ship v2" });
    registerDirectMemoryCommands(bot as any, {});

    const ctx = mockCtx({ callbackData: "dmem_done:g1" });
    await bot._triggerCallback("dmem_done:g1", ctx);

    const row = testDb.prepare("SELECT type, completed_at FROM memory WHERE id = 'g1'").get() as any;
    expect(row.type).toBe("completed_goal");
    expect(row.completed_at).toBeDefined();

    expect(ctx.editMessageText).toHaveBeenCalled();
    const editText = ctx.editMessageText.mock.calls[0][0] as string;
    expect(editText.toLowerCase()).toContain("done");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  test("dmem_done: reactivates completed goal and edits message", async () => {
    const bot = mockBot();
    seedGoal(testDb, { id: "g1", content: "Ship v2", type: "completed_goal", completed_at: "2026-02-10T00:00:00Z" });
    registerDirectMemoryCommands(bot as any, {});

    const ctx = mockCtx({ callbackData: "dmem_done:g1" });
    await bot._triggerCallback("dmem_done:g1", ctx);

    const row = testDb.prepare("SELECT type, completed_at FROM memory WHERE id = 'g1'").get() as any;
    expect(row.type).toBe("goal");
    expect(row.completed_at).toBeNull();

    expect(ctx.editMessageText).toHaveBeenCalled();
    const editText = ctx.editMessageText.mock.calls[0][0] as string;
    expect(editText).toContain("Reactivated");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });
});

// ============================================================
// Backward compatibility — existing + and - still work
// ============================================================

describe("backward compatibility — + and - unaffected by * feature", () => {
  test("+add still inserts a goal (no * interference)", async () => {
    const bot = mockBot();
    registerDirectMemoryCommands(bot as any, {});

    const ctx = mockCtx({ match: "+New goal to add" });
    await bot._triggerCommand("goals", ctx);

    const row = testDb.prepare(
      "SELECT * FROM memory WHERE content = 'New goal to add' AND type = 'goal'"
    ).get() as any;
    expect(row).toBeDefined();
    expect(row.type).toBe("goal");
  });

  test("-remove still deletes a goal (no * interference)", async () => {
    const bot = mockBot();
    seedGoal(testDb, { id: "g1", content: "Old goal to remove" });
    registerDirectMemoryCommands(bot as any, {});

    const ctx = mockCtx({ match: "-Old goal" });
    await bot._triggerCommand("goals", ctx);

    // Goal should be deleted or status changed
    const row = testDb.prepare("SELECT * FROM memory WHERE id = 'g1'").get() as any;
    // Either deleted entirely or status changed
    if (row) {
      expect(row.status).not.toBe("active");
    }
    expect(ctx.reply).toHaveBeenCalled();
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Removed");
  });
});

// ============================================================
// * syntax only works for /goals, not other commands
// ============================================================

describe("* syntax is goals-only", () => {
  test("/facts *text falls through to 'No valid items' (not treated as toggle)", async () => {
    const bot = mockBot();
    registerDirectMemoryCommands(bot as any, {});

    const ctx = mockCtx({ match: "*some fact" });
    await bot._triggerCommand("facts", ctx);

    expect(ctx.reply).toHaveBeenCalled();
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("No valid items");
  });
});
