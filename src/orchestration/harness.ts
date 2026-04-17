/**
 * NLAH Harness — Thin Event Loop
 *
 * Loads a contract, executes steps sequentially, writes a state file,
 * and posts each step's result to the CC thread.
 *
 * Replaces the blackboard/mesh/review-loop machinery with ~100 lines.
 */

import type { Bot } from "grammy";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { loadContract } from "./contractLoader.ts";
import { executeSingleDispatch } from "./dispatchEngine.ts";
import { markdownToHtml, splitMarkdown } from "../utils/htmlFormat.ts";
import { chunkMessage } from "../utils/sendToGroup.ts";
import type { DispatchPlan } from "./types.ts";
import { AGENTS } from "../agents/config.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type StepStatus = "pending" | "in_progress" | "done" | "failed";
export type HarnessStatus = "in_progress" | "done" | "failed" | "cancelled";

export interface StepState {
  seq: number;
  agent: string;
  status: StepStatus;
  output: string | null;
  durationMs: number | null;
}

export interface DispatchState {
  dispatchId: string;
  userMessage: string;
  contractFile: string | null;
  steps: StepState[];
  status: HarnessStatus;
  createdAt: string;
  updatedAt: string;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Run the NLAH harness for a confirmed dispatch.
 * Loads the matching contract, executes steps sequentially, posts results to CC.
 * State is persisted to ~/.claude-relay/harness/state/{dispatchId}.json after each step.
 */
export async function runHarness(
  bot: Bot,
  plan: DispatchPlan,
  ccChatId: number,
  ccThreadId: number | null,
): Promise<void> {
  const contract = await loadContract(plan.classification.intent);
  const contractSteps = contract?.steps ?? [];

  // Build step list: from contract if multi-step, else single step from classification
  const steps: StepState[] = contractSteps.length > 0
    ? contractSteps.map((s) => ({ seq: s.seq, agent: s.agent, status: "pending", output: null, durationMs: null }))
    : [{ seq: 1, agent: plan.classification.primaryAgent, status: "pending", output: null, durationMs: null }];

  const state: DispatchState = {
    dispatchId: plan.dispatchId,
    userMessage: plan.userMessage,
    contractFile: contract?.name ?? null,
    steps,
    status: "in_progress",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await persistState(state);

  // Execute steps sequentially
  for (const step of state.steps) {
    step.status = "in_progress";
    state.updatedAt = new Date().toISOString();
    await persistState(state);

    const stepPlan: DispatchPlan = {
      ...plan,
      classification: { ...plan.classification, primaryAgent: step.agent },
      tasks: [{ seq: step.seq, agentId: step.agent, topicHint: plan.classification.topicHint, taskDescription: plan.userMessage }],
    };

    const result = await executeSingleDispatch(bot, stepPlan, ccChatId, ccThreadId);

    step.output = result.response;
    step.durationMs = result.durationMs;
    step.status = result.success ? "done" : "failed";
    state.updatedAt = new Date().toISOString();
    await persistState(state);

    // Post step result to CC thread
    await postResult(bot, step.agent, result, ccChatId, ccThreadId);

    if (!result.success) {
      state.status = "failed";
      await persistState(state);
      return;
    }
  }

  state.status = "done";
  state.updatedAt = new Date().toISOString();
  await persistState(state);

  // Post synthesis header for multi-step dispatches
  if (state.steps.length > 1) {
    const lines = state.steps.map((s) => {
      const icon = s.status === "done" ? "✅" : "❌";
      const agent = AGENTS[s.agent]?.name ?? s.agent;
      const sec = ((s.durationMs ?? 0) / 1000).toFixed(1);
      return `${icon} ${agent} (${sec}s)`;
    });
    const summary = `📋 <b>Dispatch complete</b>\n\n${lines.join("\n")}`;
    await bot.api.sendMessage(ccChatId, summary, {
      parse_mode: "HTML",
      message_thread_id: ccThreadId ?? undefined,
    }).catch(() => {});
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function postResult(
  bot: Bot,
  agentId: string,
  result: { success: boolean; response: string; durationMs: number },
  ccChatId: number,
  ccThreadId: number | null,
): Promise<void> {
  const agentName = AGENTS[agentId]?.name ?? agentId;
  const icon = result.success ? "✅" : "❌";
  const sec = (result.durationMs / 1000).toFixed(1);
  const header = `${icon} <b>${agentName}</b> — ${result.success ? "completed" : "failed"} (${sec}s)`;

  const chunks = splitMarkdown(result.response, 3800);
  for (let i = 0; i < chunks.length; i++) {
    const html = i === 0 ? `${header}\n\n${markdownToHtml(chunks[i])}` : markdownToHtml(chunks[i]);
    await bot.api.sendMessage(ccChatId, html, {
      parse_mode: "HTML",
      message_thread_id: ccThreadId ?? undefined,
    }).catch(async () => {
      // Telegram rejected HTML → plain text fallback
      const plain = i === 0
        ? `${icon} ${agentName} — ${result.success ? "completed" : "failed"} (${sec}s)\n\n${chunks[i]}`
        : chunks[i];
      for (const chunk of chunkMessage(plain)) {
        await bot.api.sendMessage(ccChatId, chunk, {
          message_thread_id: ccThreadId ?? undefined,
        }).catch(() => {});
      }
    });
  }
}

async function persistState(state: DispatchState): Promise<void> {
  try {
    const dir = join(homedir(), ".claude-relay", "harness", "state");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${state.dispatchId}.json`), JSON.stringify(state, null, 2));
  } catch (err) {
    // State persistence is audit-only — never block dispatch
    console.warn("[harness] Failed to persist state:", err instanceof Error ? err.message : err);
  }
}
