/**
 * Tests for routineHandler — /routines command (System A)
 *
 * Run: bun test src/routines/routineHandler.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { Context } from "grammy";

// ============================================================
// Mock routineManager before importing handler
// ============================================================

const mockListAllRoutines = mock(() => ({ core: [], user: [] }));
const mockIsCoreRoutine = mock((_name: string) => false);
const mockAddUserRoutine = mock(() => Promise.resolve());
const mockUpdateUserRoutine = mock(() => Promise.resolve());
const mockDeleteUserRoutine = mock(() => Promise.resolve());
const mockSetRoutineEnabled = mock(() => Promise.resolve());
const mockTriggerRoutine = mock(() => Promise.resolve());

mock.module("./routineManager.ts", () => ({
  listAllRoutines: mockListAllRoutines,
  isCoreRoutine: mockIsCoreRoutine,
  addUserRoutine: mockAddUserRoutine,
  updateUserRoutine: mockUpdateUserRoutine,
  deleteUserRoutine: mockDeleteUserRoutine,
  setRoutineEnabled: mockSetRoutineEnabled,
  triggerRoutine: mockTriggerRoutine,
}));

mock.module("../config/groups.ts", () => ({
  GROUPS: {
    OPERATIONS: { chatId: 111, topicId: null },
    ENGINEERING: { chatId: 222, topicId: null },
  },
}));

mock.module("../utils/saveMessage.ts", () => ({
  saveCommandInteraction: mock(() => Promise.resolve()),
}));

const { handleRoutinesCommand, detectAndHandle } = await import("./routineHandler.ts");
const { detectRunRoutineIntent } = await import("./intentExtractor.ts");

// ============================================================
// Context factory
// ============================================================

function mockCtx(overrides?: object): Context {
  return {
    chat: { id: 12345 },
    from: { id: 99999 },
    match: "",
    reply: mock(() => Promise.resolve()),
    editMessageText: mock(() => Promise.resolve()),
    answerCallbackQuery: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as Context;
}

function replyText(ctx: Context, callIdx = 0): string {
  return (ctx.reply as ReturnType<typeof mock>).mock.calls[callIdx][0] as string;
}

// ============================================================
// Reset before each test
// ============================================================

beforeEach(() => {
  for (const m of [mockListAllRoutines, mockIsCoreRoutine, mockAddUserRoutine,
    mockUpdateUserRoutine, mockDeleteUserRoutine, mockSetRoutineEnabled, mockTriggerRoutine]) {
    m.mockReset();
  }
  mockListAllRoutines.mockReturnValue({ core: [], user: [] });
  mockIsCoreRoutine.mockReturnValue(false);
});

// ============================================================
// /routines list
// ============================================================

describe("handleRoutinesCommand — list", () => {
  test("empty state shows none messages", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "list");
    const text = replyText(ctx);
    expect(text).toContain("Core Routines");
    expect(text).toContain("User Routines");
    expect(text).toContain("(none");
  });

  test("shows core routine with schedule", async () => {
    mockListAllRoutines.mockReturnValue({
      core: [{ name: "watchdog", type: "handler", schedule: "0 */2 * * *", group: "OPERATIONS", enabled: true }],
      user: [],
    });
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "list");
    const text = replyText(ctx);
    expect(text).toContain("watchdog");
    expect(text).toContain("0 */2 * * *");
  });

  test("shows user prompt routine with [prompt] tag", async () => {
    mockListAllRoutines.mockReturnValue({
      core: [],
      user: [{ name: "daily-aws", type: "prompt", schedule: "0 9 * * *", group: "PERSONAL", enabled: true, prompt: "Check costs" }],
    });
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "");
    const text = replyText(ctx);
    expect(text).toContain("daily-aws");
    expect(text).toContain("[prompt]");
  });

  test("disabled routine shows ⏹ icon", async () => {
    mockListAllRoutines.mockReturnValue({
      core: [{ name: "watchdog", type: "handler", schedule: "0 */2 * * *", group: "OPERATIONS", enabled: false }],
      user: [],
    });
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "list");
    expect(replyText(ctx)).toContain("⏹");
  });
});

// ============================================================
// /routines run
// ============================================================

describe("handleRoutinesCommand — run", () => {
  test("run calls triggerRoutine", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "run watchdog");
    expect(mockTriggerRoutine).toHaveBeenCalledWith("watchdog");
    expect(replyText(ctx)).toContain("watchdog");
  });

  test("run with no name shows usage", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "run");
    expect(replyText(ctx)).toContain("Usage:");
    expect(mockTriggerRoutine).not.toHaveBeenCalled();
  });

  test("triggerRoutine error is surfaced", async () => {
    mockTriggerRoutine.mockReturnValue(Promise.reject(new Error("queue down")));
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "run watchdog");
    expect(replyText(ctx)).toContain("queue down");
  });
});

// ============================================================
// /routines enable / disable
// ============================================================

describe("handleRoutinesCommand — enable/disable", () => {
  test("enable calls setRoutineEnabled(name, true)", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "enable watchdog");
    expect(mockSetRoutineEnabled).toHaveBeenCalledWith("watchdog", true);
  });

  test("disable calls setRoutineEnabled(name, false)", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "disable watchdog");
    expect(mockSetRoutineEnabled).toHaveBeenCalledWith("watchdog", false);
  });

  test("enable with no name shows usage", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "enable");
    expect(replyText(ctx)).toContain("Usage:");
  });
});

// ============================================================
// /routines edit
// ============================================================

describe("handleRoutinesCommand — edit", () => {
  test("edit core routine is blocked", async () => {
    mockIsCoreRoutine.mockReturnValue(true);
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "edit watchdog");
    expect(replyText(ctx)).toContain("core routine");
    expect(replyText(ctx)).toContain("enable/disable");
  });

  test("edit user routine sends inline keyboard", async () => {
    mockIsCoreRoutine.mockReturnValue(false);
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "edit daily-aws");
    expect(ctx.reply).toHaveBeenCalled();
    // reply_markup should be set (InlineKeyboard)
    const call = (ctx.reply as ReturnType<typeof mock>).mock.calls[0];
    expect(call[1]).toBeDefined(); // options object with reply_markup
  });

  test("edit with no name shows usage", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "edit");
    expect(replyText(ctx)).toContain("Usage:");
  });
});

// ============================================================
// /routines delete
// ============================================================

describe("handleRoutinesCommand — delete", () => {
  test("delete core routine is blocked", async () => {
    mockIsCoreRoutine.mockReturnValue(true);
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "delete watchdog");
    expect(replyText(ctx)).toContain("cannot be deleted");
    expect(mockDeleteUserRoutine).not.toHaveBeenCalled();
  });

  test("delete user routine calls deleteUserRoutine", async () => {
    mockIsCoreRoutine.mockReturnValue(false);
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "delete daily-aws");
    expect(mockDeleteUserRoutine).toHaveBeenCalledWith("daily-aws");
    expect(replyText(ctx)).toContain("deleted");
  });

  test("delete with no name shows usage", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "delete");
    expect(replyText(ctx)).toContain("Usage:");
  });

  test("deleteUserRoutine error is surfaced", async () => {
    mockIsCoreRoutine.mockReturnValue(false);
    mockDeleteUserRoutine.mockReturnValue(Promise.reject(new Error("not found")));
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "delete ghost");
    expect(replyText(ctx)).toContain("not found");
  });
});

// ============================================================
// /routines new-handler
// ============================================================

test("new-handler sends guide with code block", async () => {
  const ctx = mockCtx();
  await handleRoutinesCommand(ctx, "new-handler");
  const text = replyText(ctx);
  expect(text).toContain("bun-script routine");
  expect(text).toContain("run(ctx)");
});

// ============================================================
// Unknown subcommand
// ============================================================

test("unknown subcommand shows help text", async () => {
  const ctx = mockCtx();
  await handleRoutinesCommand(ctx, "foobar");
  const text = replyText(ctx);
  expect(text).toContain("/routines list");
  expect(text).toContain("/routines run");
  expect(text).toContain("/routines edit");
});

// ============================================================
// detectAndHandle() — run-intent
// ============================================================

describe("detectAndHandle() — run-intent", () => {
  test("run intent with single match triggers", async () => {
    mockListAllRoutines.mockReturnValue({
      core: [{ name: "watchdog", type: "handler", schedule: "0 */2 * * *", group: "OPERATIONS", enabled: true }],
      user: [],
    });
    mockTriggerRoutine.mockReturnValue(Promise.resolve());

    const ctx = mockCtx({ chat: { id: 80001 } });
    const result = await detectAndHandle(ctx, "run watchdog routine now");
    expect(result).toBe(true);
    expect(mockTriggerRoutine).toHaveBeenCalledWith("watchdog");
  });

  test("run intent with no match replies not found", async () => {
    mockListAllRoutines.mockReturnValue({ core: [], user: [] });
    const ctx = mockCtx({ chat: { id: 80002 } });
    const result = await detectAndHandle(ctx, "run banana routine now");
    expect(result).toBe(true);
    expect(replyText(ctx)).toContain("No routine found");
  });

  test("non-intent message falls through", async () => {
    const ctx = mockCtx({ chat: { id: 80003 } });
    const result = await detectAndHandle(ctx, "what is the weather?");
    expect(result).toBe(false);
  });
});

// ============================================================
// detectRunRoutineIntent() unit tests
// ============================================================

describe("detectRunRoutineIntent()", () => {
  test("detects run phrases", () => {
    expect(detectRunRoutineIntent("run the watchdog routine now")).not.toBeNull();
    expect(detectRunRoutineIntent("trigger morning-briefing")).not.toBeNull();
    expect(detectRunRoutineIntent("execute watchdog routine immediately")).not.toBeNull();
  });

  test("returns null for unrelated messages", () => {
    expect(detectRunRoutineIntent("what's the weather?")).toBeNull();
    expect(detectRunRoutineIntent("hello")).toBeNull();
    expect(detectRunRoutineIntent("create a routine")).toBeNull();
  });
});
