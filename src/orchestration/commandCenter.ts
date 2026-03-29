/**
 * Command Center Handler
 *
 * Intercepts messages sent to the CC Telegram group and orchestrates them:
 * 1. Classify intent → determine target agent
 * 2. Show routing plan with confidence + reasoning
 * 3. Start 5s countdown with Pause/Edit/Cancel buttons
 * 4. On countdown complete → dispatch to target agent group
 * 5. Monitor response → post summary back to CC
 *
 * Entry point: orchestrateMessage() — called from relay.ts when chatId matches CC group.
 */

import type { Bot, Context } from "grammy";
import { AGENTS, type AgentConfig } from "../agents/config.ts";
import { classifyIntent, AUTO_DISPATCH_THRESHOLD } from "./intentClassifier.ts";
import { chunkMessage } from "../utils/sendToGroup.ts";
import { markdownToHtml, splitMarkdown } from "../utils/htmlFormat.ts";
import { executeSingleDispatch } from "./dispatchEngine.ts";
import {
  buildPlanKeyboard,
  buildPausedKeyboard,
  startCountdown,
  handleInterrupt,
  parseOrchCallback,
  clearCountdown,
  ORCH_CB_PREFIX,
} from "./interruptProtocol.ts";
import { InlineKeyboard } from "grammy";
import type { ClassificationResult, DispatchPlan, SubTask } from "./types.ts";

const COUNTDOWN_SECONDS = 5;

/**
 * Stores the full user message for pending agent-picker dispatches keyed by dispatchId.
 * Prevents truncation when extracting the query from the plan display text (which is capped at 100 chars).
 * Entries are deleted after dispatch or cancellation; unresolved pickers are cleared on restart.
 */
const pendingPickerMessages = new Map<string, string>();

/**
 * Check if a chat ID belongs to the Command Center agent.
 */
export function isCommandCenter(chatId: number): boolean {
  const ccAgent = AGENTS["command-center"];
  return ccAgent?.chatId === chatId && chatId !== 0 && chatId != null;
}

/**
 * Main orchestration entry point.
 *
 * Called from relay.ts when a text message arrives in the CC group.
 * Replaces the normal processTextMessage() flow for CC messages.
 */
export async function orchestrateMessage(
  bot: Bot,
  ctx: Context,
  text: string,
  chatId: number,
  threadId: number | null,
): Promise<void> {
  // 1. Classify intent
  const classification = await classifyIntent(text);
  const agent = AGENTS[classification.primaryAgent];

  if (!agent) {
    await ctx.reply(`\u26A0\uFE0F Could not determine target agent for: "${text}"`);
    return;
  }

  // 2. Show routing plan
  const dispatchId = crypto.randomUUID();
  const planText = formatPlanMessage(classification, agent, text);

  if (classification.confidence < AUTO_DISPATCH_THRESHOLD) {
    // Low confidence → show inline keyboard agent picker instead of auto-dispatching.
    // Store full message so the op: callback can retrieve it without truncation.
    pendingPickerMessages.set(dispatchId, text);
    const keyboard = buildAgentPickerKeyboard(dispatchId, text);
    await ctx.reply(
      `${planText}\n\n\u26A0\uFE0F Low confidence (${(classification.confidence * 100).toFixed(0)}%) \u2014 please pick the right agent:`,
      { reply_markup: keyboard }
    );
    return;
  }

  // 3. Post plan with countdown keyboard
  const planMsg = await ctx.reply(
    `${planText}\n\n\u23F3 Auto-dispatching in ${COUNTDOWN_SECONDS}s...`,
    { reply_markup: buildPlanKeyboard(dispatchId, COUNTDOWN_SECONDS) }
  );

  // 4. Start countdown
  const plan: DispatchPlan = {
    dispatchId,
    userMessage: text,
    classification,
    tasks: [{
      seq: 1,
      agentId: classification.primaryAgent,
      topicHint: classification.topicHint,
      taskDescription: text,
    }],
    planMessageId: planMsg.message_id,
  };

  const outcome = await startCountdown(
    dispatchId,
    chatId,
    threadId,
    planMsg.message_id,
    COUNTDOWN_SECONDS,
    (secondsLeft) => {
      // Update the plan message with new countdown
      bot.api.editMessageText(
        chatId,
        planMsg.message_id,
        `${planText}\n\n\u23F3 Auto-dispatching in ${secondsLeft}s...`,
        { reply_markup: buildPlanKeyboard(dispatchId, secondsLeft) }
      ).catch(() => {}); // ignore "message not modified"
    },
  );

  // 5. Handle countdown outcome
  switch (outcome) {
    case "dispatched":
      await executeAndReport(bot, plan, chatId, threadId, planMsg.message_id, planText);
      break;

    case "paused":
      await bot.api.editMessageText(
        chatId,
        planMsg.message_id,
        `${planText}\n\n\u23F8\uFE0F Paused. Type a new instruction or tap Resume.`,
        { reply_markup: buildPausedKeyboard(dispatchId) }
      ).catch(() => {});
      break;

    case "edit":
      await bot.api.editMessageText(
        chatId,
        planMsg.message_id,
        `${planText}\n\n\u270F\uFE0F Edit mode. Send your updated instruction.`,
      ).catch(() => {});
      break;

    case "cancelled":
      await bot.api.editMessageText(
        chatId,
        planMsg.message_id,
        `${planText}\n\n\u274C Dispatch cancelled.`,
      ).catch(() => {});
      break;
  }
}

/**
 * Execute dispatch and post results back to CC.
 */
async function executeAndReport(
  bot: Bot,
  plan: DispatchPlan,
  ccChatId: number,
  ccThreadId: number | null,
  planMessageId: number,
  planText: string,
): Promise<void> {
  const agent = AGENTS[plan.classification.primaryAgent];
  const agentName = agent?.name ?? plan.classification.primaryAgent;

  // Update plan message to show "dispatching"
  await bot.api.editMessageText(
    ccChatId,
    planMessageId,
    `${planText}\n\n\u{1F680} Dispatching to ${agentName}...`,
  ).catch(() => {});

  const result = await executeSingleDispatch(bot, plan, ccChatId, ccThreadId);

  // Post final result to CC — convert markdown → HTML, chunk to stay within Telegram's 4096-char limit
  const durationSec = (result.durationMs / 1000).toFixed(1);
  const statusIcon = result.success ? "\u2705" : "\u274C";
  const header = `${statusIcon} <b>${agentName}</b> \u2014 ${result.success ? "completed" : "failed"} (${durationSec}s)`;
  const mdChunks = splitMarkdown(result.response, 3800);
  for (let i = 0; i < mdChunks.length; i++) {
    const html = i === 0 ? `${header}\n\n${markdownToHtml(mdChunks[i])}` : markdownToHtml(mdChunks[i]);
    await bot.api.sendMessage(ccChatId, html, {
      parse_mode: "HTML",
      message_thread_id: ccThreadId ?? undefined,
    }).catch(async () => {
      // Telegram rejected HTML — fall back to plain text
      const plain = i === 0 ? `${statusIcon} ${agentName} — ${result.success ? "completed" : "failed"} (${durationSec}s)\n\n${mdChunks[i]}` : mdChunks[i];
      for (const chunk of chunkMessage(plain)) {
        await bot.api.sendMessage(ccChatId, chunk, {
          message_thread_id: ccThreadId ?? undefined,
        }).catch(() => {});
      }
    });
  }

  // Update plan message with final status
  await bot.api.editMessageText(
    ccChatId,
    planMessageId,
    `${planText}\n\n${statusIcon} Dispatch complete (${durationSec}s)`,
  ).catch(() => {});
}

/**
 * Register the callback query handler for orchestration inline buttons.
 * Called once at bot startup.
 */
export function registerOrchestrationCallbacks(bot: Bot): void {
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    const parsed = parseOrchCallback(data);
    if (!parsed) return next(); // not an orchestration callback — pass to next handler

    const { action, dispatchId } = parsed;
    const result = handleInterrupt(dispatchId, action);

    if (result === null) {
      await ctx.answerCallbackQuery({ text: "Dispatch already completed or expired." });
      return;
    }

    switch (result) {
      case "paused":
        await ctx.answerCallbackQuery({ text: "\u23F8\uFE0F Paused" });
        break;
      case "resumed":
        await ctx.answerCallbackQuery({ text: "\u25B6\uFE0F Resumed" });
        break;
      case "edit":
        await ctx.answerCallbackQuery({ text: "\u270F\uFE0F Send your updated instruction" });
        break;
      case "cancelled":
        await ctx.answerCallbackQuery({ text: "\u274C Cancelled" });
        pendingPickerMessages.delete(dispatchId);
        break;
    }
  });

  // Handle agent picker callbacks (low-confidence fallback)
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("op:")) return;

    const parts = data.slice("op:".length).split(":");
    if (parts.length < 2) return;

    const [dispatchId, agentId] = parts;
    const agent = AGENTS[agentId];
    if (!agent) {
      await ctx.answerCallbackQuery({ text: "Unknown agent" });
      return;
    }

    await ctx.answerCallbackQuery({ text: `Routing to ${agent.name}...` });

    // Retrieve the full user message stored when the picker was shown.
    // Falls back to plan-text extraction only if the entry was evicted (e.g. after a restart).
    const storedMessage = pendingPickerMessages.get(dispatchId);
    const msgText = ctx.callbackQuery.message?.text;
    const userMessage = storedMessage ?? extractUserMessageFromPlan(msgText ?? "");
    pendingPickerMessages.delete(dispatchId);

    // Remove the keyboard
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
      tasks: [{
        seq: 1,
        agentId,
        topicHint: null,
        taskDescription: userMessage,
      }],
    };

    const chatId = ctx.callbackQuery.message?.chat.id;
    const threadId = ctx.callbackQuery.message?.message_thread_id ?? null;
    if (!chatId) return;

    const result = await executeSingleDispatch(bot, plan, chatId, threadId);

    const durationSec = (result.durationMs / 1000).toFixed(1);
    const icon = result.success ? "\u2705" : "\u274C";
    const pickerHeader = `${icon} <b>${agent.name}</b> \u2014 ${result.success ? "completed" : "failed"} (${durationSec}s)`;
    const pickerMdChunks = splitMarkdown(result.response, 3800);
    for (let i = 0; i < pickerMdChunks.length; i++) {
      const html = i === 0 ? `${pickerHeader}\n\n${markdownToHtml(pickerMdChunks[i])}` : markdownToHtml(pickerMdChunks[i]);
      await bot.api.sendMessage(chatId, html, {
        parse_mode: "HTML",
        message_thread_id: threadId ?? undefined,
      }).catch(async () => {
        const plain = i === 0 ? `${icon} ${agent.name} — ${result.success ? "completed" : "failed"} (${durationSec}s)\n\n${pickerMdChunks[i]}` : pickerMdChunks[i];
        for (const chunk of chunkMessage(plain)) {
          await bot.api.sendMessage(chatId, chunk, { message_thread_id: threadId ?? undefined }).catch(() => {});
        }
      });
    }
  });
}

// ── Formatting ──────────────────────────────────────────────────────────────

function formatPlanMessage(classification: ClassificationResult, agent: AgentConfig, userMessage: string): string {
  const confidence = (classification.confidence * 100).toFixed(0);
  return [
    `\u{1F3AF} DISPATCH PLAN`,
    ``,
    `Query: "${truncate(userMessage, 100)}"`,
    `Intent: ${classification.intent}`,
    `Target: ${agent.name} (${confidence}% confidence)`,
    `Reasoning: ${classification.reasoning}`,
    ``,
    `1. \u{1F4E4} ${agent.shortName ?? agent.name} \u2192 "${truncate(classification.reasoning, 60)}"`,
  ].join("\n");
}

function buildAgentPickerKeyboard(dispatchId: string, userMessage: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const agents = Object.values(AGENTS).filter((a) => a.id !== "command-center");

  // 2 agents per row
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    keyboard.text(agent.shortName ?? agent.name, `op:${dispatchId}:${agent.id}`);
    if (i % 2 === 1 || i === agents.length - 1) keyboard.row();
  }

  keyboard.text("\u274C Cancel", `${ORCH_CB_PREFIX}cancel:${dispatchId}`);
  return keyboard;
}

function extractUserMessageFromPlan(planText: string): string {
  // Extract original user query from the "Query: ..." line embedded in the plan
  const lines = planText.split("\n");
  for (const line of lines) {
    const match = line.match(/^Query: "(.+)"$/);
    if (match) return match[1].replace(/\.\.\.$/g, "");
  }
  return planText.split("\n")[0] || "dispatched message";
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}
