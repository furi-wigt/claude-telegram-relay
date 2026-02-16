import { describe, test, expect, beforeEach, mock } from "bun:test";
import { InputRouter } from "./inputRouter.ts";

/** Creates a minimal mock Context for testing. */
function createMockCtx(overrides: {
  messageText?: string;
  replyToMessageId?: number;
  chatId?: number;
  callbackData?: string;
} = {}) {
  const repliedMessages: Array<{ text: string; options?: unknown }> = [];
  let callbackAnswered = false;

  return {
    ctx: {
      message: overrides.messageText !== undefined
        ? {
            text: overrides.messageText,
            reply_to_message: overrides.replyToMessageId !== undefined
              ? { message_id: overrides.replyToMessageId }
              : undefined,
          }
        : undefined,
      chat: overrides.chatId !== undefined ? { id: overrides.chatId } : undefined,
      callbackQuery: overrides.callbackData !== undefined
        ? { data: overrides.callbackData }
        : undefined,
      reply: mock(async (text: string, options?: unknown) => {
        repliedMessages.push({ text, options });
        return { message_id: 999 };
      }),
      answerCallbackQuery: mock(async () => {
        callbackAnswered = true;
      }),
    } as unknown as import("grammy").Context,
    repliedMessages,
    wasCallbackAnswered: () => callbackAnswered,
  };
}

/** Creates a mock CodingSessionManager for testing. */
function createMockSessionManager(sessions: Array<{
  id: string;
  pendingQuestion?: { questionMessageId: number; toolUseId: string };
  pendingPlanApproval?: { awaitingModificationReplyMessageId?: number; requestId: string };
}> = []) {
  return {
    answerQuestion: mock(async (_sessionId: string, _answer: string) => {}),
    approvePlan: mock(async (_sessionId: string, _approved: boolean, _mods?: string) => {}),
    killSession: mock(async (_sessionId: string) => {}),
    getStatusText: mock((_sessionId: string) => "Status: running"),
    getLogs: mock(async (_sessionId: string) => "log line 1\nlog line 2"),
    getDiff: mock(async (_sessionId: string) => "diff output"),
    listAll: mock(async (_chatId: number) => sessions),
  } as unknown as import("./sessionManager.ts").CodingSessionManager;
}

describe("InputRouter", () => {
  let router: InputRouter;

  beforeEach(() => {
    router = new InputRouter();
  });

  describe("tryRouteReply", () => {
    test("returns false for non-reply messages", async () => {
      const { ctx } = createMockCtx({ messageText: "hello", chatId: 1 });
      const sm = createMockSessionManager();

      const result = await router.tryRouteReply(ctx, sm);
      expect(result).toBe(false);
    });

    test("tryRouteReply returns false when chatId is missing", async () => {
      // Has a reply and text but NO chat/chatId — should bail out safely
      const { ctx } = createMockCtx({
        messageText: "my answer",
        replyToMessageId: 100,
        // chatId deliberately omitted
      });
      const sm = createMockSessionManager([
        {
          id: "sess_1",
          pendingQuestion: { questionMessageId: 100, toolUseId: "toolu_1" },
        },
      ]);

      const result = await router.tryRouteReply(ctx, sm);
      expect(result).toBe(false);
    });

    test("returns false when reply has no text", async () => {
      const { ctx } = createMockCtx({ replyToMessageId: 100, chatId: 1 });
      const sm = createMockSessionManager();

      const result = await router.tryRouteReply(ctx, sm);
      expect(result).toBe(false);
    });

    test("routes reply matching a pending question to the correct session", async () => {
      const { ctx } = createMockCtx({
        messageText: "Use TypeScript",
        replyToMessageId: 42,
        chatId: 1,
      });
      const sm = createMockSessionManager([
        {
          id: "sess_1",
          pendingQuestion: { questionMessageId: 42, toolUseId: "toolu_1" },
        },
      ]);

      const result = await router.tryRouteReply(ctx, sm);

      expect(result).toBe(true);
      expect(sm.answerQuestion).toHaveBeenCalledWith("sess_1", "Use TypeScript");
    });

    test("returns false when reply does not match any session", async () => {
      const { ctx } = createMockCtx({
        messageText: "answer",
        replyToMessageId: 999,
        chatId: 1,
      });
      const sm = createMockSessionManager([
        {
          id: "sess_1",
          pendingQuestion: { questionMessageId: 42, toolUseId: "toolu_1" },
        },
      ]);

      const result = await router.tryRouteReply(ctx, sm);
      expect(result).toBe(false);
    });

    test("routes reply matching a pending plan modification", async () => {
      const { ctx } = createMockCtx({
        messageText: "Add tests first",
        replyToMessageId: 55,
        chatId: 1,
      });
      const sm = createMockSessionManager([
        {
          id: "sess_2",
          pendingPlanApproval: { awaitingModificationReplyMessageId: 55, requestId: "req_1" },
        },
      ]);

      const result = await router.tryRouteReply(ctx, sm);

      expect(result).toBe(true);
      expect(sm.approvePlan).toHaveBeenCalledWith("sess_2", false, "Add tests first");
    });
  });

  describe("handleCallbackQuery", () => {
    test("returns false when no callback data", async () => {
      const { ctx } = createMockCtx({ chatId: 1 });
      const sm = createMockSessionManager();

      const result = await router.handleCallbackQuery(ctx, sm);
      expect(result).toBe(false);
    });

    test("handles code_answer:option callback", async () => {
      const base64Option = Buffer.from("Option A").toString("base64");
      const { ctx } = createMockCtx({
        callbackData: `code_answer:option:sess_1:toolu_1:${base64Option}`,
        chatId: 1,
      });
      const sm = createMockSessionManager();

      const result = await router.handleCallbackQuery(ctx, sm);

      expect(result).toBe(true);
      expect(sm.answerQuestion).toHaveBeenCalledWith("sess_1", "Option A");
    });

    test("handles code_answer:skip callback", async () => {
      const { ctx } = createMockCtx({
        callbackData: "code_answer:skip:sess_1:toolu_1",
        chatId: 1,
      });
      const sm = createMockSessionManager();

      const result = await router.handleCallbackQuery(ctx, sm);

      expect(result).toBe(true);
      expect(sm.answerQuestion).toHaveBeenCalledWith("sess_1", "Use your best judgment and continue");
    });

    test("handles code_plan:approve callback", async () => {
      const { ctx } = createMockCtx({
        callbackData: "code_plan:approve:sess_1:req_1",
        chatId: 1,
      });
      const sm = createMockSessionManager();

      const result = await router.handleCallbackQuery(ctx, sm);

      expect(result).toBe(true);
      expect(sm.approvePlan).toHaveBeenCalledWith("sess_1", true);
    });

    test("handles code_plan:trust callback (same as approve)", async () => {
      const { ctx } = createMockCtx({
        callbackData: "code_plan:trust:sess_1:req_1",
        chatId: 1,
      });
      const sm = createMockSessionManager();

      const result = await router.handleCallbackQuery(ctx, sm);

      expect(result).toBe(true);
      expect(sm.approvePlan).toHaveBeenCalledWith("sess_1", true);
    });

    test("handles code_plan:cancel callback", async () => {
      const { ctx, repliedMessages } = createMockCtx({
        callbackData: "code_plan:cancel:sess_1",
        chatId: 1,
      });
      const sm = createMockSessionManager();

      const result = await router.handleCallbackQuery(ctx, sm);

      expect(result).toBe(true);
      expect(sm.killSession).toHaveBeenCalledWith("sess_1");
      expect(repliedMessages.some((m) => m.text.includes("cancelled"))).toBe(true);
    });

    test("handles code_plan:modify callback (prompts for reply)", async () => {
      const { ctx, repliedMessages } = createMockCtx({
        callbackData: "code_plan:modify:sess_1:req_1",
        chatId: 1,
      });
      const sm = createMockSessionManager();

      const result = await router.handleCallbackQuery(ctx, sm);

      expect(result).toBe(true);
      expect(repliedMessages).toHaveLength(1);
      expect(repliedMessages[0].text).toContain("modified");
    });

    test("handles code_dash:status callback", async () => {
      const { ctx, repliedMessages } = createMockCtx({
        callbackData: "code_dash:status:sess_1",
        chatId: 1,
      });
      const sm = createMockSessionManager();

      const result = await router.handleCallbackQuery(ctx, sm);

      expect(result).toBe(true);
      expect(sm.getStatusText).toHaveBeenCalledWith("sess_1");
      expect(repliedMessages).toHaveLength(1);
    });

    test("handles code_dash:stop callback", async () => {
      const { ctx, repliedMessages } = createMockCtx({
        callbackData: "code_dash:stop:sess_1",
        chatId: 1,
      });
      const sm = createMockSessionManager();

      const result = await router.handleCallbackQuery(ctx, sm);

      expect(result).toBe(true);
      expect(sm.killSession).toHaveBeenCalledWith("sess_1");
      expect(repliedMessages.some((m) => m.text.includes("stopped"))).toBe(true);
    });

    test("returns false for unrecognized callback data", async () => {
      const { ctx } = createMockCtx({
        callbackData: "unknown:action:data",
        chatId: 1,
      });
      const sm = createMockSessionManager();

      const result = await router.handleCallbackQuery(ctx, sm);
      expect(result).toBe(false);
    });

    test("returns false when chatId is missing", async () => {
      const { ctx } = createMockCtx({
        callbackData: "code_answer:skip:sess_1:toolu_1",
      });
      const sm = createMockSessionManager();

      const result = await router.handleCallbackQuery(ctx, sm);
      expect(result).toBe(false);
    });

    test("code_answer:custom stores tracking in customReplyMap and sends force_reply prompt", async () => {
      const { ctx, repliedMessages } = createMockCtx({
        callbackData: "code_answer:custom:sess_1:toolu_abc",
        chatId: 1,
      });
      const sm = createMockSessionManager();

      const result = await router.handleCallbackQuery(ctx, sm);

      expect(result).toBe(true);
      expect(repliedMessages).toHaveLength(1);
      // The reply must use force_reply so Telegram prompts the user to reply to it
      expect(repliedMessages[0].options).toMatchObject({
        reply_markup: { force_reply: true },
      });
    });

    test("reply to custom answer prompt routes to correct session via customReplyMap", async () => {
      // Step 1: user taps "Custom answer" — bot sends the force_reply prompt (message_id: 999)
      const { ctx: callbackCtx } = createMockCtx({
        callbackData: "code_answer:custom:sess_1:toolu_abc",
        chatId: 1,
      });
      const sm = createMockSessionManager();
      await router.handleCallbackQuery(callbackCtx, sm);

      // Step 2: user replies to message_id 999 with their custom text
      const { ctx: replyCtx } = createMockCtx({
        messageText: "My custom answer here",
        replyToMessageId: 999,
        chatId: 1,
      });

      const result = await router.tryRouteReply(replyCtx, sm);

      expect(result).toBe(true);
      expect(sm.answerQuestion).toHaveBeenCalledWith("sess_1", "My custom answer here");
    });

    test("customReplyMap entry is deleted after use", async () => {
      // Tap "Custom answer" to register message_id 999 in the map
      const { ctx: callbackCtx } = createMockCtx({
        callbackData: "code_answer:custom:sess_1:toolu_abc",
        chatId: 1,
      });
      const sm = createMockSessionManager();
      await router.handleCallbackQuery(callbackCtx, sm);

      // First reply: consumes the map entry
      const { ctx: replyCtx1 } = createMockCtx({
        messageText: "First answer",
        replyToMessageId: 999,
        chatId: 1,
      });
      await router.tryRouteReply(replyCtx1, sm);

      // Second reply to the same message: map entry already deleted, should NOT route
      const { ctx: replyCtx2 } = createMockCtx({
        messageText: "Second answer",
        replyToMessageId: 999,
        chatId: 1,
      });
      // listAll returns no sessions so the second reply goes nowhere
      const result = await router.tryRouteReply(replyCtx2, sm);
      expect(result).toBe(false);
      // answerQuestion was only called once (from the first reply)
      expect(sm.answerQuestion).toHaveBeenCalledTimes(1);
    });

    test("code_plan:modify stores plan_modification tracking and sends force_reply", async () => {
      const { ctx, repliedMessages } = createMockCtx({
        callbackData: "code_plan:modify:sess_plan:req_123",
        chatId: 1,
      });
      const sm = createMockSessionManager();

      const result = await router.handleCallbackQuery(ctx, sm);

      expect(result).toBe(true);
      expect(repliedMessages).toHaveLength(1);
      expect(repliedMessages[0].options).toMatchObject({
        reply_markup: { force_reply: true },
      });
    });

    test("reply to plan modify prompt calls approvePlan with modifications", async () => {
      // Step 1: user taps "Modify plan" — bot sends the force_reply prompt (message_id: 999)
      const { ctx: callbackCtx } = createMockCtx({
        callbackData: "code_plan:modify:sess_plan:req_123",
        chatId: 1,
      });
      const sm = createMockSessionManager();
      await router.handleCallbackQuery(callbackCtx, sm);

      // Step 2: user replies to message_id 999 with their modification instructions
      const { ctx: replyCtx } = createMockCtx({
        messageText: "Please add error handling",
        replyToMessageId: 999,
        chatId: 1,
      });

      const result = await router.tryRouteReply(replyCtx, sm);

      expect(result).toBe(true);
      expect(sm.approvePlan).toHaveBeenCalledWith("sess_plan", false, "Please add error handling");
    });

    test("code_answer:option decodes option with colons in base64", async () => {
      // Option text containing colons: "http://example.com"
      const optionText = "http://example.com";
      const base64Option = Buffer.from(optionText).toString("base64");
      const { ctx } = createMockCtx({
        callbackData: `code_answer:option:sess_1:toolu_1:${base64Option}`,
        chatId: 1,
      });
      const sm = createMockSessionManager();

      const result = await router.handleCallbackQuery(ctx, sm);

      expect(result).toBe(true);
      // The option text with colons must be decoded correctly from the joined base64 parts
      expect(sm.answerQuestion).toHaveBeenCalledWith("sess_1", optionText);
    });
  });
});
