/**
 * Interview → Board Pipeline
 *
 * Converts completed interview Q&A into blackboard task and evidence records,
 * then initiates a board dispatch. This bridges the interactive state machine
 * (P3.1) with the blackboard execution loop (P2.4).
 *
 * Entry point: buildBoardDispatchFromInterview()
 */

import type { Bot } from "grammy";
import type { Database } from "bun:sqlite";
import type { InteractiveSession } from "../interactive/types.ts";
import type { ClassificationResult, DispatchPlan, SubTask, BbTaskContent } from "./types.ts";
import { AGENTS } from "../agents/config.ts";
import { callMlxGenerate, isMlxAvailable } from "../mlx/client.ts";
import { executeBlackboardDispatch, getDispatchRunner } from "./dispatchEngine.ts";
import { getDb } from "../local/db.ts";
import { chunkMessage } from "../utils/sendToGroup.ts";
import { markdownToHtml, splitMarkdown } from "../utils/htmlFormat.ts";
import {
  buildPlanKeyboard,
  startCountdown,
  ORCH_CB_PREFIX,
} from "./interruptProtocol.ts";
import { InlineKeyboard } from "grammy";

const COUNTDOWN_SECONDS = 5;

/** Interview answer with classification context */
export interface InterviewContext {
  task: string;
  completedQA: { question: string; answer: string }[];
  classification: ClassificationResult;
}

/** Decomposed task plan from interview answers */
export interface DecomposedPlan {
  tasks: SubTask[];
  evidence: { summary: string; source: string; supportsTasks: number[] }[];
}

/**
 * Decompose interview answers into subtasks using MLX (or simple heuristic fallback).
 *
 * For compound tasks (isCompound=true), asks the LLM to split into multiple agent tasks.
 * For simple tasks, wraps the single classification into one task.
 */
export async function decomposeFromInterview(ctx: InterviewContext): Promise<DecomposedPlan> {
  const { task, completedQA, classification } = ctx;

  // Simple task — single agent, no decomposition needed
  if (!classification.isCompound) {
    const qaContext = completedQA
      .map((qa) => `- ${qa.question}: ${qa.answer}`)
      .join("\n");

    return {
      tasks: [{
        seq: 1,
        agentId: classification.primaryAgent,
        topicHint: classification.topicHint,
        taskDescription: `${task}\n\nContext from interview:\n${qaContext}`,
      }],
      evidence: completedQA.map((qa, i) => ({
        summary: `${qa.question}: ${qa.answer}`,
        source: "user-interview",
        supportsTasks: [1],
      })),
    };
  }

  // Compound task — try MLX decomposition
  try {
    const mlxAvailable = await isMlxAvailable();
    if (mlxAvailable) {
      return await decomposeWithMlx(ctx);
    }
  } catch (err) {
    console.warn("[interviewPipeline] MLX decomposition failed, using heuristic:", err);
  }

  return decomposeHeuristic(ctx);
}

/** MLX-based decomposition for compound tasks */
async function decomposeWithMlx(ctx: InterviewContext): Promise<DecomposedPlan> {
  const { task, completedQA, classification } = ctx;
  const agents = Object.values(AGENTS)
    .filter((a) => a.id !== "command-center")
    .map((a) => `- ${a.id}: ${a.capabilities.join(", ")}`)
    .join("\n");

  const qaBlock = completedQA
    .map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`)
    .join("\n");

  const prompt = `You are a task decomposer. Given a compound task and interview answers, break it into subtasks for specific agents.

Available agents:
${agents}

Task: ${task}
Interview context:
${qaBlock}

Return ONLY valid JSON:
{
  "tasks": [
    {"seq": 1, "agentId": "<agent-id>", "topicHint": null, "taskDescription": "<what this agent should do>", "dependsOn": []},
    {"seq": 2, "agentId": "<agent-id>", "topicHint": null, "taskDescription": "<what this agent should do>", "dependsOn": [1]}
  ]
}

Rules:
- 2-5 tasks maximum
- agentId must be from the list above
- dependsOn lists seq numbers that must complete first
- taskDescription should include relevant interview context
- Order by dependency (independent tasks first)`;

  const raw = await callMlxGenerate(prompt, { maxTokens: 512, timeoutMs: 15_000 });
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in MLX response");

  const parsed = JSON.parse(jsonMatch[0]) as { tasks: SubTask[] };
  if (!parsed.tasks || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error("Invalid decomposition response");
  }

  // Validate agent IDs
  const validAgentIds = new Set(Object.keys(AGENTS));
  const validTasks = parsed.tasks.filter((t) => validAgentIds.has(t.agentId));
  if (validTasks.length === 0) throw new Error("No valid agents in decomposition");

  return {
    tasks: validTasks.slice(0, 5),
    evidence: completedQA.map((qa) => ({
      summary: `${qa.question}: ${qa.answer}`,
      source: "user-interview",
      supportsTasks: validTasks.map((t) => t.seq),
    })),
  };
}

/** Heuristic fallback — routes to primary agent with full context */
function decomposeHeuristic(ctx: InterviewContext): DecomposedPlan {
  const { task, completedQA, classification } = ctx;
  const qaContext = completedQA
    .map((qa) => `- ${qa.question}: ${qa.answer}`)
    .join("\n");

  return {
    tasks: [{
      seq: 1,
      agentId: classification.primaryAgent,
      topicHint: classification.topicHint,
      taskDescription: `${task}\n\nContext from interview:\n${qaContext}`,
    }],
    evidence: completedQA.map((qa) => ({
      summary: `${qa.question}: ${qa.answer}`,
      source: "user-interview",
      supportsTasks: [1],
    })),
  };
}

// ── Governance UI ─────────────────────────────────────────────────────────────

/** Build the governance keyboard for dispatch plan approval */
export function buildGovernanceKeyboard(dispatchId: string, secondsLeft: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(`\u2705 Approve (${secondsLeft}s)`, `${ORCH_CB_PREFIX}resume:${dispatchId}`)
    .text("\u270F\uFE0F Edit", `${ORCH_CB_PREFIX}edit:${dispatchId}`)
    .row()
    .text("\u274C Cancel", `${ORCH_CB_PREFIX}cancel:${dispatchId}`)
    .text("\u23E9 Skip Review", `orch:skip_review:${dispatchId}`)
    .row()
    .text("\u{1F6E1}\uFE0F Force Security", `orch:force_security:${dispatchId}`);
}

/**
 * Format the dispatch plan for display in CC.
 */
export function formatDispatchPlan(
  plan: DecomposedPlan,
  task: string,
  classification: ClassificationResult,
): string {
  const lines = [
    `\u{1F4CB} DISPATCH PLAN`,
    ``,
    `Task: "${task.length > 100 ? task.slice(0, 97) + "..." : task}"`,
    `Intent: ${classification.intent} (${(classification.confidence * 100).toFixed(0)}%)`,
    `Compound: ${classification.isCompound ? "Yes" : "No"}`,
    ``,
  ];

  for (const t of plan.tasks) {
    const agent = AGENTS[t.agentId];
    const name = agent?.shortName ?? agent?.name ?? t.agentId;
    const deps = t.dependsOn?.length ? ` (after #${t.dependsOn.join(", #")})` : "";
    lines.push(`${t.seq}. \u{1F4E4} ${name}${deps}`);
    lines.push(`   \u2192 "${t.taskDescription.slice(0, 80)}"`);
  }

  if (plan.evidence.length > 0) {
    lines.push(``, `Evidence: ${plan.evidence.length} items from interview`);
  }

  return lines.join("\n");
}

/**
 * Handle the full orchestration completion flow:
 * 1. Decompose interview into tasks
 * 2. Show plan with governance controls
 * 3. Start countdown → dispatch via blackboard
 */
export async function handleOrchestrationComplete(
  bot: Bot,
  session: InteractiveSession,
): Promise<void> {
  const { chatId, task, completedQA, classification, threadId } = session;
  if (!classification) {
    console.error("[interviewPipeline] No classification on orchestrate session");
    return;
  }

  // 1. Decompose
  const plan = await decomposeFromInterview({ task, completedQA, classification });

  // 2. Show plan with governance controls
  const dispatchId = crypto.randomUUID();
  const planText = formatDispatchPlan(plan, task, classification);

  const planMsg = await bot.api.sendMessage(
    chatId,
    `${planText}\n\n\u23F3 Auto-dispatching in ${COUNTDOWN_SECONDS}s...`,
    {
      reply_markup: buildGovernanceKeyboard(dispatchId, COUNTDOWN_SECONDS),
      message_thread_id: threadId ?? undefined,
    },
  );

  // 3. Countdown
  const outcome = await startCountdown(
    dispatchId,
    chatId,
    threadId ?? null,
    planMsg.message_id,
    COUNTDOWN_SECONDS,
    (secondsLeft) => {
      bot.api.editMessageText(
        chatId,
        planMsg.message_id,
        `${planText}\n\n\u23F3 Auto-dispatching in ${secondsLeft}s...`,
        { reply_markup: buildGovernanceKeyboard(dispatchId, secondsLeft) },
      ).catch(() => {});
    },
  );

  // 4. Handle outcome
  if (outcome === "cancelled") {
    await bot.api.editMessageText(
      chatId,
      planMsg.message_id,
      `${planText}\n\n\u274C Dispatch cancelled.`,
    ).catch(() => {});
    return;
  }

  if (outcome === "edit") {
    await bot.api.editMessageText(
      chatId,
      planMsg.message_id,
      `${planText}\n\n\u270F\uFE0F Edit mode. Send your updated instruction.`,
    ).catch(() => {});
    return;
  }

  if (outcome === "paused") {
    // "paused" maps to "Approve" button — user explicitly approved, dispatch immediately
    await bot.api.editMessageText(
      chatId,
      planMsg.message_id,
      `${planText}\n\n\u2705 Approved — dispatching...`,
    ).catch(() => {});
  } else {
    // "dispatched" — countdown completed naturally
    await bot.api.editMessageText(
      chatId,
      planMsg.message_id,
      `${planText}\n\n\u{1F680} Dispatching...`,
    ).catch(() => {});
  }

  // 5. Execute via blackboard
  const dispatchPlan: DispatchPlan = {
    dispatchId,
    userMessage: task,
    classification,
    tasks: plan.tasks,
    planMessageId: planMsg.message_id,
  };

  const runner = getDispatchRunner();
  if (!runner) {
    await bot.api.sendMessage(chatId, "\u26A0\uFE0F Dispatch runner not registered — cannot execute", {
      message_thread_id: threadId ?? undefined,
    });
    return;
  }

  const db = getDb();
  const result = await executeBlackboardDispatch(db, dispatchPlan, runner);

  // 6. Post results to CC
  const durationSec = (result.durationMs / 1000).toFixed(1);
  const statusIcon = result.success ? "\u2705" : "\u274C";
  const header = `${statusIcon} Dispatch complete (${durationSec}s)`;

  const mdChunks = splitMarkdown(result.response, 3800);
  for (let i = 0; i < mdChunks.length; i++) {
    const html = i === 0 ? `${header}\n\n${markdownToHtml(mdChunks[i])}` : markdownToHtml(mdChunks[i]);
    await bot.api.sendMessage(chatId, html, {
      parse_mode: "HTML",
      message_thread_id: threadId ?? undefined,
    }).catch(async () => {
      const plain = i === 0 ? `${header}\n\n${mdChunks[i]}` : mdChunks[i];
      for (const chunk of chunkMessage(plain)) {
        await bot.api.sendMessage(chatId, chunk, {
          message_thread_id: threadId ?? undefined,
        }).catch(() => {});
      }
    });
  }

  // Update plan message with final status
  await bot.api.editMessageText(
    chatId,
    planMsg.message_id,
    `${planText}\n\n${statusIcon} Dispatch complete (${durationSec}s)`,
  ).catch(() => {});
}
