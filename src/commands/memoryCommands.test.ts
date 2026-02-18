/**
 * Tests for memory commands (/remember, /forget, /summary)
 *
 * Run: bun test src/commands/memoryCommands.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { registerMemoryCommands } from "./memoryCommands.ts";

// ============================================================
// Mock factories
// ============================================================

/** Create a chainable Supabase mock */
function mockSupabase(overrides?: {
  insertResult?: { data: any; error: any };
  selectData?: any[];
  selectError?: any;
  deleteError?: any;
  summariesData?: any[];
  messageCount?: number;
}) {
  const {
    insertResult = { data: null, error: null },
    selectData = [],
    selectError = null,
    deleteError = null,
    summariesData = [],
    messageCount = 0,
  } = overrides ?? {};

  const deleteChain = {
    eq: mock(() => Promise.resolve({ data: null, error: deleteError })),
  };

  const selectChain = {
    select: mock(() => selectChain),
    eq: mock(() => selectChain),
    ilike: mock(() => selectChain),
    order: mock(() => selectChain),
    limit: mock(() => Promise.resolve({ data: selectData, error: selectError })),
    // For count queries
    then: undefined as any,
  };

  // Track table-specific behavior
  let fromCallCount = 0;
  const fromFn = mock((table: string) => {
    fromCallCount++;
    if (table === "memory") {
      return {
        insert: mock(() => Promise.resolve(insertResult)),
        select: selectChain.select,
        eq: selectChain.eq,
        ilike: selectChain.ilike,
        order: selectChain.order,
        limit: selectChain.limit,
        delete: mock(() => deleteChain),
      };
    }
    if (table === "conversation_summaries") {
      return {
        select: mock(() => ({
          eq: mock(() => ({
            order: mock(() =>
              Promise.resolve({ data: summariesData, error: null })
            ),
          })),
        })),
      };
    }
    if (table === "messages") {
      return {
        select: mock(() => ({
          eq: mock(() =>
            Promise.resolve({ count: messageCount, error: null })
          ),
        })),
      };
    }
    return {
      select: selectChain.select,
      insert: mock(() => Promise.resolve(insertResult)),
      delete: mock(() => deleteChain),
    };
  });

  return {
    from: fromFn,
    _deleteChain: deleteChain,
  } as any;
}

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
  test("replies with usage when no argument given", async () => {
    const bot = mockBot();
    const sb = mockSupabase();
    registerMemoryCommands(bot as any, { supabase: sb, userId: 1 });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("remember", ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = ctx.reply.mock.calls[0][0] as string;
    expect(replyText).toContain("Usage:");
    expect(replyText).toContain("/remember");
  });

  test("inserts a fact with correct fields", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const bot = mockBot();
    const sb = {
      from: mock(() => ({ insert: insertFn })),
    } as any;
    registerMemoryCommands(bot as any, { supabase: sb, userId: 1 });

    const ctx = mockCtx({ match: "My name is John" });
    await bot._triggerCommand("remember", ctx);

    expect(insertFn).toHaveBeenCalledTimes(1);
    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.content).toBe("My name is John");
    expect(inserted.type).toBe("fact");
    expect(inserted.extracted_from_exchange).toBe(false);
    expect(inserted.confidence).toBe(1.0);

    // Confirms to user
    const replyText = ctx.reply.mock.calls[0][0] as string;
    expect(replyText).toContain("Remembered:");
    expect(replyText).toContain("My name is John");
  });

  test("detects preference category", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const bot = mockBot();
    const sb = {
      from: mock(() => ({ insert: insertFn })),
    } as any;
    registerMemoryCommands(bot as any, { supabase: sb, userId: 1 });

    const ctx = mockCtx({ match: "I prefer bullet points" });
    await bot._triggerCommand("remember", ctx);

    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.category).toBe("preference");
    expect(inserted.type).toBe("fact");
  });

  test("detects goal category and sets type to 'goal'", async () => {
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const bot = mockBot();
    const sb = {
      from: mock(() => ({ insert: insertFn })),
    } as any;
    registerMemoryCommands(bot as any, { supabase: sb, userId: 1 });

    const ctx = mockCtx({ match: "Goal: finish the API by March" });
    await bot._triggerCommand("remember", ctx);

    const inserted = insertFn.mock.calls[0][0];
    expect(inserted.type).toBe("goal");
    expect(inserted.category).toBe("goal");
  });
});

// ============================================================
// /forget
// ============================================================

describe("/forget command", () => {
  test("shows confirmation keyboard when no topic given", async () => {
    const bot = mockBot();
    const sb = mockSupabase();
    registerMemoryCommands(bot as any, { supabase: sb, userId: 1 });

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
    const bot = mockBot();
    const sb = mockSupabase({
      selectData: [
        { id: "m1", type: "fact", content: "SingPass integration notes" },
        { id: "m2", type: "goal", content: "Complete SingPass API by March" },
      ],
    });
    registerMemoryCommands(bot as any, { supabase: sb, userId: 1 });

    const ctx = mockCtx({ match: "singpass" });
    await bot._triggerCommand("forget", ctx);

    // Should reply once per matching memory
    expect(ctx.reply).toHaveBeenCalledTimes(2);

    const firstReply = ctx.reply.mock.calls[0][0] as string;
    expect(firstReply).toContain("SingPass integration notes");
  });

  test("replies 'No memories found' when topic has no matches", async () => {
    const bot = mockBot();
    const sb = mockSupabase({ selectData: [] });
    registerMemoryCommands(bot as any, { supabase: sb, userId: 1 });

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
    const bot = mockBot();
    const sb = mockSupabase({ summariesData: [], messageCount: 0 });
    registerMemoryCommands(bot as any, { supabase: sb, userId: 1 });

    const ctx = mockCtx();
    await bot._triggerCommand("summary", ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = ctx.reply.mock.calls[0][0] as string;
    expect(replyText).toContain("No conversation history yet");
  });

  test("shows formatted summary with date range and current session", async () => {
    const bot = mockBot();
    const sb = mockSupabase({
      summariesData: [
        {
          summary: "Discussed project setup and architecture",
          message_count: 10,
          from_timestamp: "2026-02-15T10:00:00Z",
          to_timestamp: "2026-02-16T10:00:00Z",
          created_at: "2026-02-16T12:00:00Z",
        },
      ],
      messageCount: 15,
    });
    registerMemoryCommands(bot as any, { supabase: sb, userId: 1 });

    const ctx = mockCtx();
    await bot._triggerCommand("summary", ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = ctx.reply.mock.calls[0][0] as string;
    expect(replyText).toContain("CONVERSATION SUMMARY");
    expect(replyText).toContain("Discussed project setup");
    expect(replyText).toContain("10 messages");
    expect(replyText).toContain("Current session (5 messages, ongoing)");
  });
});

// ============================================================
// Callback query handlers
// ============================================================

describe("forget callback handlers", () => {
  test("forget_all deletes all memories and edits message", async () => {
    const bot = mockBot();
    const deleteMock = mock(() => ({
      eq: mock(() => Promise.resolve({ data: null, error: null })),
    }));
    const sb = {
      from: mock(() => ({
        delete: deleteMock,
      })),
    } as any;
    registerMemoryCommands(bot as any, { supabase: sb, userId: 1 });

    const ctx = mockCtx({ callbackData: "forget_all:12345" });
    await bot._triggerCallback("forget_all:12345", ctx);

    expect(ctx.editMessageText).toHaveBeenCalledTimes(1);
    const editText = ctx.editMessageText.mock.calls[0][0] as string;
    expect(editText).toContain("All memories");
    expect(editText).toContain("deleted");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  test("forget_item deletes specific memory by ID", async () => {
    const bot = mockBot();
    const eqMock = mock(() => Promise.resolve({ data: null, error: null }));
    const deleteMock = mock(() => ({ eq: eqMock }));
    const sb = {
      from: mock(() => ({
        delete: deleteMock,
      })),
    } as any;
    registerMemoryCommands(bot as any, { supabase: sb, userId: 1 });

    const ctx = mockCtx({ callbackData: "forget_item:uuid-123" });
    await bot._triggerCallback("forget_item:uuid-123", ctx);

    expect(eqMock).toHaveBeenCalledWith("id", "uuid-123");
    expect(ctx.editMessageText).toHaveBeenCalledWith("\u2713 Forgotten.");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  test("forget_keep edits message to 'Kept' without deletion", async () => {
    const bot = mockBot();
    const sb = mockSupabase();
    registerMemoryCommands(bot as any, { supabase: sb, userId: 1 });

    const ctx = mockCtx({ callbackData: "forget_keep:uuid-456" });
    await bot._triggerCallback("forget_keep:uuid-456", ctx);

    expect(ctx.editMessageText).toHaveBeenCalledWith("\u2705 Kept.");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  test("forget_cancel edits message to 'Cancelled'", async () => {
    const bot = mockBot();
    const sb = mockSupabase();
    registerMemoryCommands(bot as any, { supabase: sb, userId: 1 });

    const ctx = mockCtx({ callbackData: "forget_cancel:12345" });
    await bot._triggerCallback("forget_cancel:12345", ctx);

    expect(ctx.editMessageText).toHaveBeenCalledWith(
      "Cancelled. Your memories are safe."
    );
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });
});
