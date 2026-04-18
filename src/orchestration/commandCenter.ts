/**
 * Command Center Handler
 *
 * Intercepts messages in the CC Telegram group and routes them:
 * 1. Classify intent (200ms MLX)
 * 2. Low confidence → inline keyboard picker
 * 3. High confidence → show plan + 5s countdown
 * 4. On confirm → runHarness (contract-driven sequential dispatch)
 *
 * Entry point: orchestrateMessage() — called from relay.ts.
 */

import type { Bot, Context } from "grammy";
import { AGENTS, DEFAULT_AGENT, type AgentConfig } from "../agents/config.ts";
import { classifyIntent, AUTO_DISPATCH_THRESHOLD } from "./intentClassifier.ts";
import { chunkMessage } from "../utils/sendToGroup.ts";
import { executeSingleDispatch } from "./dispatchEngine.ts";
import { markdownToHtml, splitMarkdown } from "../utils/htmlFormat.ts";
import {
  buildPlanKeyboard,
  buildPausedKeyboard,
  startCountdown,
  handleInterrupt,
  parseOrchCallback,
  ORCH_CB_PREFIX,
} from "./interruptProtocol.ts";
import { resolveModelPrefix } from "../utils/modelPrefix.ts";
import { InlineKeyboard } from "grammy";
import { runHarness } from "./harness.ts";
import type { ClassificationResult, DispatchPlan } from "./types.ts";
import { trackAgentReply } from "./pendingAgentReplies.ts";

const COUNTDOWN_SECONDS = 5;

/** Confidence threshold below which inline picker is shown */
const PICKER_CONFIDENCE_THRESHOLD = 0.8;

/**
 * Stores the full user message for pending agent-picker dispatches.
 * Cleared after dispatch or cancellation.
 */
const pendingPickerMessages = new Map<string, string>();

export function isCommandCenter(chatId: number): boolean {
  const ccAgent = AGENTS["command-center"];
  return ccAgent?.chatId === chatId && chatId !== 0 && chatId != null;
}

/**
 * Re-route a user reply directly to the agent that last asked a question,
 * bypassing intent classification. Called when the user explicitly replies to
 * a tracked agent response message in the CC thread.
 */
export async function rerouteToAgent(
  bot: Bot,
  ctx: Context,
  text: string,
  ccChatId: number,
  ccThreadId: number | null,
  agentId: string,
): Promise<void> {
  const agent = AGENTS[agentId];
  if (!agent) {
    await ctx.reply(`⚠️ Agent "${agentId}" not found`).catch(() => {});
    return;
  }

  const dispatchId = crypto.randomUUID();
  const plan: DispatchPlan = {
    dispatchId,
    userMessage: text,
    classification: {
      intent: "follow-up",
      primaryAgent: agentId,
      topicHint: null,
      isCompound: false,
      confidence: 1.0,
      reasoning: `Follow-up reply routed to ${agent.name}`,
    },
    tasks: [{ seq: 1, agentId, topicHint: null, taskDescription: text }],
  };

  await ctx.reply(`↩️ Follow-up → <b>${agent.name}</b>`, { parse_mode: "HTML" }).catch(() => {});

  const result = await executeSingleDispatch(bot, plan, ccChatId, ccThreadId);

  const sec = (result.durationMs / 1000).toFixed(1);
  const icon = result.success ? "✅" : "❌";
  const header = `${icon} <b>${agent.name}</b> — ${result.success ? "completed" : "failed"} (${sec}s)`;
  const chunks = splitMarkdown(result.response, 3800);

  for (let i = 0; i < chunks.length; i++) {
    const html = i === 0 ? `${header}\n\n${markdownToHtml(chunks[i])}` : markdownToHtml(chunks[i]);
    const sent = await bot.api.sendMessage(ccChatId, html, {
      parse_mode: "HTML",
      message_thread_id: ccThreadId ?? undefined,
    }).catch(async () => {
      const plain = i === 0
        ? `${icon} ${agent.name} — ${result.success ? "completed" : "failed"} (${sec}s)\n\n${chunks[i]}`
        : chunks[i];
      for (const chunk of chunkMessage(plain)) {
        await bot.api.sendMessage(ccChatId, chunk, { message_thread_id: ccThreadId ?? undefined }).catch(() => {});
      }
      return null;
    });
    // Track first chunk so the user can keep replying to this agent
    if (i === 0 && sent) {
      trackAgentReply(ccChatId, sent.message_id, agentId, ccThreadId);
    }
  }
}

/**
 * Main orchestration entry point.
 * Called from relay.ts when a text message arrives in the CC group.
 */
export async function orchestrateMessage(
  bot: Bot,
  ctx: Context,
  text: string,
  chatId: number,
  threadId: number | null,
): Promise<void> {
  const { label: modelLabel, text: classifyText } = resolveModelPrefix(text);
  const effectiveText = classifyText.trim() || text;

  const classification = await classifyIntent(effectiveText);
  const agent = AGENTS[classification.primaryAgent];

  if (!agent) {
    await ctx.reply(`⚠️ Could not determine target agent for: "${text}"`);
    return;
  }

  const dispatchId = crypto.randomUUID();
  const planText = formatPlanMessage(classification, agent, text, modelLabel);

  // Low confidence on a non-default agent → show inline picker
  if (classification.confidence < PICKER_CONFIDENCE_THRESHOLD && classification.primaryAgent !== DEFAULT_AGENT.id) {
    pendingPickerMessages.set(dispatchId, text);
    const keyboard = buildAgentPickerKeyboard(dispatchId);
    await ctx.reply(
      `${planText}\n\n⚠️ Low confidence (${(classification.confidence * 100).toFixed(0)}%) — please pick the right agent:`,
      { reply_markup: keyboard }
    );
    return;
  }

  // Show plan with countdown
  const planMsg = await ctx.reply(
    `${planText}\n\n⏳ Auto-dispatching in ${COUNTDOWN_SECONDS}s...`,
    { reply_markup: buildPlanKeyboard(dispatchId, COUNTDOWN_SECONDS) }
  );

  const plan: DispatchPlan = {
    dispatchId,
    userMessage: text,
    classification,
    tasks: [{ seq: 1, agentId: classification.primaryAgent, topicHint: classification.topicHint, taskDescription: text }],
    planMessageId: planMsg.message_id,
  };

  const outcome = await startCountdown(
    dispatchId,
    chatId,
    threadId,
    planMsg.message_id,
    COUNTDOWN_SECONDS,
    (secondsLeft) => {
      bot.api.editMessageText(
        chatId,
        planMsg.message_id,
        `${planText}\n\n⏳ Auto-dispatching in ${secondsLeft}s...`,
        { reply_markup: buildPlanKeyboard(dispatchId, secondsLeft) }
      ).catch(() => {});
    },
  );

  switch (outcome) {
    case "dispatched":
      await executeAndReport(bot, plan, chatId, threadId, planMsg.message_id, planText);
      break;

    case "paused":
      await bot.api.editMessageText(
        chatId,
        planMsg.message_id,
        `${planText}\n\n⏸️ Paused. Type a new instruction or tap Resume.`,
        { reply_markup: buildPausedKeyboard(dispatchId) }
      ).catch(() => {});
      break;

    case "edit":
      await bot.api.editMessageText(
        chatId,
        planMsg.message_id,
        `${planText}\n\n✏️ Edit mode. Send your updated instruction.`,
      ).catch(() => {});
      break;

    case "cancelled":
      await bot.api.editMessageText(
        chatId,
        planMsg.message_id,
        `${planText}\n\n❌ Dispatch cancelled.`,
      ).catch(() => {});
      break;
  }
}

/**
 * Update plan message to "dispatching" and hand off to the NLAH harness.
 */
async function executeAndReport(
  bot: Bot,
  plan: DispatchPlan,
  ccChatId: number,
  ccThreadId: number | null,
  planMessageId: number,
  planText: string,
): Promise<void> {
  const agentName = AGENTS[plan.classification.primaryAgent]?.name ?? plan.classification.primaryAgent;

  await bot.api.editMessageText(
    ccChatId,
    planMessageId,
    `${planText}\n\n🚀 Dispatching to ${agentName}...`,
  ).catch(() => {});

  await runHarness(bot, plan, ccChatId, ccThreadId);

  await bot.api.editMessageText(
    ccChatId,
    planMessageId,
    `${planText}\n\n✅ Dispatch complete`,
  ).catch(() => {});
}

/**
 * Register callback query handlers for orchestration inline buttons.
 * Called once at bot startup.
 */
export function registerOrchestrationCallbacks(bot: Bot): void {
  // Countdown interrupt buttons (Pause / Edit / Cancel / Resume)
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    const parsed = parseOrchCallback(data);
    if (!parsed) return next();

    const { action, dispatchId } = parsed;
    const result = handleInterrupt(dispatchId, action);

    if (result === null) {
      await ctx.answerCallbackQuery({ text: "Dispatch already completed or expired." });
      return;
    }

    switch (result) {
      case "paused":    await ctx.answerCallbackQuery({ text: "⏸️ Paused" }); break;
      case "resumed":   await ctx.answerCallbackQuery({ text: "▶️ Resumed" }); break;
      case "edit":      await ctx.answerCallbackQuery({ text: "✏️ Send your updated instruction" }); break;
      case "cancelled":
        await ctx.answerCallbackQuery({ text: "❌ Cancelled" });
        pendingPickerMessages.delete(dispatchId);
        break;
    }
  });

  // Agent picker callbacks (low-confidence fallback)
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("op:")) return next();

    const parts = data.slice("op:".length).split(":");
    if (parts.length < 2) return;

    const [dispatchId, agentId] = parts;
    const agent = AGENTS[agentId];
    if (!agent) {
      await ctx.answerCallbackQuery({ text: "Unknown agent" });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Routing to ${agent.name}...` });

    const storedMessage = pendingPickerMessages.get(dispatchId);
    const msgText = ctx.callbackQuery.message?.text;
    const userMessage = storedMessage ?? extractUserMessageFromPlan(msgText ?? "");
    pendingPickerMessages.delete(dispatchId);

    if (ctx.callbackQuery.message) {
      await bot.api.editMessageReplyMarkup(
        ctx.callbackQuery.message.chat.id,
        ctx.callbackQuery.message.message_id,
        {}
      ).catch(() => {});
    }

    const plan: DispatchPlan = {
      dispatchId,
      userMessage,
      classification: {
        intent: "user-selected",
        primaryAgent: agentId,
        topicHint: null,
        isCompound: false,
        confidence: 1.0,
        reasoning: `User selected ${agent.name}`,
      },
      tasks: [{ seq: 1, agentId, topicHint: null, taskDescription: userMessage }],
    };

    const chatId = ctx.callbackQuery.message?.chat.id;
    const threadId = ctx.callbackQuery.message?.message_thread_id ?? null;
    if (!chatId) return;

    const result = await executeSingleDispatch(bot, plan, chatId, threadId);

    const sec = (result.durationMs / 1000).toFixed(1);
    const icon = result.success ? "✅" : "❌";
    const header = `${icon} <b>${agent.name}</b> — ${result.success ? "completed" : "failed"} (${sec}s)`;
    const chunks = splitMarkdown(result.response, 3800);
    for (let i = 0; i < chunks.length; i++) {
      const html = i === 0 ? `${header}\n\n${markdownToHtml(chunks[i])}` : markdownToHtml(chunks[i]);
      const sent = await bot.api.sendMessage(chatId, html, {
        parse_mode: "HTML",
        message_thread_id: threadId ?? undefined,
      }).catch(async () => {
        const plain = i === 0 ? `${icon} ${agent.name} — ${result.success ? "completed" : "failed"} (${sec}s)\n\n${chunks[i]}` : chunks[i];
        for (const chunk of chunkMessage(plain)) {
          await bot.api.sendMessage(chatId, chunk, { message_thread_id: threadId ?? undefined }).catch(() => {});
        }
        return null;
      });
      // Track first chunk for follow-up reply routing
      if (i === 0 && sent) {
        trackAgentReply(chatId, sent.message_id, agentId, threadId);
      }
    }
  });
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatPlanMessage(
  classification: ClassificationResult,
  agent: AgentConfig,
  userMessage: string,
  modelLabel?: string,
): string {
  const confidence = (classification.confidence * 100).toFixed(0);
  const modelLine = modelLabel && modelLabel !== "Sonnet" ? `Model: 🧠 ${modelLabel}` : null;
  return [
    `🎯 DISPATCH PLAN`,
    ``,
    `Query: "${truncate(userMessage, 100)}"`,
    ...(modelLine ? [modelLine] : []),
    `Intent: ${classification.intent}`,
    `Target: ${agent.name} (${confidence}% confidence)`,
    `Reasoning: ${classification.reasoning}`,
    ``,
    `1. 📤 ${agent.shortName ?? agent.name} → "${truncate(classification.reasoning, 60)}"`,
  ].join("\n");
}

function buildAgentPickerKeyboard(dispatchId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const agents = Object.values(AGENTS).filter((a) => a.id !== "command-center");
  for (let i = 0; i < agents.length; i++) {
    keyboard.text(agents[i].shortName ?? agents[i].name, `op:${dispatchId}:${agents[i].id}`);
    if (i % 2 === 1 || i === agents.length - 1) keyboard.row();
  }
  keyboard.text("❌ Cancel", `${ORCH_CB_PREFIX}cancel:${dispatchId}`);
  return keyboard;
}

function extractUserMessageFromPlan(planText: string): string {
  for (const line of planText.split("\n")) {
    const match = line.match(/^Query: "(.+)"$/);
    if (match) return match[1].replace(/\.\.\.$/g, "");
  }
  return planText.split("\n")[0] || "dispatched message";
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}
