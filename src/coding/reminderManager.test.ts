import { describe, test, expect, mock, beforeEach } from "bun:test";
import { ReminderManager } from "./reminderManager.ts";
import type { CodingSession } from "./types.ts";
import type { Bot } from "grammy";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockBot() {
  const mockSendMessage = mock(async () => ({ message_id: 1 }));
  const bot = {
    api: { sendMessage: mockSendMessage },
  } as unknown as Bot;
  return { bot, mockSendMessage };
}

function makeQuestionSession(overrides: Partial<CodingSession> = {}): CodingSession {
  return {
    id: "sess_q",
    chatId: 12345,
    directory: "/Users/test/project",
    projectName: "test-project",
    task: "Implement feature X",
    status: "waiting_for_input",
    useAgentTeam: false,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    filesChanged: [],
    source: "bot",
    pendingQuestion: {
      questionMessageId: 1,
      questionText: "What should we do?",
      options: ["Option A", "Option B"],
      toolUseId: "toolu_1",
      askedAt: new Date().toISOString(),
    },
    pendingPlanApproval: undefined,
    ...overrides,
  };
}

function makePlanSession(overrides: Partial<CodingSession> = {}): CodingSession {
  return {
    id: "sess_p",
    chatId: 12345,
    directory: "/Users/test/project",
    projectName: "test-project",
    task: "Deploy to production",
    status: "waiting_for_plan",
    useAgentTeam: false,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    filesChanged: [],
    source: "bot",
    pendingQuestion: undefined,
    pendingPlanApproval: {
      planMessageIds: [10, 11],
      planText: "Step 1: install\nStep 2: deploy",
      requestId: "req_1",
      askedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

/** Wait for pending microtasks and timers with a 1ms delay. */
async function waitForTimer(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReminderManager", () => {
  let manager: ReminderManager;

  beforeEach(() => {
    manager = new ReminderManager();
  });

  describe("cancelReminder", () => {
    test("cancelling a timer that was never scheduled does not throw", () => {
      expect(() => manager.cancelReminder("nonexistent-session-id")).not.toThrow();
    });

    test("cancelling twice does not throw", async () => {
      const { bot } = createMockBot();
      const session = makeQuestionSession();
      manager.scheduleReminder(session, bot, 5000);
      manager.cancelReminder(session.id);
      expect(() => manager.cancelReminder(session.id)).not.toThrow();
    });
  });

  describe("cancelAll", () => {
    test("cancelAll with no scheduled timers does not throw", () => {
      expect(() => manager.cancelAll()).not.toThrow();
    });

    test("cancelAll clears all pending timers", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const s1 = makeQuestionSession({ id: "sess_1" });
      const s2 = makePlanSession({ id: "sess_2" });

      manager.scheduleReminder(s1, bot, 1);
      manager.scheduleReminder(s2, bot, 1);
      manager.cancelAll();

      await waitForTimer();

      // Neither reminder should have fired
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test("cancelAll can be called multiple times without error", () => {
      const { bot } = createMockBot();
      const session = makeQuestionSession();
      manager.scheduleReminder(session, bot, 5000);
      manager.cancelAll();
      expect(() => manager.cancelAll()).not.toThrow();
    });
  });

  describe("scheduleReminder", () => {
    test("replaces existing timer when scheduled twice for same session", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const session = makeQuestionSession();

      // Schedule first with a long delay (won't fire in test)
      manager.scheduleReminder(session, bot, 60_000);
      // Schedule again with short delay — old timer should be cancelled
      manager.scheduleReminder(session, bot, 1);

      await waitForTimer();

      // Only one sendMessage call (from the second timer)
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    test("cancelReminder BEFORE timer fires prevents callback", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const session = makeQuestionSession();

      manager.scheduleReminder(session, bot, 1);
      manager.cancelReminder(session.id);

      await waitForTimer();

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test("cancelAll BEFORE timer fires prevents all callbacks", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const s1 = makeQuestionSession({ id: "s1" });
      const s2 = makePlanSession({ id: "s2" });

      manager.scheduleReminder(s1, bot, 1);
      manager.scheduleReminder(s2, bot, 1);
      manager.cancelAll();

      await waitForTimer();

      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe("reminder firing — question sessions", () => {
    test("fires sendQuestionReminder when session has pendingQuestion and no reminderSentAt", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const session = makeQuestionSession();

      manager.scheduleReminder(session, bot, 1);
      await waitForTimer();

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      const [chatId, messageText] = mockSendMessage.mock.calls[0];
      expect(chatId).toBe(session.chatId);
      expect(messageText).toContain("Reminder");
      expect(messageText).toContain(session.projectName);
      expect(messageText).toContain("What should we do?");
    });

    test("question reminder message includes inline keyboard with option buttons", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const session = makeQuestionSession();

      manager.scheduleReminder(session, bot, 1);
      await waitForTimer();

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      const [_chatId, _text, options] = mockSendMessage.mock.calls[0];
      const keyboard = (options as { reply_markup: { inline_keyboard: unknown[][] } }).reply_markup
        .inline_keyboard;
      expect(keyboard.length).toBeGreaterThan(0);

      // First row should have option buttons
      const firstRow = keyboard[0] as Array<{ text: string; callback_data: string }>;
      const optionTexts = firstRow.map((btn) => btn.text);
      expect(optionTexts).toContain("Option A");
      expect(optionTexts).toContain("Option B");
    });

    test("question reminder keyboard always includes 'Custom answer' and 'Claude decides'", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const session = makeQuestionSession();

      manager.scheduleReminder(session, bot, 1);
      await waitForTimer();

      const [_chatId, _text, options] = mockSendMessage.mock.calls[0];
      const keyboard = (options as { reply_markup: { inline_keyboard: unknown[][] } }).reply_markup
        .inline_keyboard;
      const allButtons = keyboard.flat() as Array<{ text: string; callback_data: string }>;
      const buttonTexts = allButtons.map((btn) => btn.text);
      expect(buttonTexts.some((t) => t.includes("Custom answer"))).toBe(true);
      expect(buttonTexts.some((t) => t.includes("Claude decides"))).toBe(true);
    });

    test("does NOT fire if pendingQuestion.reminderSentAt is already set", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const session = makeQuestionSession({
        pendingQuestion: {
          questionMessageId: 1,
          questionText: "What should we do?",
          options: [],
          toolUseId: "toolu_1",
          askedAt: new Date().toISOString(),
          reminderSentAt: new Date().toISOString(), // already reminded
        },
      });

      manager.scheduleReminder(session, bot, 1);
      await waitForTimer();

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test("marks reminderSentAt on pendingQuestion after firing", async () => {
      const { bot } = createMockBot();
      const session = makeQuestionSession();

      manager.scheduleReminder(session, bot, 1);
      await waitForTimer();

      expect(session.pendingQuestion?.reminderSentAt).toBeDefined();
    });

    test("question reminder callback_data contains session ID and toolUseId", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const session = makeQuestionSession();

      manager.scheduleReminder(session, bot, 1);
      await waitForTimer();

      const [_chatId, _text, options] = mockSendMessage.mock.calls[0];
      const keyboard = (options as { reply_markup: { inline_keyboard: unknown[][] } }).reply_markup
        .inline_keyboard;
      const allButtons = keyboard.flat() as Array<{ text: string; callback_data: string }>;
      const skipBtn = allButtons.find((btn) => btn.callback_data.includes("skip"));
      expect(skipBtn).toBeDefined();
      expect(skipBtn!.callback_data).toContain(session.id);
      expect(skipBtn!.callback_data).toContain("toolu_1");
    });

    test("session with no options still fires reminder (just no option buttons)", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const session = makeQuestionSession({
        pendingQuestion: {
          questionMessageId: 1,
          questionText: "What do you think?",
          options: [],
          toolUseId: "toolu_no_opts",
          askedAt: new Date().toISOString(),
        },
      });

      manager.scheduleReminder(session, bot, 1);
      await waitForTimer();

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      const [_chatId, _text, options] = mockSendMessage.mock.calls[0];
      const keyboard = (options as { reply_markup: { inline_keyboard: unknown[][] } }).reply_markup
        .inline_keyboard;
      // Should still have the custom/skip row but no option row
      expect(keyboard.length).toBe(1);
    });
  });

  describe("reminder firing — plan approval sessions", () => {
    test("fires sendPlanReminder when session has pendingPlanApproval and no reminderSentAt", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const session = makePlanSession();

      manager.scheduleReminder(session, bot, 1);
      await waitForTimer();

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      const [chatId, messageText] = mockSendMessage.mock.calls[0];
      expect(chatId).toBe(session.chatId);
      expect(messageText).toContain("Reminder");
      expect(messageText).toContain(session.projectName);
      expect(messageText).toContain("needs plan approval");
    });

    test("plan reminder includes plan text preview", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const session = makePlanSession();

      manager.scheduleReminder(session, bot, 1);
      await waitForTimer();

      const [_chatId, messageText] = mockSendMessage.mock.calls[0];
      expect(messageText).toContain("Step 1: install");
    });

    test("long plan text is truncated to 200 chars in reminder", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const longPlan = "X".repeat(300);
      const session = makePlanSession({
        pendingPlanApproval: {
          planMessageIds: [10],
          planText: longPlan,
          requestId: "req_long",
          askedAt: new Date().toISOString(),
        },
      });

      manager.scheduleReminder(session, bot, 1);
      await waitForTimer();

      const [_chatId, messageText] = mockSendMessage.mock.calls[0];
      // Plan preview should be truncated
      expect(messageText).toContain("...");
      // Should NOT contain the full 300-char plan
      expect(messageText).not.toContain(longPlan);
    });

    test("plan reminder keyboard includes Approve, Modify, Cancel, Trust Claude", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const session = makePlanSession();

      manager.scheduleReminder(session, bot, 1);
      await waitForTimer();

      const [_chatId, _text, options] = mockSendMessage.mock.calls[0];
      const keyboard = (options as { reply_markup: { inline_keyboard: unknown[][] } }).reply_markup
        .inline_keyboard;
      const allButtons = keyboard.flat() as Array<{ text: string; callback_data: string }>;
      const buttonTexts = allButtons.map((btn) => btn.text);
      expect(buttonTexts.some((t) => t.includes("Approve"))).toBe(true);
      expect(buttonTexts.some((t) => t.includes("Modify"))).toBe(true);
      expect(buttonTexts.some((t) => t.includes("Cancel"))).toBe(true);
      expect(buttonTexts.some((t) => t.includes("Trust Claude"))).toBe(true);
    });

    test("plan reminder callback_data contains session ID and requestId", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const session = makePlanSession();

      manager.scheduleReminder(session, bot, 1);
      await waitForTimer();

      const [_chatId, _text, options] = mockSendMessage.mock.calls[0];
      const keyboard = (options as { reply_markup: { inline_keyboard: unknown[][] } }).reply_markup
        .inline_keyboard;
      const allButtons = keyboard.flat() as Array<{ text: string; callback_data: string }>;
      const approveBtn = allButtons.find((btn) => btn.callback_data.includes("approve"));
      expect(approveBtn).toBeDefined();
      expect(approveBtn!.callback_data).toContain(session.id);
      expect(approveBtn!.callback_data).toContain("req_1");
    });

    test("does NOT fire if pendingPlanApproval.reminderSentAt is already set", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const session = makePlanSession({
        pendingPlanApproval: {
          planMessageIds: [10],
          planText: "Step 1: install",
          requestId: "req_1",
          askedAt: new Date().toISOString(),
          reminderSentAt: new Date().toISOString(), // already reminded
        },
      });

      manager.scheduleReminder(session, bot, 1);
      await waitForTimer();

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test("marks reminderSentAt on pendingPlanApproval after firing", async () => {
      const { bot } = createMockBot();
      const session = makePlanSession();

      manager.scheduleReminder(session, bot, 1);
      await waitForTimer();

      expect(session.pendingPlanApproval?.reminderSentAt).toBeDefined();
    });
  });

  describe("reminder firing — edge cases", () => {
    test("session with neither pendingQuestion nor pendingPlanApproval sends no message", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const session: CodingSession = {
        id: "sess_idle",
        chatId: 12345,
        directory: "/test",
        projectName: "idle-project",
        task: "Do nothing",
        status: "running",
        useAgentTeam: false,
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        filesChanged: [],
        source: "bot",
        pendingQuestion: undefined,
        pendingPlanApproval: undefined,
      };

      manager.scheduleReminder(session, bot, 1);
      await waitForTimer();

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test("sendMessage failure does not throw (caught silently)", async () => {
      const bot = {
        api: {
          sendMessage: mock(async () => {
            throw new Error("Telegram API error");
          }),
        },
      } as unknown as Bot;

      const session = makeQuestionSession();
      manager.scheduleReminder(session, bot, 1);

      // Should resolve without throwing
      await expect(waitForTimer()).resolves.toBeUndefined();
    });

    test("multiple independent sessions each fire their own reminder", async () => {
      const { bot, mockSendMessage } = createMockBot();
      const s1 = makeQuestionSession({ id: "multi_q", chatId: 111 });
      const s2 = makePlanSession({ id: "multi_p", chatId: 222 });

      manager.scheduleReminder(s1, bot, 1);
      manager.scheduleReminder(s2, bot, 1);

      await waitForTimer();

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      const calledChatIds = mockSendMessage.mock.calls.map(([chatId]) => chatId);
      expect(calledChatIds).toContain(111);
      expect(calledChatIds).toContain(222);
    });
  });
});
