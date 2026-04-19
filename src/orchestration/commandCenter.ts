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
import { markdownToHtml, splitMarkdown, decodeHtmlEntities } from "../utils/htmlFormat.ts";
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
import { trackAgentReply, trackLastActiveAgent } from "./pendingAgentReplies.ts";
import { isJobTopic, getJobTopic } from "../jobs/jobTopicRegistry.ts";
import { getBridgeJob, resumeJobWithAnswer } from "../jobs/jobBridge.ts";

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
      const plain = decodeHtmlEntities(html.replace(/<[^>]+>/g, ""));
      for (const chunk of chunkMessage(plain)) {
        const s = await bot.api.sendMessage(ccChatId, chunk, { message_thread_id: ccThreadId ?? undefined }).catch(() => null);
        if (s) trackAgentReply(ccChatId, s.message_id, agentId, ccThreadId);
      }
      return null;
    });
    if (sent) trackAgentReply(ccChatId, sent.message_id, agentId, ccThreadId);
  }
  // Record as last active agent so bare continuation commands route here
  trackLastActiveAgent(ccChatId, ccThreadId, agentId);
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
  let effectiveText = classifyText.trim() || text;

  // Job topic follow-up — check if the job is suspended awaiting clarification.
  // If so, treat this message as the user's clarification answer and resume.
  if (threadId !== null && isJobTopic(threadId)) {
    const jobEntry = getJobTopic(threadId)!;
    const job = getBridgeJob(jobEntry.jobId);

    if (job?.status === "awaiting-intervention" && job.intervention_type === "clarification") {
      const question = job.intervention_prompt ?? "";
      const resumed = resumeJobWithAnswer(jobEntry.jobId, text, question);
      if (resumed) {
        await ctx.reply(`▶️ Clarification received — resuming job…`).catch(() => {});
        return;
      }
    }

    // Normal follow-up: inject original job context into classifier input
    effectiveText = `Follow-up for job: "${truncate(jobEntry.prompt, 80)}" — ${effectiveText}`;
  }

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
  // Track the plan message so a reply to it routes to the correct agent without re-classifying
  trackAgentReply(chatId, planMsg.message_id, classification.primaryAgent, threadId);

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
        const plain = decodeHtmlEntities(html.replace(/<[^>]+>/g, ""));
        for (const chunk of chunkMessage(plain)) {
          const s = await bot.api.sendMessage(chatId, chunk, { message_thread_id: threadId ?? undefined }).catch(() => null);
          if (s) trackAgentReply(chatId, s.message_id, agentId, threadId);
        }
        return null;
      });
      if (sent) trackAgentReply(chatId, sent.message_id, agentId, threadId);
    }
    // Record as last active agent for continuation commands
    trackLastActiveAgent(chatId, threadId, agentId);
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

/**
 * Infer agent ID from the text of a bot-posted message.
 *
 * Matches two patterns produced by postResult / formatPlanMessage:
 *   ✅ <AgentName> — completed (Xs)   ← success header
 *   ❌ <AgentName> — failed (Xs)      ← failure header
 *   Target: <AgentName> (N%           ← dispatch plan card
 *
 * Used as a last-resort fallback when in-memory tracking is gone (e.g. after restart).
 * Returns null if no agent name matches.
 */
export function inferAgentFromText(text: string): string | null {
  for (const [id, agent] of Object.entries(AGENTS)) {
    if (id === "command-center") continue;
    const name = agent.name;
    if (
      text.includes(`${name} — completed`) ||
      text.includes(`${name} — failed`) ||
      text.includes(`Target: ${name}`)
    ) {
      return id;
    }
  }
  return null;
}
