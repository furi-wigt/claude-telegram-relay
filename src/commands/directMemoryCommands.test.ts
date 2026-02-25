/**
 * Tests for direct memory mutation commands (/goals, /facts, /prefs, /reminders)
 *
 * Run: bun test src/commands/directMemoryCommands.test.ts
 */

import { describe, test, expect, mock, beforeAll } from "bun:test";

// Mock callClaudeText before tests run so the remove path uses the deterministic ilike fallback.
// Mock duplicateDetector — controlled per test via findPotentialDuplicatesMock.
// Bun updates live bindings on mock.module, so this affects the already-loaded module.
const findPotentialDuplicatesMock = mock(() => Promise.resolve([] as any[]));
const parseModelIndicesMock = mock((raw: string, max: number) => {
  // Passthrough to real implementation is not needed; the module mock replaces the import
  return [];
});
beforeAll(() => {
  mock.module("../claude-process.ts", () => ({
    claudeText: mock(() => Promise.reject(new Error("Claude unavailable in tests"))),
  }));
  mock.module("../utils/duplicateDetector.ts", () => ({
    findPotentialDuplicates: findPotentialDuplicatesMock,
    parseModelIndices: parseModelIndicesMock,
  }));
});

import { parseAddRemoveArgs, registerDirectMemoryCommands } from "./directMemoryCommands.ts";

// ============================================================
// parseAddRemoveArgs — pure function
// ============================================================

describe("parseAddRemoveArgs", () => {
  test("parses single add", () => {
    expect(parseAddRemoveArgs("+Learn TypeScript")).toEqual({
      adds: ["Learn TypeScript"],
      removes: [],
      toggleDone: [],
    });
  });

  test("parses single remove", () => {
    expect(parseAddRemoveArgs("-Old goal")).toEqual({
      adds: [],
      removes: ["Old goal"],
      toggleDone: [],
    });
  });

  test("parses mixed adds and removes", () => {
    const result = parseAddRemoveArgs("+Goal A, +Goal B, -Old thing, +Goal C");
    expect(result.adds).toEqual(["Goal A", "Goal B", "Goal C"]);
    expect(result.removes).toEqual(["Old thing"]);
    expect(result.toggleDone).toEqual([]);
  });

  test("ignores items without +/-/* prefix", () => {
    const result = parseAddRemoveArgs("no prefix, +valid add, bare text");
    expect(result.adds).toEqual(["valid add"]);
    expect(result.removes).toEqual([]);
    expect(result.toggleDone).toEqual([]);
  });

  test("trims whitespace from items", () => {
    const result = parseAddRemoveArgs("  +  trimmed goal  ,  -  trimmed remove  ");
    expect(result.adds).toEqual(["trimmed goal"]);
    expect(result.removes).toEqual(["trimmed remove"]);
    expect(result.toggleDone).toEqual([]);
  });

  test("ignores empty items after stripping prefix", () => {
    const result = parseAddRemoveArgs("+, -, +valid");
    expect(result.adds).toEqual(["valid"]);
    expect(result.removes).toEqual([]);
    expect(result.toggleDone).toEqual([]);
  });

  test("returns empty arrays for empty input", () => {
    expect(parseAddRemoveArgs("")).toEqual({ adds: [], removes: [], toggleDone: [] });
  });

  // ── * prefix (toggleDone) tests ──────────────────────────────────────

  test("*goal text populates toggleDone", () => {
    const result = parseAddRemoveArgs("*goal text");
    expect(result).toEqual({ adds: [], removes: [], toggleDone: ["goal text"] });
  });

  test("*1 populates toggleDone with index string", () => {
    const result = parseAddRemoveArgs("*1");
    expect(result).toEqual({ adds: [], removes: [], toggleDone: ["1"] });
  });

  test("* alone populates toggleDone with empty string (list completed)", () => {
    const result = parseAddRemoveArgs("*");
    expect(result).toEqual({ adds: [], removes: [], toggleDone: [""] });
  });

  test("mixed +add, *done, -remove populates all three fields", () => {
    const result = parseAddRemoveArgs("+add me, *done goal, -remove me");
    expect(result.adds).toEqual(["add me"]);
    expect(result.removes).toEqual(["remove me"]);
    expect(result.toggleDone).toEqual(["done goal"]);
  });

  test("mixed *3, +new goal, -old stuff routes correctly", () => {
    const result = parseAddRemoveArgs("*3, +new goal, -old stuff");
    expect(result.adds).toEqual(["new goal"]);
    expect(result.removes).toEqual(["old stuff"]);
    expect(result.toggleDone).toEqual(["3"]);
  });

  test("multiple * items in one command", () => {
    const result = parseAddRemoveArgs("*first goal, *second goal");
    expect(result.toggleDone).toEqual(["first goal", "second goal"]);
    expect(result.adds).toEqual([]);
    expect(result.removes).toEqual([]);
  });
});

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

/** Supabase mock that returns given candidates for select queries.
 *
 * The select chain in findMatchingItems is:
 *   .select("id, content").or(scope).eq(type)[.or(category)|.eq(category)].limit(20)
 * so we need a self-returning chain that terminates at .limit().
 */
function mockSupabaseWithCandidates(candidates: Array<{ id: string; content: string }>) {
  const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
  const eqDeleteFn = mock(() => Promise.resolve({ data: null, error: null }));
  const deleteFn = mock(() => ({ eq: eqDeleteFn }));

  // Self-returning chain — any .eq()/.or()/.order() returns the chain; .limit() returns data
  const chain: any = {};
  chain.eq = mock(() => chain);
  chain.or = mock(() => chain);
  chain.order = mock(() => chain);
  chain.limit = mock(() => Promise.resolve({ data: candidates, error: null }));
  const selectFn = mock(() => chain);

  return {
    supabase: {
      from: mock((table: string) => {
        if (table === "messages") {
          return { insert: insertFn };
        }
        return {
          insert: insertFn,
          select: selectFn,
          delete: deleteFn,
        };
      }),
    } as any,
    insertFn,
    deleteFn,
    eqDeleteFn,
    chain,
  };
}

/** Minimal supabase for simple add-only tests */
function mockSupabaseSimple() {
  const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
  return {
    supabase: {
      from: mock(() => ({ insert: insertFn })),
    } as any,
    insertFn,
  };
}

// ============================================================
// registerDirectMemoryCommands — command registration
// ============================================================

describe("registerDirectMemoryCommands — registration", () => {
  test("registers all four commands", () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseSimple();
    registerDirectMemoryCommands(bot as any, { supabase });

    expect(Object.keys(bot._handlers)).toEqual(
      expect.arrayContaining(["goals", "facts", "prefs", "reminders"])
    );
  });

  test("registers dmem_del and dmem_cancel callback handlers", () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseSimple();
    registerDirectMemoryCommands(bot as any, { supabase });

    // Should have at least 2 callback handlers
    expect(bot._callbackHandlers.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================
// /goals — add path
// ============================================================

describe("/goals command — add path", () => {
  test("lists goals (not usage) when no argument given", async () => {
    const bot = mockBot();
    // listItems needs select; use mockSupabaseForList from the no-args section
    const listChain: any = {};
    listChain.eq = mock(() => listChain);
    listChain.or = mock(() => listChain);
    listChain.order = mock(() => listChain);
    listChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const supabase = {
      from: mock((table: string) => {
        if (table === "messages") return { insert: msgInsert };
        return { select: mock(() => listChain) };
      }),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("goals", ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const text = ctx.reply.mock.calls[0][0] as string;
    // New behaviour: list, not usage
    expect(text).not.toContain("Usage:");
    expect(text).toContain("/goals");
  });

  test("shows usage when no +/- prefix found", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseSimple();
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "just some text without prefix" });
    await bot._triggerCommand("goals", ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("No valid items");
  });

  test("inserts a goal with correct type and category", async () => {
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    // Add path now queries existing items for duplicate detection
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "+Finish the API by March" });
    await bot._triggerCommand("goals", ctx);

    expect(memInsert).toHaveBeenCalledTimes(1);
    const inserted = memInsert.mock.calls[0][0];
    expect(inserted.type).toBe("goal");
    expect(inserted.category).toBe("goal");
    expect(inserted.content).toBe("Finish the API by March");
    expect(inserted.confidence).toBe(1.0);

    // Replies with confirmation
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Finish the API by March");
  });

  test("inserts goal with chat_id=chatId for provenance (reads are globally scoped)", async () => {
    // Provenance model: goals store the originating chatId for audit trail.
    // Global visibility is achieved via read queries that ignore chat_id for goals.
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ chatId: 88888, match: "+Ship the v3 release" });
    await bot._triggerCommand("goals", ctx);

    expect(memInsert).toHaveBeenCalledTimes(1);
    const inserted = memInsert.mock.calls[0][0];
    expect(inserted.type).toBe("goal");
    expect(inserted.chat_id).toBe(88888); // provenance: records where goal was created
  });

  test("inserts multiple goals from one command", async () => {
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "+Goal One, +Goal Two" });
    await bot._triggerCommand("goals", ctx);

    expect(memInsert).toHaveBeenCalledTimes(2);
    const first = memInsert.mock.calls[0][0];
    const second = memInsert.mock.calls[1][0];
    expect(first.content).toBe("Goal One");
    expect(second.content).toBe("Goal Two");
  });
});

// ============================================================
// /facts — add path (verifies category)
// ============================================================

describe("/facts command — add path", () => {
  test("inserts a fact with personal category", async () => {
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "+My AWS account is 123456" });
    await bot._triggerCommand("facts", ctx);

    expect(memInsert).toHaveBeenCalledTimes(1);
    const inserted = memInsert.mock.calls[0][0];
    expect(inserted.type).toBe("fact");
    expect(inserted.category).toBe("personal");
  });
});

// ============================================================
// /prefs — add path (verifies category)
// ============================================================

describe("/prefs command — add path", () => {
  test("inserts a preference with preference category", async () => {
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "+Prefer concise responses" });
    await bot._triggerCommand("prefs", ctx);

    const inserted = memInsert.mock.calls[0][0];
    expect(inserted.type).toBe("fact");
    expect(inserted.category).toBe("preference");
  });
});

// ============================================================
// /reminders — add path (verifies category)
// ============================================================

describe("/reminders command — add path", () => {
  test("inserts a reminder with date category", async () => {
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "+Team standup every Monday 9am" });
    await bot._triggerCommand("reminders", ctx);

    const inserted = memInsert.mock.calls[0][0];
    expect(inserted.type).toBe("fact");
    expect(inserted.category).toBe("date");
  });
});

// ============================================================
// Global scoping — /facts and /prefs insert with chat_id=null
//
// Bug: /facts +text and /prefs +text stored with chat_id=chatId,
// making them invisible in other groups. Fix: personal and preference
// categories must be stored with chat_id=null (globally visible).
// /reminders (date category) must stay chat-scoped.
// ============================================================

describe("/facts command — provenance write path (personal category)", () => {
  test("inserts personal fact with chat_id=chatId for provenance (reads are globally scoped)", async () => {
    // Provenance model: personal facts store real chatId for audit trail.
    // Global visibility is achieved by removing chat_id filter from read queries.
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ chatId: 99999, match: "+I am a Solution Architect at GovTech" });
    await bot._triggerCommand("facts", ctx);

    expect(memInsert).toHaveBeenCalledTimes(1);
    const inserted = memInsert.mock.calls[0][0];
    expect(inserted.category).toBe("personal");
    expect(inserted.chat_id).toBe(99999); // provenance: records where fact was created
  });
});

describe("/prefs command — provenance write path (preference category)", () => {
  test("inserts preference with chat_id=chatId for provenance (reads are globally scoped)", async () => {
    // Provenance model: preferences store real chatId for audit trail.
    // Global visibility is achieved by removing chat_id filter from read queries.
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ chatId: 77777, match: "+Always use bullet points in responses" });
    await bot._triggerCommand("prefs", ctx);

    expect(memInsert).toHaveBeenCalledTimes(1);
    const inserted = memInsert.mock.calls[0][0];
    expect(inserted.category).toBe("preference");
    expect(inserted.chat_id).toBe(77777); // provenance: records where pref was created
  });
});

describe("/reminders command — stays chat-scoped (date category)", () => {
  test("inserts reminder with chat_id=chatId (date facts are group-specific)", async () => {
    // Reminders are transient and group-specific — they must stay chat-scoped.
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ chatId: 55555, match: "+AWS review Friday 2pm" });
    await bot._triggerCommand("reminders", ctx);

    expect(memInsert).toHaveBeenCalledTimes(1);
    const inserted = memInsert.mock.calls[0][0];
    expect(inserted.category).toBe("date");
    expect(inserted.chat_id).toBe(55555); // date facts stay chat-scoped
  });
});

// ============================================================
// Remove path — fallback ilike matching
// (Ollama is unavailable in test env, falls back to substring)
// ============================================================

describe("/goals command — remove path (ilike fallback)", () => {
  test("removes immediately when single candidate matches", async () => {
    const bot = mockBot();
    const { supabase, eqDeleteFn } = mockSupabaseWithCandidates([
      { id: "g1", content: "Finish the API by March" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    // "Finish the API" is a substring of the candidate — ilike fallback matches
    const ctx = mockCtx({ match: "-Finish the API" });
    await bot._triggerCommand("goals", ctx);

    // Should delete the matched item
    expect(eqDeleteFn).toHaveBeenCalledWith("id", "g1");

    // Should reply with confirmation
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Removed");
    expect(text).toContain("Finish the API by March");
  });

  test("shows 'Not found' when no candidates match query", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseWithCandidates([
      { id: "g1", content: "Something completely different" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-xyzzy does not exist" });
    await bot._triggerCommand("goals", ctx);

    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Not found");
  });

  test("shows InlineKeyboard when multiple candidates match", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseWithCandidates([
      { id: "g1", content: "API security audit" },
      { id: "g2", content: "API performance review" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    // Both have "API" — substring match catches both
    const ctx = mockCtx({ match: "-API" });
    await bot._triggerCommand("goals", ctx);

    // Should show disambiguation keyboard
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const opts = ctx.reply.mock.calls[0][1] as any;
    expect(opts?.reply_markup).toBeDefined();
    const questionText = ctx.reply.mock.calls[0][0] as string;
    expect(questionText).toContain("Multiple matches");
  });

  test("shows 'Not found' when no candidates exist at all", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseWithCandidates([]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-anything" });
    await bot._triggerCommand("goals", ctx);

    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Not found");
  });
});

// ============================================================
// dmem_del and dmem_cancel callbacks
// ============================================================

describe("dmem callback handlers", () => {
  test("dmem_del deletes item by ID and edits message", async () => {
    const bot = mockBot();
    const eqFn = mock(() => Promise.resolve({ data: null, error: null }));
    const deleteFn = mock(() => ({ eq: eqFn }));
    const supabase = {
      from: mock(() => ({ delete: deleteFn })),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ callbackData: "dmem_del:item-uuid-456" });
    await bot._triggerCallback("dmem_del:item-uuid-456", ctx);

    expect(eqFn).toHaveBeenCalledWith("id", "item-uuid-456");
    expect(ctx.editMessageText).toHaveBeenCalledTimes(1);
    const editText = ctx.editMessageText.mock.calls[0][0] as string;
    expect(editText).toContain("Removed");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  test("dmem_cancel edits message to 'Cancelled'", async () => {
    const bot = mockBot();
    registerDirectMemoryCommands(bot as any, { supabase: null });

    const ctx = mockCtx({ callbackData: "dmem_cancel" });
    await bot._triggerCallback("dmem_cancel", ctx);

    expect(ctx.editMessageText).toHaveBeenCalledWith("Cancelled.");
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  test("dmem_del with null supabase answers 'Not configured'", async () => {
    const bot = mockBot();
    registerDirectMemoryCommands(bot as any, { supabase: null });

    const ctx = mockCtx({ callbackData: "dmem_del:some-id" });
    await bot._triggerCallback("dmem_del:some-id", ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Not configured");
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });
});

// ============================================================
// Supabase not configured
// ============================================================

describe("commands with null supabase", () => {
  test("replies 'Memory is not configured' for all commands", async () => {
    const bot = mockBot();
    registerDirectMemoryCommands(bot as any, { supabase: null });

    for (const cmd of ["goals", "facts", "prefs", "reminders"]) {
      const ctx = mockCtx({ match: "+some item" });
      await bot._triggerCommand(cmd, ctx);
      const text = ctx.reply.mock.calls[0][0] as string;
      expect(text).toContain("not configured");
      ctx.reply.mockClear();
    }
  });
});

// ============================================================
// No-args path — list all items
// ============================================================

/** Build a supabase mock for the list path.
 * The listItems query chain is:
 *   .select(...).or(scope).eq(type)[.or(category)|.eq(category)].order(...).limit(50)
 */
function mockSupabaseForList(items: Array<{ id: string; content: string }>) {
  const insertFn = mock(() => Promise.resolve({ data: null, error: null }));
  const msgInsertFn = mock(() => Promise.resolve({ data: null, error: null }));

  const listChain: any = {};
  listChain.eq = mock(() => listChain);
  listChain.or = mock(() => listChain);
  listChain.order = mock(() => listChain);
  listChain.limit = mock(() => Promise.resolve({ data: items, error: null }));
  const selectFn = mock(() => listChain);

  return {
    supabase: {
      from: mock((table: string) => {
        if (table === "messages") return { insert: msgInsertFn };
        return { select: selectFn, insert: insertFn };
      }),
    } as any,
    insertFn,
    listChain,
  };
}

describe("/goals no-args — lists all goals", () => {
  test("lists stored goals when called without args", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseForList([
      { id: "g1", content: "Ship v2 by March" },
      { id: "g2", content: "Learn Rust" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("goals", ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Ship v2 by March");
    expect(text).toContain("Learn Rust");
    expect(text).toContain("/goals");
  });

  test("shows empty state message when no goals stored", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseForList([]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("goals", ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("No goal");
    expect(text).toContain("/goals");
  });

  test("saves list reply to STM via saveCommandInteraction", async () => {
    const bot = mockBot();
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const listChain: any = {};
    listChain.eq = mock(() => listChain);
    listChain.or = mock(() => listChain);
    listChain.order = mock(() => listChain);
    listChain.limit = mock(() => Promise.resolve({ data: [{ id: "g1", content: "My goal" }], error: null }));
    const supabase = {
      from: mock((table: string) => {
        if (table === "messages") return { insert: msgInsert };
        return { select: mock(() => listChain) };
      }),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("goals", ctx);

    // STM save inserts [user, assistant] pair
    expect(msgInsert).toHaveBeenCalledTimes(1);
    const insertedPair = msgInsert.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(insertedPair[1].role).toBe("assistant");
    expect(insertedPair[1].content).toContain("My goal");
  });
});

describe("/facts no-args — lists all facts", () => {
  test("lists stored facts when called without args", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseForList([
      { id: "f1", content: "I live in Singapore" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("facts", ctx);

    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("I live in Singapore");
    expect(text).toContain("/facts");
  });

  test("shows empty state for facts", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseForList([]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("facts", ctx);

    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("No fact");
  });
});

// ============================================================
// E2E: findMatchingItems scope aligned with listItems
//
// Bug: findMatchingItems used strict .eq("chat_id") + .eq("category")
// while listItems used .or() — items stored via [REMEMBER:] tags
// (category=null) appeared in /facts display but couldn't be deleted.
// Ollama fired on wrong candidates and deleted unrelated items.
//
// Fix: findMatchingItems now uses same scope/category filters as listItems.
// ============================================================

describe("E2E — findMatchingItems uses same scope as listItems", () => {
  test("findMatchingItems for /facts does NOT apply chat_id scope (provenance model: globally visible)", async () => {
    // Provenance model: facts are globally visible — no chat_id filter applied.
    // Only reminders (/reminders command) apply the chat_id scope filter.
    const bot = mockBot();
    const { supabase, chain } = mockSupabaseWithCandidates([
      { id: "f1", content: "pm2 cron implementation" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ chatId: 12345, match: "-pm2 cron" });
    await bot._triggerCommand("facts", ctx);

    // .or() must NOT be called with chat_id scope for facts
    const orArgs = (chain.or?.mock?.calls ?? []).map((c: any) => c[0] as string);
    const chatIdScopeCall = orArgs.find(
      (arg: string) => arg.includes("chat_id.eq.12345") && arg.includes("chat_id.is.null")
    );
    expect(chatIdScopeCall).toBeUndefined();
  });

  test("findMatchingItems for /facts calls .or() for category (includes null-category items)", async () => {
    const bot = mockBot();
    const { supabase, chain } = mockSupabaseWithCandidates([
      { id: "f1", content: "pm2 cron implementation" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-pm2 cron" });
    await bot._triggerCommand("facts", ctx);

    const orArgs = chain.or.mock.calls.map((c: any) => c[0] as string);
    // Category filter must include both personal and null to cover [REMEMBER:] tag items
    const categoryCall = orArgs.find(
      (arg: string) =>
        arg.includes("category.eq.personal") && arg.includes("category.is.null")
    );
    expect(categoryCall).toBeDefined();
  });

  test("/facts -pm2 cron removes item even when stored with category=null (via [REMEMBER:] tag)", async () => {
    // Simulates: item visible in /facts but was stored via [REMEMBER:] with category=null.
    // Old bug: strict .eq("category","personal") excluded it → Not found.
    // Fix: .or("category.eq.personal,category.is.null") includes it.
    const bot = mockBot();
    const { supabase, eqDeleteFn } = mockSupabaseWithCandidates([
      { id: "f1", content: "personal facts: name, age, location, job, family" },
      { id: "f2", content: "pm2 cron implementation" }, // was stored with category=null
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-pm2 cron" });
    await bot._triggerCommand("facts", ctx);

    // Single match → direct delete
    expect(eqDeleteFn).toHaveBeenCalledWith("id", "f2");
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Removed");
    expect(text).toContain("pm2 cron implementation");
  });

  test("/facts -Claude does NOT remove personal facts (no false Ollama match)", async () => {
    // Simulates the real bug from the screenshot:
    // user: /facts -Claude → bot wrongly removed "personal facts: name, age, location, job, family"
    // Root cause: "Claude relay status" had category=null so ilike found nothing in
    // category='personal' candidates → Ollama fired and matched "personal facts".
    // Fix: candidates now include category=null items, so ilike finds "Claude relay status".
    const bot = mockBot();
    const { supabase, eqDeleteFn } = mockSupabaseWithCandidates([
      { id: "f1", content: "personal facts: name, age, location, job, family" },
      { id: "f2", content: "Claude relay status" }, // stored with category=null
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-Claude" });
    await bot._triggerCommand("facts", ctx);

    // Must delete "Claude relay status", NOT "personal facts"
    expect(eqDeleteFn).toHaveBeenCalledWith("id", "f2");
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Removed");
    expect(text).toContain("Claude relay status");
    expect(text).not.toContain("personal facts");
  });

  test("/facts -Phase 3 finds 'Phase 3 ...' item stored with category=null", async () => {
    const bot = mockBot();
    const { supabase, eqDeleteFn } = mockSupabaseWithCandidates([
      { id: "f1", content: "personal facts: name, age, location, job, family" },
      { id: "f2", content: "Phase 3 Excel Rebalancer sheet complete" },
      { id: "f3", content: "fin_calculator implementation status" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-Phase 3" });
    await bot._triggerCommand("facts", ctx);

    expect(eqDeleteFn).toHaveBeenCalledWith("id", "f2");
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Removed");
    expect(text).toContain("Phase 3 Excel Rebalancer sheet complete");
  });

  test("/facts -fin_calculator finds both fin_calculator items (disambiguation keyboard)", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseWithCandidates([
      { id: "f1", content: "personal facts: name, age, location, job, family" },
      { id: "f2", content: "fin_calculator implementation status - Phase 1/2/3 complete" },
      { id: "f3", content: "fin_calculator Phase 5 complete - run_price_fetch.py" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-fin_calculator" });
    await bot._triggerCommand("facts", ctx);

    // Two matches → disambiguation keyboard
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const opts = ctx.reply.mock.calls[0][1] as any;
    expect(opts?.reply_markup).toBeDefined();

    const allButtons: Array<{ text: string; callback_data: string }> =
      opts.reply_markup.inline_keyboard.flat();
    const buttonIds = allButtons.map((b) => b.callback_data);

    expect(buttonIds).toContain("dmem_del:f2");
    expect(buttonIds).toContain("dmem_del:f3");
    expect(buttonIds).not.toContain("dmem_del:f1"); // personal facts must NOT appear
  });

  test("/facts -message finds 'message delivery failure' item", async () => {
    const bot = mockBot();
    const { supabase, eqDeleteFn } = mockSupabaseWithCandidates([
      { id: "f1", content: "personal facts: name, age, location, job, family" },
      { id: "f2", content: "message delivery failure" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-message" });
    await bot._triggerCommand("facts", ctx);

    expect(eqDeleteFn).toHaveBeenCalledWith("id", "f2");
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Removed");
    expect(text).toContain("message delivery failure");
  });
});

describe("/prefs no-args — lists all preferences", () => {
  test("lists stored prefs when called without args", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseForList([
      { id: "p1", content: "Prefer concise answers" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("prefs", ctx);

    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Prefer concise answers");
    expect(text).toContain("/prefs");
  });

  test("shows empty state for prefs", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseForList([]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("prefs", ctx);

    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("No preference");
  });
});

describe("/reminders no-args — lists all reminders", () => {
  test("lists stored reminders when called without args", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseForList([
      { id: "r1", content: "Team standup every Monday 9am" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("reminders", ctx);

    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Team standup every Monday 9am");
    expect(text).toContain("/reminders");
  });

  test("shows empty state for reminders", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseForList([]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("reminders", ctx);

    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("No reminder");
  });
});

// ============================================================
// E2E: Disambiguation keyboard shows CORRECT items (bug regression)
//
// Bug: Ollama was called first and returned wrong indices (always "1, 2"),
// causing the keyboard to show completely unrelated items.
// Fix: ilike substring match runs first; Ollama is a semantic-only fallback.
// ============================================================

describe("E2E — disambiguation keyboard shows correct items", () => {
  /**
   * 11 facts where "pm2 cron" items are at positions 7 and 8 (0-indexed: 6,7).
   * Old behaviour: Ollama returns "1, 2" → shows "Phase 3..." and "Phase 5..."
   * Fixed behaviour: ilike finds pm2 items → buttons contain dmem_del:f7 / f8.
   */
  test("/facts -pm2 cron shows pm2 items, not first items in list", async () => {
    const bot = mockBot();
    const candidates = [
      { id: "f1", content: "Phase 3 involves rebalancer.py" },
      { id: "f2", content: "Phase 5 involves xlwings Python" },
      { id: "f3", content: "personal facts: name, age, location" },
      { id: "f4", content: "message delivery failure" },
      { id: "f5", content: "claude session status" },
      { id: "f6", content: "Claude relay status" },
      { id: "f7", content: "pm2 cron implementation" },
      { id: "f8", content: "pm2 cron implementation (backup)" },
      { id: "f9", content: "User prefers gemma3-4b as fallback" },
      { id: "f10", content: "User has TradingView subscription" },
      { id: "f11", content: "User prefers to call the assistant Jarvis" },
    ];
    const { supabase } = mockSupabaseWithCandidates(candidates);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-pm2 cron" });
    await bot._triggerCommand("facts", ctx);

    // Two items match → disambiguation keyboard shown
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const opts = ctx.reply.mock.calls[0][1] as any;
    expect(opts?.reply_markup).toBeDefined();

    const questionText = ctx.reply.mock.calls[0][0] as string;
    expect(questionText).toContain("Multiple matches");
    expect(questionText).toContain("pm2 cron");

    // Extract button callback_data from InlineKeyboard
    const allButtons: Array<{ text: string; callback_data: string }> =
      opts.reply_markup.inline_keyboard.flat();
    const buttonIds = allButtons.map((b) => b.callback_data);

    // Must show the actual pm2 cron items
    expect(buttonIds).toContain("dmem_del:f7");
    expect(buttonIds).toContain("dmem_del:f8");

    // Must NOT show the first items in the list (the old bug)
    expect(buttonIds).not.toContain("dmem_del:f1");
    expect(buttonIds).not.toContain("dmem_del:f2");
  });

  test("/facts -Claude relay deletes 'Claude relay status', not unrelated items", async () => {
    const bot = mockBot();
    const candidates = [
      { id: "f1", content: "bug 1: editMessageText throws" },
      { id: "f2", content: "bug 2: completion message not shown" },
      { id: "f3", content: "pm2 cron implementation" },
      { id: "f4", content: "Claude relay status" },
      { id: "f5", content: "claude session status" },
    ];
    const { supabase, eqDeleteFn } = mockSupabaseWithCandidates(candidates);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-Claude relay" });
    await bot._triggerCommand("facts", ctx);

    // Single match → direct delete, no disambiguation
    expect(eqDeleteFn).toHaveBeenCalledWith("id", "f4");
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Removed");
    expect(text).toContain("Claude relay status");
  });

  test("/facts -claude session status deletes correct item, not personal facts", async () => {
    const bot = mockBot();
    const candidates = [
      { id: "f1", content: "name: user" },
      { id: "f2", content: "personal facts: name, age, location" },
      { id: "f3", content: "Claude relay status" },
      { id: "f4", content: "claude session status" },
      { id: "f5", content: "pm2 cron implementation" },
    ];
    const { supabase, eqDeleteFn } = mockSupabaseWithCandidates(candidates);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-claude session status" });
    await bot._triggerCommand("facts", ctx);

    // Single match → direct delete
    expect(eqDeleteFn).toHaveBeenCalledWith("id", "f4");
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Removed");
    expect(text).toContain("claude session status");
  });

  test("goals disambiguation shows correct goal items", async () => {
    const bot = mockBot();
    const candidates = [
      { id: "g1", content: "Learn Rust programming" },
      { id: "g2", content: "Read 12 books this year" },
      { id: "g3", content: "Ship API v2 by March" },
      { id: "g4", content: "Ship mobile app by Q3" },
      { id: "g5", content: "Improve test coverage to 90%" },
    ];
    const { supabase } = mockSupabaseWithCandidates(candidates);
    registerDirectMemoryCommands(bot as any, { supabase });

    // "Ship" matches g3 and g4 — should show those, not g1/g2
    const ctx = mockCtx({ match: "-Ship" });
    await bot._triggerCommand("goals", ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const opts = ctx.reply.mock.calls[0][1] as any;
    const allButtons: Array<{ text: string; callback_data: string }> =
      opts.reply_markup.inline_keyboard.flat();
    const buttonIds = allButtons.map((b) => b.callback_data);

    expect(buttonIds).toContain("dmem_del:g3");
    expect(buttonIds).toContain("dmem_del:g4");
    expect(buttonIds).not.toContain("dmem_del:g1");
    expect(buttonIds).not.toContain("dmem_del:g2");
  });

  test("prefs disambiguation shows correct pref items", async () => {
    const bot = mockBot();
    const candidates = [
      { id: "p1", content: "Prefer formal tone" },
      { id: "p2", content: "Use bullet points" },
      { id: "p3", content: "Always respond in English" },
      { id: "p4", content: "Respond concisely always" },
      { id: "p5", content: "Prefer dark mode interfaces" },
    ];
    const { supabase } = mockSupabaseWithCandidates(candidates);
    registerDirectMemoryCommands(bot as any, { supabase });

    // "always" matches p3 and p4 — should show those, not p1/p2
    const ctx = mockCtx({ match: "-always" });
    await bot._triggerCommand("prefs", ctx);

    const opts = ctx.reply.mock.calls[0][1] as any;
    const allButtons: Array<{ text: string; callback_data: string }> =
      opts.reply_markup.inline_keyboard.flat();
    const buttonIds = allButtons.map((b) => b.callback_data);

    expect(buttonIds).toContain("dmem_del:p3");
    expect(buttonIds).toContain("dmem_del:p4");
    expect(buttonIds).not.toContain("dmem_del:p1");
    expect(buttonIds).not.toContain("dmem_del:p2");
  });

  test("reminders disambiguation shows correct reminder items", async () => {
    const bot = mockBot();
    const candidates = [
      { id: "r1", content: "Call mom every Sunday" },
      { id: "r2", content: "Team standup Monday 9am" },
      { id: "r3", content: "Doctor appointment Monday 3pm" },
      { id: "r4", content: "Gym session Tuesday evening" },
    ];
    const { supabase } = mockSupabaseWithCandidates(candidates);
    registerDirectMemoryCommands(bot as any, { supabase });

    // "Monday" matches r2 and r3 — should show those, not r1/r4
    const ctx = mockCtx({ match: "-Monday" });
    await bot._triggerCommand("reminders", ctx);

    const opts = ctx.reply.mock.calls[0][1] as any;
    const allButtons: Array<{ text: string; callback_data: string }> =
      opts.reply_markup.inline_keyboard.flat();
    const buttonIds = allButtons.map((b) => b.callback_data);

    expect(buttonIds).toContain("dmem_del:r2");
    expect(buttonIds).toContain("dmem_del:r3");
    expect(buttonIds).not.toContain("dmem_del:r1");
    expect(buttonIds).not.toContain("dmem_del:r4");
  });
});

// ============================================================
// E2E: /goals and /facts discrepancy fix
//
// Bug: /goals showed "No goals stored yet" even when /memory goals showed items.
// Root causes:
//   1. listItems used .eq("category", "goal") — items from [GOAL:] tag have category=null
//   2. listItems used .eq("chat_id", chatId) — excluded chat_id=null global items
// Fix: listItems now uses .or(scope) for chat_id and no category filter for goals.
// ============================================================

describe("E2E — /goals shows items regardless of category (fix for [GOAL:] tag items)", () => {
  /**
   * Verify that /goals calls .or() for chat_id scope (not strict .eq).
   * Items stored via [GOAL:] tag have category=null — they must be visible.
   */
  test("listItems for goals does NOT filter by chatId (goals are globally scoped)", async () => {
    // Goals must be visible across all groups — listItems must not apply chatId scope for goals.
    const bot = mockBot();
    const { supabase, listChain } = mockSupabaseForList([
      { id: "g1", content: "Check with HR for internship job posting" },
      { id: "g2", content: "Centralised TODO system" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ chatId: 12345, match: "" });
    await bot._triggerCommand("goals", ctx);

    // .or() must NOT have been called with a chatId scope — goals are globally visible
    const orCalls = (listChain.or.mock.calls as any[]).map((c) => c[0] as string);
    const chatIdScopeFound = orCalls.some((arg) => arg.includes("chat_id.eq.12345"));
    expect(chatIdScopeFound).toBe(false);

    // Goals are displayed (globally scoped — items from any group visible)
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Check with HR for internship job posting");
    expect(text).toContain("Centralised TODO system");
  });

  test("/goals shows all goals when items have no category (from [GOAL:] tag)", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseForList([
      { id: "g1", content: "Check with HR for internship" },
      { id: "g2", content: "Centralised TODO system" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("goals", ctx);

    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Check with HR for internship");
    expect(text).toContain("Centralised TODO system");
  });
});

describe("E2E — /facts shows items without category (fix for [REMEMBER:] tag items)", () => {
  test("listItems for facts uses .or() for category scope (includes null category)", async () => {
    const bot = mockBot();
    const { supabase, listChain } = mockSupabaseForList([
      { id: "f1", content: "personal facts: name, age, location, job, family" },
      { id: "f2", content: "fin_calculator Phase 5 complete" },
      { id: "f3", content: "User prefers to call the assistant Jarvis" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("facts", ctx);

    // .or() called twice: once for scope, once for category filter
    expect(listChain.or).toHaveBeenCalled();
    const orCalls = listChain.or.mock.calls.map((c: any) => c[0] as string);
    // Category filter must include 'personal' and 'is.null'
    const categoryCall = orCalls.find((arg: string) =>
      arg.includes("category.eq.personal") && arg.includes("category.is.null")
    );
    expect(categoryCall).toBeDefined();

    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("fin_calculator Phase 5 complete");
  });

  test("/facts shows items from both personal category and uncategorised", async () => {
    const bot = mockBot();
    const { supabase } = mockSupabaseForList([
      { id: "f1", content: "User works at GovTech" },
      { id: "f2", content: "User has TradingView Essential subscription" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "" });
    await bot._triggerCommand("facts", ctx);

    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("User works at GovTech");
    expect(text).toContain("User has TradingView Essential subscription");
  });
});

// ============================================================
// Index-based delete (-N syntax)
// ============================================================

describe("index-based delete (-N syntax)", () => {
  test("/goals -2 with 3 goals deletes the 2nd goal", async () => {
    const bot = mockBot();
    const { supabase, eqDeleteFn } = mockSupabaseWithCandidates([
      { id: "g1", content: "Learn Rust" },
      { id: "g2", content: "Ship API v2" },
      { id: "g3", content: "Read 12 books" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-2" });
    await bot._triggerCommand("goals", ctx);

    // Index 2 (1-based) maps to candidates[1] → id "g2"
    expect(eqDeleteFn).toHaveBeenCalledWith("id", "g2");
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Removed");
    expect(text).toContain("Ship API v2");
  });

  test("/facts -1 with 2 facts deletes the 1st fact", async () => {
    const bot = mockBot();
    const { supabase, eqDeleteFn } = mockSupabaseWithCandidates([
      { id: "f1", content: "I live in Singapore" },
      { id: "f2", content: "My AWS account is 123" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-1" });
    await bot._triggerCommand("facts", ctx);

    expect(eqDeleteFn).toHaveBeenCalledWith("id", "f1");
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Removed");
    expect(text).toContain("I live in Singapore");
  });

  test("/prefs -3 out of range (only 2 prefs) shows 'Not found'", async () => {
    const bot = mockBot();
    const { supabase, eqDeleteFn } = mockSupabaseWithCandidates([
      { id: "p1", content: "Prefer concise" },
      { id: "p2", content: "Use bullet points" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-3" });
    await bot._triggerCommand("prefs", ctx);

    // No delete should happen
    expect(eqDeleteFn).not.toHaveBeenCalled();
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Not found");
  });

  test("/reminders -2 deletes the 2nd reminder", async () => {
    const bot = mockBot();
    const { supabase, eqDeleteFn } = mockSupabaseWithCandidates([
      { id: "r1", content: "Team standup Monday 9am" },
      { id: "r2", content: "Doctor appointment Friday 3pm" },
      { id: "r3", content: "Gym session Tuesday" },
    ]);
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "-2" });
    await bot._triggerCommand("reminders", ctx);

    expect(eqDeleteFn).toHaveBeenCalledWith("id", "r2");
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Removed");
    expect(text).toContain("Doctor appointment Friday 3pm");
  });
});

// ============================================================
// Duplicate detection on add (+text when duplicates exist)
// ============================================================

describe("duplicate detection on add", () => {
  test("/goals +text when findPotentialDuplicates returns a match shows InlineKeyboard", async () => {
    findPotentialDuplicatesMock.mockImplementation(() =>
      Promise.resolve([{ id: "g1", content: "Learn Python basics" }])
    );

    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() =>
      Promise.resolve({
        data: [{ id: "g1", content: "Learn Python basics" }],
        error: null,
      })
    );
    const supabase = {
      from: mock((table: string) =>
        table === "messages"
          ? { insert: msgInsert }
          : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "+Learn Python" });
    await bot._triggerCommand("goals", ctx);

    // Should NOT insert directly
    expect(memInsert).not.toHaveBeenCalled();

    // Should show duplicate confirmation keyboard
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = ctx.reply.mock.calls[0][0] as string;
    expect(replyText).toContain("Similar item");
    expect(replyText).toContain("Learn Python basics");

    const opts = ctx.reply.mock.calls[0][1] as any;
    expect(opts?.reply_markup).toBeDefined();
    const allButtons: Array<{ text: string; callback_data: string }> =
      opts.reply_markup.inline_keyboard.flat();
    const buttonDatas = allButtons.map((b) => b.callback_data);
    expect(buttonDatas.some((d) => d.startsWith("dmem_dup_yes:"))).toBe(true);
    expect(buttonDatas.some((d) => d.startsWith("dmem_dup_no:"))).toBe(true);

    // Reset mock for other tests
    findPotentialDuplicatesMock.mockImplementation(() => Promise.resolve([]));
  });

  test("dmem_dup_yes callback inserts the pending item", async () => {
    // First, trigger the duplicate flow to populate pendingAdds
    findPotentialDuplicatesMock.mockImplementation(() =>
      Promise.resolve([{ id: "g1", content: "Existing goal" }])
    );

    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() =>
      Promise.resolve({
        data: [{ id: "g1", content: "Existing goal" }],
        error: null,
      })
    );
    const supabase = {
      from: mock((table: string) =>
        table === "messages"
          ? { insert: msgInsert }
          : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    // Step 1: Trigger the add which creates a pending entry
    const addCtx = mockCtx({ match: "+My new goal" });
    await bot._triggerCommand("goals", addCtx);

    // Extract the key from the callback button
    const opts = addCtx.reply.mock.calls[0][1] as any;
    const allButtons: Array<{ text: string; callback_data: string }> =
      opts.reply_markup.inline_keyboard.flat();
    const yesButton = allButtons.find((b) => b.callback_data.startsWith("dmem_dup_yes:"));
    expect(yesButton).toBeDefined();
    const key = yesButton!.callback_data.replace("dmem_dup_yes:", "");

    // Step 2: Simulate user pressing "Yes, add it anyway"
    const callbackCtx = mockCtx({ callbackData: `dmem_dup_yes:${key}` });
    await bot._triggerCallback(`dmem_dup_yes:${key}`, callbackCtx);

    // Should insert now
    expect(memInsert).toHaveBeenCalledTimes(1);
    const inserted = memInsert.mock.calls[0][0];
    expect(inserted.content).toBe("My new goal");
    expect(inserted.type).toBe("goal");

    // Should edit message with confirmation
    expect(callbackCtx.editMessageText).toHaveBeenCalled();
    const editText = callbackCtx.editMessageText.mock.calls[0][0] as string;
    expect(editText).toContain("Added");
    expect(editText).toContain("My new goal");

    findPotentialDuplicatesMock.mockImplementation(() => Promise.resolve([]));
  });

  test("dmem_dup_no callback skips insert and replies 'Skipped.'", async () => {
    findPotentialDuplicatesMock.mockImplementation(() =>
      Promise.resolve([{ id: "g1", content: "Existing goal" }])
    );

    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() =>
      Promise.resolve({
        data: [{ id: "g1", content: "Existing goal" }],
        error: null,
      })
    );
    const supabase = {
      from: mock((table: string) =>
        table === "messages"
          ? { insert: msgInsert }
          : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    // Trigger the add to populate pendingAdds
    const addCtx = mockCtx({ match: "+My new goal" });
    await bot._triggerCommand("goals", addCtx);

    // Extract key
    const opts = addCtx.reply.mock.calls[0][1] as any;
    const allButtons: Array<{ text: string; callback_data: string }> =
      opts.reply_markup.inline_keyboard.flat();
    const noButton = allButtons.find((b) => b.callback_data.startsWith("dmem_dup_no:"));
    const key = noButton!.callback_data.replace("dmem_dup_no:", "");

    // Simulate "No, skip" press
    const callbackCtx = mockCtx({ callbackData: `dmem_dup_no:${key}` });
    await bot._triggerCallback(`dmem_dup_no:${key}`, callbackCtx);

    // Should NOT insert
    expect(memInsert).not.toHaveBeenCalled();

    // Should edit message to "Skipped."
    expect(callbackCtx.editMessageText).toHaveBeenCalledWith("Skipped.");

    findPotentialDuplicatesMock.mockImplementation(() => Promise.resolve([]));
  });

  test("dmem_dup_no with expired/unknown key replies 'Expired. Please try again.'", async () => {
    const bot = mockBot();
    const supabase = {
      from: mock(() => ({ insert: mock(() => Promise.resolve({ data: null, error: null })) })),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    // Use a key that was never added to pendingAdds
    const callbackCtx = mockCtx({ callbackData: "dmem_dup_no:nonexistent-key" });
    await bot._triggerCallback("dmem_dup_no:nonexistent-key", callbackCtx);

    // The dmem_dup_no handler always calls editMessageText("Skipped.") and deletes from pendingAdds
    // regardless of whether the key exists — it's a no-op delete on the Map
    expect(callbackCtx.editMessageText).toHaveBeenCalledWith("Skipped.");
  });

  test("dmem_dup_yes with expired/unknown key replies 'Expired. Please try again.'", async () => {
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const supabase = {
      from: mock(() => ({ insert: memInsert })),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    // Use a key that was never added to pendingAdds
    const callbackCtx = mockCtx({ callbackData: "dmem_dup_yes:nonexistent-key" });
    await bot._triggerCallback("dmem_dup_yes:nonexistent-key", callbackCtx);

    // Should NOT insert anything
    expect(memInsert).not.toHaveBeenCalled();
    // Should show expired message
    expect(callbackCtx.editMessageText).toHaveBeenCalledWith("Expired. Please try again.");
  });

  test("Claude unavailable (findPotentialDuplicates returns []) → insert proceeds directly", async () => {
    findPotentialDuplicatesMock.mockImplementation(() => Promise.resolve([]));

    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() =>
      Promise.resolve({
        data: [{ id: "g1", content: "Some existing goal" }],
        error: null,
      })
    );
    const supabase = {
      from: mock((table: string) =>
        table === "messages"
          ? { insert: msgInsert }
          : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ match: "+Brand new goal" });
    await bot._triggerCommand("goals", ctx);

    // Should insert directly without showing duplicate keyboard
    expect(memInsert).toHaveBeenCalledTimes(1);
    const inserted = memInsert.mock.calls[0][0];
    expect(inserted.content).toBe("Brand new goal");

    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).toContain("Added");
    expect(text).toContain("Brand new goal");
  });
});

// ============================================================
// Provenance model — write paths (RED)
//
// Under the provenance model, ALL memory types store the real chatId for
// audit trail.  The old ternary (goal/personal/preference → null) is removed.
// Scope is determined by the read path (no chat_id filter), not the write path.
// ============================================================

describe("/facts command — provenance write path", () => {
  test("inserts personal fact with chat_id=chatId (provenance) not null", async () => {
    // RED: fails until W4 is implemented (currently stores null for personal category).
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ chatId: 11111, match: "+I am a Solution Architect at GovTech" });
    await bot._triggerCommand("facts", ctx);

    expect(memInsert).toHaveBeenCalledTimes(1);
    const inserted = memInsert.mock.calls[0][0];
    expect(inserted.category).toBe("personal");
    expect(inserted.chat_id).toBe(11111); // provenance: store real chatId
  });
});

describe("/prefs command — provenance write path", () => {
  test("inserts preference with chat_id=chatId (provenance) not null", async () => {
    // RED: fails until W4 is implemented (currently stores null for preference category).
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ chatId: 22222, match: "+Always use bullet points in responses" });
    await bot._triggerCommand("prefs", ctx);

    expect(memInsert).toHaveBeenCalledTimes(1);
    const inserted = memInsert.mock.calls[0][0];
    expect(inserted.category).toBe("preference");
    expect(inserted.chat_id).toBe(22222); // provenance: store real chatId
  });
});

describe("/goals command — provenance write path", () => {
  test("inserts goal with chat_id=chatId (provenance) not null", async () => {
    // RED: fails until W4 is implemented (currently stores null for goals).
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ chatId: 33333, match: "+Deploy new memory architecture" });
    await bot._triggerCommand("goals", ctx);

    expect(memInsert).toHaveBeenCalledTimes(1);
    const inserted = memInsert.mock.calls[0][0];
    expect(inserted.type).toBe("goal");
    expect(inserted.chat_id).toBe(33333); // provenance: store real chatId
  });
});

describe("/reminders command — stays chat-scoped (provenance model unchanged)", () => {
  test("inserts reminder with chat_id=chatId (date facts always chat-scoped)", async () => {
    // Reminders are transient — provenance = scope for dates. No change in behavior.
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = mock(() => dupChain);
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ chatId: 44444, match: "+AWS review Friday 2pm" });
    await bot._triggerCommand("reminders", ctx);

    expect(memInsert).toHaveBeenCalledTimes(1);
    const inserted = memInsert.mock.calls[0][0];
    expect(inserted.category).toBe("date");
    expect(inserted.chat_id).toBe(44444);
  });
});

describe("listItems — provenance model read path (R5)", () => {
  test("personal facts list does NOT apply chat_id OR-scope filter", async () => {
    // RED: fails until R5 is implemented (currently applies .or(chat_id.eq.X,chat_id.is.null)
    // for all non-goal types including facts).
    // Under provenance model: no chat_id filter for facts (globally visible).
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const orFn = mock((arg: string) => dupChain);
    const dupChain: any = {};
    dupChain.eq = mock(() => dupChain);
    dupChain.or = orFn;
    dupChain.order = mock(() => dupChain);
    dupChain.limit = mock(() => Promise.resolve({
      data: [{ id: "f1", content: "User is a Solution Architect" }],
      error: null,
    }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: mock(() => dupChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ chatId: 55555, match: "" });
    await bot._triggerCommand("facts", ctx);

    // .or() should NOT be called with a chat_id scope for facts
    const orCallsWithChatIdScope = orFn.mock.calls.filter((args: string[]) =>
      args[0]?.includes("chat_id.eq.55555")
    );
    expect(orCallsWithChatIdScope.length).toBe(0);
  });

  test("reminders list DOES apply chat_id OR-scope filter (dates stay chat-scoped)", async () => {
    // Reminders are chat-scoped — .or(chat_id.eq.X, ...) must still be applied.
    const bot = mockBot();
    const memInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const msgInsert = mock(() => Promise.resolve({ data: null, error: null }));
    const orFn = mock((arg: string) => reminderChain);
    const reminderChain: any = {};
    reminderChain.eq = mock(() => reminderChain);
    reminderChain.or = orFn;
    reminderChain.order = mock(() => reminderChain);
    reminderChain.limit = mock(() => Promise.resolve({ data: [], error: null }));
    const supabase = {
      from: mock((table: string) =>
        table === "messages" ? { insert: msgInsert } : { insert: memInsert, select: mock(() => reminderChain) }
      ),
    } as any;
    registerDirectMemoryCommands(bot as any, { supabase });

    const ctx = mockCtx({ chatId: 66666, match: "" });
    await bot._triggerCommand("reminders", ctx);

    const orCallsWithChatIdScope = orFn.mock.calls.filter((args: string[]) =>
      args[0]?.includes("chat_id.eq.66666")
    );
    expect(orCallsWithChatIdScope.length).toBeGreaterThan(0);
  });
});
