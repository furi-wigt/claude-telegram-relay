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
import { requestCancel, lookupByCcChat } from "./harnessRegistry.ts";
import { loadContract } from "./contractLoader.ts";
import { callRoutineModel } from "../routines/routineModel.ts";
import type { ClassificationResult, DispatchPlan } from "./types.ts";
import { trackAgentReply } from "./pendingAgentReplies.ts";
import { isJobTopic, getJobTopic } from "../jobs/jobTopicRegistry.ts";
import { getBridgeJob, resumeJobWithAnswer } from "../jobs/jobBridge.ts";
import { getSession } from "../session/groupSessions.ts";

const COUNTDOWN_SECONDS = 5;

/** Confidence threshold below which inline picker is shown */
const PICKER_CONFIDENCE_THRESHOLD = 0.8;

/**
 * Stores the full user message for pending agent-picker dispatches.
 * Cleared after dispatch or cancellation.
 */
const pendingPickerMessages = new Map<string, string>();

/**
 * Stores attachment context (vision + file paths) for low-confidence picker dispatches
 * so it can be re-attached when the user selects an agent from the picker.
 */
const pendingPickerAttachments = new Map<string, { imageContext: string; attachmentPaths: string[] }>();

/**
 * Stores plan + planText for dispatches that were paused mid-countdown.
 * Cleared when the user taps Resume or Cancel on the paused keyboard.
 */
const pendingPausedPlans = new Map<string, { plan: DispatchPlan; planText: string; planMessageId: number }>();

export function isCommandCenter(chatId: number): boolean {
  const ccAgent = AGENTS["command-center"];
  return ccAgent?.chatId === chatId && chatId !== 0 && chatId != null;
}

/**
 * Re-route a user reply directly to the agent that last asked a question,
 * bypassing intent classification. Called when the user explicitly replies to
 * a tracked agent response message in the CC thread.
 *
 * Unified via `runHarness` (Phase 3) so [REDIRECT:] / [CLARIFY:] tags emitted
 * by the agent are honoured consistently with the main NLAH path. Without this
 * unification, redirect tags leaked into CC text instead of triggering re-routing.
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

  const plan: DispatchPlan = {
    dispatchId: crypto.randomUUID(),
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
    cwd: getSession(ccChatId, ccThreadId)?.cwd,
  };

  await ctx.reply(`↩️ Follow-up → <b>${agent.name}</b>`, { parse_mode: "HTML" }).catch(() => {});

  // Delegate to runHarness — it handles [REDIRECT:] / [CLARIFY:] parsing,
  // postResult chunking, trackAgentReply, trackLastActiveAgent, and the
  // multi-step synthesis line.
  await runHarness(bot, plan, ccChatId, ccThreadId);
}

/**
 * Main orchestration entry point.
 * Called from relay.ts when a text message arrives in the CC group.
 *
 * @param attachmentContext  Optional — vision description + local file paths for photo attachments.
 *   Analyzed once at CC entry and injected into every dispatch step via the plan.
 */
export async function orchestrateMessage(
  bot: Bot,
  ctx: Context,
  text: string,
  chatId: number,
  threadId: number | null,
  attachmentContext?: { imageContext: string; attachmentPaths: string[] },
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
    if (attachmentContext) pendingPickerAttachments.set(dispatchId, attachmentContext);
    const keyboard = buildAgentPickerKeyboard(dispatchId);
    await ctx.reply(
      `${planText}\n\n⚠️ Low confidence (${(classification.confidence * 100).toFixed(0)}%) — please pick the right agent:`,
      { reply_markup: keyboard }
    );
    return;
  }

  // Peek at the contract up front so we know whether this dispatch should be
  // isolated into a dedicated forum topic. Safe fallback to false if the
  // contract file is missing or parse fails.
  const contract = await loadContract(classification.intent).catch(() => null);
  const isolate = contract?.isolate === true;

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
    ...(attachmentContext ? {
      imageContext: attachmentContext.imageContext,
      attachmentPaths: attachmentContext.attachmentPaths,
    } : {}),
    cwd: getSession(chatId, threadId)?.cwd,
    ...(isolate ? { isolate: true } : {}),
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
      pendingPausedPlans.set(dispatchId, { plan, planText, planMessageId: planMsg.message_id });
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
 *
 * If `plan.isolate === true`, creates a forum topic in the CC group and
 * routes all step outputs into it (overrides `ccThreadId`). Topic creation
 * failure is non-fatal — dispatch falls back to the original thread.
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

  // Topic isolation — opt-in per contract via `isolate: true`
  let effectiveThreadId: number | null = ccThreadId;
  if (plan.isolate === true) {
    const topicName = await buildIsolatedTopicName(plan.classification.intent, plan.userMessage);
    try {
      const topic = await bot.api.createForumTopic(ccChatId, topicName);
      effectiveThreadId = topic.message_thread_id;
      plan.isolateTopicId = topic.message_thread_id;
    } catch (err) {
      console.warn(
        `[commandCenter] createForumTopic failed (isolate=true) — falling back to root thread:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  await bot.api.editMessageText(
    ccChatId,
    planMessageId,
    `${planText}\n\n🚀 Dispatching to ${agentName}...`,
    { reply_markup: buildCancelDispatchKeyboard(plan.dispatchId) },
  ).catch(() => {});

  await runHarness(bot, plan, ccChatId, effectiveThreadId);

  await bot.api.editMessageText(
    ccChatId,
    planMessageId,
    `${planText}\n\n✅ Dispatch complete`,
    { reply_markup: { inline_keyboard: [] } },
  ).catch(() => {});
}

/**
 * Generate a short forum-topic title for an isolated dispatch.
 * Uses the routine model to summarise the user request in 4–6 words (Title Case,
 * no punctuation). Falls back to a truncated raw message on any failure.
 *
 * Final format: `🛠 <summary>` — always starts with the tool emoji.
 */
export async function buildIsolatedTopicName(intent: string, userMessage: string): Promise<string> {
  const MAX_TITLE_LEN = 60; // Telegram forum topic names ≤ 128 chars; keep it short
  const fallback = `🛠 ${truncate(userMessage.replace(/\s+/g, " ").trim(), MAX_TITLE_LEN - 3)}`;

  const prompt =
    `Summarise this user request in 4-6 words. Title Case. No punctuation. No quotes. Output only the title, nothing else.\n\n` +
    `Request: ${userMessage}`;

  try {
    const raw = await callRoutineModel(prompt, {
      timeoutMs: 8000,
      maxTokens: 20,
      label: "isolate-topic-name",
    });
    const summary = raw
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/[.!?,;:]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!summary) return fallback;
    return `🛠 ${truncate(summary, MAX_TITLE_LEN - 3)}`;
  } catch (err) {
    console.warn(
      `[commandCenter] topic-name LLM failed (intent=${intent}) — using truncated fallback:`,
      err instanceof Error ? err.message : err,
    );
    return fallback;
  }
}

/**
 * Register callback query handlers for orchestration inline buttons.
 * Called once at bot startup.
 */
export function registerOrchestrationCallbacks(bot: Bot): void {
  // Cancel-dispatch button on in-flight harness status messages.
  // Registered FIRST so its `ocd:` prefix is consumed before the picker /
  // countdown handlers get a chance.
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith(CANCEL_DISPATCH_CB_PREFIX)) return next();
    const dispatchId = data.slice(CANCEL_DISPATCH_CB_PREFIX.length);
    await handleCancelDispatchCallback(ctx, bot, dispatchId);
  });

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
      case "resumed": {
        await ctx.answerCallbackQuery({ text: "▶️ Resumed" });
        const paused = pendingPausedPlans.get(dispatchId);
        if (paused) {
          pendingPausedPlans.delete(dispatchId);
          const resumeChatId = ctx.callbackQuery.message?.chat.id;
          const resumeThreadId = ctx.callbackQuery.message?.message_thread_id ?? null;
          if (resumeChatId) {
            await executeAndReport(bot, paused.plan, resumeChatId, resumeThreadId, paused.planMessageId, paused.planText);
          }
        }
        break;
      }
      case "edit":      await ctx.answerCallbackQuery({ text: "✏️ Send your updated instruction" }); break;
      case "cancelled":
        await ctx.answerCallbackQuery({ text: "❌ Cancelled" });
        pendingPickerMessages.delete(dispatchId);
        pendingPickerAttachments.delete(dispatchId);
        pendingPausedPlans.delete(dispatchId);
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
    const pickerAttachment = pendingPickerAttachments.get(dispatchId);
    pendingPickerAttachments.delete(dispatchId);

    if (ctx.callbackQuery.message) {
      await bot.api.editMessageReplyMarkup(
        ctx.callbackQuery.message.chat.id,
        ctx.callbackQuery.message.message_id,
        {}
      ).catch(() => {});
    }

    const chatId = ctx.callbackQuery.message?.chat.id;
    const threadId = ctx.callbackQuery.message?.message_thread_id ?? null;
    if (!chatId) return;

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
      ...(pickerAttachment ? {
        imageContext: pickerAttachment.imageContext,
        attachmentPaths: pickerAttachment.attachmentPaths,
      } : {}),
      cwd: getSession(chatId, threadId)?.cwd,
    };

    await executePickerDispatch(bot, plan, chatId, threadId);
  });
}

/** Picker-path dispatch — delegates to the harness so [REDIRECT:]/[CLARIFY:] fire. */
export async function executePickerDispatch(
  bot: Bot,
  plan: DispatchPlan,
  ccChatId: number,
  ccThreadId: number | null,
): Promise<void> {
  await runHarness(bot, plan, ccChatId, ccThreadId);
}

const CANCEL_DISPATCH_CB_PREFIX = "ocd:";

function buildCancelDispatchKeyboard(dispatchId: string): InlineKeyboard {
  return new InlineKeyboard().text("❌ Cancel dispatch", `${CANCEL_DISPATCH_CB_PREFIX}${dispatchId}`);
}

// ── Cancel-dispatch (kill-switch for in-flight harness runs) ─────────────────

/**
 * Callback handler for the inline `❌ Cancel dispatch` button on the
 * "🚀 Dispatching to ..." status message. Flips the harness registry's
 * cancellation flag for `dispatchId`. The harness loop checks the flag
 * between steps and aborts the in-flight stream via
 * `abortStreamsForDispatch(dispatchId)`.
 *
 * Idempotent: a second tap (or a tap after natural completion) returns the
 * "already completed or expired" popup instead of throwing.
 */
export async function handleCancelDispatchCallback(
  ctx: {
    callbackQuery: { message?: { chat: { id: number }; message_id: number } };
    answerCallbackQuery: (opts?: { text?: string }) => Promise<unknown>;
  },
  bot: { api: { editMessageReplyMarkup: (chatId: number, msgId: number, opts: unknown) => Promise<unknown> } },
  dispatchId: string,
): Promise<void> {
  const accepted = requestCancel(dispatchId);
  if (!accepted) {
    await ctx.answerCallbackQuery({ text: "Dispatch already completed or expired." }).catch(() => {});
    return;
  }
  const msg = ctx.callbackQuery.message;
  if (msg) {
    await bot.api.editMessageReplyMarkup(msg.chat.id, msg.message_id, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
  await ctx.answerCallbackQuery({ text: "🛑 Cancelled" }).catch(() => {});
}

/**
 * `/cancel-dispatch` slash command handler. Only meaningful inside the
 * Command Center group: looks up any in-flight harness run for that chat/
 * thread via `harnessRegistry.lookupByCcChat`, flips the cancel flag, and
 * confirms.
 */
export async function handleCancelDispatchCommand(
  ctx: {
    chat?: { id: number };
    message?: { message_thread_id?: number | null };
    reply: (text: string, opts?: unknown) => Promise<unknown>;
  },
  bot: unknown,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId == null || !isCommandCenter(chatId)) {
    await ctx.reply("`/cancel-dispatch` only works in Command Center.").catch(() => {});
    return;
  }
  const threadId = ctx.message?.message_thread_id ?? null;
  const handled = await handleCancelInCommandCenter(chatId, threadId, ctx, bot);
  if (!handled) {
    await ctx.reply("Nothing to cancel — no dispatch in flight.").catch(() => {});
  }
}

/**
 * `/cancel` reroute when invoked inside the Command Center.
 *
 * Returns `true` if a harness was active and we cancelled it (caller MUST
 * NOT fall through to the existing `handleCancelCommand`, otherwise it would
 * delete CC's own activeStream entry and abort an unrelated stream).
 *
 * Returns `false` if no harness is active — caller falls through to the
 * existing `/cancel` flow unchanged.
 */
export async function handleCancelInCommandCenter(
  chatId: number,
  threadId: number | null,
  ctx: { reply: (text: string, opts?: unknown) => Promise<unknown> },
  _bot: unknown,
): Promise<boolean> {
  const dispatchId = lookupByCcChat(chatId, threadId);
  if (!dispatchId) return false;
  requestCancel(dispatchId);
  await ctx.reply("🛑 Cancelling current dispatch…").catch(() => {});
  return true;
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
