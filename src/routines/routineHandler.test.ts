/**
 * Tests for routineHandler — /routines command subcommands
 *
 * Run: bun test src/routines/routineHandler.test.ts
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { Context } from "grammy";

// ============================================================
// Mock routineManager before importing handler
// ============================================================

const mockListUserRoutines = mock(() => Promise.resolve([]));
const mockListCodeRoutines = mock(() => Promise.resolve([]));
const mockCreateRoutine = mock(() => Promise.resolve());
const mockDeleteRoutine = mock(() => Promise.resolve());
const mockRegisterCodeRoutine = mock(() => Promise.resolve());
const mockUpdateCodeRoutineCron = mock(() => Promise.resolve());
const mockToggleCodeRoutine = mock(() => Promise.resolve());
const mockTriggerCodeRoutine = mock(() => Promise.resolve());

mock.module("./routineManager.ts", () => ({
  listUserRoutines: mockListUserRoutines,
  listCodeRoutines: mockListCodeRoutines,
  createRoutine: mockCreateRoutine,
  deleteRoutine: mockDeleteRoutine,
  registerCodeRoutine: mockRegisterCodeRoutine,
  updateCodeRoutineCron: mockUpdateCodeRoutineCron,
  toggleCodeRoutine: mockToggleCodeRoutine,
  triggerCodeRoutine: mockTriggerCodeRoutine,
}));

// Import handler and intent extractor after mocks are set up
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

// ============================================================
// Reset mocks before each test
// ============================================================

beforeEach(() => {
  mockListUserRoutines.mockReset();
  mockListCodeRoutines.mockReset();
  mockCreateRoutine.mockReset();
  mockDeleteRoutine.mockReset();
  mockRegisterCodeRoutine.mockReset();
  mockUpdateCodeRoutineCron.mockReset();
  mockToggleCodeRoutine.mockReset();
  mockTriggerCodeRoutine.mockReset();

  mockListUserRoutines.mockReturnValue(Promise.resolve([]));
  mockListCodeRoutines.mockReturnValue(Promise.resolve([]));
});

// ============================================================
// Tests
// ============================================================

describe("handleRoutinesCommand", () => {
  // ---- /routines (no args) ----

  test("no args calls reply with help/list", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "");
    expect(ctx.reply).toHaveBeenCalled();
  });

  // ---- /routines list ----

  test("list with no routines shows none", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "list");
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("(none");
  });

  test("list with code routines shows System Routines", async () => {
    mockListCodeRoutines.mockReturnValue(
      Promise.resolve([
        {
          name: "morning-briefing",
          scriptPath: "routines/morning-briefing.ts",
          cron: "0 7 * * *",
          registered: true,
          pm2Status: "online",
          description: "Morning summary",
        },
      ])
    );
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "list");
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("System Routines");
  });

  test("list with unregistered code routines sends registration keyboard", async () => {
    mockListCodeRoutines.mockReturnValue(
      Promise.resolve([
        {
          name: "aws-daily-cost",
          scriptPath: "routines/aws-daily-cost.ts",
          cron: null,
          registered: false,
          pm2Status: null,
        },
      ])
    );
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "list");
    // Should call reply twice: once for the list, once for the registration prompt
    expect((ctx.reply as ReturnType<typeof mock>).mock.calls.length).toBe(2);
  });

  // ---- /routines delete ----

  test("delete with no name replies with usage", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "delete");
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("Usage:");
  });

  test("delete a code routine tells user to use coding session", async () => {
    mockListCodeRoutines.mockReturnValue(
      Promise.resolve([
        {
          name: "morning-briefing",
          scriptPath: "routines/morning-briefing.ts",
          cron: "0 7 * * *",
          registered: true,
          pm2Status: "online",
        },
      ])
    );
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "delete morning-briefing");
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("coding session");
  });

  // ---- /routines run ----

  test("run with name calls triggerCodeRoutine", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "run my-routine");
    expect(mockTriggerCodeRoutine).toHaveBeenCalledWith("my-routine");
  });

  test("run with no name replies with usage", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "run");
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("Usage:");
  });

  // ---- /routines enable / disable ----

  test("enable calls toggleCodeRoutine with true", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "enable my-routine");
    expect(mockToggleCodeRoutine).toHaveBeenCalledWith("my-routine", true);
  });

  test("disable calls toggleCodeRoutine with false", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "disable my-routine");
    expect(mockToggleCodeRoutine).toHaveBeenCalledWith("my-routine", false);
  });

  // ---- /routines schedule ----

  test("schedule updates cron for named routine", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "schedule my-routine 0 9 * * *");
    expect(mockUpdateCodeRoutineCron).toHaveBeenCalledWith("my-routine", "0 9 * * *");
  });

  test("schedule with invalid cron replies with error", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "schedule my-routine invalid");
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("Invalid cron");
  });

  // ---- /routines register ----

  test("register with cron calls registerCodeRoutine", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "register my-routine 0 9 * * *");
    expect(mockRegisterCodeRoutine).toHaveBeenCalledWith("my-routine", "0 9 * * *");
  });

  test("register with no cron asks for cron expression", async () => {
    // Use a unique chatId so the pending registration doesn't leak into other tests
    const ctx = mockCtx({ chat: { id: 77777 } });
    await handleRoutinesCommand(ctx, "register my-routine");
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("cron expression");
    // Clean up: send a valid cron to clear the pending registration
    const cleanupCtx = mockCtx({ chat: { id: 77777 } });
    await handleRoutinesCommand(cleanupCtx, "0 9 * * *");
  });

  // ---- /routines status ----

  test("status shows routine names", async () => {
    mockListCodeRoutines.mockReturnValue(
      Promise.resolve([
        {
          name: "morning-briefing",
          scriptPath: "routines/morning-briefing.ts",
          cron: "0 7 * * *",
          registered: true,
          pm2Status: "online",
        },
        {
          name: "aws-daily-cost",
          scriptPath: "routines/aws-daily-cost.ts",
          cron: null,
          registered: false,
          pm2Status: null,
        },
      ])
    );
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "status");
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("morning-briefing");
    expect(replyText).toContain("aws-daily-cost");
  });

  // ---- unknown subcommand ----

  test("unknown subcommand shows help text", async () => {
    const ctx = mockCtx();
    await handleRoutinesCommand(ctx, "foobar");
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("/routines list");
    expect(replyText).toContain("/routines run");
  });
});

// ============================================================
// detectAndHandle() — pending registration flow
// ============================================================

// Helper: put a chatId into pendingRegistrations by calling the register command
// without a cron. Uses a dedicated chatId per test to avoid state bleed.
async function putInPending(chatId: number, routineName = "aws-daily-cost"): Promise<ReturnType<typeof mockCtx>> {
  const ctx = mockCtx({ chat: { id: chatId } });
  await handleRoutinesCommand(ctx, `register ${routineName}`);
  return ctx;
}

describe("detectAndHandle() — pending registration flow", () => {
  // Use a unique base chatId range so tests don't collide with each other
  // or with the handleRoutinesCommand tests above.
  const BASE_ID = 50000;

  // --- Test 1: valid cron registers the routine ---
  test("valid cron registers the routine", async () => {
    const chatId = BASE_ID + 1;
    await putInPending(chatId, "aws-daily-cost");
    mockRegisterCodeRoutine.mockReset();
    mockRegisterCodeRoutine.mockReturnValue(Promise.resolve());

    const ctx = mockCtx({ chat: { id: chatId } });
    const result = await detectAndHandle(ctx, "0 9 * * *");

    expect(result).toBe(true);
    expect(mockRegisterCodeRoutine).toHaveBeenCalledWith("aws-daily-cost", "0 9 * * *");
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("✅");
  });

  // --- Test 2: valid cron with extra whitespace is normalized ---
  test("valid cron with extra whitespace is normalized", async () => {
    const chatId = BASE_ID + 2;
    await putInPending(chatId, "aws-daily-cost");
    mockRegisterCodeRoutine.mockReset();
    mockRegisterCodeRoutine.mockReturnValue(Promise.resolve());

    const ctx = mockCtx({ chat: { id: chatId } });
    const result = await detectAndHandle(ctx, "  0 9 * * *  ");

    expect(result).toBe(true);
    expect(mockRegisterCodeRoutine).toHaveBeenCalledWith("aws-daily-cost", "0 9 * * *");
  });

  // --- Test 3: irrelevant natural language prompt does NOT go to Claude ---
  test("irrelevant natural language prompt is intercepted and does not fall through", async () => {
    const chatId = BASE_ID + 3;
    await putInPending(chatId, "aws-daily-cost");

    const ctx = mockCtx({ chat: { id: chatId } });
    const result = await detectAndHandle(ctx, "what's the weather today?");

    expect(result).toBe(true); // Intercepted — does NOT fall through to Claude
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("Still waiting");
    expect(replyText).toContain("cancel");

    // Cleanup: cancel the pending registration
    const cleanupCtx = mockCtx({ chat: { id: chatId } });
    await detectAndHandle(cleanupCtx, "cancel");
  });

  // --- Test 4: invalid cron (too few fields) ---
  test("invalid cron with too few fields replies with Still waiting", async () => {
    const chatId = BASE_ID + 4;
    await putInPending(chatId, "aws-daily-cost");

    const ctx = mockCtx({ chat: { id: chatId } });
    const result = await detectAndHandle(ctx, "0 9 *");

    expect(result).toBe(true);
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("Still waiting");

    // Cleanup
    const cleanupCtx = mockCtx({ chat: { id: chatId } });
    await detectAndHandle(cleanupCtx, "cancel");
  });

  // --- Test 5: invalid cron (empty string) ---
  test("empty string is treated as invalid cron", async () => {
    const chatId = BASE_ID + 5;
    await putInPending(chatId, "aws-daily-cost");

    const ctx = mockCtx({ chat: { id: chatId } });
    const result = await detectAndHandle(ctx, "");

    expect(result).toBe(true);
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("Still waiting");

    // Cleanup
    const cleanupCtx = mockCtx({ chat: { id: chatId } });
    await detectAndHandle(cleanupCtx, "cancel");
  });

  // --- Test 6: user types "cancel" clears pending ---
  test("cancel keyword clears pending registration", async () => {
    const chatId = BASE_ID + 6;
    await putInPending(chatId, "aws-daily-cost");
    mockRegisterCodeRoutine.mockReset();

    const ctx = mockCtx({ chat: { id: chatId } });
    const result = await detectAndHandle(ctx, "cancel");

    expect(result).toBe(true);
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("cancelled");
    expect(mockRegisterCodeRoutine).not.toHaveBeenCalled();

    // Verify pending is cleared: subsequent valid cron should NOT be intercepted
    // (it falls through since pending is gone and "0 9 * * *" has no routine intent)
    const followupCtx = mockCtx({ chat: { id: chatId } });
    const followupResult = await detectAndHandle(followupCtx, "0 9 * * *");
    expect(followupResult).toBe(false); // Falls through — not caught by pending check
  });

  // --- Test 7: user types "no" is same as cancel ---
  test("no keyword clears pending registration", async () => {
    const chatId = BASE_ID + 7;
    await putInPending(chatId, "aws-daily-cost");
    mockRegisterCodeRoutine.mockReset();

    const ctx = mockCtx({ chat: { id: chatId } });
    const result = await detectAndHandle(ctx, "no");

    expect(result).toBe(true);
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("cancelled");
    expect(mockRegisterCodeRoutine).not.toHaveBeenCalled();
  });

  // --- Test 8: registerCodeRoutine throws, error is sent and pending is cleared ---
  test("registerCodeRoutine throwing sends error reply and clears pending", async () => {
    const chatId = BASE_ID + 8;
    await putInPending(chatId, "aws-daily-cost");
    mockRegisterCodeRoutine.mockReset();
    mockRegisterCodeRoutine.mockReturnValue(Promise.reject(new Error("PM2 unavailable")));

    const ctx = mockCtx({ chat: { id: chatId } });
    const result = await detectAndHandle(ctx, "0 9 * * *");

    expect(result).toBe(true);
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("PM2 unavailable");

    // Verify pending is cleared after error: next call is not intercepted
    mockRegisterCodeRoutine.mockReturnValue(Promise.resolve());
    const followupCtx = mockCtx({ chat: { id: chatId } });
    const followupResult = await detectAndHandle(followupCtx, "0 9 * * *");
    // After error clears pending, "0 9 * * *" has no routine intent so falls through
    expect(followupResult).toBe(false);
  });

  // --- Test 9: successful registration clears pending (no double-register) ---
  test("successful registration clears pending so second cron is not intercepted", async () => {
    const chatId = BASE_ID + 9;
    await putInPending(chatId, "aws-daily-cost");
    mockRegisterCodeRoutine.mockReset();
    mockRegisterCodeRoutine.mockReturnValue(Promise.resolve());

    // First call — registers and clears pending
    const ctx1 = mockCtx({ chat: { id: chatId } });
    const result1 = await detectAndHandle(ctx1, "0 9 * * *");
    expect(result1).toBe(true);
    expect(mockRegisterCodeRoutine).toHaveBeenCalledTimes(1);

    // Second call — pending is gone; "0 9 * * *" has no routine intent
    const ctx2 = mockCtx({ chat: { id: chatId } });
    const result2 = await detectAndHandle(ctx2, "0 9 * * *");
    expect(result2).toBe(false); // Falls through
    expect(mockRegisterCodeRoutine).toHaveBeenCalledTimes(1); // Not called again
  });

  // --- Test 10: no pending registration — falls through normally ---
  test("no pending registration causes detectAndHandle to fall through", async () => {
    const chatId = BASE_ID + 10;
    // Do NOT call putInPending — no pending state for this chatId

    const ctx = mockCtx({ chat: { id: chatId } });
    const result = await detectAndHandle(ctx, "0 9 * * *");

    expect(result).toBe(false); // Not intercepted — let Claude handle
  });
});

// ============================================================
// detectRunRoutineIntent() — unit tests
// ============================================================

describe("detectRunRoutineIntent()", () => {
  test("detects 'run night summary routine now'", () => {
    const result = detectRunRoutineIntent("run night summary routine now");
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain("night summary");
  });

  test("detects 'trigger the morning briefing routine'", () => {
    const result = detectRunRoutineIntent("trigger the morning briefing routine");
    expect(result).not.toBeNull();
  });

  test("detects 'execute watchdog routine immediately'", () => {
    const result = detectRunRoutineIntent("execute watchdog routine immediately");
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain("watchdog");
  });

  test("detects 'start the etf routine now'", () => {
    const result = detectRunRoutineIntent("start the etf routine now");
    expect(result).not.toBeNull();
  });

  test("returns null for unrelated messages", () => {
    expect(detectRunRoutineIntent("what's the weather today?")).toBeNull();
    expect(detectRunRoutineIntent("hello")).toBeNull();
    expect(detectRunRoutineIntent("tell me about routines")).toBeNull();
  });

  test("returns null for creation intent", () => {
    // "run every day" matches ROUTINE_INTENT_PATTERNS (creation), not run-intent
    expect(detectRunRoutineIntent("create a routine that runs every day")).toBeNull();
  });
});

// ============================================================
// detectAndHandle() — run-intent flow
// ============================================================

describe("detectAndHandle() — run-intent flow", () => {
  const BASE_ID = 60000;

  test("run intent with single match triggers the routine", async () => {
    const chatId = BASE_ID + 1;
    mockListCodeRoutines.mockReturnValue(
      Promise.resolve([
        { name: "night-summary", scriptPath: "routines/night-summary.ts", cron: "0 23 * * *", registered: true, pm2Status: "online" },
        { name: "morning-briefing", scriptPath: "routines/morning-briefing.ts", cron: "0 7 * * *", registered: true, pm2Status: "online" },
      ])
    );
    mockTriggerCodeRoutine.mockReset();
    mockTriggerCodeRoutine.mockReturnValue(Promise.resolve());

    const ctx = mockCtx({ chat: { id: chatId } });
    const result = await detectAndHandle(ctx, "run night summary routine now");

    expect(result).toBe(true);
    expect(mockTriggerCodeRoutine).toHaveBeenCalledWith("night-summary");
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("night-summary");
    expect(replyText).toContain("Done");
  });

  test("run intent with no match replies with not found", async () => {
    const chatId = BASE_ID + 2;
    mockListCodeRoutines.mockReturnValue(
      Promise.resolve([
        { name: "night-summary", scriptPath: "routines/night-summary.ts", cron: "0 23 * * *", registered: true, pm2Status: "online" },
      ])
    );

    const ctx = mockCtx({ chat: { id: chatId } });
    const result = await detectAndHandle(ctx, "run banana routine now");

    expect(result).toBe(true);
    expect(mockTriggerCodeRoutine).not.toHaveBeenCalled();
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("No routine found");
    expect(replyText).toContain("/routines list");
  });

  test("run intent with trigger error replies with error message", async () => {
    const chatId = BASE_ID + 3;
    mockListCodeRoutines.mockReturnValue(
      Promise.resolve([
        { name: "night-summary", scriptPath: "routines/night-summary.ts", cron: "0 23 * * *", registered: true, pm2Status: "online" },
      ])
    );
    mockTriggerCodeRoutine.mockReset();
    mockTriggerCodeRoutine.mockReturnValue(Promise.reject(new Error("PM2 crashed")));

    const ctx = mockCtx({ chat: { id: chatId } });
    const result = await detectAndHandle(ctx, "run night summary routine now");

    expect(result).toBe(true);
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("PM2 crashed");
  });

  test("non-run-intent message falls through", async () => {
    const chatId = BASE_ID + 4;
    const ctx = mockCtx({ chat: { id: chatId } });
    const result = await detectAndHandle(ctx, "what's the weather today?");

    expect(result).toBe(false);
  });

  test("test-named routines are excluded and do not cause false ambiguity", async () => {
    // Simulates listCodeRoutines() already filtering out .test.ts files at source,
    // so the mock should only return non-test entries. This test verifies the
    // handler resolves to a single match (no false ambiguity) even when a
    // .test entry would otherwise share the same prefix.
    const chatId = BASE_ID + 6;
    mockListCodeRoutines.mockReturnValue(
      Promise.resolve([
        // Only the real routine — .test variant filtered at source by routineManager
        { name: "night-summary", scriptPath: "routines/night-summary.ts", cron: "0 23 * * *", registered: true, pm2Status: "online" },
      ])
    );
    mockTriggerCodeRoutine.mockReset();
    mockTriggerCodeRoutine.mockReturnValue(Promise.resolve());

    const ctx = mockCtx({ chat: { id: chatId } });
    const result = await detectAndHandle(ctx, "run night summary routine now");

    expect(result).toBe(true);
    // Must trigger exactly the real routine — no ambiguity from night-summary.test
    expect(mockTriggerCodeRoutine).toHaveBeenCalledWith("night-summary");
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).not.toContain("Multiple routines");
    expect(replyText).toContain("Done");
  });

  test("run intent with multiple matches replies with disambiguation", async () => {
    const chatId = BASE_ID + 5;
    mockListCodeRoutines.mockReturnValue(
      Promise.resolve([
        { name: "night-summary", scriptPath: "routines/night-summary.ts", cron: "0 23 * * *", registered: true, pm2Status: "online" },
        { name: "night-checkin", scriptPath: "routines/night-checkin.ts", cron: "0 22 * * *", registered: true, pm2Status: "online" },
      ])
    );

    const ctx = mockCtx({ chat: { id: chatId } });
    const result = await detectAndHandle(ctx, "run night routine now");

    expect(result).toBe(true);
    expect(mockTriggerCodeRoutine).not.toHaveBeenCalled();
    const replyText = (ctx.reply as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(replyText).toContain("Multiple routines");
  });
});
