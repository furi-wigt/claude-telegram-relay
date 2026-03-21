/**
 * Tests for memory commands (/remember, /forget, /summary)
 *
 * Run: bun test src/commands/memoryCommands.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock storageBackend so tests don't hit SQLite/Qdrant/Ollama ────────────

const mockInsertMemoryRecord = mock(async () => ({ id: "test-id", error: null }));
const mockDeleteMemoryRecord = mock(async () => {});
const mockDeleteAllMemoriesForChat = mock(async () => {});
const mockGetExistingMemories = mock(async () => []);
const mockGetMemoryByIndex = mock(async () => null);
const mockSearchMemoryBySubstring = mock(async () => []);
const mockSemanticSearchMemory = mock(async () => []);
const mockInsertMessageRecord = mock(async () => {});
const mockGetRecentMessagesLocal = mock(async () => []);
const mockGetConversationSummariesLocal = mock(() => []);
const mockGetMessageCountLocal = mock(async () => 0);
const mockInsertSummaryRecord = mock(async () => {});

mock.module("../local/storageBackend", () => ({
  insertMemoryRecord: mockInsertMemoryRecord,
  deleteMemoryRecord: mockDeleteMemoryRecord,
  deleteAllMemoriesForChat: mockDeleteAllMemoriesForChat,
  getExistingMemories: mockGetExistingMemories,
  getMemoryByIndex: mockGetMemoryByIndex,
  searchMemoryBySubstring: mockSearchMemoryBySubstring,
  semanticSearchMemory: mockSemanticSearchMemory,
  insertMessageRecord: mockInsertMessageRecord,
  getRecentMessagesLocal: mockGetRecentMessagesLocal,
  getConversationSummariesLocal: mockGetConversationSummariesLocal,
  getMessageCountLocal: mockGetMessageCountLocal,
  insertSummaryRecord: mockInsertSummaryRecord,
}));

// Mock semanticDuplicateChecker to avoid real vector search
mock.module("../utils/semanticDuplicateChecker", () => ({
  checkSemanticDuplicate: mock(async () => ({ isDuplicate: false })),
}));

// Mock duplicateDetector
mock.module("../utils/duplicateDetector", () => ({
  findPotentialDuplicates: mock(async () => ({ hasDuplicate: false })),
}));

// Mock documentProcessor
mock.module("../documents/documentProcessor", () => ({
  ingestText: mock(async () => ({ chunksInserted: 1, title: "test" })),
  resolveUniqueTitle: mock(async () => "test"),
}));

// Mock longTermExtractor
mock.module("../memory/longTermExtractor", () => ({
  getMemoryScores: mock(() => ({ importance: 0.7, stability: 0.7 })),
}));

import { registerMemoryCommands } from "./memoryCommands.ts";

// ============================================================
// Mock factories
// ============================================================

/** Create a mock grammy Bot that captures registered handlers */
function mockBot() {
  const handlers: Record<string, Function> = {};
  const callbackHandlers: Array<{ pattern: RegExp; handler: Function }> = [];

  return {
    command: mock((name: string, handler: Function) => {
      handlers[name] = handler;
    }),
    callbackQuery: mock((pattern: RegExp | string, handler: Function) => {
      if (typeof pattern === "string") {
        callbackHandlers.push({ pattern: new RegExp(`^${pattern}`), handler });
      } else {
        callbackHandlers.push({ pattern, handler });
      }
    }),
    _handlers: handlers,
    _callbackHandlers: callbackHandlers,
    /** Simulate calling a command handler */
    async _triggerCommand(name: string, ctx: any) {
      if (handlers[name]) await handlers[name](ctx);
    },
    /** Simulate calling a callback query handler */
    async _triggerCallback(data: string, ctx: any) {
      for (const { pattern, handler } of callbackHandlers) {
        if (pattern.test(data)) {
          await handler(ctx);
          return;
        }
      }
    },
  };
}

/** Create a mock grammy Context */
function mockCtx(overrides?: {
  chatId?: number;
  match?: string;
  callbackData?: string;
}) {
  const { chatId = 12345, match = "", callbackData = "" } = overrides ?? {};

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
// /remember
// ============================================================

describe("/remember command", () => {
  beforeEach(() => {
    mockInsertMemoryRecord.mockClear();
    mockInsertMessageRecord.mockClear();
  });

  test("replies with usage when no argument given", async () => {
    const bot = mockBot();
    registerMemoryCommands(bot as any, { userId: 1 });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("remember", ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = ctx.reply.mock.calls[0][0] as string;
    expect(replyText).toContain("Usage:");
    expect(replyText).toContain("/remember");
  });

  test("inserts a fact with correct fields", async () => {
    mockInsertMemoryRecord.mockResolvedValue({ id: "new-id", error: null });
    const bot = mockBot();
    registerMemoryCommands(bot as any, { userId: 1 });

    const ctx = mockCtx({ match: "My name is John" });
    await bot._triggerCommand("remember", ctx);

    expect(mockInsertMemoryRecord).toHaveBeenCalledTimes(1);
    const inserted = mockInsertMemoryRecord.mock.calls[0][0] as any;
    expect(inserted.content).toBe("My name is John");
    expect(inserted.type).toBe("fact");

    // Confirms to user
    const replyText = ctx.reply.mock.calls[0][0] as string;
    expect(replyText).toContain("Remembered:");
    expect(replyText).toContain("My name is John");
  });

  test("detects preference category", async () => {
    mockInsertMemoryRecord.mockResolvedValue({ id: "new-id", error: null });
    const bot = mockBot();
    registerMemoryCommands(bot as any, { userId: 1 });

    const ctx = mockCtx({ match: "I prefer bullet points" });
    await bot._triggerCommand("remember", ctx);

    const inserted = mockInsertMemoryRecord.mock.calls[0][0] as any;
    expect(inserted.category).toBe("preference");
    expect(inserted.type).toBe("fact");
  });

  test("detects goal category and sets type to 'goal'", async () => {
    mockInsertMemoryRecord.mockResolvedValue({ id: "new-id", error: null });
    const bot = mockBot();
    registerMemoryCommands(bot as any, { userId: 1 });

    const ctx = mockCtx({ match: "Goal: finish the API by March" });
    await bot._triggerCommand("remember", ctx);

    const inserted = mockInsertMemoryRecord.mock.calls[0][0] as any;
    expect(inserted.type).toBe("goal");
    expect(inserted.category).toBe("goal");
  });
});

// ============================================================
// /forget
// ============================================================

describe("/forget command", () => {
  beforeEach(() => {
    mockSearchMemoryBySubstring.mockClear();
    mockGetMemoryByIndex.mockClear();
  });

  test("shows confirmation keyboard when no topic given", async () => {
    const bot = mockBot();
    registerMemoryCommands(bot as any, { userId: 1 });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("forget", ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = ctx.reply.mock.calls[0][0] as string;
    expect(replyText).toContain("delete ALL memories");

    // Should have reply_markup with inline keyboard
    const opts = ctx.reply.mock.calls[0][1] as any;
    expect(opts?.reply_markup).toBeDefined();
  });

  test("shows matching memories when topic given", async () => {
    mockSearchMemoryBySubstring.mockResolvedValue([
      { id: "m1", type: "fact", content: "SingPass integration notes" },
      { id: "m2", type: "goal", content: "Complete SingPass API by March" },
    ]);
    const bot = mockBot();
    registerMemoryCommands(bot as any, { userId: 1 });

    const ctx = mockCtx({ match: "singpass" });
    await bot._triggerCommand("forget", ctx);

    // Should reply once per matching memory
    expect(ctx.reply).toHaveBeenCalledTimes(2);

    const firstReply = ctx.reply.mock.calls[0][0] as string;
    expect(firstReply).toContain("SingPass integration notes");
  });

  test("replies 'No memories found' when topic has no matches", async () => {
    mockSearchMemoryBySubstring.mockResolvedValue([]);
    mockSemanticSearchMemory.mockResolvedValue([]);
    const bot = mockBot();
    registerMemoryCommands(bot as any, { userId: 1 });

    const ctx = mockCtx({ match: "nonexistent" });
    await bot._triggerCommand("forget", ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = ctx.reply.mock.calls[0][0] as string;
    expect(replyText).toContain("No memories found matching");
  });
});

// ============================================================
// /summary
// ============================================================

describe("/summary command", () => {
  test("replies 'No conversation history' when nothing exists", async () => {
    mockGetConversationSummariesLocal.mockReturnValue([]);
    mockGetMessageCountLocal.mockResolvedValue(0);
    const bot = mockBot();
    registerMemoryCommands(bot as any, { userId: 1 });

    const ctx = mockCtx();
    await bot._triggerCommand("summary", ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = ctx.reply.mock.calls[0][0] as string;
    expect(replyText).toContain("No conversation history yet");
  });
});

// ============================================================
// Callback query handlers
// ============================================================

describe("forget callback handlers", () => {
  test("forget_all deletes all memories and edits message", async () => {
    mockDeleteAllMemoriesForChat.mockResolvedValue(undefined);
    const bot = mockBot();
    registerMemoryCommands(bot as any, { userId: 1 });

    const ctx = mockCtx({ callbackData: "forget_all:12345" });
    await bot._triggerCallback("forget_all:12345", ctx);

    expect(ctx.editMessageText).toHaveBeenCalledTimes(1);
    const editText = ctx.editMessageText.mock.calls[0][0] as string;
    expect(editText).toContain("All memories");
    expect(editText).toContain("deleted");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  test("forget_item deletes specific memory by ID", async () => {
    mockDeleteMemoryRecord.mockResolvedValue(undefined);
    const bot = mockBot();
    registerMemoryCommands(bot as any, { userId: 1 });

    const ctx = mockCtx({ callbackData: "forget_item:uuid-123" });
    await bot._triggerCallback("forget_item:uuid-123", ctx);

    expect(mockDeleteMemoryRecord).toHaveBeenCalledWith("uuid-123");
    expect(ctx.editMessageText).toHaveBeenCalledWith("\u2713 Forgotten.");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  test("forget_keep edits message to 'Kept' without deletion", async () => {
    const bot = mockBot();
    registerMemoryCommands(bot as any, { userId: 1 });

    const ctx = mockCtx({ callbackData: "forget_keep:uuid-456" });
    await bot._triggerCallback("forget_keep:uuid-456", ctx);

    expect(ctx.editMessageText).toHaveBeenCalledWith("\u2705 Kept.");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  test("forget_cancel edits message to 'Cancelled'", async () => {
    const bot = mockBot();
    registerMemoryCommands(bot as any, { userId: 1 });

    const ctx = mockCtx({ callbackData: "forget_cancel:12345" });
    await bot._triggerCallback("forget_cancel:12345", ctx);

    expect(ctx.editMessageText).toHaveBeenCalledWith(
      "Cancelled. Your memories are safe."
    );
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });
});

// ============================================================
// /forget N — index-based forget
// ============================================================

describe("/forget N — index-based forget", () => {
  beforeEach(() => {
    mockGetMemoryByIndex.mockClear();
  });

  test("/forget 2 with 3 memory items shows item #2 with InlineKeyboard", async () => {
    mockGetMemoryByIndex.mockResolvedValue(
      { id: "m2", type: "fact", content: "My AWS account is 123" }
    );
    const bot = mockBot();
    registerMemoryCommands(bot as any, { userId: 1 });

    const ctx = mockCtx({ match: "2" });
    await bot._triggerCommand("forget", ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = ctx.reply.mock.calls[0][0] as string;
    expect(replyText).toContain("#2");
    expect(replyText).toContain("My AWS account is 123");

    // Should have InlineKeyboard with forget_item and forget_keep
    const opts = ctx.reply.mock.calls[0][1] as any;
    expect(opts?.reply_markup).toBeDefined();
    const allButtons: Array<{ text: string; callback_data: string }> =
      opts.reply_markup.inline_keyboard.flat();
    const buttonDatas = allButtons.map((b) => b.callback_data);
    expect(buttonDatas).toContain(`forget_item:m2`);
    expect(buttonDatas.some((d) => d.startsWith("forget_keep:"))).toBe(true);
  });

  test("/forget 99 with no item at that index shows out-of-range error", async () => {
    mockGetMemoryByIndex.mockResolvedValue(null);
    const bot = mockBot();
    registerMemoryCommands(bot as any, { userId: 1 });

    const ctx = mockCtx({ match: "99" });
    await bot._triggerCommand("forget", ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = ctx.reply.mock.calls[0][0] as string;
    expect(replyText).toContain("No memory item #99");
  });

  test("/forget 0 shows out-of-range error (0 is not valid 1-based index)", async () => {
    mockGetMemoryByIndex.mockResolvedValue(null);
    const bot = mockBot();
    registerMemoryCommands(bot as any, { userId: 1 });

    const ctx = mockCtx({ match: "0" });
    await bot._triggerCommand("forget", ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = ctx.reply.mock.calls[0][0] as string;
    expect(replyText).toContain("No memory item #0");
  });
});
