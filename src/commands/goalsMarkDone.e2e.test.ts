/**
 * E2E tests for /goals *goal mark-as-done feature
 *
 * Tests the full command flow with Supabase mocks:
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

import { describe, test, expect, mock, beforeAll } from "bun:test";

// Mock callClaudeText before importing — prevents real API calls in tests
beforeAll(() => {
  mock.module("../claude.ts", () => ({
    callClaudeText: mock(() => Promise.reject(new Error("Claude unavailable in tests"))),
  }));
});

import { registerDirectMemoryCommands } from "./directMemoryCommands.ts";

// ============================================================
// Mock helpers (same pattern as directMemoryCommands.test.ts)
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
// Supabase mock — supports select chains, update chains, single fetches
//
// The goals mark-done flow touches:
//   1. findGoalsByIndexOrQuery: select → or → eq → order → limit
//   2. toggleGoalDone: select("type") → eq("id") → single()  then  update({...}) → eq("id")
//   3. listCompletedGoals: select → or → eq → order → limit
//   4. insert (for STM save)
// ============================================================

interface MockGoal {
  id: string;
  content: string;
  type?: string;
  completed_at?: string | null;
  created_at?: string;
}

/**
 * Creates a Supabase mock that:
 * - Returns selectData for list-style queries (.select().or().eq().order().limit())
 * - Returns singleData for point queries (.select().eq().single())
 * - Captures update() payloads via updateFn
 */
function mockSupabaseForGoals(opts: {
  selectData?: MockGoal[];
  singleData?: MockGoal | null;
  singleError?: any;
  updateError?: any;
}) {
  const {
    selectData = [],
    singleData = null,
    singleError = null,
    updateError = null,
  } = opts;

  const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
  const msgInsertFn = mock(() => Promise.resolve({ data: null, error: null }));

  // Track update calls
  const updateEqFn = mock(() => Promise.resolve({ data: null, error: updateError }));
  const updateFn = mock((payload: any) => ({ eq: updateEqFn }));

  // Single-row fetch (toggleGoalDone reads type, dmem_done reads content)
  const singleFn = mock(() => Promise.resolve({ data: singleData, error: singleError }));

  // List chain for queries ending in .limit()
  const listChain: any = {};
  listChain.eq = mock(() => listChain);
  listChain.or = mock(() => listChain);
  listChain.order = mock(() => listChain);
  listChain.neq = mock(() => listChain);
  listChain.limit = mock(() => Promise.resolve({ data: selectData, error: null }));

  // select() returns an object supporting both list and single query shapes
  const selectFn = mock(() => {
    const combined: any = {};
    combined.eq = mock(() => ({
      single: singleFn,
      eq: listChain.eq,
      or: listChain.or,
      order: listChain.order,
      neq: listChain.neq,
      limit: listChain.limit,
    }));
    combined.or = mock(() => listChain);
    combined.order = mock(() => listChain);
    combined.single = singleFn;
    return combined;
  });

  const deleteEqFn = mock(() => Promise.resolve({ data: null, error: null }));
  const deleteFn = mock(() => ({ eq: deleteEqFn }));

  return {
    supabase: {
      from: mock((table: string) => {
        if (table === "messages") return { insert: msgInsertFn };
        return {
          select: selectFn,
          insert: insertFn,
          update: updateFn,
          delete: deleteFn,
        };
      }),
    } as any,
    insertFn,
    msgInsertFn,
    updateFn,
    updateEqFn,
    singleFn,
    selectFn,
    listChain,
    deleteEqFn,
  };
}

// ============================================================
// /goals *1 — Mark active goal done by index
// ============================================================

describe("/goals *N — mark goal done by index", () => {
  test("marks first active goal done when *1 is used", async () => {
    const bot = mockBot();
    const goals: MockGoal[] = [
      { id: "g1", content: "Ship v2 by March", type: "goal", completed_at: null },
      { id: "g2", content: "Learn Rust", type: "goal", completed_at: null },
    ];
    const { supabase, updateFn } = mockSupabaseForGoals({
      selectData: goals,
      singleData: { id: "g1", content: "Ship v2 by March", type: "goal", completed_at: null },
    });
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "*1" });
    await bot._triggerCommand("goals", ctx);

    // toggleGoalDone should be called: update type to completed_goal
    expect(updateFn).toHaveBeenCalledTimes(1);
    const payload = updateFn.mock.calls[0][0];
    expect(payload.type).toBe("completed_goal");
    expect(payload.completed_at).toBeDefined();

    // Reply confirms the goal
    expect(ctx.reply).toHaveBeenCalled();
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Ship v2 by March");
    expect(text).toContain("done");
  });

  test("marks second goal done when *2 is used", async () => {
    const bot = mockBot();
    const goals: MockGoal[] = [
      { id: "g1", content: "Ship v2 by March", type: "goal", completed_at: null },
      { id: "g2", content: "Learn Rust", type: "goal", completed_at: null },
    ];
    const { supabase, updateFn } = mockSupabaseForGoals({
      selectData: goals,
      singleData: { id: "g2", content: "Learn Rust", type: "goal", completed_at: null },
    });
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "*2" });
    await bot._triggerCommand("goals", ctx);

    expect(updateFn).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalled();
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Learn Rust");
  });

  test("shows not found when index is out of range", async () => {
    const bot = mockBot();
    const { supabase, updateFn } = mockSupabaseForGoals({
      selectData: [
        { id: "g1", content: "Only goal", type: "goal", completed_at: null },
      ],
    });
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "*99" });
    await bot._triggerCommand("goals", ctx);

    // No update should happen
    expect(updateFn).not.toHaveBeenCalled();
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
    const goals: MockGoal[] = [
      { id: "g1", content: "Ship v2 by March", type: "goal", completed_at: null },
      { id: "g2", content: "Learn Rust programming", type: "goal", completed_at: null },
    ];
    const { supabase, updateFn } = mockSupabaseForGoals({
      selectData: goals,
      singleData: { id: "g2", content: "Learn Rust programming", type: "goal", completed_at: null },
    });
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "*Rust" });
    await bot._triggerCommand("goals", ctx);

    expect(updateFn).toHaveBeenCalledTimes(1);
    const payload = updateFn.mock.calls[0][0];
    expect(payload.type).toBe("completed_goal");

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
    const { supabase, updateFn } = mockSupabaseForGoals({
      selectData: [],
      singleData: null,
    });
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "*xyzzy nonexistent" });
    await bot._triggerCommand("goals", ctx);

    expect(updateFn).not.toHaveBeenCalled();
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
    const recentDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago
    const oldDate = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString(); // 45 days ago

    const bot = mockBot();
    const completedGoals: MockGoal[] = [
      { id: "g1", content: "Ship v2 by March", type: "completed_goal", completed_at: recentDate },
      { id: "g2", content: "Old project cleanup", type: "completed_goal", completed_at: oldDate },
    ];
    const { supabase } = mockSupabaseForGoals({
      selectData: completedGoals,
    });
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "*" });
    await bot._triggerCommand("goals", ctx);

    expect(ctx.reply).toHaveBeenCalled();
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Ship v2 by March");
    expect(text).toContain("Old project cleanup");
    // Should have Done section
    expect(text).toContain("Done");
    // Should have Archived section
    expect(text).toContain("Archived");
  });

  test("shows only Done section when all goals are recent", async () => {
    const recentDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const bot = mockBot();
    const { supabase } = mockSupabaseForGoals({
      selectData: [
        { id: "g1", content: "Recent goal", type: "completed_goal", completed_at: recentDate },
      ],
    });
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "*" });
    await bot._triggerCommand("goals", ctx);

    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Done");
    expect(text).toContain("Recent goal");
    expect(text).not.toContain("Archived");
  });

  test("shows empty message when no completed goals exist", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseForGoals({ selectData: [] });
    registerDirectMemoryCommands(bot as any, { supabase });

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
    const goals: MockGoal[] = [
      { id: "g1", content: "Ship API v2", type: "goal", completed_at: null },
      { id: "g2", content: "Ship mobile app", type: "goal", completed_at: null },
      { id: "g3", content: "Learn Rust", type: "goal", completed_at: null },
    ];
    const { supabase, updateFn } = mockSupabaseForGoals({ selectData: goals });
    registerDirectMemoryCommands(bot as any, { supabase });

    // "Ship" matches g1 and g2
    const ctx = mockCtx({ match: "*Ship" });
    await bot._triggerCommand("goals", ctx);

    // No direct toggle — disambiguation shown instead
    expect(updateFn).not.toHaveBeenCalled();

    expect(ctx.reply).toHaveBeenCalled();
    const opts = ctx.reply.mock.calls[0][1] as any;
    expect(opts?.reply_markup).toBeDefined();

    const questionText = ctx.reply.mock.calls[0][0] as string;
    expect(questionText.toLowerCase()).toContain("match");

    // Keyboard buttons should use dmem_done: prefix
    const allButtons: Array<{ text: string; callback_data: string }> =
      opts.reply_markup.inline_keyboard.flat();
    const buttonIds = allButtons.map((b) => b.callback_data);
    expect(buttonIds).toContain("dmem_done:g1");
    expect(buttonIds).toContain("dmem_done:g2");
    // g3 (Learn Rust) should NOT be in the buttons
    expect(buttonIds).not.toContain("dmem_done:g3");
  });
});

// ============================================================
// dmem_done callback handler
// ============================================================

describe("dmem_done callback handler", () => {
  test("dmem_done: callback is registered", () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseForGoals({ selectData: [] });
    registerDirectMemoryCommands(bot as any, { supabase });

    const hasDoneCallback = bot._callbackHandlers.some(({ pattern }) => {
      const re = typeof pattern === "string" ? new RegExp(pattern) : pattern;
      return re.test("dmem_done:some-id");
    });
    expect(hasDoneCallback).toBe(true);
  });

  test("dmem_done: marks active goal as done and edits message", async () => {
    const bot = mockBot();
    const { supabase, updateFn, singleFn } = mockSupabaseForGoals({
      singleData: { id: "g1", content: "Ship v2", type: "goal", completed_at: null },
    });
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ callbackData: "dmem_done:g1" });
    await bot._triggerCallback("dmem_done:g1", ctx);

    // Should update to completed_goal
    expect(updateFn).toHaveBeenCalled();
    const payload = updateFn.mock.calls[0][0];
    expect(payload.type).toBe("completed_goal");
    expect(payload.completed_at).toBeDefined();

    // Should edit the message and answer the callback
    expect(ctx.editMessageText).toHaveBeenCalled();
    const editText = ctx.editMessageText.mock.calls[0][0] as string;
    expect(editText).toContain("done");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  test("dmem_done: reactivates completed goal and edits message", async () => {
    const bot = mockBot();
    const { supabase, updateFn } = mockSupabaseForGoals({
      singleData: { id: "g1", content: "Ship v2", type: "completed_goal", completed_at: "2026-02-10T00:00:00Z" },
    });
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ callbackData: "dmem_done:g1" });
    await bot._triggerCallback("dmem_done:g1", ctx);

    // Should update back to goal with null completed_at
    expect(updateFn).toHaveBeenCalled();
    const payload = updateFn.mock.calls[0][0];
    expect(payload.type).toBe("goal");
    expect(payload.completed_at).toBeNull();

    // Should edit with reactivation message
    expect(ctx.editMessageText).toHaveBeenCalled();
    const editText = ctx.editMessageText.mock.calls[0][0] as string;
    expect(editText).toContain("Reactivated");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  test("dmem_done: with null supabase answers 'Not configured'", async () => {
    const bot = mockBot();
    registerDirectMemoryCommands(bot as any, { supabase: null });

    const ctx = mockCtx({ callbackData: "dmem_done:some-id" });
    await bot._triggerCallback("dmem_done:some-id", ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Not configured");
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });
});

// ============================================================
// Backward compatibility — existing + and - still work
// ============================================================

describe("backward compatibility — + and - unaffected by * feature", () => {
  test("+add still inserts a goal (no * interference)", async () => {
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    // Build a select chain that returns empty data (no duplicates found)
    const emptyChain: any = {};
    emptyChain.eq = mock(() => emptyChain);
    emptyChain.or = mock(() => emptyChain);
    emptyChain.order = mock(() => emptyChain);
    emptyChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const selectFn = mock(() => emptyChain);
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: selectFn }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "+New goal to add" });
    await bot._triggerCommand("goals", ctx);

    expect(memInsert).toHaveBeenCalledTimes(1);
    const inserted = memInsert.mock.calls[0][0];
    expect(inserted.content).toBe("New goal to add");
    expect(inserted.type).toBe("goal");
  });

  test("-remove still deletes a goal (no * interference)", async () => {
    const bot = mockBot();
    const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
    const eqDeleteFn = mock(() => Promise.resolve({ data: null, error: null }));
    const deleteFn = mock(() => ({ eq: eqDeleteFn }));

    const chain: any = {};
    chain.eq = mock(() => chain);
    chain.or = mock(() => chain);
    chain.order = mock(() => chain);
    chain.limit = mock(() =>
      Promise.resolve({
        data: [{ id: "g1", content: "Old goal to remove" }],
        error: null,
      })
    );
    const selectFn = mock(() => chain);
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));

    const supabase = {
      from: mock((table: string) => {
        if (table === "messages") return { insert: msgInsert };
        return { insert: insertFn, select: selectFn, delete: deleteFn };
      }),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-Old goal" });
    await bot._triggerCommand("goals", ctx);

    expect(eqDeleteFn).toHaveBeenCalledWith("id", "g1");
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
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "*some fact" });
    await bot._triggerCommand("facts", ctx);

    expect(ctx.reply).toHaveBeenCalled();
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("No valid items");
  });
});
